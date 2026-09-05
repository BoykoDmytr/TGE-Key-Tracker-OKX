// src/filter/spamFilter.ts
//
// Decides whether a deposit is a real OKX Boost campaign or self-serve spam.
//
// WHY THIS SHAPE — the counter-intuitive part, measured on all 289 historical factory
// events (both factories, 4 chains, since the factory deployed 2025-11-28):
//
// Token-quality signals are INVERTED here and must never be used. The spam tokens are
// POPULAR memecoins (OKOX 4,548 holders, OEOE 9,327, DOG 10,169 — thousands of transfers,
// live DEX pools). The valuable deposits are pre-TGE tokens that look dead: KII at its
// deposit block had 4 transfers, 3 holders, no pool, and no entry on CoinGecko,
// DexScreener, GeckoTerminal or Sourcify. Every market/liquidity/holder/verification
// check tested returns "junk" for KII — the single most valuable post of that month.
// An OKX campaign page is no good either: it appears 2-24 h AFTER the on-chain setTime
// (KII's appeared 4.3 days after the deposit).
//
// What separates them is the DEPOSIT, not the token:
//   share of totalSupply : spam 0.000005-0.001 %   legit floor 0.2 % (CAP)  -> 100x margin
//   creator history      : spam 46-49 priors        legit max 2
//
// Nothing here is ever silently dropped: anything not clearly legit goes to the owner's
// DM with an approve button, because a missed real deposit costs subscribers too.

import type { ChainKey } from '../evm/provider.js';

export type Verdict = 'legit' | 'spam' | 'unsure';

export interface FilterInput {
  chainKey: ChainKey;
  token: string;
  creator: string;
  operator: string;
  /** amount credited to the distributor, from Transfer logs (attacker-influenced) */
  landed: bigint;
  /** balanceOf(distributor) — state, not logs. null when unavailable. */
  balance: bigint | null;
  /** totalSupply() of the token. null when unreadable. */
  totalSupply: bigint | null;
  decimals: number;
  /** distinct distributors this creator has made before. null = unknown. */
  creatorPriors: number | null;
  /**
   * Is `balance` comparable to `landed`?
   * Only when the deposit was seen live: balanceOf is read at the chain head, so for
   * any historical replay the tokens have since been claimed and the balance is
   * legitimately LOWER than what landed. Comparing them there would mark every real
   * campaign as suspicious and silence the channel.
   */
  balanceCheckable: boolean;
}

export interface FilterResult {
  verdict: Verdict;
  /** short machine-readable rule id, safe to log and to show in a DM */
  rule: string;
  /** human explanation, built only from OUR numbers — never from token-supplied strings */
  detail: string;
  sharePpb: bigint | null;
}

// ---- tunables (env-overridable, defaults are the measured ones) ----

/** Below this share of totalSupply a non-stablecoin deposit is dust. 0.002 % = 20_000 ppb.
 *  Highest spam observed: LISTA BANK at 10_000 ppb. Lowest legit: CAP at 2_000_000 ppb. */
const SPAM_SHARE_PPB = BigInt(process.env.FILTER_SPAM_SHARE_PPB || 20_000);

/** At or above this share a deposit is a real campaign. 0.05 % = 500_000 ppb.
 *  Every legitimate non-stablecoin deposit in history clears this by 4x or more. */
const LEGIT_SHARE_PPB = BigInt(process.env.FILTER_LEGIT_SHARE_PPB || 500_000);

/** Serial self-serve spammers. Legit maximum in history is 2. */
const SPAM_PRIOR_COUNT = Number(process.env.FILTER_SPAM_PRIORS || 3);

/** Minimum stablecoin deposit worth posting. A real USDT 9,999 campaign exists, so 5000. */
const STABLE_MIN_UNITS = Number(process.env.FILTER_STABLE_MIN || 5000);

/**
 * Canonical stablecoins, BY ADDRESS — never by symbol.
 * symbol() is a string the token contract returns, so a spammer simply names their coin
 * "USDT". These six are every stablecoin that has ever appeared in a real deposit.
 */
const DEFAULT_STABLES: Record<string, string[]> = {
  bsc: ['0x55d398326f99059ff775485246999027b3197955'],                 // USDT
  ethereum: ['0xdac17f958d2ee523a2206206994597c13d831ec7'],            // USDT
  base: ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'],                // USDC
  xlayer: [
    '0x779ded0c9e1022225f8e0630b35a9b54be713736',                      // USD₮0
    '0x4ae46a509f6b1d9056937ba4500cb143933d2dc8',                      // USDG
    '0x74b7f16337b8972027f6196a17a631ac6de26d22',                      // USDC
  ],
};

