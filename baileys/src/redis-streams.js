import Redis from 'ioredis';
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// 'default' היה המצב הגרוע: PHONE_ID חסר → **כל** הטלפונים חולקים את
// webhooks:default, וכל אחד שולח לכל ה-webhooks של כולם. עדיף להיכשל רועש.
const PHONE_ID = process.env.PHONE_ID;
if (!PHONE_ID) {
  logger.error('PHONE_ID is not set — refusing to share one webhook key across phones');
}

// ✅ שם אחיד — WEBHOOK_KEY בלי S.
// אותו מפתח ואותו מבנה רשומה שבהם משתמש whatsapp-cloudapi: חנות אחת לשני
// הספקים, ולכן גם התנהגות אחת אחרי restart.
const WEBHOOK_KEY  = PHONE_ID ? `webhooks:${PHONE_ID}` : null;

// הנרמול הוא תנאי לדה-דופליקציה: בלעדיו `…/abc` ו-`…/abc/` הן שתי רשומות
// נפרדות ב-SET, ו-srem לפי אחת לא מוציא את השנייה — וההודעה נשלחת פעמיים.
const normUrl = (u) => String(u || '').trim().replace(/\/+$/, '');

// ה-stream נשאר על שם הטלפון. 'default' הוחלף ב-'unset' כדי שלא ייראה
// כמפתח תקין בלוג — הקונטיינר שבור בכל מקרה כש-PHONE_ID חסר.
const STREAM_KEY   = `whatsapp:messages:${PHONE_ID || 'unset'}`;

// ── אחסון ההודעות: כבוי כברירת מחדל ────────────────────────────────────────
// ה-stream הזה הוא **עותק שני** של כל הודעה נכנסת, ושום דבר לא קורא אותו:
// המסלול החי הוא sendToWebhooks → Manager → טבלת messages ב-Postgres. רק
// שלושה endpoints לדיאגנוזה נגעו בו, ואף אחד מהם לא נקרא מה-Manager.
//
// והוא יושב באותו redis_shared שמחזיק עכשיו את webhooks:{PHONE_ID} — שהוא
// load-bearing. 10,000 הודעות × ~1KB × מספר הטלפונים, בקונטיינר שמוגבל
// ל-256MB בלי maxmemory policy, פירושו OOM-kill של Redis. לא איבוד היסטוריה:
// נפילה של החנות שבה יושב הרישום של **כל** הטלפונים.
//
// STREAM_MESSAGES=1 מחזיר אותו, חסום בשלוש דרכים: אורך, גיל, ו-TTL.
const STREAM_MESSAGES   = process.env.STREAM_MESSAGES === '1';
const MAX_STREAM_LENGTH = parseInt(process.env.MAX_STREAM_LENGTH || '1000');
const STREAM_TTL_HOURS  = parseInt(process.env.STREAM_TTL_HOURS  || '24');

