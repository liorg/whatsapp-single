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
import RedisStreams from './redis-streams.js';

// ── Silence noisy Baileys logs ────────────────────────────────────────────────
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

// ── Redis Streams ─────────────────────────────────────────────────────────────
const redisStreams = new RedisStreams();

// ── Contacts Storage ──────────────────────────────────────────────────────────
const CONTACTS_FILE = '/app/data/contacts.json';

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
  } catch (e) {
    logger.error({ err: e }, 'Failed to load contacts');
  }
  return {};
}

async function saveContact(jid, data) {
  try {
    const normalized = normalizeContactJid(jid);
    if (!normalized) return;
    
    const contacts = await loadContacts();
    contacts[normalized] = {
      ...data,
      originalJid: jid,
      lastSeen: new Date().toISOString()
    };
    
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2));
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

// ── WhatsApp State ────────────────────────────────────────────────────────────
let sock       = null;
let qrCodeData = null;
let status     = 'disconnected';

// ── Message Parser ────────────────────────────────────────────────────────────
function unwrapMessage(message) {
  if (!message) return null;
  if (message.ephemeralMessage?.message) return unwrapMessage(message.ephemeralMessage.message);
  if (message.viewOnceMessageV2?.message) return unwrapMessage(message.viewOnceMessageV2.message);
  if (message.viewOnceMessage?.message) return unwrapMessage(message.viewOnceMessage.message);
  return message;
}

function parseMsg(msg) {
  const jid = msg.key.remoteJid;
  const isGroup = jid?.endsWith("@g.us");
  const sender = isGroup ? msg.key.participant : jid;
  const c = unwrapMessage(msg.message);

  let type = "unknown";
  let data = {};

  if (c?.conversation || c?.extendedTextMessage) {
    type = "text";
    data = { text: c.conversation || c.extendedTextMessage?.text };
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
  } else if (c?.buttonsResponseMessage) {
    type = "button_response";
    data = {
      buttonId: c.buttonsResponseMessage.selectedButtonId || null,
      displayText: c.buttonsResponseMessage.selectedDisplayText || null,
    };
  } else if (c?.listMessage) {
    type = "list_message";
    const sections = c.listMessage.sections || [];
    data = {
      title: c.listMessage.title || null,
      description: c.listMessage.description || null,
      buttonText: c.listMessage.buttonText || null,
      sections: sections.map((s, si) => ({
        index: si,
        title: s?.title || null,
        rows: (s?.rows || []).map((r, ri) => ({
          index: ri,
          rowId: r?.rowId || null,
          title: r?.title || null,
          description: r?.description || null,
        })),
      })),
    };
  } else if (c?.listResponseMessage) {
    type = "list_response";
    data = {
      rowId: c.listResponseMessage.singleSelectReply?.selectedRowId || null,
      title: c.listResponseMessage.title || null,
    };
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
      responseId: parsed?.id || parsed?.selectedId || null,
      bodyText: ir?.body?.text || null,
      rawParams: paramsJson || null,
    };
  } else if (c?.templateButtonReplyMessage) {
    type = "template_button_response";
    data = {
      selectedId: c.templateButtonReplyMessage.selectedId || null,
      displayText: c.templateButtonReplyMessage.selectedDisplayText || null,
    };
  } else if (c?.reactionMessage) {
    type = "reaction";
    data = { emoji: c.reactionMessage.text || null };
  } else if (c?.locationMessage) {
    type = "location";
    data = {
      lat: c.locationMessage.degreesLatitude,
      lng: c.locationMessage.degreesLongitude,
    };
  }

  if (type === "unknown") {
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

// ── Baileys ───────────────────────────────────────────────────────────────────
async function connectWA() {
  const { state, saveCreds } = await useMultiFileAuthState('/app/auth_info');
  const { version } = await fetchLatestBaileysVersion();

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

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrCodeData = qr;
      status = 'qr_ready';
      logger.info('QR ready');
    }
    if (connection === 'open') {
      qrCodeData = null;
      status = 'connected';
      logger.info('WhatsApp connected');
    }
    if (connection === 'close') {
      status = 'disconnected';
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const retry = code !== DisconnectReason.loggedOut;
      logger.warn({ code, retry }, 'Connection closed');
      if (retry) setTimeout(connectWA, 3000);
    }
  });

  sock.ev.on('contacts.update', async (updates) => {
    for (const contact of updates) {
      if (contact.id) {
        await saveContact(contact.id, {
          name: contact.name || contact.notify,
          notify: contact.notify,
          verifiedName: contact.verifiedName,
          isMyContact: contact.isMyContact || false,
        });
      }
    }
    logger.info({ count: updates.length }, 'Contacts updated');
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    
    const seen = new Set();
    
    for (const msg of messages) {
      // ✅ שמור גם הודעות שלי וגם הודעות נכנסות
      if (!msg.message) continue;
      
      const msgId = msg.key.id;
      if (seen.has(msgId)) continue;
      seen.add(msgId);
      
      // דלג על הודעות מערכת
      if (msg.message?.senderKeyDistributionMessage && 
          !msg.message?.conversation && 
          !msg.message?.extendedTextMessage) continue;

      // דלג על protocolMessage
      if (msg.message?.protocolMessage) continue;

      // שמור contact (רק להודעות נכנסות)
      if (!msg.key.fromMe) {
        const sender = msg.key.participant || msg.key.remoteJid;
        const senderPhone = msg.key.participantPn || msg.key.senderPn || sender;
        
        if (sender && !sender.includes('@g.us')) {
          await saveContact(senderPhone || sender, {
            name: msg.pushName,
            notify: msg.pushName,
            isMyContact: true
          });
        }
      }

      // הוסף ל-Redis Stream
      const parsed = parseMsg(msg);
      // ✅ סמן אם זו הודעה שלי או נכנסת
      parsed.fromMe = msg.key.fromMe || false;
      
      await redisStreams.addMessage(parsed);
    }
  });
}

