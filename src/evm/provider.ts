// src/evm/provider.ts
import { createPublicClient, http } from 'viem';
import { bsc, bscTestnet, base, arbitrum } from 'viem/chains';

export type ChainKey = 'bsc' | 'bsc_testnet' | 'base' | 'arbitrum';

// Мінімум методів, які нам треба (без “важких” типів viem)
export type EvmClient = {
  getTransaction: (args: { hash: `0x${string}` }) => Promise<{ to: `0x${string}` | null }>;
  getTransactionReceipt: (args: { hash: `0x${string}` }) => Promise<{ logs: any[] }>;
  readContract: (args: any) => Promise<any>;
};

const RPC: Record<ChainKey, string> = {
  bsc: process.env.RPC_BSC || '',
  bsc_testnet: process.env.RPC_BSC_TESTNET || '',
  base: process.env.RPC_BASE || '',
  arbitrum: process.env.RPC_ARBITRUM || '',
};

const CHAIN = {
  bsc,
  bsc_testnet: bscTestnet,
  base,
  arbitrum,
} as const;

const clients = new Map<ChainKey, EvmClient>();

export function getPublicClient(chainKey: ChainKey): EvmClient {
  const existing = clients.get(chainKey);
  if (existing) return existing;

  const url = RPC[chainKey];
  if (!url) throw new Error(`Missing RPC for chain ${chainKey}`);

  // Створюємо viem client, але віддаємо як “EvmClient”
  const client = createPublicClient({
    chain: CHAIN[chainKey],
    transport: http(url),
  }) as unknown as EvmClient;

  clients.set(chainKey, client);
  return client;
}

export function getExplorerTxUrl(chainKey: ChainKey, txHash: string): string {
  const fallback: Record<ChainKey, string> = {
    bsc: 'https://bscscan.com/tx/',
    bsc_testnet: 'https://testnet.bscscan.com/tx/',
    base: 'https://basescan.org/tx/',
    arbitrum: 'https://arbiscan.io/tx/',
  };
  return `${fallback[chainKey]}${txHash}`;
}
