// src/poller/cursor.ts
// Persisted lastScannedBlock per chain. This is THE guard against missed blocks:
// after any restart the poller resumes exactly where it left off, so a single
// crash / RPC blip can never silently drop a setTime (the Tenderly failure mode).

import { getRedis } from '../store/redis.js';

function key(chain: string): string {
  return `tge:poller:cursor:${chain}`;
}

export async function getCursor(chain: string): Promise<number | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const v = await redis.get(key(chain));
    return v != null ? Number(v) : null;
  } catch (err: any) {
    console.error('[cursor] get failed:', err?.message || err);
    return null;
  }
}

export async function setCursor(chain: string, block: number): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(key(chain), String(block));
  } catch (err: any) {
    console.error('[cursor] set failed:', err?.message || err);
  }
}
