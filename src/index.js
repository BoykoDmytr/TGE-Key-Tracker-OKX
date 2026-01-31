import dotenv from "dotenv";
dotenv.config();

import http from "http";
import { Interface, WebSocketProvider, JsonRpcProvider, getAddress } from "ethers";

import { CHAINS } from "./chains.js";
import { sendTelegram } from "./telegram.js";
import { getTokenMetaCached } from "./tokenMeta.js";
import { toTopicAddress } from "./utils.js";

// --------- Safety logs (щоб бачити причину крашів) ----------
process.on("uncaughtException", (err) => console.error("UNCAUGHT_EXCEPTION:", err));
process.on("unhandledRejection", (err) => console.error("UNHANDLED_REJECTION:", err));

// --------- Health server (для Fly smoke checks) -------------
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
http
  .createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("ok");
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("running");
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`Health server listening on 0.0.0.0:${PORT}`);
  });

// --------- ENV -------------
const WATCH_ADDRESSES_RAW = process.env.WATCH_ADDRESSES || process.env.WATCH_ADDRESS;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

// polling interval for HTTP chains (Base)
const POLL_MS = process.env.POLL_MS ? Number(process.env.POLL_MS) : 6000;

function missing(name) {
  console.error(`Missing env: ${name}`);
  return true;
}

let bad = false;
if (!WATCH_ADDRESSES_RAW) bad = true, missing("WATCH_ADDRESSES (or WATCH_ADDRESS)");
if (!TG_BOT_TOKEN) bad = true, missing("TG_BOT_TOKEN");
if (!TG_CHAT_ID) bad = true, missing("TG_CHAT_ID");

const enabledChains = CHAINS.filter((c) => !!c.rpc);
if (enabledChains.length === 0) {
  bad = true;
  console.error("No chain RPC endpoints provided. Set WS_ETH / WS_ARB / HTTP_BASE.");
}

if (bad) {
  console.error("Env is incomplete. Bot will stay alive (health ok) but will NOT track transfers.");
  setInterval(() => {}, 1 << 30);
}

// --------- Watch list normalize ----------
const WATCH_LIST = WATCH_ADDRESSES_RAW
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((a) => getAddress(a));

const WATCH_TOPICS = WATCH_LIST.map((a) => toTopicAddress(a));

// --------- ERC20 Transfer event ----------
const ERC20_ABI = ["event Transfer(address indexed from, address indexed to, uint256 value)"];
const iface = new Interface(ERC20_ABI);
const transferTopic = iface.getEvent("Transfer").topicHash;

// --------- Start watchers ----------
console.log("WATCH_ADDRESSES:", WATCH_LIST.join(", "));
console.log("Enabled chains:", enabledChains.map((c) => `${c.name}(${c.type})`).join(", "));

for (const chain of enabledChains) {
  if (chain.type === "ws") startWsWatcher(chain);
  else startHttpPollingWatcher(chain);
}

