import express from 'express';
import pino from 'pino';
import fs from 'fs';
import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
   downloadMediaMessage, Browsers

} from '@whiskeysockets/baileys';

import { Boom } from '@hapi/boom';
import RedisStreams from './redis-streams.js';
import path from 'path';         // ← 
const PHONE_ID     = process.env.PHONE_ID || null;  // ← הוסף
const APP_VERSION = '1.0.0.21';
let pairingCodeData = null;        // ←20 
const  user_display= process.env.USER_DISPLAY || '****anon';
const USE_PAIRING_CODE = process.env.USE_PAIRING_CODE === 'true';
let pairingRequested = false;  // מונע בקשות כפולות
const PHONE_NUMBER = process.env.PHONE_NUMBER || null;

const NOISE = ['SessionEntry','indexInfo','currentRatchet','_chains',
  'Closing open session','Closing session','baseKey','rootKey',
  'remoteIdentityKey','ephemeralKeyPair','lastRemoteEphemeralKey',
  'registrationId','prekey bundle','incoming prekey','privKey','pubKey'];
const isNoise = (chunk) => NOISE.some(p => chunk.toString().includes(p));
const _stdout = process.stdout.write.bind(process.stdout);
const _stderr = process.stderr.write.bind(process.stderr);
process.stdout.write = (chunk, ...a) => isNoise(chunk) ? true : _stdout(chunk, ...a);
process.stderr.write = (chunk, ...a) => isNoise(chunk) ? true : _stderr(chunk, ...a);

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

const redisStreams = new RedisStreams();
const CONTACTS_FILE = '/app/data/contacts.json';

const MEDIA_BASE = '/app/data/media';

async function saveMedia(msg, messageId, mimeType) {
  try {
    logger.warn({ messageId, mimeType, sockExists: !!sock }, '[MEDIA] saveMedia start');
    fs.mkdirSync(MEDIA_BASE, { recursive: true });
    const buffer = await downloadMediaMessage(msg, 'buffer', {},
      { logger, reuploadRequest: sock.updateMediaMessage });
    logger.warn({ size: buffer.length }, '[MEDIA] buffer downloaded');
    const ext      = (mimeType || 'image/jpeg').split('/')[1].split(';')[0];
    const filePath = `${MEDIA_BASE}/${messageId}.${ext}`;
    fs.writeFileSync(filePath, buffer);
    logger.warn({ filePath }, '[MEDIA] Saved');
    return filePath;
  } catch (e) {
    logger.warn({ err: e.message, stack: e.stack }, '[MEDIA] Failed to save');
    return null;
  }
}


function normalizeContactJid(jid) {
  if (!jid) return null;
  if (jid.includes('@lid')) return jid.split('@')[0];
  if (jid.includes('@s.whatsapp.net')) return jid.split('@')[0];
  if (jid.includes('@g.us')) return null;
  return jid;
}

async function loadContacts() {
  try {
    if (fs.existsSync(CONTACTS_FILE)) {
      const data = fs.readFileSync(CONTACTS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) { logger.error({ err: e }, 'Failed to load contacts'); }
  return {};
}

async function saveContact(jid, data) {
  try {
    const normalized = normalizeContactJid(jid);
    if (!normalized) return;
    const contacts = await loadContacts();
    contacts[normalized] = { ...data, originalJid: jid, lastSeen: new Date().toISOString() };
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2));
  } catch (e) { logger.error({ err: e, jid }, 'Failed to save contact'); }
}

async function getContacts(query = '', limit = 200) {
  try {
    const all = await loadContacts();
    return Object.entries(all)
      .map(([jid, data]) => ({ jid, ...data }))
      .filter(c => {
        if (!query) return true;
        return `${c.jid} ${c.name || ''} ${c.notify || ''}`.toLowerCase().includes(query.toLowerCase());
      })
      .slice(0, Math.min(limit, 1000));
  } catch (e) { logger.error({ err: e }, 'Failed to get contacts'); return []; }
}

async function sendToWebhooks(payload) {
  return redisStreams.sendToWebhooks(payload);
}


function buildAuthPayload() {
  const raw = fs.readFileSync('/app/auth_info/creds.json');
  const creds_b64 = raw.toString('base64');
  const jid = sock.user?.id || '';
  const phone = jid.split('@')[0].split(':')[0];
  return { 
    event: 'authenticated', 
    phone, 
    jid, 
    name:          sock.user?.name || null, 
    timestamp:     new Date().toISOString(), 
    creds_b64,
    authRevision:  parseInt(process.env.AUTH_REVISION || '0'),  
    userDisplay:  process.env.USER_DISPLAY || '****anon',  // ← חדש
    phoneId:      process.env.PHONE_ID || null,  // ← חדש

  };
}

