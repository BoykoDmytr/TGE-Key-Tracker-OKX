// src/evm/erc20MetaCache.ts
import type { Address } from 'viem';
import type { EvmClient } from './provider.js';

// Мінімальний інтерфейс клієнта, який нам потрібен
export type EvmReader = Pick<EvmClient, 'readContract'>;

type Meta = { symbol: string; name: string; decimals: number };

const cache = new Map<string, Meta>();

const ERC20_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

export async function getErc20MetaCached(client: EvmReader, token: Address): Promise<Meta> {
  const key = token.toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;

  const [symbol, name, decimals] = await Promise.all([
    client.readContract({ address: token, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => 'UNKNOWN'),
    client.readContract({ address: token, abi: ERC20_ABI, functionName: 'name' }).catch(() => 'Unknown Token'),
    client.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18),
  ]);

  const meta = { symbol: String(symbol), name: String(name), decimals: Number(decimals) };
  cache.set(key, meta);
  return meta;
}

export function formatUnitsSafe(value: bigint, decimals: number): string {
  const d = BigInt(10) ** BigInt(decimals);
  const whole = value / d;
  const frac = value % d;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fracStr}`;
}
