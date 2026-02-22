  import express from 'express';
  import pino from 'pino';
  import fs from 'fs';
  import {
    default as makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
  } from '@whiskeysockets/baileys';
  import { Boom } from '@hapi/boom';
  import Redis from 'ioredis';

  // ── Silence noisy Baileys session/crypto logs ─────────────────────────────
  const NOISE = ['SessionEntry','indexInfo','currentRatchet','_chains',
    'Closing open session','Closing session','baseKey','rootKey',
    'remoteIdentityKey','ephemeralKeyPair','lastRemoteEphemeralKey',
    'registrationId','prekey bundle','incoming prekey','privKey','pubKey'];
  const isNoise = (chunk) => NOISE.some(p => chunk.toString().includes(p));
  const _stdout = process.stdout.write.bind(process.stdout);
  const _stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...a) => isNoise(chunk) ? true : _stdout(chunk, ...a);
  process.stderr.write = (chunk, ...a) => isNoise(chunk) ? true : _stderr(chunk, ...a);

  // ── Logger ────────────────────────────────────────────────────────────────────
  const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: { target: 'pino-pretty', options: { colorize: true } }
  });

  // ── Redis ─────────────────────────────────────────────────────────────────────
  const REDIS_URL      = process.env.REDIS_URL      || 'redis://localhost:6379';
  const QUEUE_KEY      = process.env.REDIS_QUEUE_KEY || 'whatsapp:messages:incoming';
  const MAX_QUEUE_SIZE = parseInt(process.env.MAX_QUEUE_SIZE || '10000');
  // ── Contacts Storage (JSON file) ──────────────────────────────────────────────
  const CONTACTS_FILE = '/app/data/contacts3.json';
  const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    retryStrategy: (t) => Math.min(t * 500, 5000)
  });
  redis.on('error',  (e) => logger.error(e, 'Redis error'));
  redis.on('connect',()  => logger.info('Redis connected'));

  async function pushToQueue(msg) {
    const pipeline = redis.pipeline();
    pipeline.lpush(QUEUE_KEY, JSON.stringify(msg));
    pipeline.ltrim(QUEUE_KEY, 0, MAX_QUEUE_SIZE - 1);
    await pipeline.exec();
  }

  // ── WhatsApp State ────────────────────────────────────────────────────────────
  let sock       = null;
  let qrCodeData = null;
  let status     = 'disconnected';

  // ── Baileys ───────────────────────────────────────────────────────────────────
  async function connectWA() {
    const { state, saveCreds } = await useMultiFileAuthState('/app/auth_info');
    const { version }          = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      logger,
      printQRInTerminal: true,
      browser: ['WhatsApp Bot', 'Chrome', '120.0.0']
    });

    sock.ev.on('creds.update', saveCreds);
    // שמירת contacts
    sock.ev.on('contacts.update', async (updates) => {
    for (const contact of updates) {
      if (contact.id) {
        const senderPhone = contact.id; // ב-contacts.update בדרך כלל כבר מנורמל
        
        await saveContact(senderPhone, {
          name: contact.name || contact.notify,
          notify: contact.notify,
          verifiedName: contact.verifiedName,
          isMyContact: contact.isMyContact || false,
          eventType:'contact'
        });
      }
    }
    logger.info({ count: updates.length }, 'Contacts updated via event');
  });
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        qrCodeData = qr;
        status     = 'qr_ready';
        logger.info('QR ready');
      }
      if (connection === 'open') {
        qrCodeData = null;
        status     = 'connected';
        logger.info('WhatsApp connected');
      }
      if (connection === 'close') {
        status = 'disconnected';
        const code  = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const retry = code !== DisconnectReason.loggedOut;
        logger.warn({ code, retry }, 'Connection closed');
        if (retry) setTimeout(connectWA, 3000);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      
      // deduplicate by messageId
      const seen = new Set();
      
      for (const msg of messages) {
       // if (msg.key.fromMe) continue;
        // ✅ שמור contact
      const sender = msg.key.participant || msg.key.remoteJid;
      const senderPhone = msg.key.participantPn || msg.key.senderPn || sender;

      if (sender && !sender.includes('@g.us')) {
        await saveContact(senderPhone || sender, {
          name: msg.pushName,
          notify: msg.pushName,
          isMyContact: true,
          eventType:'message'
        });
      }
        // דלג אם אין תוכן
        if (!msg.message) continue;
        
        // דלג על כפילויות
        const msgId = msg.key.id;
        if (seen.has(msgId)) continue;
        seen.add(msgId);
        
        // דלג על הודעות מערכת
        if (msg.message?.senderKeyDistributionMessage && 
            !msg.message?.conversation && 
            !msg.message?.extendedTextMessage &&
            !msg.message?.buttonsMessage &&
            !msg.message?.listResponseMessage &&
            !msg.message?.buttonResponseMessage &&
            !msg.message?.templateButtonReplyMessage) continue;

        await pushToQueue(parseMsg(msg));
      }
    });
  }
  // ── Contacts Storage ──────────────────────────────────────────────────────────

