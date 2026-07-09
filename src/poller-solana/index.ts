// src/poller-solana/index.ts
// Solana poller for the OKX Boost program(s): CreateDistributor deposits + SetTime.
// Same guarantees as the EVM poller: persisted signature cursor per program (never
// skips a tx, survives restarts), Redis dedup, shadow mode, silent allowlist filter.
//
// Anchor instruction discriminators (verified on-chain, identical across program versions
// because they derive from instruction names):
//   CreateDistributor  b8671a478d4031b1  (+ u64 LE amount in token base units)
//   SetTime            3df6336eb115a167  (+ u64 LE startTime — Solana has NO duration/end)

import { solRpc, b58ToHex, u64le } from './rpc.js';
import { getSolTokenMeta } from './metadata.js';
import { getRedis } from '../store/redis.js';
import { loadFactories, factoriesFor } from '../store/factories.js';
import { addTracked, getTracked } from '../store/trackedDistributors.js';
import { isDuplicate, markDuplicate } from '../dedupe.js';
import { sendTelegram } from '../telegram.js';
import { formatNumberWithCommas } from '../utils/formatNumberWithCommas.js';
import { fmtUtcKyiv } from '../telegram/formatSetTime.js';

const CREATE_DISC = 'b8671a478d4031b1';
const SETTIME_DISC = '3df6336eb115a167';
const MIN_TOKEN_AMOUNT = 5000; // same global deposit filter as the EVM path

const DEFAULT_PROGRAMS = [
  'Boostp5MKfWuF9eoczs1eY9g885t7doG6GLXM9xQnRxj',  // old Boost program
  'BoostqXHKsk6j1pA9qHCXQhCNEVZ2bTm698QFwbhVGQU',  // new Boost program (2026-07)
];

const INTERVAL = Number(process.env.POLLER_SOLANA_INTERVAL_MS || 10_000);
const MAX_SIG_PAGES = 5;          // up to 5000 new signatures per tick
const TX_CONCURRENCY = 5;
const CURSOR_PERSIST_MS = Number(process.env.POLLER_CURSOR_PERSIST_MS || 60_000);
const SHADOW = process.env.POLLER_SOLANA_SHADOW === '1';

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function solscanTx(sig: string): string {
  return `https://solscan.io/tx/${sig}`;
}

function programs(): string[] {
  const fromEnv = (process.env.SOLANA_PROGRAMS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  // Future programs can also be added at runtime via POST /admin/factory {chain:"solana"}.
  // The factories store seeds every chain with FACTORIES_DEFAULT (EVM 0x… addresses) —
  // filter those out: only base58 Solana program ids belong here.
  const fromStore = [...factoriesFor('solana')].filter((a) => !a.startsWith('0x'));
  return [...new Set([...(fromEnv.length ? fromEnv : DEFAULT_PROGRAMS), ...fromStore])];
}

function cursorKey(program: string): string {
  return `tge:poller:cursor:solana:${program}`;
}
async function getCursor(program: string): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  try { return await redis.get(cursorKey(program)); } catch { return null; }
}
async function setCursor(program: string, sig: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try { await redis.set(cursorKey(program), sig); } catch (e: any) {
    console.error('[solana] cursor set failed:', e?.message || e);
  }
}

export function startSolanaPoller(): void {
  if (process.env.POLLER_SOLANA !== '1') {
    console.log('[solana] disabled (set POLLER_SOLANA=1 to enable)');
    return;
  }
  console.log('[solana] starting shadow=%s interval=%dms programs=%s', SHADOW, INTERVAL, programs().join(','));
  runLoop().catch((e) => console.error('[solana] loop crashed permanently: %s', e?.message || e));
}

