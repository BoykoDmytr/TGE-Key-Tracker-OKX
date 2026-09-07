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
  /** Spam-filter decision for the DEPOSIT that created this distributor. Absent on every
   *  record written before the filter existed — read as 'legit' so nothing that used to
   *  work stops working. The later setTime post inherits it, otherwise a spam deposit we
   *  correctly withheld would still announce its claim time to the channel. */
  verdict?: 'legit' | 'spam' | 'unsure';
  /** Rule id behind the verdict — shown in the owner DM and kept for audit. */
  verdictRule?: string;
}

/** Records with no verdict pre-date the filter and were already posted, so their setTime
 *  must keep posting. Absent === 'legit', deliberately. */
export function trackedVerdict(info: TrackedInfo | null): 'legit' | 'spam' | 'unsure' {
  if (!info) return 'legit';
  return info.verdict ?? 'legit';
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
export async function markTrackedLegit(chain: string, address: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    const raw = await redis.get(key(chain, address));
    if (!raw) return false;
    const info = JSON.parse(raw) as TrackedInfo;
    if (info.verdict === 'legit') return true;
    info.verdict = 'legit';
    info.verdictRule = 'owner-approved';
    const ttl = await redis.ttl(key(chain, address));
    await redis.set(key(chain, address), JSON.stringify(info), 'EX', ttl > 0 ? ttl : TTL_SECONDS);
    return true;
  } catch (err: any) {
    console.error('[trackedDistributors] markTrackedLegit failed:', err?.message || err);
    return false;
  }
}
