// Dedup keys survive restarts via Redis (shared across the webhook path AND the poller),
// so a restart / overlapping scan can never re-post an already-handled event.
// Falls back to an in-memory map when Redis is unavailable.
// Only touched on actual matches (rare), so Upstash command cost is negligible.
import { getRedis } from './store/redis.js';
const TTL_SEC = 7 * 24 * 3600;
// ---- in-memory fallback ----
const seen = new Map(); // key -> expiresAtMs
const TTL_MS = TTL_SEC * 1000;
function memIsDup(key) {
    const exp = seen.get(key);
    if (!exp)
        return false;
    if (exp < Date.now()) {
        seen.delete(key);
        return false;
    }
    return true;
}
// ttlSec is honoured here too. It used to be ignored in favour of the 7-day constant,
// which silently turned the poller's 6h lag-alert cooldown into a 7-day one on any
// machine running without Redis — the alert would fire once and then go quiet for a week.
function memMark(key, ttlSec = TTL_SEC) {
    const now = Date.now();
    seen.set(key, now + ttlSec * 1000);
    if (seen.size > 5000) {
        for (const [k, exp] of seen)
            if (exp < now)
                seen.delete(k);
    }
}
/**
 * Atomically claim the right to send exactly one message for `key`.
 * Returns true only for the caller that won the claim.
 *
 * ALWAYS claim BEFORE sending, never after. The old order (send -> mark) meant a crash,
 * a 429, or a restart between the two re-sent the message. A claim means "attempted
 * exactly once" — it is deliberately NOT released on send failure, because re-posting
 * after a rate-limit is precisely what turned the 2026-08-05 incident into a flood.
 */
export async function claimOnce(key, ttlSec = TTL_SEC) {
    const redis = getRedis();
    if (!redis) {
        // In-memory fallback: single instance only, lost on restart. Loud on purpose —
        // without Redis the "exactly once" guarantee does not survive a restart.
        console.warn('[dedupe] NO REDIS — claim is in-memory only, not restart-safe:', key);
        if (memIsDup(key))
            return false;
        memMark(key, ttlSec);
        return true;
    }
    try {
        const res = await redis.set(`tge:dedup:${key}`, '1', 'EX', ttlSec, 'NX');
        return res === 'OK';
    }
    catch (err) {
        console.error('[dedupe] claimOnce redis error, falling back to memory:', err?.message || err);
        if (memIsDup(key))
            return false;
        memMark(key, ttlSec);
        return true;
    }
}
export async function isDuplicate(key) {
    const redis = getRedis();
    if (!redis)
        return memIsDup(key);
    try {
        return (await redis.exists(`tge:dedup:${key}`)) === 1;
    }
    catch (err) {
        console.error('[dedupe] isDuplicate redis error, falling back:', err?.message || err);
        return memIsDup(key);
    }
}
export async function markDuplicate(key) {
    const redis = getRedis();
    if (!redis) {
        memMark(key);
        return;
    }
    try {
        await redis.set(`tge:dedup:${key}`, '1', 'EX', TTL_SEC);
    }
    catch (err) {
        console.error('[dedupe] markDuplicate redis error, falling back:', err?.message || err);
        memMark(key);
    }
}
/**
 * Drop a claim before its TTL expires.
 *
 * ONLY for cooldown-style keys such as pollerlag:<chain>, where the claim means "the
 * owner has already been told about THIS episode". Never call it on a message dedupe
 * key: there a claim means "attempted exactly once", and releasing it is precisely how
 * a re-post gets back into the channel.
 */
export async function releaseClaim(key) {
    seen.delete(key);
    const redis = getRedis();
    if (!redis)
        return;
    try {
        await redis.del(`tge:dedup:${key}`);
    }
    catch (err) {
        console.error('[dedupe] releaseClaim redis error:', err?.message || err);
    }
}
