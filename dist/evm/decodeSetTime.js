// src/evm/decodeSetTime.ts
export const SETTIME_SELECTOR = '0xa0355eca';
// Decodes setTime(uint256 _startTime, uint256 _duration) calldata.
export function decodeSetTime(input) {
    if (!input || input.length < 10)
        return null;
    if (input.slice(0, 10).toLowerCase() !== SETTIME_SELECTOR)
        return null;
    const data = input.slice(10);
    if (data.length < 128)
        return null;
    try {
        const startTime = Number(BigInt('0x' + data.slice(0, 64)));
        const duration = Number(BigInt('0x' + data.slice(64, 128)));
        if (!Number.isFinite(startTime) || !Number.isFinite(duration))
            return null;
        return { startTime, duration };
    }
    catch {
        return null;
    }
}
