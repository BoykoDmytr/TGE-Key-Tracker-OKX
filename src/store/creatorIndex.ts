// src/store/creatorIndex.ts
//
// How many distributors has this wallet created, across every chain we watch?
//
// This is the one spam signal that needs no external API and that a third party cannot
// forge about someone else: `creator` is topics[1] of the factory event, i.e. the wallet
// that actually sent the createDistributor transaction.
//
// Measured over all 289 historical factory events (both factories, 4 chains):
//   serial spammers: 0x2c825edb… 49 distributors, 0x41ca99b7… 75, 0x906bab6f… 24
//   every legitimate depositor: at most 2
//
// A SET (not a counter) is used deliberately: processDepositTx re-runs for the same
// transaction routinely — the poller re-scans a whole block whenever any handler in it
// failed, and the legacy webhook can run concurrently with the poller. An INCR would
// inflate a legitimate creator past the threshold and start suppressing real campaigns.
// SADD of the distributor address is idempotent, so replays are free.

import { getRedis } from './redis.js';

const TTL_SECONDS = 400 * 24 * 3600; // longer than the tracked-distributor TTL on purpose

function key(creator: string): string {
  return `tge:creator:${creator.toLowerCase()}`;
}

/**
 * Record that `creator` created `distributor` on `chain`. Idempotent.
 * Never throws — a failed write degrades the filter to "creator unknown", which is safe
 * (an unknown creator can never be judged a spammer, so the deposit goes to review).
 */
export async function noteCreator(creator: string, chain: string, distributor: string): Promise<void> {
  if (!creator) return;
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.sadd(key(creator), `${chain}:${distributor.toLowerCase()}`);
    await redis.expire(key(creator), TTL_SECONDS);
  } catch (err: any) {
    console.error('[creatorIndex] noteCreator failed:', err?.message || err);
  }
}

/**
 * How many distinct distributors this creator is known to have made.
 * Returns null when the answer is UNKNOWN (no Redis, or the read failed) — the caller
 * must treat null as "no evidence", never as zero.
 */
export async function creatorPriorCount(creator: string): Promise<number | null> {
  if (!creator) return null;
  const redis = getRedis();
  if (!redis) return null;
  try {
    return await redis.scard(key(creator));
  } catch (err: any) {
    console.error('[creatorIndex] creatorPriorCount failed:', err?.message || err);
    return null;
  }
}
