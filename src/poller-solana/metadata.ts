// src/poller-solana/metadata.ts
// Token symbol/name via the Metaplex Token Metadata PDA (fully on-chain, no third-party API).

import { PublicKey } from '@solana/web3.js';
import { solRpc } from './rpc.js';

const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

type TokenMeta = { symbol: string; name: string };
const cache = new Map<string, TokenMeta>();

export async function getSolTokenMeta(mint: string): Promise<TokenMeta> {
  const hit = cache.get(mint);
  if (hit) return hit;

  const fallback: TokenMeta = { symbol: mint.slice(0, 4) + '…', name: mint };
  try {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), new PublicKey(mint).toBuffer()],
      METADATA_PROGRAM,
    );
    const info = await solRpc('getAccountInfo', [pda.toBase58(), { encoding: 'base64' }]);
    if (!info?.value?.data?.[0]) return fallback;

    const buf = Buffer.from(info.value.data[0], 'base64');
    // Layout: key(1) + updateAuthority(32) + mint(32) + name(u32 len + bytes) + symbol(u32 len + bytes)
    let off = 1 + 32 + 32;
    const nameLen = buf.readUInt32LE(off);
    const name = buf.slice(off + 4, off + 4 + nameLen).toString('utf8').replace(/\0+$/, '').trim();
    off = off + 4 + nameLen;
    const symLen = buf.readUInt32LE(off);
    const symbol = buf.slice(off + 4, off + 4 + symLen).toString('utf8').replace(/\0+$/, '').trim();

    const meta: TokenMeta = { symbol: symbol || fallback.symbol, name: name || mint };
    cache.set(mint, meta);
    return meta;
  } catch (e: any) {
    console.error('[solana:meta] failed for %s: %s', mint, e?.message || e);
    return fallback;
  }
}
