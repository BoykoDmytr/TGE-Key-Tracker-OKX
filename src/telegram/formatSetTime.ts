// src/telegram/formatSetTime.ts
import { getExplorerTxUrl, type ChainKey } from '../evm/provider.js';
import { formatNumberWithCommas } from '../utils/formatNumberWithCommas.js';
import { kyivTimeShort } from '../utils/kyivTime.js';
import type { TrackedInfo } from '../store/trackedDistributors.js';

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function prettyNetwork(chainKey: ChainKey): string {
  switch (chainKey) {
    case 'bsc_testnet': return 'BSC Testnet';
    case 'bsc': return 'BSC';
    case 'base': return 'Base';
    case 'arbitrum': return 'Arbitrum';
    case 'ethereum': return 'Ethereum';
    case 'avalanche': return 'Avalanche';
    case 'optimism': return 'Optimism';
    case 'xlayer': return 'X Layer';
    default: return chainKey;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

// unix seconds -> "DD.MM.YYYY HH:mm UTC"
function fmtUtc(unix: number): string {
  const d = new Date(unix * 1000);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

// "03.06.2026 14:00 UTC | 17:00 Kyiv"
export function fmtUtcKyiv(unix: number): string {
  return `${fmtUtc(unix)} | ${kyivTimeShort(unix)}`;
}

export interface FormatSetTimeArgs {
  chainKey: ChainKey;
  tracked: TrackedInfo;
  startTime: number;
  duration: number;
  txHash: string;
}

export function formatSetTimeMessage(args: FormatSetTimeArgs): string {
  const { chainKey, tracked, startTime, txHash } = args;

  const amount = tracked.amountHuman ? formatNumberWithCommas(tracked.amountHuman) : '';
  const tokenLine = `${amount}${amount ? ' ' : ''}$${tracked.tokenSymbol}`.trim();

  const explorer = getExplorerTxUrl(chainKey, txHash);

  return (
    `⏰ <b>${escHtml('NEW SET TIME')}</b>\n\n` +
    `Token: ${escHtml(tokenLine)}\n` +
    `Network: ${escHtml(prettyNetwork(chainKey))}\n` +
    `Claim Time: ${escHtml(fmtUtcKyiv(startTime))}\n` +
    `<a href="${escHtml(explorer)}">${escHtml('View on Scan')}</a>\n\n` +
    `<a href="https://t.me/cryptohornettg/1354">Refback 45%</a>`
  );
}
