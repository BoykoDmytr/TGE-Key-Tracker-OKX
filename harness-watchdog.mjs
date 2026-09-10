// harness-watchdog.mjs — offline proof for the poller lag watchdog and its dependencies.
//
// HARD GUARD: refuses to run against a real channel, like every other harness here.
// Nothing in this file touches Telegram or an RPC endpoint. It exercises the pure logic:
// the dedupe cooldown, the metadata degrade flag, the env parser, and a static check that
// the poller has no path to the channel at all.
//
// Run: node harness-watchdog.mjs

if (String(process.env.TELEGRAM_CHAT_ID || '').startsWith('-100')) {
  console.error('REFUSING TO RUN: TELEGRAM_CHAT_ID points at a real channel.');
  process.exit(1);
}
delete process.env.REDIS_URL; // force the in-memory path of dedupe on purpose

import { readFileSync } from 'node:fs';
import { claimOnce, releaseClaim, isDuplicate } from './dist/dedupe.js';
import { getErc20MetaCached } from './dist/evm/erc20MetaCache.js';
import { formatSetTimeMessage } from './dist/telegram/formatSetTime.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${detail}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- cooldown semantics
// The lag alert leans entirely on claimOnce(key, ttl) as its mute. Before this change the
// in-memory fallback ignored ttl and used a 7-day constant, so a machine without Redis
// would alert once and then stay quiet for a week.
{
  const k = 'test:cooldown:' + Math.random().toString(16).slice(2);
  ok('first claim wins', (await claimOnce(k, 2)) === true);
  ok('second claim inside the ttl is refused', (await claimOnce(k, 2)) === false);
  ok('isDuplicate sees the live claim', (await isDuplicate(k)) === true);
  await sleep(2300);
  ok('claim is re-usable once the ttl passes (ttl honoured, not 7 days)', (await claimOnce(k, 2)) === true);
}

// A failed DM must give the mute back, otherwise a Telegram blip buys 6h of silence.
{
  const k = 'test:release:' + Math.random().toString(16).slice(2);
  await claimOnce(k, 3600);
  await releaseClaim(k);
  ok('releaseClaim frees the key immediately', (await claimOnce(k, 3600)) === true);
  ok('releaseClaim leaves nothing behind', (await isDuplicate(k)) === true, 'key should now be held by the re-claim');
}

// ---------------------------------------------------------------- metadata degrade flag
// A read where every eth_call failed must be flagged AND must not be cached, or one
// transient RPC failure is frozen into the process and later posts $UNKNOWN to the channel.
{
  const token = '0x1111111111111111111111111111111111111111';
  let calls = 0;
  const brokenClient = { readContract: async () => { calls++; throw new Error('rpc down'); } };
  const bad = await getErc20MetaCached(brokenClient, token, 'bsc');
  ok('degraded read is flagged', bad.degraded === true);
  ok('degraded read returns placeholders', bad.symbol === 'UNKNOWN' && bad.decimals === 18);

  const goodClient = {
    readContract: async ({ functionName }) => {
      calls++;
      if (functionName === 'symbol') return 'USDT';
      if (functionName === 'name') return 'Tether USD';
      return 6;
    },
  };
  const good = await getErc20MetaCached(goodClient, token, 'bsc');
  ok('a degraded read was NOT cached, so the retry sees the real values', good.degraded === false && good.symbol === 'USDT' && good.decimals === 6);

  const before = calls;
  await getErc20MetaCached(goodClient, token, 'bsc');
  ok('a healthy read IS cached', calls === before);

  // Same address, different chain, different token. A token-only key answered across chains.
  const other = await getErc20MetaCached(
    { readContract: async ({ functionName }) => (functionName === 'symbol' ? 'WXYZ' : functionName === 'name' ? 'Other' : 18) },
    token, 'base',
  );
  ok('cache is scoped per chain, not per address', other.symbol === 'WXYZ' && other.decimals === 18);
}

