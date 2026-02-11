import * as RedisNS from 'ioredis';

const redisUrl = process.env.REDIS_URL || '';
const Redis = (RedisNS as any).default ?? (RedisNS as any);
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

/**
 * Check if a key has already been processed. Uses Redis if available, otherwise always false.
 */
export async function isDuplicate(key: string): Promise<boolean> {
  if (!redis) return false;
  const exists = await redis.get(key);
  return Boolean(exists);
}

/**
 * Mark a key as processed for deduplication. Expiration defaults to 7 days.
 */
export async function markDuplicate(key: string): Promise<void> {
  if (!redis) return;
  await redis.set(key, '1', 'EX', 7 * 24 * 3600);
}