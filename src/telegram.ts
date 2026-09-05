// src/telegram.ts
//
// Every channel message goes through ONE serialized, rate-limited queue with a circuit
// breaker. Before 2026-08-05 this file was a bare fetch(): ~10 independent producers
// (one poller loop per chain + Solana + 2 express routes) raced the same chat with zero
// coordination. A single buggy transaction fired 20 posts in seconds, hit Telegram 429,
// and cost the channel 13 mutes and 5 unsubscribes.
//
// Design rules learned from that incident:
//  1. sendTelegram() NEVER throws. A send failure must not abort a caller's loop.
//  2. On 429 we do NOT retry into the public channel. A retry storm is worse than a
//     missed alert — these alerts lose their value in minutes anyway.
//  3. When the breaker opens we DROP the queue. Replaying a backlog is a second flood.
//  4. The owner gets exactly one DM when the breaker trips, never a channel post.

const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_ID || '825050522';

// Telegram allows ~20 messages/minute to a single chat. Stay comfortably under it.
const MIN_SPACING_MS = Number(process.env.TG_MIN_SPACING_MS || 1100);
const MAX_PER_MINUTE = Number(process.env.TG_MAX_PER_MIN || 17);
// Breaker: legitimate traffic is a handful of posts per day, so this is very generous.
const BREAKER_MAX = Number(process.env.TG_BREAKER_MAX || 8);
const BREAKER_WINDOW_MS = Number(process.env.TG_BREAKER_WINDOW_MS || 10 * 60_000);
const BREAKER_COOLDOWN_MS = Number(process.env.TG_BREAKER_COOLDOWN_MS || 30 * 60_000);
const MAX_QUEUE = Number(process.env.TG_MAX_QUEUE || 40);
const SEND_TIMEOUT_MS = Number(process.env.TG_SEND_TIMEOUT_MS || 15_000);

type Job = { text: string; chatId: string; silent: boolean };

const queue: Job[] = [];
let working = false;
let lastSentAt = 0;
const sentTimes: number[] = []; // timestamps of recent channel sends

let breakerOpenUntil = 0;
let breakerReason = '';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function prune(now: number): void {
  while (sentTimes.length && now - sentTimes[0] > BREAKER_WINDOW_MS) sentTimes.shift();
}

export function breakerStatus(): { open: boolean; until: number; reason: string; queued: number } {
  return {
    open: Date.now() < breakerOpenUntil,
    until: breakerOpenUntil,
    reason: breakerReason,
    queued: queue.length,
  };
}

/** Manual recovery hook (wire to an admin route). */
export function resetBreaker(): void {
  breakerOpenUntil = 0;
  breakerReason = '';
  console.warn('[telegram] breaker manually reset');
}

/** Raw one-shot POST. Throws on failure — only the worker calls this. */
async function postMessage(chatId: string, text: string, silent: boolean, replyMarkup?: unknown): Promise<void> {
  const botToken = requireEnv('TELEGRAM_BOT_TOKEN');
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(silent ? { disable_notification: true } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err: any = new Error(`Telegram API error: ${res.status} ${body}`);
    err.status = res.status;
    try {
      err.retryAfter = JSON.parse(body)?.parameters?.retry_after;
    } catch { /* non-JSON body */ }
    throw err;
  }
}

/** Notify the owner directly. Never throws, never touches the channel, never queued. */
export async function notifyOwner(text: string): Promise<void> {
  try {
    await postMessage(OWNER_CHAT_ID, text, true);
  } catch (e: any) {
    console.error('[telegram] owner DM failed:', e?.message || e);
  }
}

/**
 * DM the owner with inline buttons (the approve/discard flow for filtered deposits).
 * Never throws, never touches the channel, never goes through the channel queue — the
 * owner's DM must keep working even when the channel breaker is open.
 */
export async function notifyOwnerWithButtons(
  text: string,
  buttons: Array<Array<{ text: string; callback_data: string }>>,
): Promise<void> {
  try {
    await postMessage(OWNER_CHAT_ID, text, true, { inline_keyboard: buttons });
  } catch (e: any) {
    console.error('[telegram] owner DM (buttons) failed:', e?.message || e);
  }
}

