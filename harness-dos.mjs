delete process.env.REDIS_URL; delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_CHAT_ID;
process.env.THRESHOLDS_JSON='{}';
process.env.FACTORIES_DEFAULT='0x000310fa98E36191ec79de241d72C6CA093EAFd3,0x00306cEfc385c8767cA580913a3F88319a343FC0';
const { processDepositTx } = await import('./dist/handlers.js');
const { getPollerClient } = await import('./dist/poller/clients.js');
let n=0; const seen=[];
const log={info:(o,m)=>{ if(typeof m==='string'&&m.includes('would send deposit')){n++;seen.push(o);} }};
const r = await processDepositTx('bsc','0x7dff661f7bffa7c63aceb2ee63562003d0393abf2c5b8ed084c6fa9c109e947c',
  getPollerClient('bsc'), {notify:false,persist:false,source:'poller',blockTimestamp:0,log});
console.log('messages:', n, '| result:', JSON.stringify(r));
for(const s of seen) console.log(`  ${s.amountLine}  ->  ${s.to}`);
process.exit(0);
