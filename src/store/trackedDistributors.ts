// src/store/trackedDistributors.ts
import { getRedis } from './redis.js';

// Key:   tge:tracked:{chain}:{lowercaseAddress}
// Value: JSON TrackedInfo
// TTL:   120 days
const TTL_SECONDS = 120 * 24 * 3600;

export interface TrackedInfo {
  depositTxHash: string;
  addedAt: number; // unix seconds
  tokenAddress: string;
  tokenSymbol: string;
  amountHuman: string;
}

function key(chain: string, address: string): string {
  return `tge:tracked:${chain}:${address.toLowerCase()}`;
}

export async function addTracked(chain: string, address: string, info: TrackedInfo): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(key(chain, address), JSON.stringify(info), 'EX', TTL_SECONDS);
  } catch (err: any) {
    console.error('[trackedDistributors] addTracked failed:', err?.message || err);
  }
}

export async function getTracked(chain: string, address: string): Promise<TrackedInfo | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(key(chain, address));
    if (!raw) return null;
    return JSON.parse(raw) as TrackedInfo;
  } catch (err: any) {
    console.error('[trackedDistributors] getTracked failed:', err?.message || err);
    return null;
  }
}