async function runLoop(): Promise<void> {
  await loadFactories('solana');
  const lastPersist = new Map<string, number>();
  let lastStoreRefresh = Date.now();

  for (;;) {
    try {
      if (Date.now() - lastStoreRefresh > 300_000) {
        await loadFactories('solana');
        lastStoreRefresh = Date.now();
      }
      for (const program of programs()) {
        await pollProgram(program, lastPersist, cursorCache);
      }
    } catch (e: any) {
      console.error('[solana] tick error: %s', e?.message || e);
    }
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
}

// In-memory cursor cache: Redis is read once per program (boot) and written on
// checkpoints only — keeps Upstash reads near zero (same pattern as the EVM poller).
const cursorCache = new Map<string, string>();

async function pollProgram(program: string, lastPersist: Map<string, number>, cache: Map<string, string>): Promise<void> {
  let cursor = cache.get(program);
  if (!cursor) {
    const fromRedis = await getCursor(program);
    if (fromRedis) {
      cursor = fromRedis;
      cache.set(program, fromRedis);
      console.log('[solana:%s…] resuming from cursor %s…', program.slice(0, 8), fromRedis.slice(0, 16));
    }
  }

  // First run: seed at the newest signature — future events only, no history spam.
  if (!cursor) {
    const sigs = await solRpc('getSignaturesForAddress', [program, { limit: 1 }]);
    if (sigs?.length) {
      cache.set(program, sigs[0].signature);
      await setCursor(program, sigs[0].signature);
      console.log('[solana:%s…] seeded cursor at %s…', program.slice(0, 8), sigs[0].signature.slice(0, 16));
    }
    return;
  }

  // Collect everything newer than the cursor (newest -> oldest), then process oldest -> newest.
  const collected: Array<{ signature: string; err: any }> = [];
  let before: string | undefined;
  let reachedCursor = false;
  for (let page = 0; page < MAX_SIG_PAGES && !reachedCursor; page++) {
    const params: any = { limit: 1000, until: cursor };
    if (before) params.before = before;
    const sigs = await solRpc('getSignaturesForAddress', [program, params]);
    if (!sigs?.length) { reachedCursor = true; break; }
    collected.push(...sigs);
    before = sigs[sigs.length - 1].signature;
    if (sigs.length < 1000) reachedCursor = true;
  }
  if (!collected.length) return;
  if (!reachedCursor) {
    console.warn('[solana:%s…] backlog >%d sigs, processing oldest window first', program.slice(0, 8), collected.length);
  }

  const ordered = collected.reverse(); // oldest first
  let processedUpTo: string | null = null;
  let posted = false;

  for (let i = 0; i < ordered.length; i += TX_CONCURRENCY) {
    const batch = ordered.slice(i, i + TX_CONCURRENCY);
    const txs = await Promise.all(batch.map(async (s) => {
      if (s.err) return { s, tx: 'skip' as const };           // failed tx: skip but advance
      try {
        const tx = await solRpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
        return { s, tx };
      } catch { return { s, tx: null }; }                      // fetch failure: stop before the gap
    }));

    let gap = false;
    for (const { s, tx } of txs) {
      if (tx === null) { gap = true; break; }
      if (tx !== 'skip' && tx) {
        try {
          if (await scanSolanaTx(program, s.signature, tx)) posted = true;
        } catch (e: any) {
          console.error('[solana] scan error %s: %s', s.signature.slice(0, 16), e?.message || e);
        }
      }
      processedUpTo = s.signature;
    }

    if (processedUpTo) {
      cache.set(program, processedUpTo); // in-memory advance: next tick never re-fetches these sigs
      const last = lastPersist.get(program) || 0;
      if (posted || Date.now() - last >= CURSOR_PERSIST_MS) {
        await setCursor(program, processedUpTo);
        lastPersist.set(program, Date.now());
        posted = false;
      }
    }
    if (gap) break; // retry the rest next tick; cursor never moves past an unfetched tx
  }

  // End-of-window checkpoint so a quiet program still advances durably.
  if (processedUpTo) {
    cache.set(program, processedUpTo);
    await setCursor(program, processedUpTo);
    lastPersist.set(program, Date.now());
  }
}

// Returns true if we actually posted something (forces a cursor checkpoint).
async function scanSolanaTx(program: string, sig: string, tx: any): Promise<boolean> {
  const progSet = new Set(programs());
  const top = tx?.transaction?.message?.instructions || [];
  const inner = (tx?.meta?.innerInstructions || []).flatMap((g: any) => g.instructions || []);
  let posted = false;

  for (const ix of [...top, ...inner]) {
    const pid = String(ix.programId || '');
    if (!progSet.has(pid) || !ix.data) continue;
    const hex = b58ToHex(String(ix.data));
    if (hex.length < 16) continue;
    const disc = hex.slice(0, 16);

    if (disc === CREATE_DISC) {
      if (await handleCreate(sig, tx)) posted = true;
    } else if (disc === SETTIME_DISC) {
      const accounts: string[] = (ix.accounts || []).map(String);
      const startTime = hex.length >= 32 ? u64le(hex.slice(16, 32)) : 0;
      if (await handleSetTime(sig, accounts[0] || '', startTime)) posted = true;
    }
  }
  return posted;
}

async function handleCreate(sig: string, tx: any): Promise<boolean> {
  const progSet = new Set(programs());
  const inner = (tx?.meta?.innerInstructions || []).flatMap((g: any) => g.instructions || []);

  // Distributor = the created account owned by the Boost program (space ~189/208; the tiny 12-byte one is auxiliary).
  let distributor = '';
  for (const ix of inner) {
    const p = ix.parsed;
    if (p?.type === 'createAccount' && progSet.has(String(p.info?.owner)) && Number(p.info?.space || 0) > 100) {
      distributor = String(p.info.newAccount);
    }
  }
  // Token transfer into the distributor's token account.
  let mint = '', amountHuman = '';
  for (const ix of inner) {
    const p = ix.parsed;
    if (p?.type === 'transferChecked' && p.info?.tokenAmount) {
      mint = String(p.info.mint);
      amountHuman = String(p.info.tokenAmount.uiAmountString ?? p.info.tokenAmount.uiAmount ?? '');
    }
  }
  if (!distributor || !mint || !amountHuman) {
    console.log('[solana] createDistributor %s…: missing pieces (dist=%s mint=%s amt=%s), skipping', sig.slice(0, 16), !!distributor, !!mint, !!amountHuman);
    return false;
  }

  const amountNum = Number(amountHuman);
  if (!Number.isNaN(amountNum) && amountNum < MIN_TOKEN_AMOUNT) {
    console.log('[solana] deposit below global minimum (%s), skipping', amountHuman);
    return false;
  }

  const dedupeKey = `deposit:solana:${sig}`;
  if (await isDuplicate(dedupeKey)) return false;

  const meta = await getSolTokenMeta(mint);
  const amountLine = `${formatNumberWithCommas(amountHuman)} $${meta.symbol}`;

  const message =
    `⚡ <b>${escHtml('NEW OKX DEPOSIT DETECTED')}</b>\n\n` +
    `Amount: ${escHtml(amountLine)}\n` +
    `Network: ${escHtml('Solana')}\n` +
    `<a href="${escHtml(solscanTx(sig))}">${escHtml('View on Scan')}</a>\n\n` +
    `<a href="https://t.me/cryptohornettg/1354">Refback 45%</a>`;

  if (SHADOW) {
    console.log('[solana] SHADOW: would send deposit', JSON.stringify({ distributor, amountLine, sig }));
    return false;
  }

  await sendTelegram(message);
  await markDuplicate(dedupeKey);
  await addTracked('solana', distributor, {
    depositTxHash: sig,
    addedAt: Number(tx.blockTime) || Math.floor(Date.now() / 1000),
    tokenAddress: mint,
    tokenSymbol: meta.symbol,
    amountHuman,
  });
  console.log('[solana] deposit notification sent', JSON.stringify({ distributor, amountLine, sig }));
  return true;
}

async function handleSetTime(sig: string, distributor: string, startTime: number): Promise<boolean> {
  if (!distributor || !startTime) return false;

  const tracked = await getTracked('solana', distributor);
  if (!tracked) {
    console.log('[solana] setTime for non-tracked distributor, skipping', JSON.stringify({ distributor, sig }));
    return false;
  }

  const dedupeKey = `settime:solana:${sig}`;
  if (await isDuplicate(dedupeKey)) return false;

  const amount = tracked.amountHuman ? formatNumberWithCommas(tracked.amountHuman) : '';
  const tokenLine = `${amount}${amount ? ' ' : ''}$${tracked.tokenSymbol}`.trim();

  const message =
    `⏰ <b>${escHtml('NEW SET TIME')}</b>\n\n` +
    `Token: ${escHtml(tokenLine)}\n` +
    `Network: ${escHtml('Solana')}\n` +
    `Claim Time: ${escHtml(fmtUtcKyiv(startTime))}\n` +
    `<a href="${escHtml(solscanTx(sig))}">${escHtml('View on Scan')}</a>\n\n` +
    `<a href="https://t.me/cryptohornettg/1354">Refback 45%</a>`;

  if (SHADOW) {
    console.log('[solana] SHADOW: would send setTime', JSON.stringify({ distributor, startTime, sig }));
    return false;
  }

  await sendTelegram(message);
  await markDuplicate(dedupeKey);
  console.log('[solana] setTime notification sent', JSON.stringify({ distributor, startTime, sig }));
  return true;
}