class RedisStreams {
  constructor() {
    this.redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: null,
      retryStrategy: (times) => Math.min(times * 500, 5000)
    });

    this.redis.on('error',   (e) => logger.error(e, 'Redis error'));
    this.redis.on('connect', ()  => logger.info('Redis Streams connected'));
  }

  // ── Add message to stream ─────────────────────────────────────────────────
  async addMessage(msg) {
    if (!STREAM_MESSAGES) return null;     // ברירת המחדל. ההודעה כבר בדרך
                                           // ל-Manager דרך ה-webhook.
    const id = await this.redis.xadd(
      STREAM_KEY,
      'MAXLEN', '~', MAX_STREAM_LENGTH,
      '*',
      'data', JSON.stringify(msg)
    );

    // MAXLEN לבד לא מספיק: טלפון שקט מחזיק 1000 הודעות לנצח, וסכום הטלפונים
    // הוא מה שמפיל את Redis. MINID מוחק לפי **גיל**, ולכן הזיכרון מתנקז מעצמו.
    if (STREAM_TTL_HOURS > 0) {
      const cutoff = Date.now() - STREAM_TTL_HOURS * 3600_000;
      try {
        await this.redis.xtrim(STREAM_KEY, 'MINID', '~', `${cutoff}-0`);
        // ה-TTL הוא גם מה שמגן על ה-webhooks: ב-maxmemory-policy volatile-lru
        // נמחקים רק מפתחות עם TTL, ולמפתח ה-webhooks אין. כלומר Redis תחת
        // לחץ זורק היסטוריית הודעות, ולעולם לא את הרישום.
        await this.redis.expire(STREAM_KEY, STREAM_TTL_HOURS * 3600);
      } catch (e) {
        logger.warn({ err: e.message }, 'stream trim failed');
      }
    }

    logger.debug({ id, jid: msg.jid }, 'Message added to stream');
    return id;
  }

  // ── Read records, collapsed by url ────────────────────────────────────────
  // דה-דופליקציה גם בקריאה, לא רק בכתיבה. הכתיבה עושה srem-ואז-sadd, אבל
  // כפילות יכולה להיות ב-SET עוד לפני שהגענו: רשומות שנכתבו לפני הנרמול,
  // או שתי כתיבות במקביל. בלי הכיווץ הזה כפילות קיימת = שליחה כפולה.
  async getWebhookRecords() {
    if (!WEBHOOK_KEY) return [];
    const members = await this.redis.smembers(WEBHOOK_KEY);
    const byUrl   = new Map();

    for (const raw of members) {
      let rec;
      try { rec = JSON.parse(raw); } catch { continue; }
      const url = normUrl(rec.url);
      if (!url) continue;

      const prev = byUrl.get(url);
      // מנצח ה-registeredAt החדש. ISO-8601 ב-UTC משתווה נכון כמחרוזת.
      if (!prev || String(rec.registeredAt || '') >= String(prev.registeredAt || '')) {
        byUrl.set(url, { url, secret: rec.secret, registeredAt: rec.registeredAt });
      }
    }
    return [...byUrl.values()];
  }

  // ── Send to registered webhooks ───────────────────────────────────────────
  async sendToWebhooks(payload) {
    try {
      const webhooks = await this.getWebhookRecords();

      logger.info(
        { event: payload.event, phoneId: payload.phoneId, count: webhooks.length },
        '[WEBHOOK] Sending to webhooks'
      );

      if (webhooks.length === 0) {
        logger.warn('[WEBHOOK] No webhooks registered — nothing sent');
        return;
      }

      const promises = webhooks.map(async (parsed) => {
        let url = '?';
        try {
          url = parsed.url;
          const secret = parsed.secret;

          const response = await fetch(url, {
            method:  'POST',
            headers: {
              'Content-Type':     'application/json',
              'X-Webhook-Secret': secret || '',
              'User-Agent':       'WhatsApp-Baileys/1.0'
            },
            body:   JSON.stringify(payload),
            signal: AbortSignal.timeout(30000)
          });

          if (!response.ok) {
            logger.warn({ url, status: response.status }, '[WEBHOOK] Remote returned error');
          } else {
            logger.info({ url, event: payload.event }, '[WEBHOOK] ✓ Sent OK');
          }
        } catch (e) {
          logger.error({ err: e.message, url }, '[WEBHOOK] Send failed');
        }
      });

      await Promise.allSettled(promises);
    } catch (e) {
      logger.error({ err: e.message }, '[WEBHOOK] sendToWebhooks crashed');
    }
  }

  // ── Register webhook ──────────────────────────────────────────────────────
  // הזהות של רשומה היא phone_id (ב-מפתח) + url (ב-member). לכן srem לפי url
  // לפני sadd: אותו url עם registeredAt אחר הוא member שונה ב-SET, ובלי
  // ההסרה היינו מצטברים לרשומה נוספת בכל רישום מחדש.
  async registerWebhook(url, secret = null) {
    if (!WEBHOOK_KEY) {
      logger.error({ url }, 'Cannot register webhook — PHONE_ID is not set');
      return false;
    }
    try {
      url = normUrl(url);
      if (!url) return false;

      await this.unregisterWebhook(url);
      const data = JSON.stringify({ url, secret, registeredAt: new Date().toISOString() });
      await this.redis.sadd(WEBHOOK_KEY, data);
      logger.info({ url, key: WEBHOOK_KEY }, 'Webhook registered');
      return true;
    } catch (e) {
      logger.error({ err: e, url }, 'Failed to register webhook');
      return false;
    }
  }

  // ── Unregister webhook ────────────────────────────────────────────────────
  async unregisterWebhook(url) {
    if (!WEBHOOK_KEY) return false;
    try {
      url = normUrl(url);
      const webhooks = await this.redis.smembers(WEBHOOK_KEY);

      // **כל** הרשומות של ה-url הזה, לא רק הראשונה. אם ה-SET כבר מכיל
      // כפילות — וזה המצב שאנחנו באים לנקות — find היה משאיר את השנייה.
      const toRemove = webhooks.filter(w => {
        try { return normUrl(JSON.parse(w).url) === url; }
        catch { return false; }
      });

      if (toRemove.length > 0) {
        await this.redis.srem(WEBHOOK_KEY, ...toRemove);
        logger.info({ url, removed: toRemove.length }, 'Webhook unregistered');
        return true;
      }
      return false;
    } catch (e) {
      logger.error({ err: e, url }, 'Failed to unregister webhook');
      return false;
    }
  }

  // ── List webhooks ─────────────────────────────────────────────────────────
  async listWebhooks() {
    try {
      return (await this.getWebhookRecords())
        .map(({ url, registeredAt }) => ({ url, registeredAt }));
    } catch (e) {
      logger.error({ err: e }, 'Failed to list webhooks');
      return [];
    }
  }

  // ── Read messages from stream ─────────────────────────────────────────────
  // [] כש-STREAM_MESSAGES=0 אינו "אין הודעות" אלא "אין אחסון". מחזירים את זה
  // במפורש, כדי שקורא עתידי לא יפרש שקט כריק.
  async readMessages(count = 10, lastId = '0') {
    if (!STREAM_MESSAGES) return [];
    try {
      const results = await this.redis.xread(
        'COUNT', count,
        'STREAMS', STREAM_KEY, lastId
      );

      if (!results || results.length === 0) return [];

      return results[0][1].map(([id, fields]) => {
        try { return { id, ...JSON.parse(fields[1]) }; }
        catch { return null; }
      }).filter(Boolean);
    } catch (e) {
      logger.error({ err: e }, 'Failed to read from stream');
      return [];
    }
  }

  // ── Get stream info ───────────────────────────────────────────────────────
  async getStreamInfo() {
    if (!STREAM_MESSAGES) {
      return { enabled: false, length: 0, firstEntry: null, lastEntry: null,
               note: 'STREAM_MESSAGES=0 — messages go to the Manager webhook only' };
    }
    try {
      const info   = await this.redis.xinfo('STREAM', STREAM_KEY);
      const length = await this.redis.xlen(STREAM_KEY);
      return { enabled: true, length, maxLen: MAX_STREAM_LENGTH,
               ttlHours: STREAM_TTL_HOURS, firstEntry: info[6], lastEntry: info[8] };
    } catch (e) {
      return { enabled: true, length: 0, firstEntry: null, lastEntry: null };
    }
  }

  async ping() {
    try { await this.redis.ping(); return true; }
    catch { return false; }
  }

  // ── Get conversation history ──────────────────────────────────────────────
  async getConversationHistory(jid, limit = 100) {
    if (!STREAM_MESSAGES) return [];
    try {
      const normalizedJid = jid.includes('@')
        ? jid
        : jid.replace(/\D/g, '') + '@s.whatsapp.net';

      const results = await this.redis.xrevrange(STREAM_KEY, '+', '-', 'COUNT', limit * 3);
      if (!results || results.length === 0) return [];

      return results
        .map(([id, fields]) => {
          try { return { id, ...JSON.parse(fields[1]) }; }
          catch { return null; }
        })
        .filter(Boolean)
        .filter(msg => msg.jid === normalizedJid || msg.sender === normalizedJid)
        .slice(0, limit);
    } catch (e) {
      logger.error({ err: e, jid }, 'Failed to get conversation history');
      return [];
    }
  }
}

export default RedisStreams;