/**
 * PER-CHAIN TOKEN ALLOWLIST — the simplest rule that solves the actual problem.
 *
 * The spam is confined to X Layer, and every legitimate X Layer deposit in the bot's
 * entire history was a stablecoin: 12 deposits over the 5000-token floor, 8 legitimate
 * (USD₮0 x6, USDC, USDG) and 4 spam (OKOX x2, DOG, OEOE). Even the AIW3 X Launch on
 * X Layer was funded in USD₮0 — OKX funds campaigns on its own chain in stablecoins.
 * So on X Layer a three-address allowlist separates them perfectly, with no RPC call,
 * no heuristic and no added latency.
 *
 * A chain with an allowlist is judged ONLY by it. A chain without one is not touched at
 * all (see filterAppliesTo). Anything not on the list goes to the owner for one tap —
 * never silently dropped.
 */
const DEFAULT_ALLOWLIST: Record<string, string[]> = {
  xlayer: [
    '0x779ded0c9e1022225f8e0630b35a9b54be713736', // USD₮0 — 6 of the 8 legit deposits
    '0x4ae46a509f6b1d9056937ba4500cb143933d2dc8', // USDG  — RWA season competitions
    '0x74b7f16337b8972027f6196a17a631ac6de26d22', // USDC
  ],
};

/** Returns null when this chain has no allowlist (then it is not allowlist-judged). */
export function allowlistFor(chain: ChainKey): Set<string> | null {
  let cfg: Record<string, string[]> = DEFAULT_ALLOWLIST;
  const raw = process.env.FILTER_ALLOWLIST_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') cfg = parsed;
    } catch {
      console.error('[filter] FILTER_ALLOWLIST_JSON is malformed — using the built-in list');
    }
  }
  const list = cfg[chain];
  if (!Array.isArray(list) || list.length === 0) return null;
  return new Set(list.map((a) => String(a).toLowerCase()));
}

function stablesFor(chain: ChainKey): Set<string> {
  const out = new Set((DEFAULT_STABLES[chain] || []).map((a) => a.toLowerCase()));
  // FILTER_STABLE_TOKENS_JSON = {"xlayer":["0x…"],"bsc":["0x…"]} — additive, never replaces
  try {
    const extra = JSON.parse(process.env.FILTER_STABLE_TOKENS_JSON || '{}');
    for (const a of extra?.[chain] || []) out.add(String(a).toLowerCase());
  } catch {
    console.error('[filter] FILTER_STABLE_TOKENS_JSON is malformed — using built-in list only');
  }
  return out;
}

/** Creators known to be self-serve spammers. Belt and braces: the prior count catches them
 *  anyway, but this stays correct even if the creator index is cold after a Redis wipe. */
const BLOCKLIST = new Set(
  (process.env.FILTER_CREATOR_BLOCKLIST ||
    // 49 / 75 / 24 distributors respectively, every one of them dust (max share 0.001%)
    '0x2c825edb17c2c04983a481ebd2da2a39424c7cb7,' +
    '0x41ca99b7a5f95f49c2b0861a8623c9f46293e09c,' +
    '0x906bab6fdfd399e9f710bd98ba84bba6696fc034')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
);

const fmtPpb = (ppb: bigint): string => {
  const pct = Number(ppb) / 1e7; // ppb -> percent
  return pct >= 0.01 ? `${pct.toFixed(3)}%` : `${pct.toExponential(2)}%`;
};

/**
 * Pure function — no I/O, so it is fully unit-testable and cannot slow a post down.
 * Callers gather the inputs; this only decides.
 */
