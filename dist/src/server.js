"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processTransfers = processTransfers;
exports.handleWebhook = handleWebhook;
exports.buildServer = buildServer;
const fastify_1 = __importDefault(require("fastify"));
const pino_1 = __importDefault(require("pino"));
const crypto_1 = require("crypto");
const ethers_1 = require("ethers");
const ioredis_1 = __importDefault(require("ioredis"));
const telegram_1 = require("./telegram");
/**
 * ENV
 * - MORALIS_WEBHOOK_SECRET (required)
 * - INTERACTION_CONTRACT (required)
 * - CHAINS (optional, comma-separated: base,arbitrum,optimism,eth,bsc)
 * - THRESHOLDS_JSON (required for actual alerts; strict mode ignores others)
 * - REDIS_URL (optional)
 * - RPC_URLS_JSON (optional; only needed when Moralis doesn't provide tokenSymbol/decimals)
 * - MORALIS_SIGNATURE_HEADER (optional; default tries x-signature then x-moralis-signature)
 * - DEDUPE_TTL_SECONDS (optional; default 604800 (7d))
 * - PORT (optional)
 */
const logger = (0, pino_1.default)({ level: process.env.LOG_LEVEL || "info" });
const STRICT_MODE = (process.env.STRICT_MODE || "false").toLowerCase() === "true";
const DEFAULT_THRESHOLD = Number(process.env.DEFAULT_THRESHOLD || "0");
const INTERACTION_CONTRACT = (process.env.INTERACTION_CONTRACT || "").toLowerCase();
const MORALIS_WEBHOOK_SECRET = process.env.MORALIS_WEBHOOK_SECRET || "";
const CHAINS_ALLOWED = new Set((process.env.CHAINS || "eth,base,arbitrum,optimism,bsc")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean));
const DEDUPE_TTL_SECONDS = Number(process.env.DEDUPE_TTL_SECONDS || "604800");
function parseThresholds() {
    const raw = process.env.THRESHOLDS_JSON || "{}";
    try {
        const obj = JSON.parse(raw);
        const out = {};
        for (const [k, v] of Object.entries(obj)) {
            if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
                continue;
            const key = k.startsWith("0x") && k.length === 42 ? k.toLowerCase() : k.toUpperCase();
            out[key] = v;
        }
        return out;
    }
    catch {
        return {};
    }
}
function parseRpcUrls() {
    const raw = process.env.RPC_URLS_JSON || "{}";
    try {
        const obj = JSON.parse(raw);
        const out = {};
        for (const [k, v] of Object.entries(obj)) {
            if (typeof v === "string" && v.startsWith("http"))
                out[k.toLowerCase()] = v;
        }
        return out;
    }
    catch {
        return {};
    }
}
const thresholds = parseThresholds();
const rpcUrls = parseRpcUrls();
if (!INTERACTION_CONTRACT) {
    logger.warn("INTERACTION_CONTRACT is missing (env). Webhook will reject candidates.");
}
if (!MORALIS_WEBHOOK_SECRET) {
    logger.warn("MORALIS_WEBHOOK_SECRET is missing (env). Signature verification will fail.");
}
// ---------- Chain helpers ----------
const chainIdToSlug = {
    "0x1": "eth",
    "1": "eth",
    "0x2105": "base",
    "8453": "base",
    "0xa4b1": "arbitrum",
    "42161": "arbitrum",
    "0xa": "optimism",
    "10": "optimism",
    "0x38": "bsc",
    "56": "bsc"
};
function normalizeChainSlug(payload) {
    const chainIdRaw = payload?.chainId ?? payload?.chain?.id ?? payload?.chain_id;
    const chainNameRaw = payload?.chain ?? payload?.chainName ?? payload?.chain_name;
    if (chainIdRaw !== undefined && chainIdRaw !== null) {
        const idStr = String(chainIdRaw);
        const slug = chainIdToSlug[idStr] || chainIdToSlug[idStr.toLowerCase()];
        if (slug)
            return { chainSlug: slug, chainId: idStr };
    }
    if (typeof chainNameRaw === "string") {
        const s = chainNameRaw.toLowerCase();
        if (CHAINS_ALLOWED.has(s))
            return { chainSlug: s };
        if (chainIdToSlug[s])
            return { chainSlug: chainIdToSlug[s], chainId: s };
    }
    return { chainSlug: "unknown", chainId: chainIdRaw ? String(chainIdRaw) : undefined };
}
function explorerTx(chainSlug, txHash) {
    switch (chainSlug) {
        case "eth":
            return `https://etherscan.io/tx/${txHash}`;
        case "base":
            return `https://basescan.org/tx/${txHash}`;
        case "arbitrum":
            return `https://arbiscan.io/tx/${txHash}`;
        case "optimism":
            return `https://optimistic.etherscan.io/tx/${txHash}`;
        case "bsc":
            return `https://bscscan.com/tx/${txHash}`;
        default:
            return txHash;
    }
}
// ---------- Dedupe (Redis NX/EX preferred; memory fallback) ----------
class DedupeStore {
    constructor(redisUrl) {
        this.mem = new Map(); // key -> expiresAtMs
        if (redisUrl) {
            this.redis = new ioredis_1.default(redisUrl);
            this.redis.on("error", (err) => logger.error({ err }, "Redis error"));
            logger.info("Dedupe store: Redis (SET NX EX)");
        }
        else {
            logger.info("Dedupe store: In-memory (fallback)");
        }
    }
    async seen(key, ttlSeconds) {
        const now = Date.now();
        if (this.redis) {
            const res = await this.redis.set(key, "1", "EX", ttlSeconds, "NX");
            return res === null; // null => key existed
        }
        const exp = this.mem.get(key);
        if (exp && exp > now)
            return true;
        this.mem.set(key, now + ttlSeconds * 1000);
        // light cleanup
        if (this.mem.size > 50000) {
            for (const [k, v] of this.mem)
                if (v <= now)
                    this.mem.delete(k);
        }
        return false;
    }
}
const dedupe = new DedupeStore(process.env.REDIS_URL);
const tokenMetaCache = new Map(); // key: `${chainSlug}:${tokenAddrLower}`
const ERC20_ABI = ["function symbol() view returns (string)", "function decimals() view returns (uint8)"];
async function getTokenMeta(chainSlug, tokenAddress) {
    const key = `${chainSlug}:${tokenAddress.toLowerCase()}`;
    if (tokenMetaCache.has(key))
        return tokenMetaCache.get(key);
    const rpcUrl = rpcUrls[chainSlug];
    if (!rpcUrl)
        return null;
    try {
        const provider = new ethers_1.ethers.JsonRpcProvider(rpcUrl);
        const c = new ethers_1.ethers.Contract(tokenAddress, ERC20_ABI, provider);
        const [symbol, decimals] = await Promise.all([c.symbol(), c.decimals()]);
        const meta = { symbol: String(symbol), decimals: Number(decimals) };
        tokenMetaCache.set(key, meta);
        return meta;
    }
    catch (err) {
        logger.warn({ err, chainSlug, tokenAddress }, "Failed to fetch token meta via RPC");
        return null;
    }
}
// ---------- Retry ----------
async function withRetry(fn, opts) {
    let attempt = 0;
    while (true) {
        try {
            return await fn();
        }
        catch (err) {
            attempt++;
            if (attempt > opts.retries)
                throw err;
            const delay = Math.min(opts.baseMs * 2 ** (attempt - 1), opts.maxMs);
            await new Promise((r) => setTimeout(r, delay));
        }
    }
}
// ---------- Transfer parsing ----------
const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
function parseFromMoralisErc20Transfers(payload) {
    const arr = payload?.erc20Transfers;
    if (!Array.isArray(arr))
        return [];
    const transfers = [];
    for (const t of arr) {
        const txHash = t?.transactionHash || t?.transaction_hash || t?.txHash || t?.hash;
        const tokenAddress = (t?.address || t?.tokenAddress || t?.contract || "").toLowerCase();
        const from = (t?.from || t?.fromAddress || "").toLowerCase();
        const to = (t?.to || t?.toAddress || "").toLowerCase();
        const logIndex = Number(t?.logIndex ?? t?.log_index ?? -1);
        const valueRaw = String(t?.value ?? t?.amount ?? "");
        if (!txHash || !tokenAddress || logIndex < 0 || !from || !to || !valueRaw)
            continue;
        const symbol = t?.tokenSymbol || t?.symbol;
        const decimals = t?.tokenDecimals ?? t?.tokenDecimal ?? t?.decimals;
        transfers.push({
            txHash: String(txHash),
            logIndex,
            tokenAddress,
            from,
            to,
            valueRaw,
            symbol: typeof symbol === "string" ? symbol : undefined,
            decimals: decimals !== undefined ? Number(decimals) : undefined
        });
    }
    return transfers;
}
function collectRawLogs(payload) {
    const logs = [];
    if (Array.isArray(payload?.logs)) {
        for (const l of payload.logs)
            logs.push(l);
    }
    if (Array.isArray(payload?.txs)) {
        for (const tx of payload.txs) {
            if (Array.isArray(tx?.logs)) {
                for (const l of tx.logs) {
                    logs.push({
                        ...l,
                        transactionHash: l?.transactionHash || l?.transaction_hash || tx?.hash || tx?.transactionHash
                    });
                }
            }
        }
    }
    return logs
        .filter((l) => l && typeof l.address === "string" && Array.isArray(l.topics) && typeof l.data === "string")
        .map((l) => ({
        address: String(l.address).toLowerCase(),
        topics: l.topics.map((x) => String(x).toLowerCase()),
        data: String(l.data),
        logIndex: l.logIndex !== undefined ? Number(l.logIndex) : undefined,
        transactionHash: l.transactionHash ? String(l.transactionHash) : undefined
    }));
}
function parseFromRawLogs(payload) {
    const logs = collectRawLogs(payload);
    const out = [];
    for (const log of logs) {
        const topic0 = log.topics?.[0];
        if (!topic0 || topic0.toLowerCase() !== TRANSFER_TOPIC0)
            continue;
        const topic1 = log.topics?.[1];
        const topic2 = log.topics?.[2];
        if (!topic1 || !topic2)
            continue;
        const from = ethers_1.ethers.getAddress(`0x${topic1.slice(26)}`).toLowerCase();
        const to = ethers_1.ethers.getAddress(`0x${topic2.slice(26)}`).toLowerCase();
        let valueRaw = "";
        try {
            const v = ethers_1.ethers.toBigInt(log.data);
            valueRaw = v.toString();
        }
        catch {
            continue;
        }
        const txHash = log.transactionHash || payload?.txs?.[0]?.hash || payload?.transactionHash || payload?.txHash || "";
        const logIndex = log.logIndex ?? -1;
        if (!txHash || logIndex < 0)
            continue;
        out.push({
            txHash: String(txHash),
            logIndex,
            tokenAddress: log.address.toLowerCase(),
            from,
            to,
            valueRaw
        });
    }
    return out;
}
function findCandidateInteractionTxHashes(payload, interactionContract) {
    const candidates = [];
    const txs = payload?.txs;
    if (Array.isArray(txs)) {
        for (const tx of txs) {
            const to = (tx?.to || tx?.toAddress || tx?.to_address || "").toLowerCase();
            const hash = tx?.hash || tx?.transactionHash || tx?.transaction_hash;
            if (to && hash && to === interactionContract)
                candidates.push(String(hash));
        }
    }
    const singleTo = (payload?.tx?.to || payload?.to || "").toLowerCase();
    const singleHash = payload?.tx?.hash || payload?.hash || payload?.txHash;
    if (singleTo && singleHash && singleTo === interactionContract)
        candidates.push(String(singleHash));
    return Array.from(new Set(candidates));
}
// ---------- Core processing ----------
function humanAmount(valueRaw, decimals) {
    try {
        return ethers_1.ethers.formatUnits(valueRaw, decimals);
    }
    catch {
        return "0";
    }
}
function thresholdFor(tokenAddressLower, symbolMaybe) {
    const byAddr = thresholds[tokenAddressLower];
    if (typeof byAddr === "number")
        return byAddr;
    if (symbolMaybe) {
        const bySym = thresholds[symbolMaybe.toUpperCase()];
        if (typeof bySym === "number")
            return bySym;
    }
    if (STRICT_MODE)
        return null;
    if (Number.isFinite(DEFAULT_THRESHOLD) && DEFAULT_THRESHOLD > 0)
        return DEFAULT_THRESHOLD;
    return null;
}
function toNumberSafe(s) {
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
}
async function processTransfers(opts) {
    const { chainSlug, interactionContract, txHash } = opts;
    const timestampSeconds = opts.timestampSeconds ?? Math.floor(Date.now() / 1000);
    for (const t of opts.transfers) {
        if (t.txHash.toLowerCase() !== txHash.toLowerCase())
            continue;
        const tokenAddr = t.tokenAddress.toLowerCase();
        let symbol = t.symbol;
        let decimals = t.decimals;
        if (!symbol || decimals === undefined || Number.isNaN(decimals)) {
            const meta = await getTokenMeta(chainSlug, tokenAddr);
            if (!meta)
                continue; // strict skip if can't resolve meta
            symbol = symbol || meta.symbol;
            decimals = decimals ?? meta.decimals;
        }
        const threshold = thresholdFor(tokenAddr, symbol);
        if (threshold === null)
            continue;
        const amountHuman = humanAmount(t.valueRaw, decimals);
        const amountNum = toNumberSafe(amountHuman);
        if (amountNum <= threshold)
            continue;
        const dedupeKey = `dedupe:${chainSlug}:${txHash.toLowerCase()}:${t.logIndex}:${tokenAddr}:${t.to.toLowerCase()}`;
        const already = await dedupe.seen(dedupeKey, DEDUPE_TTL_SECONDS);
        if (already)
            continue;
        const msg = `🔔 ERC-20 Transfer Detected\n` +
            `Chain: ${chainSlug}\n` +
            `Token: ${symbol} (${tokenAddr})\n` +
            `Amount: ${amountHuman}\n` +
            `From: ${t.from}\n` +
            `To: ${t.to}\n` +
            `Tx: ${txHash}\n` +
            `Explorer: ${explorerTx(chainSlug, txHash)}\n` +
            `Timestamp: ${new Date(timestampSeconds * 1000).toISOString()}\n` +
            `Interaction Contract: ${interactionContract}`;
        await withRetry(() => (0, telegram_1.sendTelegram)(msg), { retries: 5, baseMs: 500, maxMs: 8000 });
        logger.info({ chainSlug, txHash, tokenAddr, to: t.to, logIndex: t.logIndex, amountHuman }, "Telegram sent");
    }
}
async function handleWebhook(raw, headers, payload) {
    verifyMoralisSignature(raw, headers);
    const { chainSlug } = normalizeChainSlug(payload);
    if (!CHAINS_ALLOWED.has(chainSlug)) {
        logger.info({ chainSlug }, "Chain not allowed, ignoring");
        return { ok: true, ignored: true, reason: "chain_not_allowed" };
    }
    const candidates = findCandidateInteractionTxHashes(payload, INTERACTION_CONTRACT);
    if (!candidates.length) {
        return { ok: true, ignored: true, reason: "no_interaction_tx" };
    }
    let transfers = parseFromMoralisErc20Transfers(payload);
    if (!transfers.length)
        transfers = parseFromRawLogs(payload);
    if (!transfers.length) {
        return { ok: true, ignored: true, reason: "no_transfers" };
    }
    const ts = payload?.block?.timestamp ?? payload?.block_timestamp ?? payload?.confirmedAt ?? payload?.confirmed_at;
    const timestampSeconds = typeof ts === "number" ? ts : undefined;
    for (const txHash of candidates) {
        await processTransfers({
            chainSlug,
            interactionContract: INTERACTION_CONTRACT,
            txHash,
            transfers,
            timestampSeconds
        });
    }
    return { ok: true };
}
// ---------- Signature verification ----------
function headerValue(headers, name) {
    const v = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
    if (typeof v === "string")
        return v;
    if (Array.isArray(v) && typeof v[0] === "string")
        return v[0];
    return null;
}
function verifyMoralisSignature(raw, headers) {
    const overrideHeader = process.env.MORALIS_SIGNATURE_HEADER;
    const sig = (overrideHeader ? headerValue(headers, overrideHeader) : null) ||
        headerValue(headers, "x-signature") ||
        headerValue(headers, "x-moralis-signature") ||
        headerValue(headers, "x-webhook-signature");
    if (!sig) {
        const err = new Error("Missing webhook signature header");
        err.statusCode = 401;
        throw err;
    }
    const digest = (0, crypto_1.createHmac)("sha256", MORALIS_WEBHOOK_SECRET).update(raw).digest("hex");
    const normalizedSig = sig.startsWith("sha256=") ? sig.slice("sha256=".length) : sig;
    const a = Buffer.from(digest, "utf8");
    const b = Buffer.from(normalizedSig, "utf8");
    if (a.length !== b.length || !(0, crypto_1.timingSafeEqual)(a, b)) {
        const err = new Error("Invalid webhook signature");
        err.statusCode = 401;
        throw err;
    }
}
// ---------- Raw body reader (no plugins) ----------
async function readRawBody(req) {
    const chunks = [];
    for await (const chunk of req.raw) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}
// ---------- Server ----------
function buildServer() {
    const app = (0, fastify_1.default)({
        logger: logger
    });
    app.get("/health", async () => ({ ok: true }));
    app.post("/webhooks/moralis", async (req, reply) => {
        try {
            const rawBuf = await readRawBody(req);
            const payload = JSON.parse(rawBuf.toString("utf8"));
            const result = await handleWebhook(rawBuf, req.headers, payload);
            return reply.code(200).send(result);
        }
        catch (err) {
            const status = err?.statusCode || 500;
            logger.error({ err }, "Webhook error");
            return reply.code(status).send({ ok: false, error: err?.message || "error" });
        }
    });
    return app;
}
async function main() {
    const port = Number(process.env.PORT || "8080");
    const host = "0.0.0.0";
    const app = buildServer();
    await app.listen({ port, host });
    logger.info({ port }, "Server started");
}
if (require.main === module) {
    main().catch((err) => {
        logger.error({ err }, "Fatal");
        process.exit(1);
    });
}
