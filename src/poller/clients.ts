// src/poller/clients.ts
// Dedicated viem clients for the poller, each with an RPC FALLBACK POOL.
// If one endpoint dies / returns garbage (the llama-HTML failure), viem rotates
// to the next automatically. Configure extra/override endpoints per chain via
// POLLER_RPCS_<CHAIN> (comma-separated). The bot's existing RPC_<CHAIN> is tried first.

import { createPublicClient, http, fallback } from 'viem';
import { bsc, base, arbitrum, mainnet, avalanche, optimism, xLayer } from 'viem/chains';
import type { ChainKey } from '../evm/provider.js';

const CHAIN: Record<string, any> = {
  bsc,
  base,
  arbitrum,
  ethereum: mainnet,
  avalanche,
  optimism,
  xlayer: xLayer,
};

// Reliable public defaults (publicnode first — survived our HTML-on-ratelimit test).
const DEFAULT_RPCS: Record<string, string[]> = {
  bsc:       ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.binance.org', 'https://bsc-dataseed1.defibit.io'],
  base:      ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.drpc.org'],
  arbitrum:  ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc', 'https://arbitrum.drpc.org'],
  ethereum:  ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://rpc.ankr.com/eth'],
  avalanche: ['https://avalanche-c-chain-rpc.publicnode.com', 'https://api.avax.network/ext/bc/C/rpc'],
  optimism:  ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io', 'https://optimism.drpc.org'],
  xlayer:    ['https://rpc.xlayer.tech', 'https://xlayerrpc.okx.com', 'https://xlayer.drpc.org'],
};

function rpcsFor(chain: ChainKey): string[] {
  const upper = chain.toUpperCase();
  // Poller-specific endpoints (optional) first, then the reliable public pool.
  // We intentionally do NOT auto-include the bot's RPC_<CHAIN> (e.g. a metered
  // nodereal key shared with the webhook path) — the poller's continuous block
  // fetching would burn that quota. Add it via POLLER_RPCS_<CHAIN> if you want it.
  const fromEnv = (process.env[`POLLER_RPCS_${upper}`] || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  // When POLLER_RPCS_<CHAIN> is set it REPLACES the defaults rather than merely leading
  // them, so a bad endpoint can be taken OUT of the pool from env, with no deploy.
  // On 2026-09-10 publicnode began answering 403 to this machine on every request for
  // bsc/base/arbitrum while sitting first in all three default pools. Each block then
  // cost two dead round trips and a fresh TLS handshake; the connection churn made the
  // whole machine 20x slower at every destination, including ones we never poll, and
  // the poller fell a day behind on the two chains with the highest block rate.
  const list = fromEnv.length ? fromEnv : (DEFAULT_RPCS[chain] || []);
  return [...new Set(list)];
}

const clients = new Map<ChainKey, any>();

export function getPollerClient(chain: ChainKey): any {
  const existing = clients.get(chain);
  if (existing) return existing;

  const urls = rpcsFor(chain);
  if (!urls.length) throw new Error(`[poller] no RPCs for chain ${chain}`);

  const client = createPublicClient({
    chain: CHAIN[chain],
    transport: fallback(
      // retryCount 0 on purpose: inside a fallback pool, retrying the SAME endpoint is
      // wasted work — the pool already gives redundancy across independent providers,
      // and against an endpoint that hard-fails (403/429) the retry doubles the cost of
      // every single block. A transient blip still costs nothing: fetchBlock returns
      // null, the cursor holds before the gap, and the next tick re-reads that block.
      urls.map((u) => http(u, { timeout: 8000, retryCount: 0 })),
      { rank: false }, // try in listed order; rotate on failure
    ),
  });

  clients.set(chain, client);
  return client;
}

export function rpcCountFor(chain: ChainKey): number {
  return rpcsFor(chain).length;
}
