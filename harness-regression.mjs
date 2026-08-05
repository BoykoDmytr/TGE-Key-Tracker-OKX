// REGRESSION HARNESS — replays every real historical deposit we know about.
// Each must still produce EXACTLY 1 message with the amount recorded in Redis.
// Covers both factories (OLD has no amount in its event) across 5 chains.
delete process.env.REDIS_URL;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
process.env.THRESHOLDS_JSON = '{}';
process.env.FACTORIES_DEFAULT =
  '0x000310fa98E36191ec79de241d72C6CA093EAFd3,0x00306cEfc385c8767cA580913a3F88319a343FC0';

const { processDepositTx } = await import('./dist/handlers.js');
const { getPollerClient } = await import('./dist/poller/clients.js');

// [chain, txHash, expectedDistributor, expectedAmountSubstring, note]
const CASES = [
  ['xlayer', '0x7152fcb56ba8a4af338f50ed2b8e44531ff48ab7b2f450ca8a886fc1556d5ecc', '0xa49d69822bfc0d3a4e5c8baac1ed458cec253df7', '400,000', 'new factory'],
  ['xlayer', '0x9a62092548c38fe54cf2629f4309aa5815f3f1f058c74b947e76d0fd541edbf3', '0xbd0933872409be682e92ab8069359e5e852128ed', '250,000', 'new factory'],
  ['xlayer', '0x6bfd5341e6ca08cdaf7fe60392a67bd2c0e8028e83f930a46a0893087bcb6000', '0x53cc9d0882a02e3f9340913cf50e86f5bfa4d872', '50,000', 'new factory'],
  ['bsc', '0x8c93bf66cb8b69c1c0a9b99acf7909c82f9478d38f4af250fd9a03315c51ddf5', '0x57e79239204567b996bf404947f9d056cc4a2afe', '5,000,000', 'AEON'],
  ['bsc', '0xf38e738917a80e23f1c21faf48cefa9eacd70a29e45b3474ca521cda1f9559d1', '0x677a017ab97aec3895aabe1e25af3c15339e78f8', '3,000,000', 'OLD FACTORY (no amount in event)'],
  ['bsc', '0x30ca0e5e8a533a9ecb219c45e4aadac8ccf0e1d22ca3d1baa26e30606f2da99a', '0x6f4a11d6d6d4701f0c78fb06b3ee82424e67fb6b', '20,000,000', 'CAP'],
  ['bsc', '0x6dff67537c73217df68b3bd4b2e9b1a82c71f0ee5ac69a642b24a85fa299323b', '0x5e56069ca9c90b4dfef8e6ca9c55039f197ba07f', '4,000,000', 'VEERA'],
  ['bsc', '0xdb8bd60ebe4bb3f8a299a79222dcd9108da647e5e97831cab1635ede0d3f81ec', '0xea4ad13dc8503c6ee43977d78ab53f94387f5aec', '1,430,000', 'NES'],
  ['base', '0xb5882168e57a0afd36b796a85b208759f59c862276a2711c097ca83d0b0b67b7', '0x3a8e69b1f22946ab30e08982cedcf3dc346f330b', '450,000', 'USDC 6dec'],
  ['base', '0xa87acacf5157e2b08aab0c9b51d7aab8b4988386cc192add206b88850be5946b', '0xa44907a3047a043f43cf07fdd0a74d179b9279d9', '4,000,000', 'DEUS'],
];

let pass = 0, fail = 0;
for (const [chain, tx, wantDist, wantAmt, note] of CASES) {
  let count = 0;
  const seen = [];
  const log = {
    info: (obj, msg) => {
      if (typeof msg === 'string' && msg.includes('would send deposit')) {
        count++;
        seen.push({ to: obj.to, amountLine: obj.amountLine });
      }
    },
  };
  try {
    await processDepositTx(chain, tx, getPollerClient(chain), {
      notify: false, persist: false, source: 'poller', blockTimestamp: 0, log,
    });
  } catch (e) {
    console.log(`FAIL  ${chain.padEnd(8)} ${note.padEnd(32)} threw: ${e.message}`);
    fail++; continue;
  }
  const okCount = count === 1;
  const okDist = seen[0]?.to?.toLowerCase() === wantDist.toLowerCase();
  const okAmt = seen[0]?.amountLine?.includes(wantAmt);
  if (okCount && okDist && okAmt) {
    console.log(`PASS  ${chain.padEnd(8)} ${note.padEnd(32)} 1 msg  ${seen[0].amountLine}`);
    pass++;
  } else {
    console.log(`FAIL  ${chain.padEnd(8)} ${note.padEnd(32)} count=${count} want 1 | got ${JSON.stringify(seen[0] || null)} | wantDist=${wantDist} wantAmt=${wantAmt}`);
    fail++;
  }
}
console.log(`\n=========== ${pass} passed, ${fail} failed ===========`);
process.exit(fail ? 1 : 0);
