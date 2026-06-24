// src/poller/index.ts
// Self-hosted block poller. Replaces the fragile Tenderly Web3 Action:
//  - scans every block from a PERSISTED cursor (never skips a block, even after restart)
//  - matches setTime (0xa0355eca) by SELECTOR on ANY contract — no address needed
//  - matches createDistributor (0xe89c7e5a) to the FACTORIES set (old + new + future)
//  - multi-RPC fallback pool (no silent llama-style death)
// Both detections call the shared handlers (single source of truth with the webhooks).

import type { ChainKey } from '../evm/provider.js';
import { getPollerClient, rpcCountFor } from './clients.js';
import { getCursor, setCursor } from './cursor.js';
import { loadFactories, factoriesFor } from '../store/factories.js';
import { processSetTimeTx, processDepositTx } from '../handlers.js';
import { SETTIME_SELECTOR } from '../evm/decodeSetTime.js';

const CREATE_DISTRIBUTOR_SELECTOR = '0xe89c7e5a';

// Confirmation depth per chain (don't alert at the tip — reorg safety).
const DEFAULT_CONF: Record<string, number> = {
  ethereum: 3,
  bsc: 12,
  base: 8,
  arbitrum: 15,
  avalanche: 2,
  optimism: 8,
};

const ALL_CHAINS: ChainKey[] = ['bsc', 'base', 'arbitrum', 'ethereum', 'avalanche', 'optimism'];

const INTERVAL = Number(process.env.POLLER_INTERVAL_MS || 4000);
const MAX_BATCH = Number(process.env.POLLER_MAX_BATCH || 300);
const CONCURRENCY = Number(process.env.POLLER_BLOCK_CONCURRENCY || 6);
const SHADOW = process.env.POLLER_SHADOW === '1';
const DEPOSITS_ENABLED = process.env.POLLER_DEPOSITS !== '0'; // default on
// Persist the cursor to Redis at most this often (keeps Upstash command count low).
// In-memory cursor still advances every block; we also force-persist right after any
// match so a restart never re-posts an already-handled event.
const CURSOR_PERSIST_MS = Number(process.env.POLLER_CURSOR_PERSIST_MS || 60_000);

function confFor(chain: ChainKey): number {
  const v = Number(process.env[`POLLER_CONF_${chain.toUpperCase()}`]);
  return Number.isFinite(v) && v > 0 ? v : (DEFAULT_CONF[chain] ?? 6);
}