// ── Express API ───────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3001;
app.use(express.json());

const normalizeJid = (raw) => raw.includes('@') ? raw : raw.replace(/\D/g,'') + '@s.whatsapp.net';

// Connection
app.get('/status', (_,res) => res.json({ status }));
app.get('/qrcode', (_,res) => {
  if (!qrCodeData) return res.status(404).json({ error: 'QR not available', status });
  res.json({ qr: qrCodeData, status });
});

// Send
app.post('/send/text', async (req, res) => {
  try {
    const r = await sock.sendMessage(normalizeJid(req.body.jid), { text: req.body.text });
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

// Webhooks
app.post('/webhooks/register', async (req, res) => {
  const { url, secret } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  const success = await redisStreams.registerWebhook(url, secret);
  res.json({ success });
});

app.delete('/webhooks/unregister', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  const success = await redisStreams.unregisterWebhook(url);
  res.json({ success });
});

app.get('/webhooks', async (req, res) => {
  const webhooks = await redisStreams.listWebhooks();
  res.json({ webhooks, count: webhooks.length });
});

// Messages Stream
app.get('/messages/stream/info', async (req, res) => {
  const info = await redisStreams.getStreamInfo();
  res.json(info);
});

app.get('/messages/stream/read', async (req, res) => {
  const count = parseInt(req.query.count || '10');
  const lastId = req.query.lastId || '0';
  const messages = await redisStreams.readMessages(count, lastId);
  res.json({ messages, count: messages.length });
});

// Conversation Trace
app.get('/messages/trace/:jid', async (req, res) => {
  const jid = req.params.jid;
  const limit = parseInt(req.query.limit || '100');
  const messages = await redisStreams.getConversationHistory(jid, limit);
  res.json({ jid, messages, count: messages.length });
});

// Contacts
app.get('/contacts', async (req, res) => {
  const q = req.query.q || '';
  const limit = parseInt(req.query.limit || '200');
  const items = await getContacts(q, limit);
  res.json({ count: items.length, items });
});

app.get('/debug/contacts-count', async (req, res) => {
  const all = await loadContacts();
  res.json({ count: Object.keys(all).length });
});

app.delete('/logout', async (_,res) => {
  try { await sock.logout(); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  logger.info(`Baileys service on :${PORT}`);
  connectWA();
});