async function loadContacts() {
  try {
    if (fs.existsSync(CONTACTS_FILE)) {
      const data = fs.readFileSync(CONTACTS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    logger.error({ err: e }, 'Failed to load contacts');
  }
  return {};
}

// ✅ נרמול JID
function normalizeContactJid(jid) {
  if (!jid) return null;
  
  // אם יש @lid - חלץ את המספר מ-senderPn אם קיים
  if (jid.includes('@lid')) {
    // רק המספר
    return jid.split('@')[0];
  }
  
  // אם @s.whatsapp.net - חלץ מספר
  if (jid.includes('@s.whatsapp.net')) {
    return jid.split('@')[0];
  }
  
  // אם @g.us - דלג (זו קבוצה)
  if (jid.includes('@g.us')) {
    return null;
  }
  
  return jid;
}

async function saveContact(jid, data) {
  try {
    const normalized = normalizeContactJid(jid);
    if (!normalized) return; // דלג על קבוצות
    
    const contacts = await loadContacts();
    
    // שמור תחת המספר הנקי
    contacts[normalized] = {
      ...data,
      originalJid: jid,
      lastSeen: new Date().toISOString()
    };
    
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2));
    logger.debug({ jid: normalized }, 'Contact saved');
  } catch (e) {
    logger.error({ err: e, jid }, 'Failed to save contact');
  }
}

