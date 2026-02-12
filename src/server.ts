// src/server.ts
import 'dotenv/config';
import express, { Request, Response } from 'express';
import * as pinoHttpNS from 'pino-http';

import { verifyTenderlySignature } from './tenderly/verify.js';
import { extractTransfersFromReceipt } from './tenderly/parseTransfers.js';

import { getPublicClient, type ChainKey, getExplorerTxUrl } from './evm/provider.js';
import { getErc20MetaCached, formatUnitsSafe } from './evm/erc20MetaCache.js';

import { isDuplicate, markDuplicate } from './dedupe.js';
import { sendTelegram } from './telegram.js';

const app = express();

// ====== BOOT LOG ======
console.log('[boot] server.ts version=2026-02-12TXX:XXZ allTokensMode=ON');
console.log('[boot] NODE_ENV=%s PORT=%s', process.env.NODE_ENV, process.env.PORT);
console.log('[boot] CHAINS=%s', process.env.CHAINS || '(not set)');
console.log('[boot] INTERACTION_CONTRACT=%s', process.env.INTERACTION_CONTRACT || '(not set)');
console.log('[boot] THRESHOLDS_JSON=%s', process.env.THRESHOLDS_JSON ? '(set)' : '(not set)');
console.log('[boot] TOKEN_LABELS_JSON=%s', process.env.TOKEN_LABELS_JSON ? '(set)' : '(not set)');
console.log('[boot] TENDERLY_SIGNING_KEY=%s', process.env.TENDERLY_SIGNING_KEY ? '(set)' : '(not set)');
console.log('[boot] REDIS_URL=%s', process.env.REDIS_URL ? '(set)' : '(not set)');

const pinoHttp = (pinoHttpNS as any).default ?? (pinoHttpNS as any);
app.use(pinoHttp());

// ====== ROUTES ======
app.get('/health', (_req: Request, res: Response) => res.status(200).send('ok'));
app.get('/webhooks/tenderly', (_req, res) => res.status(200).send('ok - use POST here'));