/** Answer a callback_query so Telegram stops showing the spinner on the button. */
export async function answerCallback(callbackQueryId: string, text: string): Promise<void> {
  try {
    const botToken = requireEnv('TELEGRAM_BOT_TOKEN');
    await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: text.slice(0, 200) }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (e: any) {
    console.error('[telegram] answerCallbackQuery failed:', e?.message || e);
  }
}

/** Replace the buttons on an owner DM after it has been acted on, so it cannot be
 *  double-approved by tapping again. Best effort. */
export async function editOwnerMarkup(messageId: number, note: string): Promise<void> {
  try {
    const botToken = requireEnv('TELEGRAM_BOT_TOKEN');
    await fetch(`https://api.telegram.org/bot${botToken}/editMessageReplyMarkup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: OWNER_CHAT_ID, message_id: messageId,
        reply_markup: { inline_keyboard: [[{ text: note, callback_data: 'noop' }]] },
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (e: any) {
    console.error('[telegram] editMessageReplyMarkup failed:', e?.message || e);
  }
}

export { OWNER_CHAT_ID };

function openBreaker(reason: string): void {
  breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
  breakerReason = reason;
  const dropped = queue.length;
  queue.length = 0; // DROP — replaying the backlog would be a second flood
  console.error('[telegram] CIRCUIT BREAKER OPEN: %s (dropped %d queued)', reason, dropped);
  void notifyOwner(
    `🚨 <b>Telegram circuit breaker OPEN</b>\n\n` +
    `Reason: ${reason}\n` +
    `Dropped from queue: ${dropped}\n` +
    `Channel posting paused for ${Math.round(BREAKER_COOLDOWN_MS / 60000)} min.\n\n` +
    `Investigate before resetting.`,
  );
}

async function worker(): Promise<void> {
  if (working) return;
  working = true;
  try {
    while (queue.length) {
      if (Date.now() < breakerOpenUntil) {
        const dropped = queue.length;
        queue.length = 0;
        console.error('[telegram] breaker open — dropped %d queued messages', dropped);
        break;
      }

      const now = Date.now();
      prune(now);
      if (sentTimes.length >= BREAKER_MAX) {
        openBreaker(`${sentTimes.length} sends in ${Math.round(BREAKER_WINDOW_MS / 60000)} min`);
        break;
      }

      // rolling per-minute cap
      const inLastMinute = sentTimes.filter((t) => now - t < 60_000).length;
      if (inLastMinute >= MAX_PER_MINUTE) {
        await sleep(2000);
        continue;
      }

      const wait = MIN_SPACING_MS - (now - lastSentAt);
      if (wait > 0) await sleep(wait);

      const job = queue.shift();
      if (!job) break;

      try {
        await postMessage(job.chatId, job.text, job.silent);
        lastSentAt = Date.now();
        sentTimes.push(lastSentAt);
      } catch (e: any) {
        lastSentAt = Date.now();
        if (e?.status === 429) {
          // Do NOT retry. Rate-limited means we are already posting too fast.
          openBreaker(`Telegram 429 (retry_after=${e?.retryAfter ?? '?'})`);
          break;
        }
        console.error('[telegram] send failed (dropped, not retried):', e?.message || e);
      }
    }
  } finally {
    working = false;
  }
}

/**
 * Enqueue a channel message. Resolves once queued — NOT once delivered.
 * Never throws: a Telegram problem must never break a caller's scan loop.
 */
export async function sendTelegram(text: string): Promise<void> {
  try {
    const chatId = requireEnv('TELEGRAM_CHAT_ID');

    if (Date.now() < breakerOpenUntil) {
      console.error('[telegram] breaker open — message suppressed');
      return;
    }
    if (queue.length >= MAX_QUEUE) {
      openBreaker(`queue overflow (>${MAX_QUEUE} pending)`);
      return;
    }

    queue.push({ text, chatId, silent: false });
    void worker();
  } catch (e: any) {
    console.error('[telegram] enqueue failed:', e?.message || e);
  }
}
