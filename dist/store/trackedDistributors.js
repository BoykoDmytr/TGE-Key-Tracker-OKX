// src/store/trackedDistributors.ts
import { getRedis } from './redis.js';
// Key:   tge:tracked:{chain}:{lowercaseAddress}
// Value: JSON TrackedInfo
// TTL:   120 days
const TTL_SECONDS = 120 * 24 * 3600;
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
