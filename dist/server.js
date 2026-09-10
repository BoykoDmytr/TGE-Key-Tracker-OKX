// src/server.ts
import 'dotenv/config';
import express from 'express';
import * as pinoHttpNS from 'pino-http';
import { verifyTenderlySignature } from './tenderly/verify.js';
import { getPublicClient } from './evm/provider.js';
import { sendTelegram } from './telegram.js';
import { addTracked } from './store/trackedDistributors.js';
import { processSetTimeTx, processDepositTx } from './handlers.js';
import { addFactory, listFactories } from './store/factories.js';
import { startPoller, isShadow, pollerStatus } from './poller/index.js';
import { breakerStatus, resetBreaker, answerCallback, editOwnerMarkup, OWNER_CHAT_ID } from './telegram.js';
import { takePending } from './filter/pendingApproval.js';
import { markTrackedLegit } from './store/trackedDistributors.js';
// Solana support was removed 2026-08-05 (product decision: we do not track that network).
// The poller, its RPC/metadata helpers and @solana/web3.js are gone; 'solana' is no longer
// an accepted admin chain, so a stray /admin/factory {chain:"solana"} cannot resurrect it.
function normalizeAdminChain(net) {
    const n = String(net).toLowerCase().trim();
    return normalizeTenderlyNetwork(n);
}
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
        // Process deposit via the shared handler. notify honours shadow mode — previously this
        // was hardcoded true, so POLLER_SHADOW=1 muted the poller but NOT this route.
        const { sent, tracked } = await processDepositTx(chainKey, txHash, client, {
            notify: !isShadow(chainKey),
            persist: true,
            source: 'webhook',
            log: req.log,
        });
        req.log.info({ sent, tracked, ms: Date.now() - startedAt }, 'webhook processed');
        return res.status(200).send('ok');
    }
    catch (err) {
        req.log?.error?.({
            err: err?.message || err,
            stack: err?.stack,
            ms: Date.now() - startedAt,
        }, 'Error handling webhook');
        // 200 on purpose: a 500 makes the sender retry, which re-fetches the receipt and
        // re-walks it. During an incident every call 500s and every retry compounds the
        // flood. The poller re-scans the same blocks anyway, so nothing is truly lost.
        return res.status(200).send('error-logged');
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
        // Decode + allowlist + dedup + send via shared handler (same path the poller uses).
        const r = await processSetTimeTx({ chainKey, txHash: String(tx_hash), to: String(to), input: String(input) }, { notify: !isShadow(chainKey), source: 'webhook', log: req.log });
        req.log.info({ chainKey, to, tx_hash, result: r }, 'settime processed');
        return res.status(200).send('ok');
    }
    catch (err) {
        req.log?.error?.({ err: err?.message || err }, 'settime webhook error');
        return res.status(200).send('error-logged'); // see the deposit route: no retry amplification
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
                const chainKey = normalizeAdminChain(String(it.chain));
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
// ====== ADMIN: manage watched factory addresses (for the block poller) ======
app.post('/admin/factory', express.json(), async (req, res) => {
    try {
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
                const chainKey = normalizeAdminChain(String(it.chain));
                if (!chainKey) {
                    results.push({ chain: it.chain, address: it.address, ok: false, err: 'unsupported chain' });
                    continue;
                }
                await addFactory(chainKey, String(it.address));
                results.push({ chain: chainKey, address: String(it.address).toLowerCase(), ok: true });
            }
            catch (e) {
                results.push({ chain: it?.chain || '', address: it?.address || '', ok: false, err: e?.message || String(e) });
            }
        }
        const added = results.filter((r) => r.ok).length;
        req.log.info({ added, total: items.length }, 'admin factory updated');
        return res.json({ added, total: items.length, results });
    }
    catch (err) {
        req.log?.error?.({ err: err?.message || err }, 'admin factory error');
        return res.status(500).send('error');
    }
});
// Per-chain poller lag, so a degradation can be checked from anywhere instead of by
// SSHing into the machine and reading Redis by hand.
app.get('/admin/lag', (req, res) => {
    const secret = req.header('x-admin-secret') || '';
    if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
        return res.status(401).send('unauthorized');
    }
    return res.json(pollerStatus());
});
app.get('/admin/factory', async (req, res) => {
    const secret = req.header('x-admin-secret') || '';
    if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
        return res.status(401).send('unauthorized');
    }
    const chain = normalizeAdminChain(String(req.query.chain || ''));
    if (!chain)
        return res.status(400).send('bad/missing chain');
    return res.json({ chain, factories: await listFactories(chain) });
});
// ====== Telegram callback: the owner approving a withheld post ======
// Registered with setWebhook + a secret token. Three independent checks before anything
// can reach the channel: the URL path secret, the Telegram secret-token header, and the
// sender's Telegram user id. A withheld post is published only by the owner, by hand.
app.post('/tg/callback/:secret', express.json(), async (req, res) => {
    // Always 200: a non-200 makes Telegram retry the same update forever.
    try {
        const want = process.env.TG_WEBHOOK_SECRET || process.env.ADMIN_SECRET || "";
        if (!want || req.params.secret !== want)
            return res.status(200).send("ok");
        const hdr = req.header("x-telegram-bot-api-secret-token") || "";
        if (process.env.TG_WEBHOOK_SECRET && hdr !== process.env.TG_WEBHOOK_SECRET) {
            return res.status(200).send("ok");
        }
        const cq = (req.body || {}).callback_query;
        if (!cq)
            return res.status(200).send("ok");
        // Only the owner may publish. Anyone else tapping is ignored silently.
        if (String(cq.from?.id || "") !== String(OWNER_CHAT_ID)) {
            await answerCallback(cq.id, "Not authorised");
            return res.status(200).send("ok");
        }
        const data = String(cq.data || "");
        const msgId = cq.message?.message_id;
        const m = /^(ap|no):([0-9a-f]{16})$/.exec(data);
        if (!m) {
            await answerCallback(cq.id, "Expired");
            return res.status(200).send("ok");
        }
        const [, action, id] = m;
        const rec = await takePending(id); // atomic: a second tap finds nothing
        if (!rec) {
            await answerCallback(cq.id, "Already handled or expired");
            if (msgId)
                await editOwnerMarkup(msgId, "\u2014 already handled");
            return res.status(200).send("ok");
        }
        if (action === "no") {
            await answerCallback(cq.id, "Discarded");
            if (msgId)
                await editOwnerMarkup(msgId, "\u{1F5D1} discarded");
            console.log("[approve] discarded %s %s %s", rec.chain, rec.kind, rec.distributor);
            return res.status(200).send("ok");
        }
        // Approve. The automatic path already claimed this dedupe key before withholding, so
        // publishing here cannot race a later automatic post of the same event.
        //
        // Approving a DEPOSIT also promotes the distributor to legit, so its later setTime goes
        // straight to the channel instead of coming back here for a second approval.
        if (rec.kind === 'deposit' && rec.distributor) {
            const promoted = await markTrackedLegit(rec.chain, rec.distributor);
            console.log('[approve] verdict promotion for %s %s: %s', rec.chain, rec.distributor, promoted ? 'ok' : 'record not found');
        }
        await sendTelegram(rec.message);
        await answerCallback(cq.id, "Posted to channel");
        if (msgId)
            await editOwnerMarkup(msgId, "\u2705 posted to channel");
        console.log("[approve] published %s %s %s (rule %s)", rec.chain, rec.kind, rec.distributor, rec.rule);
        return res.status(200).send("ok");
    }
    catch (err) {
        console.error("[approve] callback failed:", err?.message || err);
        return res.status(200).send("ok");
    }
});
// ====== ADMIN: Telegram circuit breaker ======
app.get('/admin/tg', (req, res) => {
    const secret = req.header('x-admin-secret') || '';
    if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
        return res.status(401).send('unauthorized');
    }
    return res.json(breakerStatus());
});
app.post('/admin/tg/reset', (req, res) => {
    const secret = req.header('x-admin-secret') || '';
    if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
        return res.status(401).send('unauthorized');
    }
    resetBreaker();
    return res.json({ ok: true, status: breakerStatus() });
});
// ====== START ======
console.log('[boot] POLLER_ENABLED=%s POLLER_SHADOW=%s POLLER_SHADOW_CHAINS=%s POLLER_CHAINS=%s FACTORIES_DEFAULT=%s', process.env.POLLER_ENABLED || '0', process.env.POLLER_SHADOW || '0', process.env.POLLER_SHADOW_CHAINS || '(none)', process.env.POLLER_CHAINS || process.env.CHAINS || '(none)', process.env.FACTORIES_DEFAULT ? '(set)' : '(not set)');
const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
    console.log(`Listening on :${port}`);
    startPoller();
});
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
    if (n === '196')
        return 'xlayer'; // нове: X Layer (OKX zkEVM)
    // Текстові формати
    if (n.includes('xlayer') || n.includes('x-layer') || n.includes('x layer'))
        return 'xlayer';
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
