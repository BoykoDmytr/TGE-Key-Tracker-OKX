// src/poller-solana/rpc.ts
// Minimal Solana JSON-RPC client with a rotating endpoint pool
// (same resilience philosophy as the EVM poller: one dead endpoint must not stall us).

const DEFAULT_RPCS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
];

function endpoints(): string[] {
  const extra = (process.env.POLLER_RPCS_SOLANA || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set([...extra, ...DEFAULT_RPCS])];
}

export async function solRpc(method: string, params: any[]): Promise<any> {
  let lastErr: any = null;
  for (const url of endpoints()) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 12_000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
      });
      clearTimeout(t);
      const json: any = await res.json();
      if (json && json.error) { lastErr = new Error(json.error.message || 'rpc error'); continue; }
      if (json && 'result' in json) return json.result;
      lastErr = new Error('malformed rpc response');
    } catch (e: any) {
      lastErr = e;
    }
  }
  throw lastErr || new Error(`solana rpc failed: ${method}`);
}

// base58 decode -> hex string (preserving leading zero bytes)
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58ToHex(s: string): string {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) return '';
    n = n * 58n + BigInt(i);
  }
  let h = n === 0n ? '' : n.toString(16);
  if (h.length % 2) h = '0' + h;
  let zeros = 0;
  for (const c of s) { if (c === '1') zeros++; else break; }
  return '0'.repeat(zeros * 2) + h;
}

// little-endian u64 from a hex slice -> number
export function u64le(hex: string): number {
  const bytes = hex.match(/../g) || [];
  return Number(BigInt('0x' + (bytes.reverse().join('') || '0')));
}