// ---------------- WS watcher ----------------
function startWsWatcher(chain) {
  console.log(`[${chain.name}] WS endpoint: ${chain.rpc}`);
  const provider = new WebSocketProvider(chain.rpc);

  const seen = new Set(); // txHash:logIndex (per chain)

  const filter = {
    topics: [transferTopic, null, WATCH_TOPICS.length === 1 ? WATCH_TOPICS[0] : WATCH_TOPICS],
  };

  provider.on(filter, async (logEvent) => {
    const dedupeKey = `${logEvent.transactionHash}:${logEvent.index}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    try {
      const parsed = iface.parseLog({ topics: logEvent.topics, data: logEvent.data });
      const from = getAddress(parsed.args.from);
      const to = getAddress(parsed.args.to);
      const value = BigInt(parsed.args.value.toString());

      // only incoming to our watch list
      if (!WATCH_LIST.includes(to)) return;

      const tokenAddress = getAddress(logEvent.address);
      const meta = await getTokenMetaCached(provider, tokenAddress);

      const amountHuman =
        meta.decimals != null ? formatUnitsBigInt(value, meta.decimals) : value.toString();

      const txUrl = `${chain.explorerTx}${logEvent.transactionHash}`;

      const msg =
        `📥 Incoming ERC-20 Transfer\n` +
        `Chain: ${chain.name}\n` +
        `Token: ${meta.symbol || "?"} (${meta.name || "?"})\n` +
        `TokenContract: ${tokenAddress}\n` +
        `To: ${to}\n` +
        `From: ${from}\n` +
        `Amount: ${amountHuman} ${meta.symbol || ""}\n` +
        `Tx: ${txUrl}`;

      await sendTelegram({ botToken: TG_BOT_TOKEN, chatId: TG_CHAT_ID, text: msg });
      console.log(`[${chain.name}] Sent Telegram: ${logEvent.transactionHash}`);
    } catch (e) {
      console.error(`[${chain.name}] handler error:`, e?.message || e);
    }
  });

  provider._websocket?.on?.("open", () => console.log(`[${chain.name}] WebSocket OPEN`));
  provider._websocket?.on?.("close", (c) => console.log(`[${chain.name}] WebSocket CLOSE`, c));
  provider._websocket?.on?.("error", (e) =>
    console.log(`[${chain.name}] WebSocket ERROR`, e?.message || e)
  );
}

// ---------------- HTTP polling watcher (Base) ----------------
// NodeReal Base docs show HTTPS endpoint format; WS not shown -> polling via getBlockNumber + getLogs. :contentReference[oaicite:1]{index=1}
function startHttpPollingWatcher(chain) {
  console.log(`[${chain.name}] HTTP endpoint: ${chain.rpc} (polling every ~${POLL_MS}ms)`);
  const provider = new JsonRpcProvider(chain.rpc);

  const seen = new Set(); // txHash:logIndex
  let lastBlock = null;

  const baseFilter = {
    topics: [transferTopic, null, WATCH_TOPICS.length === 1 ? WATCH_TOPICS[0] : WATCH_TOPICS],
  };

  const tick = async () => {
    try {
      const current = await provider.getBlockNumber();
      if (lastBlock == null) {
        lastBlock = current;
        console.log(`[${chain.name}] start from block ${lastBlock}`);
        return;
      }

      if (current <= lastBlock) return;

      // scan only new blocks
      const fromBlock = lastBlock + 1;
      const toBlock = current;

      // chunk if large (safety)
      const CHUNK = 2000;
      for (let b = fromBlock; b <= toBlock; b += CHUNK) {
        const end = Math.min(b + CHUNK - 1, toBlock);
        const logs = await provider.getLogs({ ...baseFilter, fromBlock: b, toBlock: end });

        for (const logEvent of logs) {
          const dedupeKey = `${logEvent.transactionHash}:${logEvent.index}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);

          try {
            const parsed = iface.parseLog({ topics: logEvent.topics, data: logEvent.data });
            const from = getAddress(parsed.args.from);
            const to = getAddress(parsed.args.to);
            const value = BigInt(parsed.args.value.toString());
            if (!WATCH_LIST.includes(to)) continue;

            const tokenAddress = getAddress(logEvent.address);
            const meta = await getTokenMetaCached(provider, tokenAddress);

            const amountHuman =
              meta.decimals != null ? formatUnitsBigInt(value, meta.decimals) : value.toString();

            const txUrl = `${chain.explorerTx}${logEvent.transactionHash}`;

            const msg =
              `📥 Incoming ERC-20 Transfer\n` +
              `Chain: ${chain.name}\n` +
              `Token: ${meta.symbol || "?"} (${meta.name || "?"})\n` +
              `TokenContract: ${tokenAddress}\n` +
              `To: ${to}\n` +
              `From: ${from}\n` +
              `Amount: ${amountHuman} ${meta.symbol || ""}\n` +
              `Tx: ${txUrl}`;

            await sendTelegram({ botToken: TG_BOT_TOKEN, chatId: TG_CHAT_ID, text: msg });
            console.log(`[${chain.name}] Sent Telegram: ${logEvent.transactionHash}`);
          } catch (e) {
            console.error(`[${chain.name}] parse/send error:`, e?.message || e);
          }
        }
      }

      lastBlock = current;
    } catch (e) {
      console.error(`[${chain.name}] polling tick error:`, e?.message || e);
    }
  };

  // run periodically
  setInterval(tick, POLL_MS);
  // and run immediately once
  tick();
}

// --------- helpers ----------
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