let sock = null;
let qrCodeData = null;
let status = 'disconnected';

function unwrapMessage(message) {
  if (!message) return null;
  if (message.ephemeralMessage?.message)  return unwrapMessage(message.ephemeralMessage.message);
  if (message.viewOnceMessageV2?.message) return unwrapMessage(message.viewOnceMessageV2.message);
  if (message.viewOnceMessage?.message)   return unwrapMessage(message.viewOnceMessage.message);
  return message;
}
async function notifyOutgoing(messageId, jid, type, data) {
  if (!messageId) return;
  await sendToWebhooks({
    event:     'message',
    messageId,
    jid,
    type,
    data:      { ...data, fromMe: true, pushName: null },
    timestamp: Math.floor(Date.now() / 1000),   // ✅ Unix seconds כמו Baileys
    phoneId:   PHONE_ID,
  });
}

function parseMsg(msg) {
  const jid     = msg.key.remoteJid;
  const isGroup = jid?.endsWith('@g.us');
  const sender  = isGroup ? msg.key.participant : jid;
  const c       = unwrapMessage(msg.message);

  let type = 'unknown';
  let data = {};

  if (c?.conversation || c?.extendedTextMessage) {
    type = 'text';
    data = { text: c.conversation || c.extendedTextMessage?.text };
  // ✅ אחרי — עם mimeType כדי ש-saveMedia יידע את הextension
  } 
else if (c?.imageMessage) {
  type = 'image';
  data = {
    caption:  c.imageMessage.caption  || null,
    mimeType: c.imageMessage.mimetype || 'image/jpeg',  // ← נחוץ ל-saveMedia!
  };
} 
else if (c?.audioMessage) {
  type = 'audio';
  data = {
    mimeType: c.audioMessage.mimetype || 'audio/ogg',   // ← נחוץ ל-saveMedia!
    duration: c.audioMessage.seconds  || null,
    isPtt:    c.audioMessage.ptt      || false,
  };
}
else if (c?.videoMessage) {
  type = 'video';
  data = { caption: c.videoMessage.caption || null };

} 
  else if (c?.documentMessage) {
    type = 'document';
    data = { fileName: c.documentMessage.fileName || null };

  } else if (c?.buttonsMessage) {
    type = 'buttons';
    data = {
      text:    c.buttonsMessage.contentText || c.buttonsMessage.text || null,
      footer:  c.buttonsMessage.footerText  || null,
      buttons: (c.buttonsMessage.buttons || []).map((b, i) => ({
        index:    i,
        buttonId: b.buttonId || null,
        label:    b.buttonText?.displayText || null,
      })),
    };

  } else if (c?.buttonsResponseMessage) {
    type = 'button_response';
    data = {
      buttonId:    c.buttonsResponseMessage.selectedButtonId    || null,
      displayText: c.buttonsResponseMessage.selectedDisplayText || null,
    };

  } else if (c?.templateMessage) {
    const hydrated = c.templateMessage.hydratedTemplate;
    type = 'template';
    data = {
      text:    hydrated?.hydratedContentText || null,
      buttons: (hydrated?.hydratedButtons || []).map(b => ({
        label:    b.quickReplyButton?.displayText || b.urlButton?.displayText || null,
        buttonId: b.quickReplyButton?.id || null,
      })),
    };

  } else if (c?.templateButtonReplyMessage) {
    type = 'template_button_response';
    data = {
      selectedId:  c.templateButtonReplyMessage.selectedId          || null,
      displayText: c.templateButtonReplyMessage.selectedDisplayText || null,
    };

  } else if (c?.listMessage) {
    type = 'list_message';
    const sections = c.listMessage.sections || [];
    data = {
      title:       c.listMessage.title       || null,
      description: c.listMessage.description || null,
      buttonText:  c.listMessage.buttonText  || null,
      sections: sections.map((s, si) => ({
        index: si,
        title: s?.title || null,
        rows: (s?.rows || []).map((r, ri) => ({
          index: ri, rowId: r?.rowId || null,
          title: r?.title || null, description: r?.description || null,
        })),
      })),
    };

  } else if (c?.listResponseMessage) {
    type = 'list_response';
    data = {
      rowId: c.listResponseMessage.singleSelectReply?.selectedRowId || null,
      title: c.listResponseMessage.title || null,
    };

  } else if (c?.interactiveResponseMessage || c?.interactiveMessage) {
    const ir = c.interactiveResponseMessage || c.interactiveMessage;
    const paramsJson = ir?.nativeFlowResponseMessage?.paramsJson;
    let parsed = null;
    if (paramsJson) { try { parsed = JSON.parse(paramsJson); } catch {} }
    type = 'interactive_response';
    data = {
      responseId: parsed?.id || parsed?.selectedId || null,
      bodyText:   ir?.body?.text || null,
      rawParams:  paramsJson    || null,
    };

  } else if (c?.reactionMessage) {
    type = 'reaction';
    data = { emoji: c.reactionMessage.text || null };

  } else if (c?.locationMessage) {
    type = 'location';
    data = { lat: c.locationMessage.degreesLatitude, lng: c.locationMessage.degreesLongitude };
  }

  if (type === 'unknown') {
    const keys = c ? Object.keys(c) : [];
    data = { rawType: keys[0] || null, keys };
  }

  return { messageId: msg.key.id, jid, sender, isGroup, timestamp: msg.messageTimestamp, type, data, receivedAt: new Date().toISOString() };
}

