// src/poller/cursor.ts
// Persisted lastScannedBlock per chain. This is THE guard against missed blocks:
// after any restart the poller resumes exactly where it left off, so a single
// crash / RPC blip can never silently drop a setTime (the Tenderly failure mode).
import { getRedis } from '../store/redis.js';
function key(chain) {
    return `tge:poller:cursor:${chain}`;
}
/**
 * null means "genuinely no cursor stored" and NOTHING else.
 *
 * We never collapse a Redis error into null here. The caller treats null as first run
 * and seeds the cursor at the chain head — so a Redis blip during a restart used to
 * skip every block between the real cursor and the head, permanently and silently.
 * A thrown error reaches the supervisor instead, which retries with backoff.
 */
export async function getCursor(chain) {
    const redis = getRedis();
    if (!redis)
        return null; // no REDIS_URL configured at all
    const v = await redis.get(key(chain)); // a Redis failure PROPAGATES on purpose
    return v != null ? Number(v) : null; // key absent -> genuine first run
}
export async function setCursor(chain, block) {
    const redis = getRedis();
    if (!redis)
        return;
    try {
        await redis.set(key(chain), String(block));
    }
    catch (err) {
        console.error('[cursor] set failed:', err?.message || err);
    }
}
