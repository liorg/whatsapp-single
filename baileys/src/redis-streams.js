import Redis from 'ioredis';
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const PHONE_ID    = process.env.PHONE_ID || 'default';

// ✅ שם אחיד — WEBHOOK_KEY בלי S
const WEBHOOK_KEY  = `webhooks:${PHONE_ID}`;
const STREAM_KEY   = `whatsapp:messages:${PHONE_ID}`;
const MAX_STREAM_LENGTH = parseInt(process.env.MAX_STREAM_LENGTH || '10000');

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
    const id = await this.redis.xadd(
      STREAM_KEY,
      'MAXLEN', '~', MAX_STREAM_LENGTH,
      '*',
      'data', JSON.stringify(msg)
    );
    logger.debug({ id, jid: msg.jid }, 'Message added to stream');
    return id;
  }

  // ── Send to registered webhooks ───────────────────────────────────────────
  async sendToWebhooks(payload) {
    try {
      // ✅ תוקן: WEBHOOK_KEY (בלי S)
      const webhooks = await this.redis.smembers(WEBHOOK_KEY);

      logger.info(
        { event: payload.event, phoneId: payload.phoneId, count: webhooks.length },
        '[WEBHOOK] Sending to webhooks'
      );

      if (webhooks.length === 0) {
        logger.warn('[WEBHOOK] No webhooks registered — nothing sent');
        return;
      }

      const promises = webhooks.map(async (webhookData) => {
        let url = '?';
        try {
          const parsed = JSON.parse(webhookData);
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
            signal: AbortSignal.timeout(10000)
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
  async registerWebhook(url, secret = null) {
    try {
        await this.unregisterWebhook(url);
      const data = JSON.stringify({ url, secret, registeredAt: new Date().toISOString() });
      // ✅ תוקן: WEBHOOK_KEY
      await this.redis.sadd(WEBHOOK_KEY, data);
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
      // ✅ תוקן: WEBHOOK_KEY
      const webhooks = await this.redis.smembers(WEBHOOK_KEY);
      const toRemove = webhooks.find(w => {
        try { return JSON.parse(w).url === url; }
        catch { return false; }
      });

      if (toRemove) {
        await this.redis.srem(WEBHOOK_KEY, toRemove);
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
      // ✅ תוקן: WEBHOOK_KEY
      const webhooks = await this.redis.smembers(WEBHOOK_KEY);
      return webhooks.map(w => {
        try {
          const parsed = JSON.parse(w);
          return { url: parsed.url, registeredAt: parsed.registeredAt };
        } catch { return null; }
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
    try {
      const info   = await this.redis.xinfo('STREAM', STREAM_KEY);
      const length = await this.redis.xlen(STREAM_KEY);
      return { length, firstEntry: info[6], lastEntry: info[8] };
    } catch (e) {
      return { length: 0, firstEntry: null, lastEntry: null };
    }
  }

  async ping() {
    try { await this.redis.ping(); return true; }
    catch { return false; }
  }

  // ── Get conversation history ──────────────────────────────────────────────
  async getConversationHistory(jid, limit = 100) {
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