async function connectWA() {
  const { state, saveCreds } = await useMultiFileAuthState('/app/auth_info');
  const { version }          = await fetchLatestBaileysVersion();

  // sock = makeWASocket({ version,   auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) }, logger,  browser: ['ScenarioBot', 'Chrome', APP_VERSION],});

  sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    browser: USE_PAIRING_CODE
      ? Browsers.macOS('Chrome')                       // pairing code דורש פורמט תקין
      : [user_display, 'Chrome', APP_VERSION],         // QR — נשאר עם הזיהוי המותאם
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    await new Promise(resolve => setTimeout(resolve, 500));
    if (!fs.existsSync('/app/auth_info/creds.json')) return;
    if (!sock?.user?.id) return;
    const payload = buildAuthPayload();
    await sendToWebhooks(payload);
    logger.info({ phone: payload.phone }, 'Creds updated — sent to webhooks');
  });

sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      if (USE_PAIRING_CODE && !sock.authState.creds.registered && !pairingRequested && PHONE_NUMBER) {
        pairingRequested = true;
        try {
          const phoneNumber = PHONE_NUMBER.replace(/\D/g, '');
          const code = await sock.requestPairingCode(phoneNumber);
          pairingCodeData = code;
          status = 'pairing_ready';
          logger.info({ code }, 'Pairing code ready');
          await sendToWebhooks({
            event: 'pairing_code',
            pairingCode: code,
            timestamp: new Date().toISOString(),
            phoneId: PHONE_ID,
          });
        } catch (e) {
          pairingRequested = false;
          logger.warn({ err: e.message }, 'Pairing code failed, falling back to QR');
          qrCodeData = qr; status = 'qr_ready';
          await sendToWebhooks({ event: 'qr', timestamp: new Date().toISOString(), phoneId: PHONE_ID });
        }
      } else {
        qrCodeData = qr;
        status = 'qr_ready';
        logger.info('QR ready');
        await sendToWebhooks({ event: 'qr', timestamp: new Date().toISOString(), phoneId: PHONE_ID });
      }
    }

    if (connection === 'open') {
      qrCodeData = null;
      pairingCodeData = null;
      status = 'connected';
      logger.info('WhatsApp connected');
      try { await sendToWebhooks(buildAuthPayload()); } catch (e) { logger.error({ err: e }, 'Failed to send creds'); }
    }

    if (connection === 'close') {
      status = 'disconnected';
      const code  = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const retry = code !== DisconnectReason.loggedOut;
      logger.warn({ code, retry }, 'Connection closed');
      await sendToWebhooks({ event: 'disconnected', code, retry, timestamp: new Date().toISOString(), phoneId: PHONE_ID });
      if (retry) setTimeout(connectWA, 3000);
    }
  });

  sock.ev.on('contacts.update', async (updates) => {
    for (const contact of updates) {
      if (contact.id) {
        await saveContact(contact.id, {
          name: contact.name || contact.notify, notify: contact.notify,
          verifiedName: contact.verifiedName, isMyContact: contact.isMyContact || false,
        });
      }
    }
    logger.info({ count: updates.length }, 'Contacts updated');
  });

   sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      if (!key?.id) continue;
      logger.warn({ id: key.id, status: update.status, jid: key.remoteJid }, '[STATUS] Message update');
      await sendToWebhooks({
        event:     'message_status',
        messageId: key.id,
        jid:       key.remoteJid,
        status:    update.status,
        timestamp: new Date().toISOString(),
        phoneId:   PHONE_ID,
      });
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const seen = new Set();
    for (const msg of messages) {
      if (!msg.message) continue;
      const msgId = msg.key.id;
      if (seen.has(msgId)) continue;
      seen.add(msgId);
      if (msg.message?.senderKeyDistributionMessage && !msg.message?.conversation && !msg.message?.extendedTextMessage) continue;
      if (msg.message?.protocolMessage) continue;

      if (!msg.key.fromMe) {
        const sender = msg.key.participant || msg.key.remoteJid;
        const senderPhone = msg.key.participantPn || msg.key.senderPn || sender;
        if (sender && !sender.includes('@g.us')) {
          await saveContact(senderPhone || sender, { name: msg.pushName, notify: msg.pushName, isMyContact: true });
        }
      }

      const parsed = parseMsg(msg);
      parsed.fromMe   = msg.key.fromMe || false;
      parsed.pushName = msg.pushName || null;

      // ✅ הוסף כאן — הורדה async בתוך async context
      if (parsed.type === 'image' || parsed.type === 'audio') {
        const mediaPath = await saveMedia(msg, parsed.messageId, parsed.data.mimeType);
        parsed.data.mediaPath = mediaPath;
        parsed.data.mediaUrl  = mediaPath ? `/media/${parsed.messageId}` : null;
      }


      await redisStreams.addMessage(parsed);
    
      // ✅ אחרי — fromMe נלקח מ-parsed.fromMe שנקבע נכון מה-msg.key.fromMe
      await sendToWebhooks({
        event:     'message',
        messageId: parsed.messageId,
        jid:       parsed.jid,
        type:      parsed.type,
        data:      { ...parsed.data, fromMe: parsed.fromMe, pushName: parsed.pushName, lid: parsed.sender },
        timestamp: parsed.timestamp,   // Unix epoch number — נשמר כבר ב-parsed
        phoneId:   PHONE_ID,
      });
    
      
     // await sendToWebhooks({
     //   event: 'message', messageId: parsed.messageId, jid: parsed.jid, type: parsed.type,
      //  data: { ...parsed.data, fromMe: parsed.fromMe, pushName: parsed.pushName, lid: parsed.sender },
     //   timestamp: parsed.timestamp,
   //   });
    }
  });
}

