// src/handlers.ts
// Single source of truth for setTime + deposit processing.
// Called by BOTH the webhook routes (server.ts) and the block poller (poller/index.ts).

import { type ChainKey, getExplorerTxUrl } from './evm/provider.js';
import { getErc20MetaCached, formatUnitsSafe } from './evm/erc20MetaCache.js';
import { extractDistributorCreated, sumTransfersTo } from './evm/parseFactoryEvents.js';
import { loadFactories, factoriesFor } from './store/factories.js';
import { isDuplicate, markDuplicate, claimOnce } from './dedupe.js';
import { sendTelegram, notifyOwner } from './telegram.js';
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
    case 'xlayer': return 'X Layer';
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

  // Lowercase the hash: the poller supplies viem's lowercase hash, the webhook supplies
  // Tenderly's un-normalized one. Mixed case = two different keys = the same setTime twice.
  const dedupeKey = `settime:${chainKey}:${String(txHash).toLowerCase()}`;
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

  // Claim before sending (see dedupe.claimOnce) — the old send-then-mark order re-posted
  // whenever the send threw or the process restarted in between.
  if (!(await claimOnce(dedupeKey))) return { sent: false, reason: 'dup' };

  await sendTelegram(message);
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

// Ground truth: one createDistributor == one factory event == one message.
// A batch tx could legitimately create a few; anything beyond this is a bug or an attack,
// and we refuse to post rather than risk another flood.
const MAX_DEPOSIT_POSTS_PER_TX = Number(process.env.MAX_DEPOSIT_POSTS_PER_TX || 3);
const MAX_FACTORY_EVENTS_PER_TX = Number(process.env.MAX_FACTORY_EVENTS_PER_TX || 50);

function humanToRaw(human: string, decimals: number): bigint | null {
  const s = String(human).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [int, frac = ''] = s.split('.');
  const f = (frac + '0'.repeat(decimals)).slice(0, decimals);
  try { return BigInt(int + f); } catch { return null; }
}

let factoriesLoadedAt: Record<string, number> = {};
async function ensureFactories(chainKey: ChainKey): Promise<void> {
  const now = Date.now();
  if (now - (factoriesLoadedAt[chainKey] || 0) < 300_000) return;
  try {
    await loadFactories(chainKey);
    factoriesLoadedAt[chainKey] = now;
  } catch { /* keep whatever is already in memory */ }
}

