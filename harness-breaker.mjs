// Proves the Telegram queue + circuit breaker actually stop a flood.
// No network: global.fetch is mocked. Nothing can reach Telegram.
process.env.TELEGRAM_BOT_TOKEN = 'test:token';
process.env.TELEGRAM_CHAT_ID = '-100999';
process.env.TELEGRAM_OWNER_ID = '825050522';
process.env.TG_MIN_SPACING_MS = '5';      // speed up the test
process.env.TG_BREAKER_WINDOW_MS = '600000';
process.env.TG_BREAKER_MAX = '8';

let channelSends = 0, ownerDMs = 0, mode = 'ok';
const calls = [];
global.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push(body.chat_id);
  if (String(body.chat_id) === process.env.TELEGRAM_OWNER_ID) {
    ownerDMs++;
    return { ok: true, text: async () => 'ok' };
  }
  channelSends++;
  if (mode === '429') {
    return {
      ok: false, status: 429,
      text: async () => JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 34 } }),
    };
  }
  return { ok: true, text: async () => 'ok' };
};

const { sendTelegram, breakerStatus, resetBreaker } = await import('./dist/telegram.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('--- TEST 1: flood of 50 messages must NOT all go out ---');
for (let i = 0; i < 50; i++) await sendTelegram(`flood ${i}`);
await sleep(3000);
console.log(`  channel sends: ${channelSends}  (cap is TG_BREAKER_MAX=8)`);
console.log(`  owner DMs:     ${ownerDMs}`);
console.log(`  breaker:       ${JSON.stringify(breakerStatus())}`);
const t1 = channelSends <= 8 && ownerDMs === 1 && breakerStatus().open;
console.log(`  => ${t1 ? 'PASS' : 'FAIL'} (breaker opened, queue dropped, exactly 1 owner DM)\n`);

console.log('--- TEST 2: while breaker is open, nothing reaches the channel ---');
const before = channelSends;
for (let i = 0; i < 10; i++) await sendTelegram(`suppressed ${i}`);
await sleep(500);
console.log(`  additional channel sends: ${channelSends - before}`);
const t2 = channelSends === before;
console.log(`  => ${t2 ? 'PASS' : 'FAIL'}\n`);

console.log('--- TEST 3: a 429 opens the breaker and is never retried ---');
resetBreaker(); channelSends = 0; ownerDMs = 0; mode = '429';
for (let i = 0; i < 5; i++) await sendTelegram(`will-429 ${i}`);
await sleep(2000);
console.log(`  channel attempts: ${channelSends}  (must be 1: first 429 stops everything)`);
console.log(`  owner DMs:        ${ownerDMs}`);
console.log(`  breaker:          ${JSON.stringify(breakerStatus())}`);
const t3 = channelSends === 1 && ownerDMs === 1 && breakerStatus().open;
console.log(`  => ${t3 ? 'PASS' : 'FAIL'}\n`);

console.log('--- TEST 4: sendTelegram never throws ---');
resetBreaker(); mode = 'throw';
global.fetch = async () => { throw new Error('network down'); };
let threw = false;
try { await sendTelegram('x'); await sleep(300); } catch { threw = true; }
console.log(`  threw: ${threw}`);
console.log(`  => ${!threw ? 'PASS' : 'FAIL'}\n`);

const all = t1 && t2 && t3 && !threw;
console.log(`=========== ${all ? 'ALL PASS' : 'FAILURES PRESENT'} ===========`);
process.exit(all ? 0 : 1);