// ====== WEBHOOK HANDLER ======
app.post('/webhooks/tenderly', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  const startedAt = Date.now();

  try {
    // ---- headers debug ----
    const signature = (req.header('x-tenderly-signature') || '').trim();
    const date = (req.header('date') || '').trim();
    const contentType = (req.header('content-type') || '').trim();
    const ua = (req.header('user-agent') || '').trim();
    const rawLen = Buffer.isBuffer(req.body) ? (req.body as Buffer).length : 0;

    req.log.info(
      {
        method: req.method,
        path: req.path,
        contentType,
        ua,
        signaturePresent: Boolean(signature),
        datePresent: Boolean(date),
        rawLen,
      },
      'tenderly webhook received',
    );

    // ---- signing key ----
    const signingKey = process.env.TENDERLY_SIGNING_KEY || '';
    if (!signingKey) {
      req.log.error('Missing TENDERLY_SIGNING_KEY');
      return res.status(500).send('Missing TENDERLY_SIGNING_KEY');
    }

    // ---- verify signature ----
    const okSig = verifyTenderlySignature({
      signingKey,
      signature,
      date,
      rawBody: req.body as Buffer,
    });

    if (!okSig) {
      req.log.warn(
        {
          signature: signature ? signature.slice(0, 12) + '…' : '(missing)',
          date,
          rawLen,
        },
        'Invalid Tenderly signature',
      );
      return res.status(400).send('Invalid signature');
    }

    // ---- parse body ----
    let body: any;
    try {
      body = JSON.parse((req.body as Buffer).toString('utf8'));
    } catch (e: any) {
      req.log.error({ err: e?.message || e }, 'Failed to JSON.parse body');
      return res.status(400).send('Bad JSON');
    }

    req.log.info(
      {
        event_type: body?.event_type,
        hasAlert: Boolean(body?.alert),
        topKeys: body ? Object.keys(body).slice(0, 20) : [],
      },
      'payload parsed',
    );

    // Tenderly event types
    const eventType: string = body?.event_type;
    if (eventType === 'TEST') {
      req.log.info('TEST event - ignoring');
      return res.status(200).send('ok');
    }
    if (eventType !== 'ALERT') {
      req.log.info({ eventType }, 'Non-ALERT event - ignored');
      return res.status(200).send('ignored');
    }

    // Extract network + txHash (Tenderly payload differs by alert type)
    const networkRaw: any =
      body?.alert?.network || body?.network || body?.data?.network || body?.transaction?.network;

    const txHashRaw: any =
      body?.alert?.tx_hash || body?.tx_hash || body?.transaction?.hash || body?.data?.tx_hash;

    const network = networkRaw != null ? String(networkRaw) : undefined;
    const txHash = txHashRaw != null ? String(txHashRaw) : undefined;

    req.log.info({ network, txHash }, 'extracted network/txHash');

    if (!network || !txHash) {
      req.log.warn({ network, txHash }, 'Missing network or txHash in Tenderly payload');
      return res.status(200).send('ok');
    }

    const chainKey = normalizeTenderlyNetwork(network);
    if (!chainKey) {
      req.log.warn({ network }, 'Unsupported network');
      return res.status(200).send('ok');
    }
    req.log.info({ network, chainKey }, 'network mapped');

    // allowlist chains (optional)
    const allow = new Set((process.env.CHAINS || '').split(',').map((s) => s.trim()).filter(Boolean));
    req.log.info({ allow: [...allow] }, 'chains allowlist');
    if (allow.size && !allow.has(chainKey)) {
      req.log.info({ chainKey }, 'chain not in allowlist - ignored');
      return res.status(200).send('ok');
    }

    // Interaction contract
    const interactionAddr = (process.env.INTERACTION_CONTRACT || '').toLowerCase();
    if (!interactionAddr) {
      req.log.error('Missing INTERACTION_CONTRACT');
      return res.status(500).send('Missing INTERACTION_CONTRACT');
    }

    // Create client
    req.log.info({ chainKey }, 'creating public client');
    const client = getPublicClient(chainKey);

    // Fetch tx
    req.log.info({ txHash }, 'fetching transaction');
    const tx = await client.getTransaction({ hash: txHash as `0x${string}` });

    req.log.info(
      {
        txTo: tx?.to || null,
        txFrom: (tx as any)?.from || null,
      },
      'transaction fetched',
    );

    if (!tx.to || tx.to.toLowerCase() !== interactionAddr) {
      req.log.info(
        { txTo: tx?.to || null, interactionAddr },
        'tx.to != INTERACTION_CONTRACT (not our interaction) - ignored',
      );
      return res.status(200).send('ok');
    }

    // Receipt + transfers
    req.log.info({ txHash }, 'fetching receipt');
    const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });

    req.log.info(
      {
        logsCount: receipt?.logs?.length ?? 0,
        status: (receipt as any)?.status,
        blockNumber: (receipt as any)?.blockNumber?.toString?.() ?? (receipt as any)?.blockNumber,
      },
      'receipt fetched',
    );

    const transfers = extractTransfersFromReceipt(receipt);
    req.log.info({ transfersCount: transfers.length }, 'parsed transfers');

    if (!transfers.length) return res.status(200).send('ok');

    // Thresholds / labels
    const thresholds: Record<string, string> = safeJson(process.env.THRESHOLDS_JSON || '{}');
    const thresholdsLower: Record<string, string> = {};
    for (const [addr, human] of Object.entries(thresholds || {})) thresholdsLower[addr.toLowerCase()] = String(human);

    const strictMode = Object.keys(thresholdsLower).length > 0;

    const tokenLabels: Record<string, string> = safeJson(process.env.TOKEN_LABELS_JSON || '{}');
    const tokenLabelsLower: Record<string, string> = {};
    for (const [addr, label] of Object.entries(tokenLabels || {})) tokenLabelsLower[addr.toLowerCase()] = String(label);

    req.log.info(
      {
        strictMode,
        thresholdsKeys: Object.keys(thresholdsLower).slice(0, 20),
        labelsKeys: Object.keys(tokenLabelsLower).slice(0, 20),
      },
      'loaded thresholds/labels',
    );

    // Process transfers
    let sentCount = 0;

    for (const t of transfers) {
      const tokenAddrLower = t.token.toLowerCase();
      const threshHuman = thresholdsLower[tokenAddrLower] ?? null;

      req.log.info(
        {
          token: t.token,
          from: t.from,
          to: t.to,
          logIndex: t.logIndex,
          value: t.value.toString(),
          hasThreshold: Boolean(threshHuman),
          threshold: threshHuman,
        },
        'transfer candidate',
      );

      // strict mode: only tokens in thresholds
      if (strictMode && !threshHuman) {
        req.log.info({ token: t.token }, 'skip: token not in thresholds (strictMode)');
        continue;
      }

      const dedupeKey = `${chainKey}:${txHash}:${t.logIndex}:${tokenAddrLower}:${t.to.toLowerCase()}`;
      const dup = await isDuplicate(dedupeKey);
      req.log.info({ dedupeKey, dup }, 'dedupe check');
      if (dup) continue;

      // meta
      req.log.info({ token: t.token }, 'fetching token meta');
      const meta = await getErc20MetaCached(client as any, t.token);
      const amountHuman = formatUnitsSafe(t.value, meta.decimals);
      function compareHuman(amount: string, threshold: string): boolean {
        const a = Number(amount);
        const b = Number(threshold);
        if (Number.isNaN(a) || Number.isNaN(b)) return false;
        return a >= b;
      }
      // threshold compare: if there is a per-token threshold -> enforce it, else allow (non-strict)
      const pass = threshHuman ? compareHuman(amountHuman, String(threshHuman)) : true;

      req.log.info(
        {
          token: t.token,
          symbol: meta.symbol,
          decimals: meta.decimals,
          amountHuman,
          threshold: threshHuman,
          pass,
        },
        'meta + amount',
      );

      if (!pass) continue;

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

      req.log.info({ messagePreview: message.slice(0, 200) }, 'sending telegram');
      await sendTelegram(message);
      sentCount++;

      await markDuplicate(dedupeKey);
      req.log.info({ dedupeKey }, 'marked duplicate');
    }

    req.log.info({ sentCount, ms: Date.now() - startedAt }, 'webhook processed');
    return res.status(200).send('ok');
  } catch (err: any) {
    (req as any).log?.error?.(
      {
        err: err?.message || err,
        stack: err?.stack,
        ms: Date.now() - startedAt,
      },
      'Error handling webhook',
    );
    return res.status(500).send('error');
  }
});

// ====== START ======
const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`Listening on :${port}`));

function normalizeTenderlyNetwork(net: string): ChainKey | null {
  const n = String(net).toLowerCase().trim();

  // chainId format
  if (n === '56') return 'bsc';
  if (n === '97') return 'bsc_testnet';
  if (n === '8453') return 'base';
  if (n === '42161') return 'arbitrum';

  // textual format
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