export async function processDepositTx(
  chainKey: ChainKey,
  txHash: string,
  client: any,
  opts: DepositOpts,
): Promise<{ sent: number; tracked: number; capped?: boolean }> {
  const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });

  // A reverted tx creates nothing.
  if (receipt?.status && receipt.status !== 'success') {
    logInfo(opts.log, { chainKey, txHash, status: receipt.status }, 'deposit tx not successful, skipping');
    return { sent: 0, tracked: 0 };
  }

  // The deposit is read from the FACTORY'S OWN EVENT — never from Transfer logs.
  // (Transfer-walking is what produced 49 would-be messages from one tx on 2026-08-05.)
  await ensureFactories(chainKey);
  const known = factoriesFor(chainKey);

  // An empty allowlist rejects every event and silently disables deposit detection —
  // it looks identical to "quiet day" in the logs. Fail loudly instead.
  if (known.size === 0) {
    console.error('[handler] %s: factory allowlist is EMPTY — deposit detection is disabled (check FACTORIES_DEFAULT)', chainKey);
    void notifyOwner(
      `🚨 <b>Factory allowlist empty</b>\n\nChain: ${chainKey}\n` +
      `Deposit detection is effectively OFF. Check FACTORIES_DEFAULT / Redis.`,
    );
    return { sent: 0, tracked: 0 };
  }
  const { events, rejected } = extractDistributorCreated(receipt as any, (a) => known.has(a));

  if (rejected.length) {
    console.error('[handler] known factory emitted undecodable log(s) on %s %s: %j', chainKey, txHash, rejected);
    void notifyOwner(
      `⚠️ <b>Unknown factory event</b>\n\nChain: ${chainKey}\nTx: ${txHash}\n` +
      `${rejected.length} log(s) from a known factory could not be decoded ` +
      `(possible new factory version). Nothing was posted.`,
    );
  }

  if (!events.length) {
    logInfo(opts.log, { chainKey, txHash, source: opts.source }, 'no DistributorCreated event, skipping');
    return { sent: 0, tracked: 0 };
  }

  if (events.length > MAX_FACTORY_EVENTS_PER_TX) {
    console.error('[handler] %s %s: %d factory events — refusing to process', chainKey, txHash, events.length);
    void notifyOwner(
      `🚨 <b>Absurd factory event count</b>\n\nChain: ${chainKey}\nTx: ${txHash}\n` +
      `Events: ${events.length}. Nothing posted, nothing tracked.`,
    );
    return { sent: 0, tracked: 0, capped: true };
  }

  const thresholds = safeJson<Record<string, string>>(process.env.THRESHOLDS_JSON || '{}');
  const thresholdsLower: Record<string, string> = {};
  for (const [addr, human] of Object.entries(thresholds || {})) thresholdsLower[addr.toLowerCase()] = String(human);
  const strictMode = Object.keys(thresholdsLower).length > 0;

  const tokenLabels = safeJson<Record<string, string>>(process.env.TOKEN_LABELS_JSON || '{}');
  const tokenLabelsLower: Record<string, string> = {};
  for (const [addr, label] of Object.entries(tokenLabels || {})) tokenLabelsLower[addr.toLowerCase()] = String(label);

  let sent = 0;
  let tracked = 0;

  let capped = false;
  const seenInTx = new Set<string>();

  for (const ev of events) {
    try {
      const pairKey = `${ev.token}:${ev.distributor}`;
      if (seenInTx.has(pairKey)) continue;
      seenInTx.add(pairKey);

      const meta = await getErc20MetaCached(client, ev.token);

      // Amount: what actually LANDED beats what was declared. Tax/reflection tokens skim
      // on transfer (DOG declared 20000, only 19800 reached the distributor).
      const landed = sumTransfersTo(receipt as any, ev.token, ev.distributor);
      const raw = landed > 0n ? landed : (ev.declaredAmount ?? null);
      const amountHuman = raw != null ? formatUnitsSafe(raw, meta.decimals) : '';

      // Track FIRST and unconditionally: a distributor below the post threshold is still a
      // real distributor, and if it is missing from the allowlist its future setTime is
      // silently dropped. (The old code `continue`d past addTracked on every filter.)
      if (opts.persist) {
        await addTracked(chainKey, ev.distributor, {
          depositTxHash: txHash,
          addedAt: opts.blockTimestamp || Math.floor(Date.now() / 1000),
          tokenAddress: ev.token,
          tokenSymbol: meta.symbol,
          amountHuman,
        });
        tracked++;
      }

      // ---- posting gates (tracking already happened above) ----
      const threshHuman = thresholdsLower[ev.token] ?? null;
      if (strictMode && !threshHuman) continue;

      if (raw == null) {
        logInfo(opts.log, { chainKey, distributor: ev.distributor, txHash }, 'amount unknown, tracked but not posted');
        continue;
      }

      // bigint comparisons in base units — the old Number() path let NaN pass the filter.
      const minRaw = BigInt(MIN_TOKEN_AMOUNT) * 10n ** BigInt(meta.decimals);
      if (raw < minRaw) continue;

      if (threshHuman) {
        const threshRaw = humanToRaw(threshHuman, meta.decimals);
        if (threshRaw != null && raw < threshRaw) continue;
      }

      const explorer = getExplorerTxUrl(chainKey, txHash);
      const label = tokenLabelsLower[ev.token] || meta.symbol;
      const amountLine = `${formatNumberWithCommas(amountHuman)} $${label}`;

      const message =
        `⚡ <b>${escHtml('NEW OKX DEPOSIT DETECTED')}</b>\n\n` +
        `Amount: ${escHtml(amountLine)}\n` +
        `Network: ${escHtml(networkPretty(chainKey))}\n` +
        `<a href="${escHtml(explorer)}">${escHtml('View on Scan')}</a>\n\n` +
        `<a href="https://t.me/cryptohornettg/1354">Refback 45%</a>`;

      if (!opts.notify) {
        logInfo(opts.log, { chainKey, to: ev.distributor, source: opts.source, amountLine }, 'SHADOW: would send deposit');
        continue; // shadow must never consume the dedupe claim
      }

      if (sent >= MAX_DEPOSIT_POSTS_PER_TX) {
        capped = true;
        continue;
      }

      // Claim BEFORE sending: a crash/429/restart between the two used to re-post.
      const dedupeKey = `deposit:${chainKey}:${txHash.toLowerCase()}:${ev.logIndex}`;
      if (!(await claimOnce(dedupeKey))) continue;

      await sendTelegram(message);
      sent++;
    } catch (e: any) {
      console.error('[handler] deposit event failed %s %s #%d: %s', chainKey, txHash, ev.logIndex, e?.message || e);
    }
  }

  if (capped) {
    console.error('[handler] %s %s: capped at %d posts (%d events)', chainKey, txHash, MAX_DEPOSIT_POSTS_PER_TX, events.length);
    void notifyOwner(
      `🚨 <b>Deposit post cap hit</b>\n\nChain: ${chainKey}\nTx: ${txHash}\n` +
      `Events: ${events.length}, posted only ${MAX_DEPOSIT_POSTS_PER_TX}.\n` +
      `All were tracked. Check whether this is a batch or a bug.`,
    );
  }

  return { sent, tracked, capped };
}
