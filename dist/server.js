// src/server.ts
import 'dotenv/config';
import express from 'express';
import * as pinoHttpNS from 'pino-http';
import { verifyTenderlySignature } from './tenderly/verify.js';
import { extractTransfersFromReceipt } from './tenderly/parseTransfers.js';
import { getPublicClient, getExplorerTxUrl } from './evm/provider.js';
import { getErc20MetaCached, formatUnitsSafe } from './evm/erc20MetaCache.js';
import { isDuplicate, markDuplicate } from './dedupe.js';
import { sendTelegram } from './telegram.js';
import { formatNumberWithCommas } from './utils/formatNumberWithCommas.js';
import { addTracked, getTracked } from './store/trackedDistributors.js';
import { decodeSetTime } from './evm/decodeSetTime.js';
import { formatSetTimeMessage } from './telegram/formatSetTime.js';
const app = express();
// ✅ GLOBAL MIN AMOUNT FILTER (tokens)
const MIN_TOKEN_AMOUNT = 5000;
// ====== BOOT LOG ======
console.log('[boot] server.ts version=2026-02-12TXX:XXZ allTokensMode=ON');
console.log('[boot] NODE_ENV=%s PORT=%s', process.env.NODE_ENV, process.env.PORT);
console.log('[boot] CHAINS=%s', process.env.CHAINS || '(not set)');
console.log('[boot] INTERACTION_CONTRACT=%s', process.env.INTERACTION_CONTRACT || '(not set)');
console.log('[boot] THRESHOLDS_JSON=%s', process.env.THRESHOLDS_JSON ? '(set)' : '(not set)');
console.log('[boot] TOKEN_LABELS_JSON=%s', process.env.TOKEN_LABELS_JSON ? '(set)' : '(not set)');
console.log('[boot] TENDERLY_SIGNING_KEY=%s', process.env.TENDERLY_SIGNING_KEY ? '(set)' : '(not set)');
console.log('[boot] REDIS_URL=%s', process.env.REDIS_URL ? '(set)' : '(not set)');
console.log('[boot] SETTIME_SHARED_SECRET=%s', process.env.SETTIME_SHARED_SECRET ? '(set)' : '(not set)');
console.log('[boot] ADMIN_SECRET=%s', process.env.ADMIN_SECRET ? '(set)' : '(not set)');
const pinoHttp = pinoHttpNS.default ?? pinoHttpNS;
app.use(pinoHttp());
// ====== ROUTES ======
app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/webhooks/tenderly', (_req, res) => res.status(200).send('ok - use POST here'));
// ====== TELEGRAM MARKDOWNV2 HELPERS ======
function escMdV2(s) {
    // Escape Telegram MarkdownV2 special chars
    return s.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}
