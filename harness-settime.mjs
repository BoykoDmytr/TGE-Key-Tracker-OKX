// Replays the REAL 400k setTime tx through the live handler in shadow mode.
// notify:false => cannot post, cannot claim. Uses prod Redis READ-ONLY (getTracked).
process.env.TELEGRAM_BOT_TOKEN='';
process.env.TELEGRAM_CHAT_ID='';
process.env.REDIS_URL='rediss://default:gQAAAAAAAhEhAAIgcDIzZDQ3NjIwM2RiOTA0MjAzOGU2NjNkNTQzM2IyOGMwOA@sensible-akita-135457.upstash.io:6379';
const { processSetTimeTx } = await import('./dist/handlers.js');
const { getPollerClient } = await import('./dist/poller/clients.js');

const TX='0x0f237f6da46d8b158c6402e53a6a75d291b509ccd7dfa16576f9c3d4912e34fb';
const c = getPollerClient('xlayer');
const tx = await c.getTransaction({hash:TX});
console.log('tx.to      :', tx.to);
console.log('selector   :', tx.input.slice(0,10), '(setTime = 0xa0355eca)');

let msg=null;
const log={ info:(o,m)=>{ if(typeof m==='string'){ console.log('  LOG:', m, JSON.stringify(o).slice(0,200)); if(o?.preview) msg=o.preview; } } };
const r = await processSetTimeTx(
  { chainKey:'xlayer', txHash:TX, to:tx.to, input:tx.input },
  { notify:false, source:'poller', log },
);
console.log('\nresult:', JSON.stringify(r));
console.log(msg ? '\n=> WOULD HAVE POSTED. Preview:\n' + msg : '\n=> NO MESSAGE');
process.exit(0);
