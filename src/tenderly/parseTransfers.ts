import type { TransactionReceipt } from 'viem';
import { hexToBigInt } from 'viem';

const TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

type Hex = `0x${string}`;

export type ParsedTransfer = {
  token: Hex;
  from: Hex;
  to: Hex;
  value: bigint;
  logIndex: number;
};

function isHex(x: unknown): x is Hex {
  return typeof x === 'string' && x.startsWith('0x');
}

export function extractTransfersFromReceipt(receipt: TransactionReceipt): ParsedTransfer[] {
  const out: ParsedTransfer[] = [];
  const logs = receipt?.logs ?? [];

  for (const log of logs) {
    const topics = log.topics ?? [];
    if (!topics[0] || typeof topics[0] !== 'string') continue;
    if (topics[0].toLowerCase() !== TRANSFER_TOPIC0) continue;

    // topics[1], topics[2] можуть бути undefined/null
    const t1 = topics[1];
    const t2 = topics[2];
    if (!isHex(t1) || !isHex(t2)) continue;

    if (!isHex(log.address)) continue;
    if (!isHex(log.data)) continue;

    const from = topicToAddress(t1);
    const to = topicToAddress(t2);

    const value = hexToBigInt(log.data); // ✅ готовий парсер viem
    const logIndex = typeof log.logIndex === 'number' ? log.logIndex : Number(log.logIndex ?? 0);

    out.push({
      token: log.address,
      from,
      to,
      value,
      logIndex,
    });
  }

  return out;
}

function topicToAddress(topic: Hex): Hex {
  return (`0x${topic.slice(-40)}`) as Hex;
}