export function classifyDeposit(inp: FilterInput): FilterResult {
  const { landed, balance, totalSupply, creatorPriors } = inp;

  // ---- 1. Evidence guards. A missing or absurd operand must never produce a verdict of
  // "spam" — that is the one outcome that hides a real deposit. Fall through to review.
  if (landed <= 0n) {
    return { verdict: 'unsure', rule: 'no-amount', detail: 'deposit amount could not be determined', sharePpb: null };
  }
  if (totalSupply == null || totalSupply <= 0n) {
    return { verdict: 'unsure', rule: 'no-supply', detail: 'totalSupply() unreadable', sharePpb: null };
  }
  if (landed > totalSupply) {
    return { verdict: 'unsure', rule: 'amount-gt-supply', detail: 'credited amount exceeds total supply', sharePpb: null };
  }
  // The amount we post comes from Transfer LOGS, which the token contract itself emits and
  // can therefore fabricate. balanceOf is contract STATE. If the state does not back the
  // logs, the numbers are not trustworthy — review it, never auto-post it.
  if (inp.balanceCheckable && balance != null && balance < landed) {
    return {
      verdict: 'unsure', rule: 'balance-mismatch',
      detail: 'Transfer logs claim more than the distributor actually holds', sharePpb: null,
    };
  }

  const sharePpb = (landed * 1_000_000_000n) / totalSupply;

  // ---- 1b. Allowlisted chain: the list is the whole decision. Matched BY ADDRESS —
  // symbol() is a string the spammer's own contract returns, so "USDT" proves nothing.
  const allow = allowlistFor(inp.chainKey);
  if (allow) {
    if (allow.has(inp.token.toLowerCase())) {
      return { verdict: 'legit', rule: 'allowlist', detail: 'token is on the allowlist for this chain', sharePpb };
    }
    return {
      verdict: 'unsure', rule: 'not-allowlisted',
      detail: 'token is not on the allowlist for this chain', sharePpb,
    };
  }

  // ---- 2. Stablecoins are exempt from the share test: a campaign funded in USDT is a
  // rounding error of the stablecoin's supply by definition (USDG sat at 27_300 ppb).
  const isStable = stablesFor(inp.chainKey).has(inp.token.toLowerCase());
  if (isStable) {
    const minRaw = BigInt(STABLE_MIN_UNITS) * 10n ** BigInt(inp.decimals);
    if (landed >= minRaw) {
      return { verdict: 'legit', rule: 'stablecoin', detail: `canonical stablecoin, ${STABLE_MIN_UNITS}+ units`, sharePpb };
    }
    return { verdict: 'unsure', rule: 'stablecoin-small', detail: `stablecoin below ${STABLE_MIN_UNITS} units`, sharePpb };
  }

  // ---- 3. Serial creator.
  //
  // A healthy share OVERRIDES this. Real projects do repeat: the wallet behind ZAMA made
  // three deposits (share 3.37%), and the USDG/USD₮0 depositor made three as well. On
  // their next one a bare "3+ distributors = spam" rule would have silently killed a real
  // campaign. So when the share alone already says "real", a serial creator can only
  // demote it to a human decision — never to silence.
  const priors = creatorPriors ?? 0;
  const blocklisted = BLOCKLIST.has(inp.creator.toLowerCase());
  const serial = blocklisted || (creatorPriors != null && priors >= SPAM_PRIOR_COUNT);
  if (serial) {
    const rule = blocklisted ? 'creator-blocklist' : 'creator-serial';
    const who = blocklisted ? 'creator is a known self-serve spammer' : `creator has made ${priors} distributors`;
    if (sharePpb >= LEGIT_SHARE_PPB) {
      return {
        verdict: 'unsure', rule: rule + '-but-large',
        detail: `${who}, but this deposit is ${fmtPpb(sharePpb)} of supply`,
        sharePpb,
      };
    }
    return { verdict: 'spam', rule, detail: who, sharePpb };
  }

  // ---- 4. Dust share. 100x margin below the smallest real campaign.
  if (sharePpb < SPAM_SHARE_PPB) {
    return { verdict: 'spam', rule: 'dust-share', detail: `only ${fmtPpb(sharePpb)} of total supply`, sharePpb };
  }

  // ---- 5. Real campaign.
  if (sharePpb >= LEGIT_SHARE_PPB) {
    return { verdict: 'legit', rule: 'share', detail: `${fmtPpb(sharePpb)} of total supply`, sharePpb };
  }

  // ---- 6. The band in between is deliberately undecided: a human looks at it.
  return { verdict: 'unsure', rule: 'ambiguous-share', detail: `${fmtPpb(sharePpb)} of total supply — between the thresholds`, sharePpb };
}

export type FilterMode = 'off' | 'shadow' | 'enforce';

/** off = behave exactly as before (default). shadow = decide and log, change nothing.
 *  enforce = route non-legit deposits to the owner instead of the channel. */
export function filterMode(): FilterMode {
  const m = String(process.env.FILTER_MODE || 'off').toLowerCase();
  return m === 'enforce' ? 'enforce' : m === 'shadow' ? 'shadow' : 'off';
}

/** Which chains the filter applies to. Empty = all. Lets X Layer be filtered first. */
export function filterAppliesTo(chain: ChainKey): boolean {
  const raw = String(process.env.FILTER_CHAINS || '').trim();
  if (!raw) return true;
  return raw.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean).includes(chain);
}
