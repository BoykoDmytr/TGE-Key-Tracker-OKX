// SAFETY HARNESS — reproduces the 2026-08-05 flood on the real X Layer tx.
// notify:false + persist:false + NO Redis + NO Telegram creds => cannot post, cannot write prod state.
delete process.env.REDIS_URL;          // force in-memory dedupe (prod Redis untouched)
delete process.env.TELEGRAM_BOT_TOKEN; // if anything tried to send, it would throw instead
delete process.env.TELEGRAM_CHAT_ID;
process.env.THRESHOLDS_JSON = '{}';
// Same value as prod (verified in `fly secrets list`): without it the factory allowlist is
// empty and EVERY event is rejected — which looks like "0 messages, fixed!" but is really
// "detection is off". The guard in handlers.ts now shouts if this is missing.
process.env.FACTORIES_DEFAULT =
  '0x000310fa98E36191ec79de241d72C6CA093EAFd3,0x00306cEfc385c8767cA580913a3F88319a343FC0';

const { processDepositTx } = await import('./dist/handlers.js');
const { getPollerClient } = await import('./dist/poller/clients.js');

const TX = '0x82b5bfd1068ad4b41759a72a81809daa39948c8adab1ac68fb336166bffbb16e';

let wouldSend = 0;
const seen = [];
const log = {
  info: (obj, msg) => {
    if (typeof msg === 'string' && msg.includes('would send deposit')) {
      wouldSend++;
      seen.push(`${obj.amountLine}  -> ${obj.to}`);
    }
  },
};

const client = getPollerClient('xlayer');
const res = await processDepositTx('xlayer', TX, client, {
  notify: false,
  persist: false,
  source: 'poller',
  blockTimestamp: 1785926059,
  log,
});

console.log('\n================ RESULT ================');
console.log('tx:', TX);
console.log('messages the bot WOULD post:', wouldSend);
console.log('handler returned:', JSON.stringify(res));
console.log('\n--- each would-be message ---');
for (const s of seen) console.log('  ', s);
console.log('\nEXPECTED AFTER FIX: 1   (19,800 $DOG -> 0x65b70a3aa94b6ed6fc8efaa3a584a939aaf4b1dd)');
console.log('=======================================\n');