async function getContacts(query = '', limit = 200) {
  try {
    const all = await loadContacts();
    const items = Object.entries(all)
      .map(([jid, data]) => ({ jid, ...data }))
      .filter(c => {
        if (!query) return true;
        const hay = `${c.jid} ${c.name || ''} ${c.notify || ''}`.toLowerCase();
        return hay.includes(query.toLowerCase());
      })
      .slice(0, Math.min(limit, 1000));
    return items;
  } catch (e) {
    logger.error({ err: e }, 'Failed to get contacts');
    return [];
  }
}

  // 1) Unwrap wrappers (ephemeral / viewOnce) to reach the real message payload
  function unwrapMessage(message) {
    if (!message) return null;

    // common WhatsApp wrappers (Baileys)
    if (message.ephemeralMessage?.message) {
      return unwrapMessage(message.ephemeralMessage.message);
    }
    if (message.viewOnceMessageV2?.message) {
      return unwrapMessage(message.viewOnceMessageV2.message);
    }
    if (message.viewOnceMessage?.message) {
      return unwrapMessage(message.viewOnceMessage.message);
    }
    if (message.viewOnceMessageV2Extension?.message) {
      return unwrapMessage(message.viewOnceMessageV2Extension.message);
    }

    return message;
  }

  // 2) Parse message types incl. buttons/list/interactive (native flow) + listMessage + unknown fallback
  function parseMsg(msg) {
    console.log("PARSE VERSION 2.1");

    const jid = msg.key.remoteJid;
    const isGroup = jid?.endsWith("@g.us");
    const sender = isGroup ? msg.key.participant : jid;

    const c = unwrapMessage(msg.message);

    let type = "unknown23";
    let data = {};

    // Text
    if (c?.conversation || c?.extendedTextMessage) {
      type = "text";
      data = { text: c.conversation || c.extendedTextMessage?.text };

    // Media
    } else if (c?.imageMessage) {
      type = "image";
      data = { caption: c.imageMessage.caption || null };

    } else if (c?.videoMessage) {
      type = "video";
      data = { caption: c.videoMessage.caption || null };

    } else if (c?.audioMessage) {
      type = "audio";
      data = {};

    } else if (c?.documentMessage) {
      type = "document";
      data = { fileName: c.documentMessage.fileName || null };

    // ✅ Buttons response (plural)
    } else if (c?.buttonsResponseMessage) {
      type = "button_response";
      data = {
        buttonId: c.buttonsResponseMessage.selectedButtonId || null,
        displayText: c.buttonsResponseMessage.selectedDisplayText || null,
      };

    // ✅ List message (the menu you sent)
    } 
  else if (c?.listMessage) {
    type = "list_message";

    const sections = c.listMessage.sections || [];
    const mappedSections = sections.map((s, si) => ({
      index: si,
      title: s?.title || null,
      rows: (s?.rows || []).map((r, ri) => ({
        index: ri,
        rowId: r?.rowId || null,
        title: r?.title || null,
        description: r?.description || null,
      })),
    }));

    const rowsCount = mappedSections.reduce((sum, s) => sum + s.rows.length, 0);

    data = {
      title: c.listMessage.title || null,
      description: c.listMessage.description || null,
      buttonText: c.listMessage.buttonText || null,
      sectionsCount: mappedSections.length,
      rowsCount,
      sections: mappedSections,          // ✅ כאן כל הרשימה
    };
  }

    // ✅ List response (user selection)
    else if (c?.listResponseMessage) {
      type = "list_response";
      data = {
        rowId: c.listResponseMessage.singleSelectReply?.selectedRowId || null,
        title: c.listResponseMessage.title || null,
      };

    // ✅ Interactive / Native Flow (floating menu etc.)
    } else if (c?.interactiveResponseMessage || c?.interactiveMessage) {
      const ir = c.interactiveResponseMessage || c.interactiveMessage;

      const nativeFlow = ir?.nativeFlowResponseMessage;
      const paramsJson = nativeFlow?.paramsJson;

      let parsed = null;
      if (paramsJson) {
        try { parsed = JSON.parse(paramsJson); } catch { parsed = null; }
      }

      type = "interactive_response";
      data = {
        responseId: parsed?.id || parsed?.selectedId || parsed?.selected_id || null,
        bodyText: ir?.body?.text || null,
        rawParams: paramsJson || null,
      };

    // Template button reply
    } else if (c?.templateButtonReplyMessage) {
      type = "template_button_response";
      data = {
        selectedId: c.templateButtonReplyMessage.selectedId || null,
        displayText: c.templateButtonReplyMessage.selectedDisplayText || null,
      };

    // Reaction
    } else if (c?.reactionMessage) {
      type = "reaction";
      data = { emoji: c.reactionMessage.text || null };

    // Location
    } else if (c?.locationMessage) {
      type = "location";
      data = {
        lat: c.locationMessage.degreesLatitude,
        lng: c.locationMessage.degreesLongitude,
      };
    }

    // Fallback for unknown
    if (type === "unknown23") {
      const keys = c ? Object.keys(c) : [];
      data = { rawType: keys[0] || null, keys };
    }

    return {
      messageId: msg.key.id,
      jid,
      sender,
      isGroup,
      timestamp: msg.messageTimestamp,
      type,
      data,
      receivedAt: new Date().toISOString(),
    };
  }





  // ── Express API ───────────────────────────────────────────────────────────────
  const app  = express();
  const PORT = process.env.PORT || 3001;
  app.use(express.json());

  const normalizeJid = (raw) => raw.includes('@') ? raw : raw.replace(/\D/g,'') + '@s.whatsapp.net';

  app.get('/status',  (_,res) => res.json({ status }));
  app.get('/qrcode',  (_,res) => {
    if (!qrCodeData) return res.status(404).json({ error: 'QR not available', status });
    res.json({ qr: qrCodeData, status });
  });

  app.post('/send/text', async (req, res) => {
    try {
      const r = await sock.sendMessage(normalizeJid(req.body.jid), { text: req.body.text });
      res.json({ success: true, messageId: r?.key?.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/send/image', async (req, res) => {
    try {
      const r = await sock.sendMessage(normalizeJid(req.body.jid), {
        image: { url: req.body.url }, caption: req.body.caption || ''
      });
      res.json({ success: true, messageId: r?.key?.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/send/buttons', async (req, res) => {
    try {
      const { jid: j, text, footer, buttons } = req.body;
      const r = await sock.sendMessage(normalizeJid(j), {
        text, footer: footer || '',
        buttons: buttons.map((b,i) => ({
          buttonId: b.id || `btn_${i}`,
          buttonText: { displayText: b.text }, type: 1
        })),
        headerType: 1
      });
      res.json({ success: true, messageId: r?.key?.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/send/list', async (req, res) => {
    try {
      const { jid: j, text, title, buttonText, footer, sections } = req.body;
      const r = await sock.sendMessage(normalizeJid(j), {
        text, title: title || '', footer: footer || '',
        buttonText: buttonText || 'בחר אפשרות',
        sections: sections.map(s => ({
          title: s.title,
          rows: s.rows.map((row,i) => ({
            title: row.title, description: row.description || '',
            rowId: row.id || `row_${i}`
          }))
        }))
      });
      res.json({ success: true, messageId: r?.key?.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/send/template', async (req, res) => {
    try {
      const { jid: j, text, footer, templateButtons } = req.body;
      const r = await sock.sendMessage(normalizeJid(j), {
        text, footer: footer || '',
        templateButtons: templateButtons.map((b,i) => {
          if (b.type === 'url')  return { index: i+1, urlButton:  { displayText: b.text, url: b.url } };
          if (b.type === 'call') return { index: i+1, callButton: { displayText: b.text, phoneNumber: b.phone } };
          return { index: i+1, quickReplyButton: { displayText: b.text, id: b.id || `tpl_${i}` } };
        })
      });
      res.json({ success: true, messageId: r?.key?.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/send/reaction', async (req, res) => {
    try {
      const { jid: j, messageId, emoji } = req.body;
      await sock.sendMessage(normalizeJid(j), {
        react: { text: emoji, key: { remoteJid: normalizeJid(j), id: messageId } }
      });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/send/button-click', async (req, res) => {
    try {
      const { jid: j, buttonId, displayText } = req.body;
      const r = await sock.sendMessage(normalizeJid(j), {
        buttonsResponse: { selectedButtonId: buttonId,
                          selectedDisplayText: displayText || buttonId, type: 1 }
      });
      res.json({ success: true, messageId: r?.key?.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/send/list-click', async (req, res) => {
    try {
      const { jid: j, rowId, title } = req.body;
      const r = await sock.sendMessage(normalizeJid(j), {
        listResponse: { singleSelectReply: { selectedRowId: rowId },
                        title: title || rowId }
      });
      res.json({ success: true, messageId: r?.key?.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/logout', async (_,res) => {
    try { await sock.logout(); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/contacts', async (req, res) => {
    const q = req.query.q || '';
    const limit = parseInt(req.query.limit || '200');
    const items = await getContacts(q, limit);
    res.json({ count: items.length, items });
  });

  app.get('/debug/contacts-count', async (req, res) => {
    const all = await redis.hlen('whatsapp:contacts');
    res.json({ count: all });
  });
  app.listen(PORT, () => {
    logger.info(`Baileys service on :${PORT}`);
    connectWA();
  });
