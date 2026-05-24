// src/telegram/formatSetTime.ts
import { getExplorerTxUrl } from '../evm/provider.js';
import { formatNumberWithCommas } from '../utils/formatNumberWithCommas.js';
function escHtml(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function prettyNetwork(chainKey) {
    switch (chainKey) {
        case 'bsc_testnet': return 'BSC Testnet';
        case 'bsc': return 'BSC';
        case 'base': return 'Base';
        case 'arbitrum': return 'Arbitrum';
        case 'ethereum': return 'Ethereum';
        case 'avalanche': return 'Avalanche';
        case 'optimism': return 'Optimism';
        default: return chainKey;
    }
}
const pad = (n) => String(n).padStart(2, '0');
// unix seconds -> "DD.MM.YYYY HH:mm UTC"
function fmtUtc(unix) {
    const d = new Date(unix * 1000);
    return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
// seconds -> "14d" / "14d 5h" / "5h" / "30m"
function humanizeDuration(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const parts = [];
    if (d > 0)
        parts.push(`${d}d`);
    if (h > 0)
        parts.push(`${h}h`);
    if (!parts.length)
        parts.push(`${m}m`);
    return parts.join(' ');
}
// relative to now -> "in 55d 23h" / "12h ago"
function relFromNow(targetUnix) {
    const now = Math.floor(Date.now() / 1000);
    const diff = targetUnix - now;
    const ahead = diff >= 0;
    const abs = Math.abs(diff);
    const d = Math.floor(abs / 86400);
    const h = Math.floor((abs % 86400) / 3600);
    const parts = [];
    if (d > 0)
        parts.push(`${d}d`);
    parts.push(`${h}h`);
    const body = parts.join(' ');
    return ahead ? `in ${body}` : `${body} ago`;
}
export function formatSetTimeMessage(args) {
    const { chainKey, tracked, startTime, duration, txHash } = args;
    const endTime = startTime + duration;
    const amount = tracked.amountHuman ? formatNumberWithCommas(tracked.amountHuman) : '';
    const tokenLine = `${amount}${amount ? ' ' : ''}$${tracked.tokenSymbol}`.trim();
    const explorer = getExplorerTxUrl(chainKey, txHash);
    return (`⏰ <b>${escHtml('NEW SET TIME')}</b>\n\n` +
        `Token: ${escHtml(tokenLine)}\n` +
        `Network: ${escHtml(prettyNetwork(chainKey))}\n` +
        `Start: ${escHtml(fmtUtc(startTime))} (${escHtml(relFromNow(startTime))})\n` +
        `End: ${escHtml(fmtUtc(endTime))} (${escHtml(relFromNow(endTime))})\n` +
        `Duration: ${escHtml(humanizeDuration(duration))}\n\n` +
        `<a href="${escHtml(explorer)}">${escHtml('View on Scan')}</a>\n\n` +
        `<a href="https://t.me/cryptohornettg/1354">Refback 45%</a>`);
}
