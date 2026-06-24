// src/poller/clients.ts
// Dedicated viem clients for the poller, each with an RPC FALLBACK POOL.
// If one endpoint dies / returns garbage (the llama-HTML failure), viem rotates
// to the next automatically. Configure extra/override endpoints per chain via
// POLLER_RPCS_<CHAIN> (comma-separated). The bot's existing RPC_<CHAIN> is tried first.

import { createPublicClient, http, fallback } from 'viem';
import { bsc, base, arbitrum, mainnet, avalanche, optimism } from 'viem/chains';
import type { ChainKey } from '../evm/provider.js';

const CHAIN: Record<string, any> = {
  bsc,
  base,
  arbitrum,
  ethereum: mainnet,
  avalanche,
  optimism,
};

// Reliable public defaults (publicnode first — survived our HTML-on-ratelimit test).
const DEFAULT_RPCS: Record<string, string[]> = {
  bsc:       ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.binance.org', 'https://bsc-dataseed1.defibit.io'],
  base:      ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.drpc.org'],
  arbitrum:  ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc', 'https://arbitrum.drpc.org'],
  ethereum:  ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://rpc.ankr.com/eth'],
  avalanche: ['https://avalanche-c-chain-rpc.publicnode.com', 'https://api.avax.network/ext/bc/C/rpc'],
  optimism:  ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io', 'https://optimism.drpc.org'],
};

function rpcsFor(chain: ChainKey): string[] {
  const upper = chain.toUpperCase();
  const fromEnv = (process.env[`POLLER_RPCS_${upper}`] || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const single = (process.env[`RPC_${upper}`] || '').trim();
  const list = [...(single ? [single] : []), ...fromEnv, ...(DEFAULT_RPCS[chain] || [])];
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
      urls.map((u) => http(u, { timeout: 8000, retryCount: 1 })),
      { rank: false }, // try in listed order; rotate on failure
    ),
  });

  clients.set(chain, client);
  return client;
}

export function rpcCountFor(chain: ChainKey): number {
  return rpcsFor(chain).length;
}
