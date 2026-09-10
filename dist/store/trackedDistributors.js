// src/store/trackedDistributors.ts
import { getRedis } from './redis.js';
// Key:   tge:tracked:{chain}:{lowercaseAddress}
// Value: JSON TrackedInfo
// TTL:   120 days
const TTL_SECONDS = 120 * 24 * 3600;
/** Records with no verdict pre-date the filter and were already posted, so their setTime
 *  must keep posting. Absent === 'legit', deliberately. */
export function trackedVerdict(info) {
    if (!info)
        return 'legit';
    return info.verdict ?? 'legit';
}
function key(chain, address) {
    return `tge:tracked:${chain}:${address.toLowerCase()}`;
}
export async function addTracked(chain, address, info) {
    const redis = getRedis();
    if (!redis)
        return;
    try {
        await redis.set(key(chain, address), JSON.stringify(info), 'EX', TTL_SECONDS);
    }
    catch (err) {
        console.error('[trackedDistributors] addTracked failed:', err?.message || err);
    }
}
export async function getTracked(chain, address) {
    const redis = getRedis();
    if (!redis)
        return null;
    try {
        const raw = await redis.get(key(chain, address));
        if (!raw)
            return null;
        return JSON.parse(raw);
    }
    catch (err) {
        console.error('[trackedDistributors] getTracked failed:', err?.message || err);
        return null;
    }
}
/**
 * Promote a tracked distributor to verdict=legit.
 *
 * Called when the owner approves a withheld deposit. Without this the deposit is
 * published but the record still says 'unsure', so the distributor's later setTime is
 * withheld too and has to be approved a second time — which is exactly what happened
 * with the 300,000 USDC campaign on 2026-09-07.
 *
 * Only ever upgrades. A verdict is never downgraded here.
 */
export async function markTrackedLegit(chain, address) {
    const redis = getRedis();
    if (!redis)
        return false;
    try {
        const raw = await redis.get(key(chain, address));
        if (!raw)
            return false;
        const info = JSON.parse(raw);
        if (info.verdict === 'legit')
            return true;
        info.verdict = 'legit';
        info.verdictRule = 'owner-approved';
        const ttl = await redis.ttl(key(chain, address));
        await redis.set(key(chain, address), JSON.stringify(info), 'EX', ttl > 0 ? ttl : TTL_SECONDS);
        return true;
    }
    catch (err) {
        console.error('[trackedDistributors] markTrackedLegit failed:', err?.message || err);
        return false;
    }
}
