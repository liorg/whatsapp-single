import Redis from 'ioredis';
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const STREAM_KEY = process.env.REDIS_STREAM_KEY || 'whatsapp:messages';
const WEBHOOKS_KEY = 'whatsapp:webhooks';
const MAX_STREAM_LENGTH = parseInt(process.env.MAX_STREAM_LENGTH || '10000');

class RedisStreams {
  constructor() {
    this.redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: null,
      retryStrategy: (times) => Math.min(times * 500, 5000)
    });

    this.redis.on('error', (e) => logger.error(e, 'Redis error'));
    this.redis.on('connect', () => logger.info('Redis Streams connected'));
  }

  // ── Add message to stream ─────────────────────────────────────────────────
  async addMessage(msg) {
    try {
      const id = await this.redis.xadd(
        STREAM_KEY,
        'MAXLEN', '~', MAX_STREAM_LENGTH,
        '*',
        'data', JSON.stringify(msg)
      );
      
      logger.debug({ id, jid: msg.jid }, 'Message added to stream');
      
      // שלח ל-webhooks אם רשומים
      await this.sendToWebhooks(msg);
      
      return id;
    } catch (e) {
      logger.error({ err: e }, 'Failed to add message to stream');
      throw e;
    }
  }

  // ── Send to registered webhooks ───────────────────────────────────────────
  async sendToWebhooks(msg) {
    try {
      // ✅ שלח רק הודעות נכנסות (לא שלי)
      if (msg.fromMe) {
        logger.debug({ jid: msg.jid }, 'Skipping webhook for outgoing message');
        return;
      }
      
      const webhooks = await this.redis.smembers(WEBHOOKS_KEY);
      
      if (webhooks.length === 0) return;

      const promises = webhooks.map(async (webhookData) => {
        try {
          const { url, secret } = JSON.parse(webhookData);
          
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Webhook-Secret': secret || '',
              'User-Agent': 'WhatsApp-Baileys/1.0'
            },
            body: JSON.stringify(msg),
            signal: AbortSignal.timeout(10000) // 10s timeout
          });

          if (!response.ok) {
            logger.warn({ url, status: response.status }, 'Webhook failed');
          } else {
            logger.debug({ url }, 'Webhook sent successfully');
          }
        } catch (e) {
          logger.error({ err: e, url: webhookData }, 'Webhook send error');
        }
      });

      await Promise.allSettled(promises);
    } catch (e) {
      logger.error({ err: e }, 'Failed to send webhooks');
    }
  }

  // ── Register webhook ──────────────────────────────────────────────────────
  async registerWebhook(url, secret = null) {
    try {
      const data = JSON.stringify({ url, secret, registeredAt: new Date().toISOString() });
      await this.redis.sadd(WEBHOOKS_KEY, data);
      logger.info({ url }, 'Webhook registered');
      return true;
    } catch (e) {
      logger.error({ err: e, url }, 'Failed to register webhook');
      return false;
    }
  }

  // ── Unregister webhook ────────────────────────────────────────────────────
  async unregisterWebhook(url) {
    try {
      const webhooks = await this.redis.smembers(WEBHOOKS_KEY);
      const toRemove = webhooks.find(w => {
        try {
          return JSON.parse(w).url === url;
        } catch {
          return false;
        }
      });

      if (toRemove) {
        await this.redis.srem(WEBHOOKS_KEY, toRemove);
        logger.info({ url }, 'Webhook unregistered');
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
      const webhooks = await this.redis.smembers(WEBHOOKS_KEY);
      return webhooks.map(w => {
        try {
          const parsed = JSON.parse(w);
          return { url: parsed.url, registeredAt: parsed.registeredAt };
        } catch {
          return null;
        }
      }).filter(Boolean);
    } catch (e) {
      logger.error({ err: e }, 'Failed to list webhooks');
      return [];
    }
  }

  // ── Read messages from stream ─────────────────────────────────────────────
  async readMessages(count = 10, lastId = '0') {
    try {
      const results = await this.redis.xread(
        'COUNT', count,
        'STREAMS', STREAM_KEY, lastId
      );

      if (!results || results.length === 0) return [];

      const messages = results[0][1].map(([id, fields]) => {
        try {
          const data = JSON.parse(fields[1]); // fields[0] is 'data', fields[1] is the value
          return { id, ...data };
        } catch {
          return null;
        }
      }).filter(Boolean);

      return messages;
    } catch (e) {
      logger.error({ err: e }, 'Failed to read from stream');
      return [];
    }
  }

  // ── Get stream info ───────────────────────────────────────────────────────
  async getStreamInfo() {
    try {
      const info = await this.redis.xinfo('STREAM', STREAM_KEY);
      const length = await this.redis.xlen(STREAM_KEY);
      
      return {
        length,
        firstEntry: info[6],
        lastEntry: info[8]
      };
    } catch (e) {
      return { length: 0, firstEntry: null, lastEntry: null };
    }
  }

  async ping() {
    try {
      await this.redis.ping();
      return true;
    } catch {
      return false;
    }
  }

  // ── Get conversation history ─────────────────────────────────────────────────
  async getConversationHistory(jid, limit = 100) {
    try {
      // נרמל JID
      const normalizedJid = jid.includes('@') ? jid : jid.replace(/\D/g,'') + '@s.whatsapp.net';
      
      // קרא את כל ההודעות מה-stream
      const results = await this.redis.xrevrange(STREAM_KEY, '+', '-', 'COUNT', limit * 3);
      
      if (!results || results.length === 0) return [];

      const messages = results
        .map(([id, fields]) => {
          try {
            const data = JSON.parse(fields[1]);
            return { id, ...data };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        // סינון לפי JID (שולח או מקבל)
        .filter(msg => {
          // הודעות שהתקבלו מה-JID הזה
          if (msg.jid === normalizedJid || msg.sender === normalizedJid) return true;
          
          // הודעות ששלחנו ל-JID הזה (צריך לבדוק metadata)
          // כרגע רק הודעות נכנסות מסומנות, אז נחפש לפי JID בלבד
          return false;
        })
        .slice(0, limit);

      return messages;
    } catch (e) {
      logger.error({ err: e, jid }, 'Failed to get conversation history');
      return [];
    }
  }
}

export default RedisStreams;
