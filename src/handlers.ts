// src/handlers.ts
// Single source of truth for setTime + deposit processing.
// Called by BOTH the webhook routes (server.ts) and the block poller (poller/index.ts).

import { type ChainKey, getExplorerTxUrl } from './evm/provider.js';
import { getErc20MetaCached, formatUnitsSafe } from './evm/erc20MetaCache.js';
import { extractTransfersFromReceipt } from './tenderly/parseTransfers.js';
import { isDuplicate, markDuplicate } from './dedupe.js';
import { sendTelegram } from './telegram.js';
import { formatNumberWithCommas } from './utils/formatNumberWithCommas.js';
import { addTracked, getTracked } from './store/trackedDistributors.js';
import { decodeSetTime } from './evm/decodeSetTime.js';
import { formatSetTimeMessage } from './telegram/formatSetTime.js';

const MIN_TOKEN_AMOUNT = 5000;

type Logger = { info?: (...a: any[]) => void; warn?: (...a: any[]) => void; error?: (...a: any[]) => void };
function logInfo(log: Logger | undefined, obj: any, msg: string) {
  if (log?.info) log.info(obj, msg);
  else console.log('[handler]', msg, JSON.stringify(obj));
}

function safeJson<T>(s: string): T {
  try { return JSON.parse(s) as T; } catch { return {} as T; }
}
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function networkPretty(chainKey: ChainKey): string {
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

// ---------- setTime ----------
export interface SetTimeArgs { chainKey: ChainKey; txHash: string; to: string; input: string; }
export interface SetTimeOpts { notify: boolean; source: 'webhook' | 'poller'; log?: Logger; }

export async function processSetTimeTx(
  args: SetTimeArgs,
  opts: SetTimeOpts,
): Promise<{ sent: boolean; reason?: string }> {
  const { chainKey, txHash, to, input } = args;

  const decoded = decodeSetTime(String(input));
  if (!decoded) return { sent: false, reason: 'not-settime' };

  // Allowlist filter — only Distributors that already passed a deposit alert / backfill
  const tracked = await getTracked(chainKey, String(to));
  if (!tracked) {
    logInfo(opts.log, { chainKey, to, txHash, source: opts.source }, 'setTime for non-tracked distributor, skipping');
    return { sent: false, reason: 'non-tracked' };
  }

  const dedupeKey = `settime:${chainKey}:${txHash}`;
  if (await isDuplicate(dedupeKey)) return { sent: false, reason: 'dup' };

  const message = formatSetTimeMessage({
    chainKey,
    tracked,
    startTime: decoded.startTime,
    duration: decoded.duration,
    txHash: String(txHash),
  });

  if (!opts.notify) {
    logInfo(opts.log, { chainKey, to, txHash, source: opts.source, preview: message.slice(0, 120) }, 'SHADOW: would send setTime');
    return { sent: false, reason: 'shadow' };
  }

  await sendTelegram(message);
  await markDuplicate(dedupeKey);
  logInfo(opts.log, { chainKey, to, txHash, source: opts.source }, 'setTime notification sent');
  return { sent: true };
}

// ---------- deposit (createDistributor) ----------
// `client` must expose viem's getTransactionReceipt + readContract.
export interface DepositOpts {
  notify: boolean;
  persist: boolean;
  source: 'webhook' | 'poller';
  blockTimestamp?: number;
  log?: Logger;
}

export async function processDepositTx(
  chainKey: ChainKey,
  txHash: string,
  client: any,
  opts: DepositOpts,
): Promise<{ sent: number; tracked: number }> {
  const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
  const transfers = extractTransfersFromReceipt(receipt as any);
  if (!transfers.length) return { sent: 0, tracked: 0 };

  const thresholds = safeJson<Record<string, string>>(process.env.THRESHOLDS_JSON || '{}');
  const thresholdsLower: Record<string, string> = {};
  for (const [addr, human] of Object.entries(thresholds || {})) thresholdsLower[addr.toLowerCase()] = String(human);
  const strictMode = Object.keys(thresholdsLower).length > 0;

  const tokenLabels = safeJson<Record<string, string>>(process.env.TOKEN_LABELS_JSON || '{}');
  const tokenLabelsLower: Record<string, string> = {};
  for (const [addr, label] of Object.entries(tokenLabels || {})) tokenLabelsLower[addr.toLowerCase()] = String(label);

  let sent = 0;
  let tracked = 0;

  for (const t of transfers) {
    const tokenAddrLower = t.token.toLowerCase();
    const threshHuman = thresholdsLower[tokenAddrLower] ?? null;

    // strict mode: only tokens in thresholds
    if (strictMode && !threshHuman) continue;

    const dedupeKey = `${chainKey}:${txHash}:${t.logIndex}:${tokenAddrLower}:${t.to.toLowerCase()}`;
    if (await isDuplicate(dedupeKey)) continue;

    const meta = await getErc20MetaCached(client, t.token);
    const amountHuman = formatUnitsSafe(t.value, meta.decimals);

    const amountNum = Number(amountHuman);
    if (!Number.isNaN(amountNum) && amountNum < MIN_TOKEN_AMOUNT) continue;

    const pass = threshHuman ? Number(amountHuman) >= Number(threshHuman) : true;
    if (!pass) continue;

    const explorer = getExplorerTxUrl(chainKey, txHash);
    const label = tokenLabelsLower[tokenAddrLower] || meta.symbol;
    const amountLine = `${formatNumberWithCommas(amountHuman)} $${label}`;

    const message =
      `⚡ <b>${escHtml('NEW OKX DEPOSIT DETECTED')}</b>\n\n` +
      `Amount: ${escHtml(amountLine)}\n` +
      `Network: ${escHtml(networkPretty(chainKey))}\n` +
      `<a href="${escHtml(explorer)}">${escHtml('View on Scan')}</a>\n\n` +
      `<a href="https://t.me/cryptohornettg/1354">Refback 45%</a>`;

    if (opts.notify) {
      await sendTelegram(message);
      await markDuplicate(dedupeKey);
      sent++;
    } else {
      logInfo(opts.log, { chainKey, to: t.to, source: opts.source, amountLine }, 'SHADOW: would send deposit');
    }

    // Remember the new Distributor in the allowlist so its future setTime is caught.
    if (opts.persist) {
      await addTracked(chainKey, t.to, {
        depositTxHash: txHash,
        addedAt: opts.blockTimestamp || Math.floor(Date.now() / 1000),
        tokenAddress: t.token,
        tokenSymbol: meta.symbol,
        amountHuman,
      });
      tracked++;
    }
  }

  return { sent, tracked };
}