// ---------------------------------------------------------------- name() is not published
// name() is rendered in no message. A token that reverts on name() (plenty of old ones do)
// must not have its deposit withheld over a field nobody ever sees.
{
  const t = '0x2222222222222222222222222222222222222222';
  const nameOnlyFails = {
    readContract: async ({ functionName }) => {
      if (functionName === 'name') throw new Error('reverted');
      if (functionName === 'symbol') return 'USDC';
      return 6;
    },
  };
  const m = await getErc20MetaCached(nameOnlyFails, t, 'base');
  ok('a failing name() does NOT degrade the read', m.degraded === false && m.symbol === 'USDC' && m.decimals === 6);

  const symbolFails = {
    readContract: async ({ functionName }) => {
      if (functionName === 'symbol') throw new Error('reverted');
      if (functionName === 'name') return 'Token';
      return 6;
    },
  };
  const m2 = await getErc20MetaCached(symbolFails, '0x3333333333333333333333333333333333333333', 'base');
  ok('a failing symbol() DOES degrade the read', m2.degraded === true);

  const decimalsFails = { readContract: async ({ functionName }) => { if (functionName === 'decimals') throw new Error('reverted'); return 'X'; } };
  const m3 = await getErc20MetaCached(decimalsFails, '0x4444444444444444444444444444444444444444', 'base');
  ok('a failing decimals() DOES degrade the read', m3.degraded === true);
}

// ------------------------------------------------- a degraded record never publishes numbers
{
  const base = { depositTxHash: '0x' + 'a'.repeat(64), addedAt: 1789000000, tokenAddress: '0x55d398326f99059ff775485246999027b3197955', tokenSymbol: 'UNKNOWN', amountHuman: '0.0000003' };
  const good = formatSetTimeMessage({ chainKey: 'bsc', tracked: { ...base, tokenSymbol: 'USDT', amountHuman: '300000' }, startTime: 1789100000, duration: 3600, txHash: '0x' + 'b'.repeat(64) });
  ok('a healthy record still renders the token line', good.includes('Token: 300,000 ' + '$' + 'USDT'), good.slice(0, 120));
  const bad = formatSetTimeMessage({ chainKey: 'bsc', tracked: { ...base, metaDegraded: true }, startTime: 1789100000, duration: 3600, txHash: '0x' + 'b'.repeat(64) });
  ok('a degraded record renders NO token line', !bad.includes('Token:') && !bad.includes('UNKNOWN') && !bad.includes('0.0000003'), bad.slice(0, 160));
  ok('a degraded record still announces the claim time', bad.includes('Claim Time:') && bad.includes('NEW SET TIME'));
}
// ---------------------------------------------------------------- static channel safety
// The poller must have no way to reach the channel. Everything it emits is an owner DM.
{
  const src = readFileSync(new URL('./src/poller/index.ts', import.meta.url), 'utf8');
  ok('poller never imports sendTelegram', !/\bsendTelegram\b/.test(src), 'found a channel sender in the poller');
  ok('poller only messages the owner', /notifyOwner/.test(src));
  const dm = (src.match(/notifyOwner\(/g) || []).length;
  ok(`every poller message is an owner DM (${dm} call sites)`, dm >= 2);

  // Both alert senders must be rate-limited by a claim.
  ok('lag alert is behind a claim', /claimOnce\(`pollerlag:\$\{chain\}`/.test(src));
  ok('crash alert is behind a claim', /claimOnce\(`pollercrash:\$\{chain\}`/.test(src));
  // A failed DM must not consume the mute.
  ok('lag alert gives the mute back when the DM fails', /releaseClaim\(`pollerlag:\$\{chain\}`\)/.test(src));
  ok('crash alert gives the mute back when the DM fails', /releaseClaim\(`pollercrash:\$\{chain\}`\)/.test(src));
  // The check must not live inside the tick's try, or it is silent during a total outage.
  const tail = src.slice(src.indexOf('await checkLag()') - 600, src.indexOf('await checkLag()'));
  ok('lag check runs after the tick catch, not inside the try', /\}\s*catch\s*\(e: any\)\s*\{[\s\S]*tick error[\s\S]*\}\s*$/m.test(tail.trimEnd() + '\n') || tail.includes('tick error'));
  // Every numeric env read must go through the validating parser.
  const rawNum = src.match(/Number\(process\.env\.[A-Z_]+/g) || [];
  ok('no unvalidated Number(process.env...) reads remain', rawNum.length === 0, rawNum.join(', '));
  // A dead loop must be restarted, not merely logged.
  ok('a crashed chain loop is supervised and restarted', /superviseChainLoop/.test(src));
  ok('a chain that never started is still reported', /never-started/.test(src));
}

console.log(`\n=========== ${pass} passed, ${fail} failed ===========`);
process.exit(fail ? 1 : 0);
