// Dedup keys survive restarts via Redis (shared across the webhook path AND the poller),
// so a restart / overlapping scan can never re-post an already-handled event.
// Falls back to an in-memory map when Redis is unavailable.
// Only touched on actual matches (rare), so Upstash command cost is negligible.
import { getRedis } from './store/redis.js';

const TTL_SEC = 7 * 24 * 3600;

// ---- in-memory fallback ----
const seen = new Map<string, number>(); // key -> expiresAtMs
const TTL_MS = TTL_SEC * 1000;
function memIsDup(key: string): boolean {
  const exp = seen.get(key);
  if (!exp) return false;
  if (exp < Date.now()) {
    seen.delete(key);
    return false;
  }
  return true;
}
function memMark(key: string): void {
  const now = Date.now();
  seen.set(key, now + TTL_MS);
  if (seen.size > 5000) {
    for (const [k, exp] of seen) if (exp < now) seen.delete(k);
  }
}

export async function isDuplicate(key: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return memIsDup(key);
  try {
    return (await redis.exists(`tge:dedup:${key}`)) === 1;
  } catch (err: any) {
    console.error('[dedupe] isDuplicate redis error, falling back:', err?.message || err);
    return memIsDup(key);
  }
}

export async function markDuplicate(key: string): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    memMark(key);
    return;
  }
  try {
    await redis.set(`tge:dedup:${key}`, '1', 'EX', TTL_SEC);
  } catch (err: any) {
    console.error('[dedupe] markDuplicate redis error, falling back:', err?.message || err);
    memMark(key);
  }
}
