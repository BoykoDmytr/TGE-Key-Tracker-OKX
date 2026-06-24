// src/store/factories.ts
// Set of DistributorFactory addresses we watch for createDistributor() deposits.
// Grows over time (new factories) without redeploy: POST /admin/factory -> Redis SADD.
// Because the protocol deploys factories at the SAME CREATE2 address on every chain,
// FACTORIES_DEFAULT (env) is applied to ALL chains; per-chain extras live in Redis.

import { getRedis } from './redis.js';

const ENV_DEFAULT = (process.env.FACTORIES_DEFAULT || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function key(chain: string): string {
  return `tge:factories:${chain}`;
}

// in-memory cache per chain (hot path: poller checks this every tx)
const mem = new Map<string, Set<string>>();

export function factoriesFor(chain: string): Set<string> {
  let s = mem.get(chain);
  if (!s) {
    s = new Set(ENV_DEFAULT);
    mem.set(chain, s);
  }
  return s;
}

// Reconcile in-memory set with env defaults + Redis (call at boot and periodically).
export async function loadFactories(chain: string): Promise<Set<string>> {
  const s = factoriesFor(chain);
  for (const a of ENV_DEFAULT) s.add(a);
  const redis = getRedis();
  if (redis) {
    try {
      const arr = await redis.smembers(key(chain));
      for (const a of arr) s.add(a.toLowerCase());
    } catch (err: any) {
      console.error('[factories] load failed:', err?.message || err);
    }
  }
  return s;
}

export async function addFactory(chain: string, address: string): Promise<void> {
  const a = address.toLowerCase();
  factoriesFor(chain).add(a);
  const redis = getRedis();
  if (redis) {
    try {
      await redis.sadd(key(chain), a);
    } catch (err: any) {
      console.error('[factories] sadd failed:', err?.message || err);
    }
  }
}

export async function listFactories(chain: string): Promise<string[]> {
  await loadFactories(chain);
  return [...factoriesFor(chain)];
}
