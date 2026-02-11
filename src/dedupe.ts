// src/dedupe.ts
import RedisNS from 'ioredis';
import type { Redis as RedisClient } from 'ioredis';

const REDIS_URL = process.env.REDIS_URL?.trim() || '';
const DEDUPE_TTL_SECONDS = Number(process.env.DEDUPE_TTL_SECONDS || 7 * 24 * 3600);

// ---------- In-memory fallback ----------
type MemEntry = { expiresAt: number };
const mem = new Map<string, MemEntry>();

function memHas(key: string): boolean {
  const it = mem.get(key);
  if (!it) return false;
  if (Date.now() > it.expiresAt) {
    mem.delete(key);
    return false;
  }
  return true;
}
function memSet(key: string, ttlSeconds: number) {
  mem.set(key, { expiresAt: Date.now() + ttlSeconds * 1000 });
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of mem.entries()) if (now > v.expiresAt) mem.delete(k);
}, 60_000).unref();

// ---------- Redis (optional) ----------
// ioredis у деяких сетапах експортується як default, у деяких — як module object.
// Тому беремо конструктор максимально сумісно:
const RedisCtor = (RedisNS as unknown as { default?: any }).default ?? (RedisNS as unknown as any);

let redis: RedisClient | null = null;
let redisHealthy = false;

if (REDIS_URL) {
  redis = new RedisCtor(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
  }) as RedisClient;

  redis.on('error', (err: unknown) => {
    redisHealthy = false;
    console.error('[redis] error:', (err as any)?.message ?? err);
  });

  redis.on('connect', () => {
    redisHealthy = true;
    console.log('[redis] connected');
  });

  redis.on('close', () => {
    redisHealthy = false;
    console.log('[redis] connection closed');
  });

  redis.connect().catch((e: unknown) => {
    redisHealthy = false;
    console.error('[redis] initial connect failed:', (e as any)?.message ?? e);
  });
}

export async function isDuplicate(key: string): Promise<boolean> {
  if (!key) return false;

  if (!redis || !redisHealthy) return memHas(key);

  try {
    const exists = await redis.get(key);
    return Boolean(exists);
  } catch {
    redisHealthy = false;
    return memHas(key);
  }
}

export async function markDuplicate(key: string, ttlSeconds = DEDUPE_TTL_SECONDS): Promise<void> {
  if (!key) return;

  memSet(key, ttlSeconds);
  if (!redis || !redisHealthy) return;

  try {
    await redis.set(key, '1', 'EX', ttlSeconds);
  } catch {
    redisHealthy = false;
  }
}
