import { JsonRpcProvider, Interface, getAddress } from "ethers";
import { getTokenMetaCached } from "./tokenMeta.js";
import { sendTelegram } from "./telegram.js";

// Factory (Interacted With) зі скріну:
export const FACTORY = getAddress("0x000310fa98e36191ec79de241d72c6ca093eafd3");

// ERC-20 Transfer
const ERC20_ABI = ["event Transfer(address indexed from, address indexed to, uint256 value)"];
const iface = new Interface(ERC20_ABI);
const TRANSFER_TOPIC0 = iface.getEvent("Transfer").topicHash;

function lower(a) {
  return (a || "").toLowerCase();
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

// ---- required functions ----
export async function fetchLatestBlock(provider) {
  return provider.getBlockNumber();
}

export async function getTxReceipt(provider, txHash) {
  return provider.getTransactionReceipt(txHash);
}

export function parseTransferLogs(receiptLogs) {
  const out = [];
  for (const log of receiptLogs) {
    if (!log?.topics?.length) continue;
    if (log.topics[0] !== TRANSFER_TOPIC0) continue;

    // decode Transfer
    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      out.push({
        tokenContract: getAddress(log.address),
        from: getAddress(parsed.args.from),
        to: getAddress(parsed.args.to),
        value: BigInt(parsed.args.value.toString()),
        logIndex: Number(log.index ?? log.logIndex ?? 0),
      });
    } catch {
      // ignore unparseable
    }
  }
  return out;
}

// Якщо захочеш пізніше — можна додати ABI і розпарсити DistributorCreated.
// Але для твоєї вимоги не потрібно.
export function parseDistributorCreatedLogs(_receiptLogs) {
  return { distributorAddress: null };
}

export async function getTokenMeta(provider, tokenAddress) {
  // використовує існуючий кеш з repo
  return getTokenMetaCached(provider, tokenAddress);
}

export function formatTelegramMessage({
  chainName,
  explorerTx,
  txHash,
  sender,
  interactedWith,
  transfers,
  note,
}) {
  const txUrl = `${explorerTx}${txHash}`;

  const lines = [];
  lines.push(`Contract interaction detected`);
  lines.push(`Chain: ${chainName}`);
  lines.push(`Interacted contract: ${interactedWith}`);
  lines.push(`Tx: ${txHash}`);
  lines.push(`BscScan: ${txUrl}`);
  lines.push(`Sender: ${sender}`);
  if (note) lines.push(note);
  lines.push(``);

  lines.push(`Token transfers to WATCH_ADDRESS:`);

  const show = transfers.slice(0, 5);
  for (const t of show) {
    const meta = t.meta || {};
    const sym = meta.symbol || "?";
    const name = meta.name || "?";
    const dec = meta.decimals;

    const amount =
      dec != null ? formatUnitsBigInt(t.value, dec) : t.value.toString();

    lines.push(`- Token: ${sym} (${name})`);
    lines.push(`  Token contract: ${t.tokenContract}`);
    lines.push(`  Transfer: ${t.from} -> ${t.to}`);
    lines.push(`  Amount: ${amount} ${meta.symbol || ""}`.trim());
  }

  if (transfers.length > 5) {
    lines.push(`+${transfers.length - 5} more`);
  }

  return lines.join("\n");
}

// ---- main watcher ----
export function startDistributorWatcher({
  chainName,
  rpcUrl,
  explorerTx,
  tgBotToken,
  tgChatId,
  watchAddresses,      // array of checksum addresses
  pollMs = 15000,
  maxMsgsPerMin = 20,  // X повідомлень/хв
}) {
  const provider = new JsonRpcProvider(rpcUrl);

  const WATCH_SET = new Set(watchAddresses.map(a => getAddress(a)));
  const seenTx = new Set(); // txHash dedupe

  // rate limit (simple sliding window)
  let sentTimestamps = [];

  let lastBlock = null;

  async function rateLimitOk() {
    const now = Date.now();
    sentTimestamps = sentTimestamps.filter(t => now - t < 60_000);
    return sentTimestamps.length < maxMsgsPerMin;
  }

  async function markSent() {
    sentTimestamps.push(Date.now());
  }

  async function tick() {
    try {
      const current = await fetchLatestBlock(provider);

      if (lastBlock == null) {
        lastBlock = current;
        console.log(`[${chainName}] distributor watcher start from block ${lastBlock}`);
        return;
      }
      if (current <= lastBlock) return;

      for (let b = lastBlock + 1; b <= current; b++) {
        const block = await provider.getBlock(b, true); // with transactions
        if (!block?.transactions?.length) continue;

        for (const tx of block.transactions) {
          if (!tx?.to) continue;

          // Only tx.to == FACTORY
          if (getAddress(tx.to) !== FACTORY) continue;

          const txHash = tx.hash;
          if (seenTx.has(txHash)) continue;

          // Receipt
          const receipt = await getTxReceipt(provider, txHash);
          if (!receipt) continue;

          const transfersAll = parseTransferLogs(receipt.logs || []);

          // IMPORTANT: only transfers where to == WATCH_ADDRESS
          const transfersToWatch = transfersAll.filter(t => WATCH_SET.has(getAddress(t.to)));

          if (transfersToWatch.length === 0) {
            // якщо в цій транзі не було Transfer на твою адресу — ігноруємо
            continue;
          }

          // attach token meta (KEY filter ти просив раніше — але зараз ти хочеш “все, що прийшло”)
          for (const tr of transfersToWatch) {
            const meta = await getTokenMeta(provider, tr.tokenContract);
            tr.meta = meta;

            // Якщо metadata не читається — все одно шлемо, просто показуємо адресу
            if (!meta?.symbol && !meta?.name) {
              tr.meta = { ...(meta || {}), symbol: null, name: null };
            }
          }

          // rate limit
          if (!(await rateLimitOk())) {
            console.log(`[${chainName}] rate limit reached, skipping tx ${txHash}`);
            continue;
          }

          const msg = formatTelegramMessage({
            chainName,
            explorerTx,
            txHash,
            sender: getAddress(tx.from),
            interactedWith: FACTORY,
            transfers: transfersToWatch,
            note: `WATCH_ADDRESS matched: ${[...WATCH_SET].join(", ")}`,
          });

          await sendTelegram({ botToken: tgBotToken, chatId: tgChatId, text: msg });
          await markSent();

          seenTx.add(txHash);
          console.log(`[${chainName}] Sent distributor message for ${txHash}`);
        }
      }

      lastBlock = current;
    } catch (e) {
      console.error(`[${chainName}] distributor tick error:`, e?.message || e);
    }
  }

  setInterval(tick, pollMs);
  tick();

  console.log(`[${chainName}] Distributor watcher enabled. FACTORY=${FACTORY}`);
}
