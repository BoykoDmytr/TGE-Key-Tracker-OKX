const cache = new Map();
const ERC20_ABI = [
    { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
    { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
    { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
];
/**
 * The cache key includes the CHAIN. The same address is a different token on a
 * different chain, and this Map is process-wide and shared with the webhook path, so a
 * token-only key let one chain answer for another.
 *
 * A degraded read is never cached: a transient RPC failure used to be frozen into the
 * process for its whole lifetime.
 */
export async function getErc20MetaCached(client, token, chain) {
    const key = `${String(chain).toLowerCase()}:${token.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit)
        return hit;
    // degraded means "a value that REACHES SUBSCRIBERS is a guess". Only symbol and
    // decimals qualify: name() is rendered nowhere in this bot, so a token that reverts on
    // name() (plenty do) must not have its deposit withheld over a field nobody sees.
    let degraded = false;
    const fallback = (v) => () => { degraded = true; return v; };
    const nameFallback = () => 'Unknown Token';
    const [symbol, name, decimals] = await Promise.all([
        client.readContract({ address: token, abi: ERC20_ABI, functionName: 'symbol' }).catch(fallback('UNKNOWN')),
        client.readContract({ address: token, abi: ERC20_ABI, functionName: 'name' }).catch(nameFallback),
        client.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' }).catch(fallback(18)),
    ]);
    const meta = { symbol: String(symbol), name: String(name), decimals: Number(decimals), degraded };
    if (!degraded)
        cache.set(key, meta);
    return meta;
}
export function formatUnitsSafe(value, decimals) {
    const d = BigInt(10) ** BigInt(decimals);
    const whole = value / d;
    const frac = value % d;
    if (frac === 0n)
        return whole.toString();
    const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
    return `${whole.toString()}.${fracStr}`;
}