function pollerChains(): ChainKey[] {
  const raw = (process.env.POLLER_CHAINS || process.env.CHAINS || '').toLowerCase();
  const picked = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((c) => ALL_CHAINS.includes(c as ChainKey)) as ChainKey[];
  return picked;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function startPoller(): void {
  if (process.env.POLLER_ENABLED !== '1') {
    console.log('[poller] disabled (set POLLER_ENABLED=1 to enable)');
    return;
  }
  const chains = pollerChains();
  if (!chains.length) {
    console.log('[poller] no chains configured (POLLER_CHAINS / CHAINS) — not starting');
    return;
  }
  console.log(
    '[poller] starting chains=%s shadow=%s deposits=%s interval=%dms maxBatch=%d',
    chains.join(','), SHADOW, DEPOSITS_ENABLED, INTERVAL, MAX_BATCH,
  );
  for (const chain of chains) {
    runChainLoop(chain).catch((e) => console.error('[poller:%s] loop crashed permanently: %s', chain, e?.message || e));
  }
}

async function runChainLoop(chain: ChainKey): Promise<void> {
  const client = getPollerClient(chain);
  await loadFactories(chain);
  const conf = confFor(chain);
  console.log('[poller:%s] conf=%d rpcs=%d', chain, conf, rpcCountFor(chain));

  // Seed cursor near head on first run (no historical backfill).
  let cursor: number;
  const existing = await getCursor(chain);
  if (existing == null) {
    const head = Number(await client.getBlockNumber());
    cursor = Math.max(0, head - conf);
    await setCursor(chain, cursor);
    console.log('[poller:%s] seeded cursor at %d (head %d)', chain, cursor, head);
  } else {
    cursor = existing;
    console.log('[poller:%s] resuming from cursor %d', chain, cursor);
  }

  let lastFactoryRefresh = Date.now();
  let lastProgress = Date.now();
  let lastPersist = Date.now();

  for (;;) {
    try {
      if (Date.now() - lastFactoryRefresh > 300_000) {
        await loadFactories(chain);
        lastFactoryRefresh = Date.now();
      }

      const head = Number(await client.getBlockNumber());
      const safeHead = head - conf;

      if (safeHead > cursor) {
        const to = Math.min(safeHead, cursor + MAX_BATCH);

        for (let from = cursor + 1; from <= to; from += CONCURRENCY) {
          const batch: number[] = [];
          for (let b = from; b < from + CONCURRENCY && b <= to; b++) batch.push(b);

          const blocks = await Promise.all(batch.map((n) => fetchBlock(client, chain, n)));

          // If any block failed (null), stop this batch BEFORE advancing past the gap.
          let advanceTo: number = cursor;
          let matched = false;
          for (let i = 0; i < blocks.length; i++) {
            if (!blocks[i]) break; // leave cursor before the missing block; retry next tick
            if (await scanBlock(chain, blocks[i])) matched = true;
            advanceTo = batch[i];
          }
          if (advanceTo > cursor) {
            cursor = advanceTo;
            lastProgress = Date.now();
            // Persist sparingly to keep Upstash command count low: time-based, OR
            // immediately after a match so a restart never re-posts a handled event.
            if (matched || Date.now() - lastPersist >= CURSOR_PERSIST_MS) {
              await setCursor(chain, cursor);
              lastPersist = Date.now();
            }
          }
          if (advanceTo !== batch[batch.length - 1]) break; // had a gap; retry next tick
        }
      }

      // Watchdog: behind head and not progressing => shout (could self-alert later).
      if (head - conf - cursor > MAX_BATCH * 3 && Date.now() - lastProgress > 120_000) {
        console.error('[poller:%s] WATCHDOG: cursor=%d safeHead=%d no-progress>120s', chain, cursor, head - conf);
      }
    } catch (e: any) {
      console.error('[poller:%s] tick error: %s', chain, e?.message || e);
    }
    await sleep(INTERVAL);
  }
}

async function fetchBlock(client: any, chain: ChainKey, n: number): Promise<any | null> {
  try {
    return await client.getBlock({ blockNumber: BigInt(n), includeTransactions: true });
  } catch (e: any) {
    console.error('[poller:%s] getBlock %d failed: %s', chain, n, e?.message || e);
    return null;
  }
}

// Returns true if the block contained a setTime or tracked-factory deposit we handled
// (used to force a cursor checkpoint so a restart never re-posts it).
async function scanBlock(chain: ChainKey, block: any): Promise<boolean> {
  const facs = factoriesFor(chain);
  const blockTs = Number(block.timestamp);
  let matched = false;

  for (const tx of block.transactions || []) {
    const input: string = (tx.input || '0x') as string;
    if (input.length < 10) continue;
    const sel = input.slice(0, 10).toLowerCase();
    const to = ((tx.to || '') as string).toLowerCase();

    if (sel === SETTIME_SELECTOR) {
      try {
        const r = await processSetTimeTx(
          { chainKey: chain, txHash: tx.hash, to, input },
          { notify: !SHADOW, source: 'poller' },
        );
        if (r?.sent) matched = true; // we actually posted -> force a checkpoint
      } catch (e: any) {
        console.error('[poller:%s] setTime handler error %s: %s', chain, tx.hash, e?.message || e);
      }
    } else if (DEPOSITS_ENABLED && sel === CREATE_DISTRIBUTOR_SELECTOR && to && facs.has(to)) {
      try {
        const r = await processDepositTx(chain, tx.hash, getPollerClient(chain), {
          notify: !SHADOW,
          persist: !SHADOW,
          source: 'poller',
          blockTimestamp: blockTs,
        });
        if (r && r.sent > 0) matched = true; // we actually posted -> force a checkpoint
      } catch (e: any) {
        console.error('[poller:%s] deposit handler error %s: %s', chain, tx.hash, e?.message || e);
      }
    }
  }
  return matched;
}
