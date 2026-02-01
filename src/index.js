import dotenv from "dotenv";
dotenv.config();

import http from "http";
import { Interface, JsonRpcProvider, getAddress } from "ethers";

import { CHAINS } from "./chains.js";
import { sendTelegram } from "./telegram.js";
import { getTokenMetaCached } from "./tokenMeta.js";

// --------- Safety logs ----------
process.on("uncaughtException", (err) => console.error("UNCAUGHT_EXCEPTION:", err));
process.on("unhandledRejection", (err) => console.error("UNHANDLED_REJECTION:", err));

// --------- Health server (Fly smoke checks) ----------
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

// --------- ENV ----------
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

const POLL_MS = process.env.POLL_MS ? Number(process.env.POLL_MS) : 15000;

// rate limit: X повідомлень/хв
const RATE_LIMIT_PER_MIN = process.env.RATE_LIMIT_PER_MIN
  ? Number(process.env.RATE_LIMIT_PER_MIN)
  : 20;

// Factory contract (interacted with / tx.to)
const FACTORY_CONTRACT = getAddress(
  process.env.FACTORY_CONTRACT || "0x000310fa98e36191ec79de241d72c6ca093eafd3"
);

function missing(name) {
  console.error(`Missing env: ${name}`);
  return true;
}

let bad = false;
if (!TG_BOT_TOKEN) (bad = true), missing("TG_BOT_TOKEN");
if (!TG_CHAT_ID) (bad = true), missing("TG_CHAT_ID");

const enabledChains = CHAINS.filter((c) => !!c.rpc);
if (enabledChains.length === 0) {
  bad = true;
  console.error("No chain RPC endpoints provided. Check CHAINS.js and your env RPC vars.");
}

if (bad) {
  console.error("Env is incomplete. Bot will stay alive (health ok) but will NOT track.");
  setInterval(() => {}, 1 << 30);
}

// --------- ERC20 Transfer event ----------
const ERC20_ABI = ["event Transfer(address indexed from, address indexed to, uint256 value)"];
const iface = new Interface(ERC20_ABI);
const transferTopic = iface.getEvent("Transfer").topicHash;

// --------- Start watcher (BSC only) ----------
console.log("Enabled chains:", enabledChains.map((c) => `${c.name}(${c.type})`).join(", "));
console.log("FACTORY_CONTRACT:", FACTORY_CONTRACT);
console.log(`Polling every ~${POLL_MS}ms, rate limit: ${RATE_LIMIT_PER_MIN}/min`);

// шукаємо BSC chain
const bscChain =
  enabledChains.find((c) => c.key === "bsc") ||
  enabledChains.find((c) => (c.name || "").toLowerCase() === "bsc");

if (!bscChain) {
  console.error("BSC chain is not enabled in CHAINS.js (key:'bsc') or missing HTTP_BSC_RPC env.");
  setInterval(() => {}, 1 << 30);
} else {
  startFactoryInteractionWatcher(bscChain);
}