function escMdV2Url(url) {
    // In MarkdownV2 links, you must escape ')' and '\' at minimum
    return url.replace(/\\/g, '\\\\').replace(/\)/g, '\\)');
}
// ====== WEBHOOK HANDLER ======
app.post('/webhooks/tenderly', express.raw({ type: 'application/json' }), async (req, res) => {
    const startedAt = Date.now();
    try {
        // ---- headers debug ----
        const signature = (req.header('x-tenderly-signature') || '').trim();
        const date = (req.header('date') || '').trim();
        const contentType = (req.header('content-type') || '').trim();
        const ua = (req.header('user-agent') || '').trim();
        const rawLen = Buffer.isBuffer(req.body) ? req.body.length : 0;
        req.log.info({
            method: req.method,
            path: req.path,
            contentType,
            ua,
            signaturePresent: Boolean(signature),
            datePresent: Boolean(date),
            rawLen,
        }, 'tenderly webhook received');
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
            rawBody: req.body,
        });
        if (!okSig) {
            req.log.warn({
                signature: signature ? signature.slice(0, 12) + '…' : '(missing)',
                date,
                rawLen,
            }, 'Invalid Tenderly signature');
            return res.status(400).send('Invalid signature');
        }
        // ---- parse body ----
        let body;
        try {
            body = JSON.parse(req.body.toString('utf8'));
        }
        catch (e) {
            req.log.error({ err: e?.message || e }, 'Failed to JSON.parse body');
            return res.status(400).send('Bad JSON');
        }
        req.log.info({
            event_type: body?.event_type,
            hasAlert: Boolean(body?.alert),
            topKeys: body ? Object.keys(body).slice(0, 20) : [],
        }, 'payload parsed');
        // Tenderly event types
        const eventType = body?.event_type;
        if (eventType === 'TEST') {
            req.log.info('TEST event - ignoring');
            return res.status(200).send('ok');
        }
        if (eventType !== 'ALERT') {
            req.log.info({ eventType }, 'Non-ALERT event - ignored');
            return res.status(200).send('ignored');
        }
        // Extract network + txHash (Tenderly payload differs by alert type)
        const networkRaw = body?.alert?.network || body?.network || body?.data?.network || body?.transaction?.network;
        const txHashRaw = body?.alert?.tx_hash || body?.tx_hash || body?.transaction?.hash || body?.data?.tx_hash;
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
        const tx = await client.getTransaction({ hash: txHash });
        req.log.info({
            txTo: tx?.to || null,
            txFrom: tx?.from || null,
        }, 'transaction fetched');
        if (!tx.to || tx.to.toLowerCase() !== interactionAddr) {
            req.log.info({ txTo: tx?.to || null, interactionAddr }, 'tx.to != INTERACTION_CONTRACT (not our interaction) - ignored');
            return res.status(200).send('ok');
        }
        // Receipt + transfers
        req.log.info({ txHash }, 'fetching receipt');
        const receipt = await client.getTransactionReceipt({ hash: txHash });
        req.log.info({
            logsCount: receipt?.logs?.length ?? 0,
            status: receipt?.status,
            blockNumber: receipt?.blockNumber?.toString?.() ?? receipt?.blockNumber,
        }, 'receipt fetched');
        const transfers = extractTransfersFromReceipt(receipt);
        req.log.info({ transfersCount: transfers.length }, 'parsed transfers');
        if (!transfers.length)
            return res.status(200).send('ok');
        // Thresholds / labels
        const thresholds = safeJson(process.env.THRESHOLDS_JSON || '{}');
        const thresholdsLower = {};
        for (const [addr, human] of Object.entries(thresholds || {}))
            thresholdsLower[addr.toLowerCase()] = String(human);
        const strictMode = Object.keys(thresholdsLower).length > 0;
        const tokenLabels = safeJson(process.env.TOKEN_LABELS_JSON || '{}');
        const tokenLabelsLower = {};
        for (const [addr, label] of Object.entries(tokenLabels || {}))
            tokenLabelsLower[addr.toLowerCase()] = String(label);
        req.log.info({
            strictMode,
            thresholdsKeys: Object.keys(thresholdsLower).slice(0, 20),
            labelsKeys: Object.keys(tokenLabelsLower).slice(0, 20),
        }, 'loaded thresholds/labels');
        // Process transfers
        let sentCount = 0;
        for (const t of transfers) {
            const tokenAddrLower = t.token.toLowerCase();
            const threshHuman = thresholdsLower[tokenAddrLower] ?? null;
            req.log.info({
                token: t.token,
                from: t.from,
                to: t.to,
                logIndex: t.logIndex,
                value: t.value.toString(),
                hasThreshold: Boolean(threshHuman),
                threshold: threshHuman,
            }, 'transfer candidate');
            // strict mode: only tokens in thresholds
            if (strictMode && !threshHuman) {
                req.log.info({ token: t.token }, 'skip: token not in thresholds (strictMode)');
                continue;
            }
            const dedupeKey = `${chainKey}:${txHash}:${t.logIndex}:${tokenAddrLower}:${t.to.toLowerCase()}`;
            const dup = await isDuplicate(dedupeKey);
            req.log.info({ dedupeKey, dup }, 'dedupe check');
            if (dup)
                continue;
            // meta
            req.log.info({ token: t.token }, 'fetching token meta');
            const meta = await getErc20MetaCached(client, t.token);
            const amountHuman = formatUnitsSafe(t.value, meta.decimals);
            // ✅ GLOBAL FILTER: skip if amount < 5000 tokens
            const amountNum = Number(amountHuman);
            if (!Number.isNaN(amountNum) && amountNum < MIN_TOKEN_AMOUNT) {
                req.log.info({ amountHuman, MIN_TOKEN_AMOUNT }, 'skip: amount below global minimum');
                continue;
            }
            function compareHuman(amount, threshold) {
                const a = Number(amount);
                const b = Number(threshold);
                if (Number.isNaN(a) || Number.isNaN(b))
                    return false;
                return a >= b;
            }
            // threshold compare: if there is a per-token threshold -> enforce it, else allow (non-strict)
            const pass = threshHuman ? compareHuman(amountHuman, String(threshHuman)) : true;
            req.log.info({
                token: t.token,
                symbol: meta.symbol,
                decimals: meta.decimals,
                amountHuman,
                threshold: threshHuman,
                pass,
            }, 'meta + amount');
            if (!pass)
                continue;
            const explorer = getExplorerTxUrl(chainKey, txHash);
            // красиве ім’я мережі без underscore (щоб не ламало Markdown)
            const networkPretty = chainKey === 'bsc_testnet' ? 'BSC Testnet' :
                chainKey === 'bsc' ? 'BSC' :
                    chainKey === 'base' ? 'Base' :
                        chainKey === 'arbitrum' ? 'Arbitrum' :
                            chainKey === 'ethereum' ? 'Ethereum' : // нове
                                chainKey === 'avalanche' ? 'Avalanche' : // нове
                                    chainKey === 'optimism' ? 'Optimism' : // нове
                                        chainKey;
            const label = tokenLabelsLower[tokenAddrLower] || meta.symbol;
            const amountLine = `${formatNumberWithCommas(amountHuman)} $${label}`;
            // ✅ MESSAGE EXACT FORMAT (MarkdownV2 + quote + link)
            // IMPORTANT: sendTelegram must use parse_mode: 'MarkdownV2'
            function escHtml(s) {
                return s
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;')
                    .replace(/'/g, '&#39;');
            }
            const message = `⚡ <b>${escHtml('NEW OKX DEPOSIT DETECTED')}</b>\n\n` +
                `Amount: ${escHtml(amountLine)}\n` +
                `Network: ${escHtml(networkPretty)}\n` +
                `<a href="${escHtml(explorer)}">${escHtml('View on Scan')}</a>\n\n` +
                `<a href="https://t.me/cryptohornettg/1354">Refback 45%</a>`;
            req.log.info({ messagePreview: message.slice(0, 200) }, 'sending telegram');
            await sendTelegram(message);
            sentCount++;
            // Remember the new Distributor address in the allowlist for setTime
            await addTracked(chainKey, t.to, {
                depositTxHash: txHash,
                addedAt: Math.floor(Date.now() / 1000),
                tokenAddress: t.token,
                tokenSymbol: meta.symbol,
                amountHuman,
            });
            req.log.info({ chainKey, distributor: t.to }, 'added to setTime allowlist');
            await markDuplicate(dedupeKey);
            req.log.info({ dedupeKey }, 'marked duplicate');
        }
        req.log.info({ sentCount, ms: Date.now() - startedAt }, 'webhook processed');
        return res.status(200).send('ok');
    }
    catch (err) {
        req.log?.error?.({
            err: err?.message || err,
            stack: err?.stack,
            ms: Date.now() - startedAt,
        }, 'Error handling webhook');
        return res.status(500).send('error');
    }
});
// ====== SETTIME WEBHOOK (Tenderly Web3 Action -> Distributor.setTime) ======
app.post('/webhooks/settime', express.json(), async (req, res) => {
    try {
        // 1. Auth: shared secret (Web3 Actions don't sign with HMAC like Alerts)
        const secret = req.header('x-settime-secret') || '';
        if (!process.env.SETTIME_SHARED_SECRET || secret !== process.env.SETTIME_SHARED_SECRET) {
            return res.status(401).send('unauthorized');
        }
        const { network, tx_hash, to, input } = req.body || {};
        if (!network || !tx_hash || !to || !input) {
            return res.status(400).send('bad payload');
        }
        const chainKey = normalizeTenderlyNetwork(String(network));
        if (!chainKey)
            return res.status(200).send('unsupported network');
        // 2. Decode selector + 2×uint256
        const decoded = decodeSetTime(String(input));
        if (!decoded) {
            req.log.info({ tx_hash }, 'not a setTime call');
            return res.status(200).send('ok');
        }
        // 3. Allowlist filter — only Distributors that already passed a deposit alert
        const tracked = await getTracked(chainKey, String(to));
        if (!tracked) {
            req.log.info({ chainKey, to, tx_hash }, 'setTime for non-tracked distributor, skipping');
            return res.status(200).send('ok');
        }
        // 4. Dedupe
        const dedupeKey = `settime:${chainKey}:${tx_hash}`;
        if (await isDuplicate(dedupeKey))
            return res.status(200).send('ok');
        // 5. Format + send
        const message = formatSetTimeMessage({
            chainKey,
            tracked,
            startTime: decoded.startTime,
            duration: decoded.duration,
            txHash: String(tx_hash),
        });
        await sendTelegram(message);
        await markDuplicate(dedupeKey);
        req.log.info({ chainKey, to, tx_hash }, 'setTime notification sent');
        return res.status(200).send('ok');
    }
    catch (err) {
        req.log?.error?.({ err: err?.message || err }, 'settime webhook error');
        return res.status(500).send('error');
    }
});
// ====== ADMIN: manual allowlist backfill ======
app.post('/admin/tracked', express.json(), async (req, res) => {
    try {
        // Auth: separate secret from the setTime webhook
        const secret = req.header('x-admin-secret') || '';
        if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
            return res.status(401).send('unauthorized');
        }
        const items = Array.isArray(req.body) ? req.body : [req.body];
        if (!items.length)
            return res.status(400).send('empty body');
        const results = [];
        for (const it of items) {
            try {
                if (!it || !it.chain || !it.address) {
                    results.push({ chain: it?.chain || '', address: it?.address || '', ok: false, err: 'missing chain/address' });
                    continue;
                }
                const chainKey = normalizeTenderlyNetwork(String(it.chain));
                if (!chainKey) {
                    results.push({ chain: it.chain, address: it.address, ok: false, err: 'unsupported chain' });
                    continue;
                }
                await addTracked(chainKey, String(it.address), {
                    depositTxHash: it.depositTxHash || 'manual-backfill',
                    addedAt: Number(it.addedAt) || Math.floor(Date.now() / 1000),
                    tokenAddress: String(it.tokenAddress || ''),
                    tokenSymbol: String(it.tokenSymbol || ''),
                    amountHuman: String(it.amountHuman || ''),
                });
                results.push({ chain: chainKey, address: it.address, ok: true });
            }
            catch (e) {
                results.push({ chain: it?.chain || '', address: it?.address || '', ok: false, err: e?.message || String(e) });
            }
        }
        const added = results.filter((r) => r.ok).length;
        req.log.info({ added, total: items.length }, 'admin backfill processed');
        return res.json({ added, total: items.length, results });
    }
    catch (err) {
        req.log?.error?.({ err: err?.message || err }, 'admin tracked error');
        return res.status(500).send('error');
    }
});
// ====== START ======
const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`Listening on :${port}`));
function normalizeTenderlyNetwork(net) {
    const n = String(net).toLowerCase().trim();
    // Chain ID формати
    if (n === '56')
        return 'bsc';
    if (n === '97')
        return 'bsc_testnet';
    if (n === '8453')
        return 'base';
    if (n === '42161')
        return 'arbitrum';
    if (n === '1')
        return 'ethereum'; // нове: Ethereum Mainnet
    if (n === '43114')
        return 'avalanche'; // нове: Avalanche C‑Chain
    if (n === '10')
        return 'optimism'; // нове: Optimism
    // Текстові формати
    if (n.includes('bsc') && n.includes('test'))
        return 'bsc_testnet';
    if (n.includes('bsc') || n.includes('bnb'))
        return 'bsc';
    if (n.includes('base'))
        return 'base';
    if (n.includes('arbitrum'))
        return 'arbitrum';
    if (n.includes('eth') || n.includes('ethereum'))
        return 'ethereum'; // нове
    if (n.includes('avax') || n.includes('avalanche'))
        return 'avalanche'; // нове
    if (n.includes('op') || n.includes('optimism'))
        return 'optimism'; // нове
    return null;
}
function safeJson(s) {
    try {
        return JSON.parse(s);
    }
    catch {
        return {};
    }
}
