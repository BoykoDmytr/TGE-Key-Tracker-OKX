// src/filter/pendingApproval.ts
//
// A deposit the filter did not clear is not thrown away — the exact channel message is
// parked here and DM'd to the owner with an approve button. Tapping it publishes that
// stored message verbatim, so an approved post is byte-identical to an automatic one.
//
// Why store the rendered message rather than re-derive it on approval: re-deriving means
// re-reading the receipt and re-formatting minutes or hours later, which can produce a
// different string (cache state, RPC differences) or fail outright. Storing it makes the
// button a pure "send this" action with no new failure modes.

import { randomBytes } from 'node:crypto';
import { getRedis } from '../store/redis.js';

const TTL_SECONDS = Number(process.env.FILTER_PENDING_TTL_SEC || 14 * 24 * 3600);

export interface PendingPost {
  /** exact HTML message to publish if approved */
  message: string;
  /** the dedupe key the automatic path would have claimed — reused so an approval can
   *  never double-post alongside a later automatic post of the same event */
  dedupeKey: string;
  chain: string;
  distributor: string;
  kind: 'deposit' | 'settime';
  verdict: string;
  rule: string;
  createdAt: number;
}

function key(id: string): string {
  return `tge:pending:${id}`;
}

/** 16 hex chars keeps `ap:<id>` far inside Telegram's 64-byte callback_data limit. */
export function newPendingId(): string {
  return randomBytes(8).toString('hex');
}

export async function putPending(id: string, rec: PendingPost): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    await redis.set(key(id), JSON.stringify(rec), 'EX', TTL_SECONDS);
    return true;
  } catch (err: any) {
    console.error('[pending] put failed:', err?.message || err);
    return false;
  }
}

/**
 * Atomically take the pending record: returns it and deletes it in one step, so two taps
 * on the same button cannot both publish.
 */
export async function takePending(id: string): Promise<PendingPost | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await (redis as any).getdel?.(key(id));
    if (raw !== undefined) return raw ? (JSON.parse(raw) as PendingPost) : null;
    // Fallback for Redis servers without GETDEL: read then delete, and only honour the
    // read if we were the one who removed it.
    const val = await redis.get(key(id));
    if (!val) return null;
    const removed = await redis.del(key(id));
    return removed === 1 ? (JSON.parse(val) as PendingPost) : null;
  } catch (err: any) {
    console.error('[pending] take failed:', err?.message || err);
    return null;
  }
}