// ---------------- Factory interaction watcher (polling) ----------------
function startFactoryInteractionWatcher(chain) {
  console.log(`[${chain.name}] HTTP endpoint: ${chain.rpc} (factory tx polling)`);
  const provider = new JsonRpcProvider(chain.rpc);

  const seenTx = new Set(); // txHash dedupe
  let lastBlock = null;

  // Sliding-window rate limiter
  let sentTimestamps = [];
  const canSend = () => {
    const now = Date.now();
    sentTimestamps = sentTimestamps.filter((t) => now - t < 60_000);
    return sentTimestamps.length < RATE_LIMIT_PER_MIN;
  };
  const markSent = () => sentTimestamps.push(Date.now());

  const tick = async () => {
    try {
      const current = await provider.getBlockNumber();

      if (lastBlock == null) {
        lastBlock = current;
        console.log(`[${chain.name}] start from block ${lastBlock}`);
        return;
      }

      if (current <= lastBlock) return;

      for (let b = lastBlock + 1; b <= current; b++) {
        const block = await provider.getBlock(b, true);
        if (!block?.transactions?.length) continue;

        const ts = Number(block.timestamp);

        for (const tx of block.transactions) {
          if (!tx?.to) continue;

          let toAddr;
          try {
            toAddr = getAddress(tx.to);
          } catch {
            continue;
          }

          // ✅ trigger on any tx where tx.to == FACTORY_CONTRACT
          if (toAddr !== FACTORY_CONTRACT) continue;

          const txHash = tx.hash;
          if (!txHash || seenTx.has(txHash)) continue;

          const receipt = await provider.getTransactionReceipt(txHash);
          if (!receipt?.logs?.length) {
            seenTx.add(txHash);
            continue;
          }

          // ✅ parse ALL ERC-20 Transfer logs in this tx (no WATCH filtering)
          const transfersAll = parseTransferLogs(receipt.logs);

          // якщо взагалі нема Transfer логів — можна не надсилати
          if (transfersAll.length === 0) {
            seenTx.add(txHash);
            continue;
          }

          // fetch token meta for each transfer
          for (const t of transfersAll) {
            const meta = await getTokenMetaCached(provider, t.tokenContract);
            t.meta = meta || { address: t.tokenContract, symbol: null, name: null, decimals: null };
          }

          if (!canSend()) {
            console.log(`[${chain.name}] rate limit reached, skipping tx ${txHash}`);
            // ⚠️ пропускаємо, але щоб не спамити повторно — дедупимо
            seenTx.add(txHash);
            continue;
          }

          const msg = formatTelegramMessage({
            chain,
            txHash,
            sender: getAddress(tx.from),
            interactedWith: FACTORY_CONTRACT,
            blockNumber: Number(receipt.blockNumber),
            timestamp: ts,
            transfers: transfersAll,
          });

          await sendTelegram({ botToken: TG_BOT_TOKEN, chatId: TG_CHAT_ID, text: msg });
          markSent();
          seenTx.add(txHash);

          console.log(`[${chain.name}] Sent Telegram for factory tx: ${txHash}`);
        }
      }

      lastBlock = current;
    } catch (e) {
      console.error(`[${chain.name}] polling tick error:`, e?.message || e);
    }
  };

  setInterval(tick, POLL_MS);
  tick();
}

// ---------------- helpers ----------------
function parseTransferLogs(logs) {
  const out = [];

  for (const log of logs) {
    if (!log?.topics?.length) continue;
    if (log.topics[0] !== transferTopic) continue;

    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      out.push({
        tokenContract: getAddress(log.address),
        from: getAddress(parsed.args.from),
        to: getAddress(parsed.args.to),
        value: BigInt(parsed.args.value.toString()),
        logIndex: Number(log.index ?? log.logIndex ?? 0),
        meta: null,
      });
    } catch {
      // ignore
    }
  }

  out.sort((a, b) => a.logIndex - b.logIndex);
  return out;
}

function formatTelegramMessage({ chain, txHash, sender, interactedWith, blockNumber, timestamp, transfers }) {
  const txUrl = `${chain.explorerTx}${txHash}`;

  const lines = [];
  lines.push(`Contract interaction detected`);
  lines.push(`Chain: ${chain.name}`);
  lines.push(`Interacted contract: ${interactedWith}`);
  lines.push(`Tx: ${txHash}`);
  lines.push(`Link: ${txUrl}`);
  lines.push(`Sender: ${sender}`);
  lines.push(`Block: ${blockNumber}`);
  lines.push(`Timestamp (unix): ${timestamp}`);
  lines.push(``);
  lines.push(`Token transfers in this transaction:`);

  const show = transfers.slice(0, 5);

  for (const t of show) {
    const meta = t.meta || {};
    const symbol = meta.symbol || "?";
    const name = meta.name || "?";
    const decimals = meta.decimals;

    const amountHuman = decimals != null ? formatUnitsBigInt(t.value, decimals) : t.value.toString();

    if (!meta.symbol && !meta.name) {
      lines.push(`- Token: Unknown token metadata`);
      lines.push(`  Token contract: ${t.tokenContract}`);
    } else {
      lines.push(`- Token: ${symbol} (${name})`);
      lines.push(`  Token contract: ${t.tokenContract}`);
    }

    lines.push(`  Transfer: ${t.from} -> ${t.to}`);
    lines.push(`  Amount: ${amountHuman} ${meta.symbol || ""}`.trim());
  }

  if (transfers.length > 5) {
    lines.push(`+${transfers.length - 5} more`);
  }

  return lines.join("\n");
}

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
