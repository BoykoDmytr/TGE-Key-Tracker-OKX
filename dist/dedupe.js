const seen = new Map(); // key -> expiresAtMs
const TTL_MS = 7 * 24 * 3600 * 1000;
export async function isDuplicate(key) {
    const now = Date.now();
    const exp = seen.get(key);
    if (!exp)
        return false;
    if (exp < now) {
        seen.delete(key);
        return false;
    }
    return true;
}
export async function markDuplicate(key) {
    const now = Date.now();
    seen.set(key, now + TTL_MS);
    // трішки прибираємо прострочені, щоб мапа не росла вічно
    if (seen.size > 5000) {
        for (const [k, exp] of seen)
            if (exp < now)
                seen.delete(k);
    }
}
