import dotenv from "dotenv";
import { WebSocketProvider, getAddress, Interface } from "ethers";
import { getTokenMetaCached } from "./tokenMeta.js";
import { sendTelegram } from "./telegram.js";
import { toTopicAddress, includesKey } from "./utils.js";
import http from "http";

// Fly зазвичай дає PORT=8080
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

// Простий health endpoint, щоб Fly міг перевіряти що процес живий
http
  .createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("ok");
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("tge-key-tracker running");
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`Health server listening on 0.0.0.0:${PORT}`);
  });

dotenv.config();

/**
 * ENV
 */
const NODEREAL_API_KEY = process.env.NODEREAL_API_KEY;
const WS_ENDPOINT =
  process.env.WS_ENDPOINT ||
  (NODEREAL_API_KEY ? `wss://bsc-ws-node.nodereal.io/ws/v1/${NODEREAL_API_KEY}` : null);

const WATCH_ADDRESSES_RAW = process.env.WATCH_ADDRESS; // "0xabc...,0xdef..."
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

// Опційно: мінімальний amount у raw (в найменших одиницях токена) — антиспам
const MIN_RAW = process.env.MIN_RAW ? BigInt(process.env.MIN_RAW) : 0n;

// Опційно: explorer tx url
const EXPLORER_TX = process.env.EXPLORER_TX || "https://bscscan.com/tx/";

if (!WS_ENDPOINT) throw new Error("Missing WS_ENDPOINT or NODEREAL_API_KEY");
if (!WATCH_ADDRESSES_RAW) throw new Error("Missing WATCH_ADDRESSES (comma-separated list)");
if (!TG_BOT_TOKEN) throw new Error("Missing TG_BOT_TOKEN");
if (!TG_CHAT_ID) throw new Error("Missing TG_CHAT_ID");

/**
 * Normalize watch list
 */
const WATCH_LIST = WATCH_ADDRESSES_RAW.split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((a) => getAddress(a));

const WATCH_TOPICS = WATCH_LIST.map((a) => toTopicAddress(a));

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

/**
 * Ethers provider (WS)
 */
const provider = new WebSocketProvider(WS_ENDPOINT);

/**
 * Minimal ERC20 ABI for decoding Transfer
 */
const ERC20_ABI = ["event Transfer(address indexed from, address indexed to, uint256 value)"];
const iface = new Interface(ERC20_ABI);
const transferTopic = iface.getEvent("Transfer").topicHash;

/**
 * Dedup cache: txHash:logIndex
 */
const seen = new Set();

/**
 * Subscribe:
 *  - topic0 = Transfer
 *  - topic2 (indexed to) = one of WATCH_TOPICS (OR)
 *
 * Це суперефективно: ми НЕ слухаємо весь блокчейн, а тільки transfers на твої адреси.
 */
const filter = {
  topics: [transferTopic, null, WATCH_TOPICS.length === 1 ? WATCH_TOPICS[0] : WATCH_TOPICS]
};

log("Starting KEY-like token tracker…");
log("WS_ENDPOINT:", WS_ENDPOINT);
log("WATCH_ADDRESSES:", WATCH_LIST.join(", "));

provider.on(filter, async (logEvent) => {
  try {
    const dedupeKey = `${logEvent.transactionHash}:${logEvent.index}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    const parsed = iface.parseLog({ topics: logEvent.topics, data: logEvent.data });
    if (!parsed || parsed.name !== "Transfer") return;

    const from = getAddress(parsed.args.from);
    const to = getAddress(parsed.args.to);
    const value = BigInt(parsed.args.value.toString());

    // safety
    if (!WATCH_LIST.includes(to)) return;
    if (value < MIN_RAW) return;

    const tokenAddress = getAddress(logEvent.address);

    // Fetch & cache token meta (symbol/name/decimals) ONCE per token contract
    const meta = await getTokenMetaCached(provider, tokenAddress);

    // Check KEY substring in symbol or name (case-insensitive)
    //const isKeyLike = includesKey(meta.symbol) || includesKey(meta.name);
    //if (!isKeyLike) return;

    // Pretty amount
    const amountHuman = meta.decimals != null
      ? formatUnitsBigInt(value, meta.decimals)
      : value.toString();

    const txUrl = `${EXPLORER_TX}${logEvent.transactionHash}`;

    const msg =
      `🔑 KEY-like token received\n` +
      `Token: ${meta.symbol || "?"} (${meta.name || "?"})\n` +
      `Contract: ${tokenAddress}\n` +
      `To: ${to}\n` +
      `From: ${from}\n` +
      `Amount: ${amountHuman} ${meta.symbol || ""}\n` +
      `Tx: ${txUrl}`;

    await sendTelegram({ botToken: TG_BOT_TOKEN, chatId: TG_CHAT_ID, text: msg });
    log("Sent Telegram:", msg);
  } catch (e) {
    log("Handler error:", e?.message || e);
  }
});

// WS lifecycle logs
provider._websocket?.on?.("open", () => log("WebSocket OPEN"));
provider._websocket?.on?.("close", (c) => log("WebSocket CLOSE", c));
provider._websocket?.on?.("error", (e) => log("WebSocket ERROR", e?.message || e));

/**
 * Simple bigint formatter to decimal string (no float errors)
 */
function formatUnitsBigInt(value, decimals) {
  const s = value.toString();
  if (decimals === 0) return s;
  const d = Number(decimals);
  const pad = d - s.length + 1;
  const whole = pad > 0 ? "0" : s.slice(0, -d);
  const frac = (pad > 0 ? "0".repeat(pad) + s : s).slice(-d);
  const fracTrim = frac.replace(/0+$/, "");
  return fracTrim ? `${whole}.${fracTrim}` : whole;
}
