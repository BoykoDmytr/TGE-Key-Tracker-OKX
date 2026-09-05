// SPAM-FILTER HARNESS — replays real deposits through the real classifier.
//
// SAFETY: this harness must never be able to reach a Telegram channel.
//  - no bot token and no chat id are present, so a send would throw before any network call
//  - it refuses to start if TELEGRAM_CHAT_ID looks like a real channel
//  - processDepositTx is called with notify:false and persist:false
delete process.env.REDIS_URL;
if (String(process.env.TELEGRAM_CHAT_ID || '').startsWith('-100')) {
  console.error('REFUSING TO RUN: TELEGRAM_CHAT_ID looks like a real channel');
  process.exit(1);
}
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
process.env.THRESHOLDS_JSON = '{}';
process.env.FACTORIES_DEFAULT =
  '0x000310fa98E36191ec79de241d72C6CA093EAFd3,0x00306cEfc385c8767cA580913a3F88319a343FC0';
process.env.FILTER_MODE = 'shadow';   // decide + log, change nothing

const { processDepositTx } = await import('./dist/handlers.js');
const { getPollerClient } = await import('./dist/poller/clients.js');
const { classifyDeposit } = await import('./dist/filter/spamFilter.js');

// [chain, tx, expectedVerdict, label]
const CASES = [
  // --- spam that reached the channel and must not again ---
  ['xlayer', '0x08e590e10f7c2851facc369ae4291575671ee941b0a780f1182edb8e825bf874', 'spam', 'OKOX 100k (02.09)'],
  ['bsc',    '0xa0869f508c8bf00be098662708077daa282284d47eb8e842d194c030bc38102b', 'spam', 'LISTA BANK 10k (02.09)'],
  ['xlayer', '0x005de7e37b12febf0f6e3d894ee7ba15c84f82cbfc3981b2bc849dfdf28afa10', 'spam', 'OEOE 5k (03.09)'],
  ['xlayer', '0x82b5bfd1068ad4b41759a72a81809daa39948c8adab1ac68fb336166bffbb16e', 'spam', 'DOG 19.8k (05.08 flood)'],
  // --- real campaigns that must keep posting ---
  ['bsc',    '0x036de29262552683b323d18f04d1980895e69b7f941c584dd341e28a93e49eae', 'legit', 'KII 5.4M — PRE-TGE, no market'],
  ['base',   '0xa47d26839305f41ca8d1316ccda63e5854ec4108961a09c1ec095be7ce9f6501', 'legit', 'CP 17M — pre-market'],
  ['xlayer', '0x4ca80dd9209dc3a8b26aaf505f198729bd2abcf38fe8a66db4ce19c1f683fe8a', 'legit', 'USDG 50k (stablecoin)'],
  ['xlayer', '0x7152fcb56ba8a4af338f50ed2b8e44531ff48ab7b2f450ca8a886fc1556d5ecc', 'legit', 'USD₮0 400k (stablecoin)'],
  ['bsc',    '0x8c93bf66cb8b69c1c0a9b99acf7909c82f9478d38f4af250fd9a03315c51ddf5', 'legit', 'AEON 5M'],
  ['bsc',    '0xf38e738917a80e23f1c21faf48cefa9eacd70a29e45b3474ca521cda1f9559d1', 'legit', 'SLX 3M (OLD factory)'],
  ['bsc',    '0x30ca0e5e8a533a9ecb219c45e4aadac8ccf0e1d22ca3d1baa26e30606f2da99a', 'legit', 'CAP 20M'],
];

let pass = 0, fail = 0;
console.log('=== live replay through the real classifier (creator index empty = worst case) ===\n');
for (const [chain, tx, want, label] of CASES) {
  let got = null, rule = '', detail = '';
  const log = {
    info: (o, m) => { if (typeof m === 'string' && m.includes('FILTER verdict')) { got = o.verdict; rule = o.rule; detail = o.detail; } },
  };
  try {
    await processDepositTx(chain, tx, getPollerClient(chain), {
      notify: false, persist: false, source: 'poller', blockTimestamp: 0, log,
    });
  } catch (e) {
    console.log(`FAIL  ${label.padEnd(34)} threw: ${e.message.slice(0, 60)}`); fail++; continue;
  }
  const ok = got === want;
  console.log(`${(ok ? 'PASS' : 'FAIL ***').padEnd(9)} ${label.padEnd(34)} verdict=${String(got).padEnd(7)} want=${String(want).padEnd(7)} [${rule}] ${detail}`);
  ok ? pass++ : fail++;
}

// --- unit checks that need no chain: the creator rule and the guards ---
console.log('\n=== unit: creator history and evidence guards ===');
const base = {
  chainKey: 'xlayer', token: '0xdead', creator: '0xc0ffee', operator: '0x7a39c61a',
  landed: 10n ** 22n, balance: 10n ** 22n, totalSupply: 10n ** 24n, decimals: 18, creatorPriors: 0, balanceCheckable: true,
};
const units = [
  ['serial creator + dust share -> spam', { ...base, creatorPriors: 49, landed: 10n ** 16n }, 'spam'],
  ['fresh creator, healthy share -> legit', { ...base, creatorPriors: 0 }, 'legit'],
  ['unknown creator (null) never convicts', { ...base, creatorPriors: null }, 'legit'],
  ['fake Transfer log (balance < landed) -> unsure', { ...base, balance: 0n }, 'unsure'],
  ['totalSupply unreadable -> unsure, never spam', { ...base, totalSupply: null }, 'unsure'],
  ['zero amount -> unsure, never spam', { ...base, landed: 0n }, 'unsure'],
  ['landed > supply -> unsure', { ...base, landed: 10n ** 30n }, 'unsure'],
  ['ZAMA-shaped: serial creator BUT big share -> unsure, never spam', { ...base, creatorPriors: 9 }, 'unsure'],
  ['blocklisted creator with big share -> unsure, never spam', { ...base, creator: '0x2c825edb17c2c04983a481ebd2da2a39424c7cb7' }, 'unsure'],
  ['blocklisted creator with dust share -> spam', { ...base, creator: '0x2c825edb17c2c04983a481ebd2da2a39424c7cb7', landed: 10n ** 16n }, 'spam'],
];
for (const [name, inp, want] of units) {
  const r = classifyDeposit(inp);
  const ok = r.verdict === want;
  console.log(`${(ok ? 'PASS' : 'FAIL ***').padEnd(9)} ${name.padEnd(44)} -> ${r.verdict} [${r.rule}]`);
  ok ? pass++ : fail++;
}

console.log(`\n=========== ${pass} passed, ${fail} failed ===========`);
process.exit(fail ? 1 : 0);
