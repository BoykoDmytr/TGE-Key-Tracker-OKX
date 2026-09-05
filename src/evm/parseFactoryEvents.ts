// src/evm/parseFactoryEvents.ts
//
// THE authoritative record of a deposit is the DistributorFactory's own creation event.
// One event == one distributor created == exactly one Telegram message.
//
// Why this module exists (incident 2026-08-05):
// processDepositTx used to walk EVERY ERC-20 Transfer log in the receipt and treat each
// one as a separate deposit. A reflection/tax token with a dividend tracker emits dozens
// of Transfer logs for a single transfer (paying out holders), so ONE legitimate
// createDistributor on X Layer produced 49 would-be messages; 20 reached the channel
// before Telegram 429'd. 13 users muted the channel, 5 left.
//
// The factory emits exactly one event per creation and it carries everything we need,
// so there is no reason to guess from Transfer logs ever again.

type Hex = `0x${string}`;

// NEW factory 0x00306cEfc385c8767cA580913a3F88319a343FC0 — data = [token, distributor, amount]
export const CREATED_TOPIC_NEW =
  '0xcf9068cf0507f6c18ee38fd73ba24a528f514f0e73ad08229b6db0541071d48d';
// OLD factory 0x000310fa98E36191ec79de241d72C6CA093EAFd3 — data = [token, distributor] (NO amount)
export const CREATED_TOPIC_OLD =
  '0xe31b7f4b4f3b6042afb5723869d989be921bea013625e326792f25a623ea6c20';

const TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const SPEC: Record<string, { dataWords: number; hasAmount: boolean; label: string }> = {
  [CREATED_TOPIC_NEW]: { dataWords: 3, hasAmount: true, label: 'new' },
  [CREATED_TOPIC_OLD]: { dataWords: 2, hasAmount: false, label: 'old' },
};

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

export interface DistributorCreatedEvent {
  factory: string;
  /** topics[1] — the wallet that CALLED createDistributor. A third party cannot write this
   *  about someone else, which is why the spam filter keys its creator history on it. */
  creator: string;
  /** topics[2] — the operator ARGUMENT the caller passed in. Anyone may name any address
   *  here, so it may DOWNGRADE trust, never establish it. */
  operator: string;
  token: Hex;
  distributor: Hex;
  /** amount as declared by the factory event. NEW factory only; null on OLD. */
  declaredAmount: bigint | null;
  logIndex: number;
  variant: string;
}

export interface RejectedFactoryLog {
  factory: string;
  topic0: string;
  logIndex: number;
  reason: string;
}

export interface ParseFactoryResult {
  events: DistributorCreatedEvent[];
  /** Logs emitted BY a known factory that we could not decode — i.e. a possible new
   *  factory version. Never auto-posted; surfaced so a human can add support. */
  rejected: RejectedFactoryLog[];
}

function word(data: string, i: number): string {
  const d = data.startsWith('0x') ? data.slice(2) : data;
  return d.slice(i * 64, (i + 1) * 64);
}

/** A 32-byte word holds an address only if the top 12 bytes are zero. */
function isAddressWord(w: string): boolean {
  return /^0{24}[0-9a-fA-F]{40}$/.test(w);
}

function toAddress(w: string): Hex {
  return (`0x${w.slice(24)}`).toLowerCase() as Hex;
}

/**
 * Extract distributor-creation events from a receipt.
 *
 * `isKnownFactory` is a SECURITY BOUNDARY, not an optimisation: any contract can emit any
 * topic0 it likes. Matching on topic0 alone would let anyone mint a fake
 * "NEW OKX DEPOSIT DETECTED" post (carrying our refback link) for the price of one log.
 * The emitting address MUST be an allowlisted factory.
 */
export function extractDistributorCreated(
  receipt: { logs?: any[] },
  isKnownFactory: (addr: string) => boolean,
): ParseFactoryResult {
  const events: DistributorCreatedEvent[] = [];
  const rejected: RejectedFactoryLog[] = [];

  for (const log of receipt?.logs ?? []) {
    const addr = String(log?.address ?? '').toLowerCase();
    if (!addr || !isKnownFactory(addr)) continue; // not our factory -> ignore entirely

    const topics: string[] = log?.topics ?? [];
    const topic0 = String(topics[0] ?? '').toLowerCase();
    const logIndex = typeof log.logIndex === 'number' ? log.logIndex : Number(log.logIndex ?? 0);

    const spec = SPEC[topic0];
    if (!spec) {
      // Known factory, unknown event: could be an unrelated event, could be factory v3.
      rejected.push({ factory: addr, topic0, logIndex, reason: 'unknown-topic0' });
      continue;
    }

    const data = String(log?.data ?? '0x');
    if (topics.length !== 3) {
      rejected.push({ factory: addr, topic0, logIndex, reason: `topics=${topics.length}, want 3` });
      continue;
    }
    if (data.length !== 2 + 64 * spec.dataWords) {
      rejected.push({
        factory: addr, topic0, logIndex,
        reason: `data=${data.length} chars, want ${2 + 64 * spec.dataWords}`,
      });
      continue;
    }

    const w0 = word(data, 0);
    const w1 = word(data, 1);
    if (!isAddressWord(w0) || !isAddressWord(w1)) {
      rejected.push({ factory: addr, topic0, logIndex, reason: 'data words not address-shaped' });
      continue;
    }

    const token = toAddress(w0);
    const distributor = toAddress(w1);
    if (distributor === ZERO_ADDR || token === ZERO_ADDR) {
      rejected.push({ factory: addr, topic0, logIndex, reason: 'zero address' });
      continue;
    }

    let declaredAmount: bigint | null = null;
    if (spec.hasAmount) {
      try {
        declaredAmount = BigInt('0x' + word(data, 2));
      } catch {
        declaredAmount = null;
      }
    }

    const creator = topics[1] ? (`0x${String(topics[1]).slice(26)}`).toLowerCase() : '';
    const operator = topics[2] ? (`0x${String(topics[2]).slice(26)}`).toLowerCase() : '';

    events.push({ factory: addr, creator, operator, token, distributor, declaredAmount, logIndex, variant: spec.label });
  }

  events.sort((a, b) => a.logIndex - b.logIndex);
  return { events, rejected };
}

/**
 * How much of `token` actually LANDED in `distributor` in this transaction.
 *
 * Preferred over the event's declared amount because tax/reflection tokens skim on
 * transfer: the DOG incident tx declared 20000 but only 19800 reached the distributor,
 * and 19800 is what will actually be claimable.
 */
export function sumTransfersTo(
  receipt: { logs?: any[] },
  token: string,
  distributor: string,
): bigint {
  const tok = token.toLowerCase();
  const dst = distributor.toLowerCase();
  let total = 0n;

  for (const log of receipt?.logs ?? []) {
    if (String(log?.address ?? '').toLowerCase() !== tok) continue;
    const topics: string[] = log?.topics ?? [];
    if (String(topics[0] ?? '').toLowerCase() !== TRANSFER_TOPIC0) continue;
    if (topics.length < 3 || typeof topics[2] !== 'string') continue;
    if (`0x${topics[2].slice(-40)}`.toLowerCase() !== dst) continue;
    try {
      total += BigInt(String(log?.data ?? '0x0'));
    } catch {
      /* malformed log — ignore this one, keep the rest */
    }
  }
  return total;
}
