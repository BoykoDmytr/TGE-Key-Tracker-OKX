// src/server.ts
import 'dotenv/config';
import express, { Request, Response } from 'express';
import pinoHttp from 'pino-http';

import { verifyTenderlySignature } from './tenderly/verify';
import { extractTransfersFromReceipt } from './tenderly/parseTransfers';

import { getPublicClient, type ChainKey, getExplorerTxUrl } from './evm/provider';
import { getErc20MetaCached, formatUnitsSafe } from './evm/erc20MetaCache';

import { isDuplicate, markDuplicate } from './dedupe';
import { sendTelegram } from './telegram';

const app = express();
app.use(pinoHttp());

// Tenderly вимагає raw body для signature verification
app.post('/webhooks/tenderly', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  try {
    const signingKey = process.env.TENDERLY_SIGNING_KEY || '';
    if (!signingKey) return res.status(500).send('Missing TENDERLY_SIGNING_KEY');

    const signature = (req.header('x-tenderly-signature') || '').trim();
    const date = (req.header('date') || '').trim();

    if (!verifyTenderlySignature({ signingKey, signature, date, rawBody: req.body as Buffer })) {
      req.log.warn({ signature, date }, 'Invalid Tenderly signature');
      return res.status(400).send('Invalid signature');
    }

    const body = JSON.parse((req.body as Buffer).toString('utf8'));

    // Tenderly event types
    const eventType: string = body?.event_type;
    if (eventType === 'TEST') return res.status(200).send('ok');
    if (eventType !== 'ALERT') return res.status(200).send('ignored');

    // Витягуємо network + txHash (у різних алертів може бути трохи різна структура)
    const network: string | undefined =
      body?.alert?.network || body?.network || body?.data?.network || body?.transaction?.network;

    const txHash: string | undefined =
      body?.alert?.tx_hash || body?.tx_hash || body?.transaction?.hash || body?.data?.tx_hash;

    if (!network || !txHash) {
      req.log.warn({ network, txHash }, 'Missing network or txHash in Tenderly payload');
      return res.status(200).send('ok');
    }

    const chainKey = normalizeTenderlyNetwork(network);
    if (!chainKey) {
      req.log.warn({ network }, 'Unsupported network');
      return res.status(200).send('ok');
    }

    // allowlist chains (optional)
    const allow = new Set((process.env.CHAINS || '').split(',').map(s => s.trim()).filter(Boolean));
    if (allow.size && !allow.has(chainKey)) return res.status(200).send('ok');

    const client = getPublicClient(chainKey);

    // 1) tx.to == INTERACTION_CONTRACT
    const tx = await client.getTransaction({ hash: txHash as `0x${string}` });
    const interactionAddr = (process.env.INTERACTION_CONTRACT || '').toLowerCase();
    if (!interactionAddr) return res.status(500).send('Missing INTERACTION_CONTRACT');

    if (!tx.to || tx.to.toLowerCase() !== interactionAddr) {
      return res.status(200).send('ok');
    }

    // 2) Парсимо ERC20 Transfer з receipt.logs
    const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
    const transfers = extractTransfersFromReceipt(receipt);
    if (!transfers.length) return res.status(200).send('ok');

    // Thresholds: {"0xTokenAddr": "1000", "0xToken2": "0.5"}
    const thresholds: Record<string, string> = safeJson(process.env.THRESHOLDS_JSON || '{}');
    const thresholdsLower: Record<string, string> = {};
    for (const [addr, human] of Object.entries(thresholds)) thresholdsLower[addr.toLowerCase()] = String(human);

    // (опціонально) кастомні назви токенів у боті:
    // {"0xTokenAddr":"MMS (Test)","0xToken2":"USDT"}
    const tokenLabels: Record<string, string> = safeJson(process.env.TOKEN_LABELS_JSON || '{}');
    const tokenLabelsLower: Record<string, string> = {};
    for (const [addr, label] of Object.entries(tokenLabels)) tokenLabelsLower[addr.toLowerCase()] = String(label);

    for (const t of transfers) {
      const tokenAddrLower = t.token.toLowerCase();

      // strict mode: тільки токени, які є в thresholds
      const threshHuman = thresholdsLower[tokenAddrLower];
      if (!threshHuman) continue;

      // dedupe
      const dedupeKey = `${chainKey}:${txHash}:${t.logIndex}:${tokenAddrLower}:${t.to.toLowerCase()}`;
      if (await isDuplicate(dedupeKey)) continue;

      // meta token
      const meta = await getErc20MetaCached(client, t.token);
      const amountHuman = formatUnitsSafe(t.value, meta.decimals);

      if (!compareHuman(amountHuman, threshHuman)) continue;

      const explorer = getExplorerTxUrl(chainKey, txHash);

      const label = tokenLabelsLower[tokenAddrLower] || meta.symbol;

      const message =
        `🔔 Interaction + ERC20 Transfer\n` +
        `Chain: ${chainKey}\n` +
        `Token: ${label} (${t.token})\n` +
        `Amount: ${amountHuman}\n` +
        `From: ${t.from}\n` +
        `To: ${t.to}\n` +
        `Interaction: ${tx.to}\n` +
        `Tx: ${explorer}`;

      await sendTelegram(message);

      await markDuplicate(dedupeKey);
    }

    return res.status(200).send('ok');
  } catch (err: any) {
    (req as any).log?.error?.({ err }, 'Error handling webhook');
    return res.status(500).send('error');
  }
});

app.get('/health', (_req: Request, res: Response) => res.status(200).send('ok'));

const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`Listening on :${port}`));

function normalizeTenderlyNetwork(net: string): ChainKey | null {
  const n = net.toLowerCase();
  if (n.includes('bsc') && n.includes('test')) return 'bsc_testnet';
  if (n.includes('bsc') || n.includes('bnb')) return 'bsc';
  if (n.includes('base')) return 'base';
  if (n.includes('arbitrum')) return 'arbitrum';
  return null;
}

function safeJson<T>(s: string): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return {} as T;
  }
}

// просте порівняння, ок для невеликих/середніх чисел
function compareHuman(amount: string, threshold: string): boolean {
  const a = Number(amount);
  const b = Number(threshold);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return a >= b;
}
