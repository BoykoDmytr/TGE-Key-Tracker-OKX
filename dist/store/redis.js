// src/store/redis.ts
import { Redis } from 'ioredis';
let client = null;
let warnedMissing = false;
// Lazy singleton. Returns null when REDIS_URL is not configured so that
// callers can degrade gracefully instead of crashing the whole bot.
export function getRedis() {
    if (client)
        return client;
    const url = process.env.REDIS_URL;
    if (!url) {
        if (!warnedMissing) {
            warnedMissing = true;
            console.warn('[redis] REDIS_URL is not set — persistent store disabled (setTime allowlist will not work)');
        }
        return null;
    }
    // ioredis enables TLS automatically for rediss:// URLs (e.g. Upstash).
    client = new Redis(url, {
        maxRetriesPerRequest: 3,
        lazyConnect: false,
    });
    client.on('error', (err) => {
        console.error('[redis] connection error:', err?.message || err);
    });
    client.on('connect', () => {
        console.log('[redis] connected');
    });
    return client;
}