const app  = express();
const PORT = process.env.PORT || 3001;
app.use(express.json());

const normalizeJid = (raw) => raw.includes('@') ? raw : raw.replace(/\D/g, '') + '@s.whatsapp.net';

app.get('/status',  (_, res) => res.json({ status }));
app.get('/version', (_, res) => res.json({ version: APP_VERSION }));

app.get('/qrcode', (_, res) => {
  if (!qrCodeData) return res.status(404).json({ error: 'QR not available', status });
  res.json({ qr: qrCodeData, status });
});

app.get('/pairing-code', (_, res) => {        // ← כאן
  if (!pairingCodeData) return res.status(404).json({ error: 'Pairing code not available', status });
  res.json({ pairingCode: pairingCodeData, status });
});

app.post('/resend-auth', async (req, res) => {
  try {
    if (status !== 'connected') return res.status(400).json({ error: 'not connected', status });
    if (!fs.existsSync('/app/auth_info/creds.json')) return res.status(404).json({ error: 'creds.json not found' });
    const payload = buildAuthPayload();
    await sendToWebhooks(payload);
    res.json({ success: true, phone: payload.phone });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/send/text', async (req, res) => {
  try {
    logger.warn({ readyState: sock?.ws?.readyState, wsUser: sock?.user?.id }, '[DEBUG] Pre-send socket state');
    const jid = normalizeJid(req.body.jid);
    const r   = await sock.sendMessage(jid, { text: req.body.text });
    await notifyOutgoing(r?.key?.id, jid, 'text', {
      text: req.body.text,
      lid:  null,
    });
    res.json({ success: true, messageId: r?.key?.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


app.post('/send/buttons', async (req, res) => {
  try {
    const { jid: j, text, footer, buttons } = req.body;
    const jid = normalizeJid(j);
    const r   = await sock.sendMessage(jid, {
      text,
      footer:     footer || '',
      buttons:    buttons.map((b, i) => ({
        buttonId:   b.id || `btn_${i}`,
        buttonText: { displayText: b.text },
        type: 1,
      })),
      headerType: 1,
    });
    await notifyOutgoing(r?.key?.id, jid, 'buttons', {
      text,
      footer:  footer || null,
      buttons: buttons.map((b, i) => ({
        buttonId: b.id || `btn_${i}`,
        label:    b.text,
      })),
      lid: null,
    });
    res.json({ success: true, messageId: r?.key?.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


app.post('/send/list', async (req, res) => {
  try {
    const { jid: j, text, title, buttonText, footer, sections } = req.body;
    const jid = normalizeJid(j);                          // ← שמור ב-variable כי צריך פעמיים
    const r = await sock.sendMessage(jid, {
      text, title: title || '', footer: footer || '', buttonText: buttonText || 'בחר אפשרות',
      sections: sections.map(s => ({
        title: s.title,
        rows: s.rows.map((row, i) => ({ title: row.title, description: row.description || '', rowId: row.id || `row_${i}` })),
      })),
    });
    // ← זה כל מה שנוסף:
    await notifyOutgoing(r?.key?.id, jid, 'list_message', {
      title, description: text, buttonText: buttonText || 'בחר אפשרות',
      footer: footer || null, sections, lid: null,
    });
    res.json({ success: true, messageId: r?.key?.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── /send/button-response ─────────────────────────────────────────────────────
app.post('/send/button-response', async (req, res) => {
  try {
    const { jid: j, buttonId, displayText } = req.body;
    const jid = normalizeJid(j);
    const r   = await sock.sendMessage(jid, { text: displayText || buttonId });
    await notifyOutgoing(r?.key?.id, jid, 'button_response', {
      buttonId,
      displayText: displayText || null,
      lid: null,
    });
    res.json({ success: true, messageId: r?.key?.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── /send/list-response ───────────────────────────────────────────────────────
app.post('/send/list-response', async (req, res) => {
  try {
    const { jid: j, rowId, title } = req.body;
    const jid = normalizeJid(j);
    const r   = await sock.sendMessage(jid, { text: title || rowId });
    await notifyOutgoing(r?.key?.id, jid, 'list_response', {
      rowId,
      title: title || null,
      lid:   null,
    });
    res.json({ success: true, messageId: r?.key?.id, note: 'Sent as text' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── הוסף ב-index.js לפני app.listen ──────────────────────────────────────────

app.post('/webhooks/register', async (req, res) => {
  const { url, secret } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  const success = await redisStreams.registerWebhook(url, secret);
  res.json({ success, url, key: `webhooks:${PHONE_ID}` });
});

app.delete('/webhooks/unregister', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  res.json({ success: await redisStreams.unregisterWebhook(url) });
});

app.get('/webhooks', async (req, res) => {
  const webhooks = await redisStreams.listWebhooks();
  res.json({ webhooks, count: webhooks.length });
});

app.get('/messages/stream/info',  async (req, res) => res.json(await redisStreams.getStreamInfo()));
app.get('/messages/stream/read',  async (req, res) => {
  const messages = await redisStreams.readMessages(parseInt(req.query.count || '10'), req.query.lastId || '0');
  res.json({ messages, count: messages.length });
});
app.get('/messages/trace/:jid',   async (req, res) => {
  const messages = await redisStreams.getConversationHistory(req.params.jid, parseInt(req.query.limit || '100'));
  res.json({ jid: req.params.jid, messages, count: messages.length });
});

app.get('/contacts', async (req, res) => {
  const items = await getContacts(req.query.q || '', parseInt(req.query.limit || '200'));
  res.json({ count: items.length, items });
});

app.get('/debug/contacts-count', async (req, res) => {
  const all = await loadContacts();
  res.json({ count: Object.keys(all).length });
});
app.post('/pairing-code/refresh', async (req, res) => {
    try {
        if (!sock || !PHONE_NUMBER) {
            return res.status(400).json({ error: 'socket not ready' });
        }

        // ← כאן, מיד אחרי בדיקת ה-socket
        if (sock.authState.creds.registered) {
            return res.status(400).json({ error: 'already registered', status: 'connected' });
        }

        // אפס את ה-guard וה-state
        pairingRequested = false;
        pairingCodeData  = null;

        const cleanNumber = PHONE_NUMBER.replace(/\D/g, '');
        const code = await sock.requestPairingCode(cleanNumber);
        pairingCodeData  = code;
        pairingRequested = true;
        status = 'pairing_ready';

        logger.info({ code }, '[PAIRING] Refreshed code');

        await sendToWebhooks({
            event: 'pairing_code',
            pairingCode: code,
            timestamp: new Date().toISOString(),
            phoneId: PHONE_ID,
        });

        res.json({ pairingCode: code, status: 'pairing_ready' });
    } catch (err) {
        logger.warn({ err: err.message }, '[PAIRING] Refresh failed');
        res.status(500).json({ error: err.message });
    }
});

app.delete('/logout', async (_, res) => {
  try { await sock.logout(); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  logger.info(`Baileys service on :${PORT}`);
  connectWA();
});
