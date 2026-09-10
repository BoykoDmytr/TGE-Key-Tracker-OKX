// src/poller/index.ts
// Self-hosted block poller. Replaces the fragile Tenderly Web3 Action:
//  - scans every block from a PERSISTED cursor (never skips a block, even after restart)
//  - matches setTime (0xa0355eca) by SELECTOR on ANY contract — no address needed
//  - matches createDistributor (0xe89c7e5a) to the FACTORIES set (old + new + future)
//  - multi-RPC fallback pool (no silent llama-style death)
// Both detections call the shared handlers (single source of truth with the webhooks).
import { getPollerClient, rpcCountFor } from './clients.js';
import { getCursor, setCursor } from './cursor.js';
import { loadFactories, factoriesFor } from '../store/factories.js';
import { processSetTimeTx, processDepositTx } from '../handlers.js';
import { SETTIME_SELECTOR } from '../evm/decodeSetTime.js';
import { notifyOwner } from '../telegram.js';
import { claimOnce, isDuplicate, releaseClaim } from '../dedupe.js';
const CREATE_DISTRIBUTOR_SELECTOR = '0xe89c7e5a';
// Confirmation depth per chain (don't alert at the tip — reorg safety).
const DEFAULT_CONF = {
    ethereum: 3,
    bsc: 12,
    base: 8,
    arbitrum: 15,
    avalanche: 2,
    optimism: 8,
    xlayer: 12,
};
const ALL_CHAINS = ['bsc', 'base', 'arbitrum', 'ethereum', 'avalanche', 'optimism', 'xlayer'];
/**
 * A misspelled or malformed numeric env var used to become NaN and take the feature with
 * it, silently: NaN as the tick interval makes setTimeout fire immediately (a busy loop),
 * and NaN as an alert threshold makes every comparison false (a watchdog that never
 * fires). Both are exactly the shape of failure this file now exists to prevent.
 */
function numEnv(name, def) {
    const raw = process.env[name];
    if (raw == null || raw === '')
        return def;
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) {
        console.error('[poller] %s=%j is not a positive number — falling back to %d', name, raw, def);
        return def;
    }
    return v;
}
const INTERVAL = numEnv('POLLER_INTERVAL_MS', 4000);
const MAX_BATCH = numEnv('POLLER_MAX_BATCH', 300);
const CONCURRENCY = numEnv('POLLER_BLOCK_CONCURRENCY', 6);
const SHADOW = process.env.POLLER_SHADOW === '1';
// Per-chain shadow: chains listed here stay silent (detect+log, never post) even when
// the global poller is live. Lets a NEW chain soak in shadow while the rest run live.
const SHADOW_CHAINS = new Set((process.env.POLLER_SHADOW_CHAINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
export function isShadow(chain) {
    return SHADOW || SHADOW_CHAINS.has(chain);
}
const DEPOSITS_ENABLED = process.env.POLLER_DEPOSITS !== '0'; // default on
// Persist the cursor to Redis at most this often (keeps Upstash command count low).
// In-memory cursor still advances every block; we also force-persist right after any
// match so a restart never re-posts an already-handled event.
const CURSOR_PERSIST_MS = numEnv('POLLER_CURSOR_PERSIST_MS', 60_000);
// How stale the newest scanned block may get before the owner is told, in seconds of
// CHAIN time. Deliberately not a block count: the same number of blocks means four
// minutes on Arbitrum and four hours on Ethereum.
const LAG_ALERT_SEC = numEnv('POLLER_LAG_ALERT_SEC', 900);
// One DM per chain per cooldown. A degradation lasts hours; without this the alert
// itself becomes the flood.
const LAG_COOLDOWN_SEC = numEnv('POLLER_LAG_COOLDOWN_SEC', 6 * 3600);
// Hysteresis: recover well below the alert threshold so a chain hovering at the line
// cannot alternate between "behind" and "caught up".
// Clamped below half the alert threshold: with a small POLLER_LAG_ALERT_SEC the 60s floor
// would otherwise meet or exceed it and the dead band would vanish.
const LAG_RECOVER_SEC = Math.max(1, Math.min(Math.max(60, Math.floor(LAG_ALERT_SEC / 3)), Math.floor(LAG_ALERT_SEC / 2)));
// If the DM itself could not be delivered, try again soon instead of burning the mute.
const LAG_RETRY_SEC = 60;
// A DM path that is broken rather than blipping must not retry every minute forever.
const LAG_RETRY_MAX_SEC = 3600;
// After a recovery the episode mute is handed back, so only this floor stands between a
// flapping endpoint and one alert+recovery pair per flap.
const LAG_REALERT_MIN_SEC = Math.min(LAG_COOLDOWN_SEC, 3600);
/** First time this process saw a chain. Module scope on purpose: a crash-looping chain
 *  restarts runChainLoop every few seconds, and a per-invocation start time would reset
 *  the clock each time and never accumulate enough lag to alert. */
const FIRST_SEEN = new Map();
const escHtml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const STATUS = new Map();
/**
 * Per-chain poller health for /admin/lag. In-memory, costs no RPC call.
 *
 * Seeded from the CONFIGURED chain list first. A chain whose loop died before its first
 * tick never writes a STATUS entry, and an absent key reads as "fine" to anyone glancing
 * at the output — the same silent-hole failure this whole change is about.
 */
export function pollerStatus() {
    const now = Math.floor(Date.now() / 1000);
    const out = {};
    for (const chain of pollerChains()) {
        out[chain] = {
            cursor: -1, head: 0, lastBlockTs: 0, refTs: 0, lagSec: -1, state: 'never-started',
            lastError: '', updatedAt: 0, staleSec: -1,
        };
    }
    for (const [chain, st] of STATUS) {
        out[chain] = { ...st, staleSec: now - st.updatedAt };
    }
    return out;
}
function confFor(chain) {
    const v = Number(process.env[`POLLER_CONF_${chain.toUpperCase()}`]);
    return Number.isFinite(v) && v > 0 ? v : (DEFAULT_CONF[chain] ?? 6);
}
function pollerChains() {
    const raw = (process.env.POLLER_CHAINS || process.env.CHAINS || '').toLowerCase();
    const picked = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((c) => ALL_CHAINS.includes(c));
    return picked;
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
export function startPoller() {
    if (process.env.POLLER_ENABLED !== '1') {
        console.log('[poller] disabled (set POLLER_ENABLED=1 to enable)');
        return;
    }
    const chains = pollerChains();
    if (!chains.length) {
        console.log('[poller] no chains configured (POLLER_CHAINS / CHAINS) — not starting');
        return;
    }
    console.log('[poller] starting chains=%s shadow=%s deposits=%s interval=%dms maxBatch=%d', chains.join(','), SHADOW, DEPOSITS_ENABLED, INTERVAL, MAX_BATCH);
    for (const chain of chains) {
        void superviseChainLoop(chain);
    }
}
/**
 * Keep a chain loop alive.
 *
 * runChainLoop can throw BEFORE its own per-tick try/catch is ever reached: building the
 * client from a misconfigured POLLER_RPCS_<CHAIN>, loading factories, reading the cursor,
 * or the seeding getBlockNumber when the entire RPC pool is down. That used to print one
 * line and leave the chain dead until a human noticed — /health still answers 200, so
 * nothing else would ever notice either.
 *
 * Restarting the whole loop (not just the failing call) also re-reads the cursor, so a
 * Redis outage that has since cleared resumes from the persisted position instead of
 * re-seeding at the head.
 */
async function superviseChainLoop(chain) {
    let attempt = 0;
    // Same local gate the lag path uses: without it every restart of a crash loop issues a
    // Redis SET NX, which is the one thing this file is careful about.
    let crashNextClaimAt = 0;
    for (;;) {
        try {
            await runChainLoop(chain); // only returns by throwing
        }
        catch (e) {
            attempt++;
            const msg = String(e?.message || e).slice(0, 200);
            const backoff = Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5));
            console.error('[poller:%s] loop crashed (attempt %d): %s — restarting in %dms', chain, attempt, msg, backoff);
            const nowSec = Math.floor(Date.now() / 1000);
            const prev = STATUS.get(chain);
            STATUS.set(chain, {
                cursor: prev?.cursor ?? -1, head: prev?.head ?? 0, lastBlockTs: prev?.lastBlockTs ?? 0,
                refTs: prev?.refTs ?? nowSec, lagSec: prev?.lagSec ?? -1, state: 'crashed',
                lastError: msg, updatedAt: nowSec,
            });
            // Owner DM only, rate-limited exactly like the lag alert, so a crash loop cannot
            // turn into a message loop.
            if (nowSec >= crashNextClaimAt) {
                crashNextClaimAt = nowSec + LAG_COOLDOWN_SEC;
                if (await claimOnce(`pollercrash:${chain}`, LAG_COOLDOWN_SEC)) {
                    const sent = await notifyOwner('\u{1F4A5} <b>Poller loop crashed</b>' + '\n\n' +
                        'Chain: ' + chain + '\n' + 'Attempt: ' + attempt + '\n' +
                        // The error text is an RPC/Redis message we do not control. Unescaped, a single
                        // "<" makes Telegram reject the whole HTML message and the alert never arrives.
                        'Error: ' + escHtml(msg) + '\n\n' +
                        'Restarting automatically. Muted for ' + Math.round(LAG_COOLDOWN_SEC / 3600) + 'h.');
                    if (!sent) {
                        await releaseClaim(`pollercrash:${chain}`);
                        crashNextClaimAt = nowSec + LAG_RETRY_SEC;
                    }
                }
            }
            await sleep(backoff);
        }
    }
}
async function runChainLoop(chain) {
    const client = getPollerClient(chain);
    await loadFactories(chain);
    const conf = confFor(chain);
    console.log('[poller:%s] conf=%d rpcs=%d', chain, conf, rpcCountFor(chain));
    // Seed cursor near head on first run (no historical backfill).
    let cursor;
    const existing = await getCursor(chain);
    if (existing == null) {
        const head = Number(await client.getBlockNumber());
        cursor = Math.max(0, head - conf);
        await setCursor(chain, cursor);
        console.log('[poller:%s] seeded cursor at %d (head %d)', chain, cursor, head);
    }
    else {
        cursor = existing;
        console.log('[poller:%s] resuming from cursor %d', chain, cursor);
    }
    let lastFactoryRefresh = Date.now();
    let lastProgress = Date.now();
    let lastPersist = Date.now();
    // ---- lag watchdog state ----
    // Timestamp of the newest block we have scanned. This, not "did the cursor move", is
    // what tells us whether we are keeping up: on 2026-09-10 the cursor advanced the entire
    // time, just slower than the chain produced blocks, so a no-progress check stayed silent
    // for a full day while the bot drifted 3.5 hours behind.
    let lastBlockTs = 0;
    // Reference for the case where NOTHING has been scanned yet. A chain whose pool is dead
    // from the first tick looks identical to a brand-new one; without this it would sit on a
    // sentinel forever and never alert.
    if (!FIRST_SEEN.has(chain))
        FIRST_SEEN.set(chain, Math.floor(Date.now() / 1000));
    const startedSec = FIRST_SEEN.get(chain);
    // Last head we managed to read. Kept outside the tick try so the alert can still report
    // something useful while getBlockNumber is failing.
    let lastHead = 0;
    // Survive a restart mid-episode: the mute lives in Redis, so "the owner already knows"
    // has to come from Redis too, or the recovery message is silently lost.
    let lagAlerted = await isDuplicate(`pollerlag:${chain}`);
    // Local gate in front of the Redis probe. Without it the cooldown check itself would run
    // once per 4s tick for the whole degradation — thousands of Upstash commands a day,
    // spent precisely while the poller is already struggling.
    let lagNextClaimAt = 0;
    // '' means the last tick completed. Anything else means it threw, and a status of 'ok'
    // would be a lie.
    let lastTickError = '';
    // Consecutive failed alert DMs, for the retry backoff.
    let lagDmFails = 0;
    // >0 means an all-clear DM is owed; the value is the earliest second to retry it.
    let lagRecoveryDmAt = 0;
    // The crash mute is handed back once the loop proves it can run, so the NEXT crash is
    // not swallowed by a six-hour window opened by the previous one.
    let crashClaimCleared = false;
    /**
     * Evaluate lag and tell the owner if needed. Owner DM only — never the channel.
     * Called on EVERY tick, including ones that threw: a health check that lives inside the
     * same try as the thing it monitors is silent exactly when it matters most.
     */
    const checkLag = async () => {
        const nowSec = Math.floor(Date.now() / 1000);
        // Nothing scanned yet: measure from when this process first saw the chain, so a pool
        // that is dead from boot still alerts. That number may only DRIVE AN ALERT — it must
        // never be read as health, because it starts at zero and climbs.
        const scanned = lastBlockTs > 0;
        const refTs = scanned ? lastBlockTs : startedSec;
        const lagSec = nowSec - refTs;
        STATUS.set(chain, {
            cursor, head: lastHead, lastBlockTs, refTs, lagSec,
            state: lagSec > LAG_ALERT_SEC ? 'lagging' : (scanned ? 'ok' : 'never-started'),
            lastError: lastTickError, updatedAt: nowSec,
        });
        // The loop is demonstrably alive: give back any crash mute so the next crash is heard.
        if (scanned && !crashClaimCleared) {
            crashClaimCleared = true;
            await releaseClaim(`pollercrash:${chain}`);
        }
        // An all-clear we owe from an earlier tick whose DM did not go through.
        if (lagRecoveryDmAt && nowSec >= lagRecoveryDmAt && lagSec < LAG_RECOVER_SEC) {
            lagRecoveryDmAt = (await notifyOwner('\u2705 <b>Poller caught up</b>' + '\n\n' + 'Chain: ' + chain + '\n' + 'Back within ' + lagSec + 's of the head.')) ? 0 : nowSec + LAG_RETRY_SEC;
        }
        if (lagSec > LAG_ALERT_SEC) {
            if (nowSec < lagNextClaimAt)
                return;
            // Assume the mute before asking, so a refusal cannot turn into a per-tick probe.
            lagNextClaimAt = nowSec + LAG_COOLDOWN_SEC;
            if (!(await claimOnce(`pollerlag:${chain}`, LAG_COOLDOWN_SEC))) {
                // Someone already holds the mute for this episode: a previous process, or an
                // earlier attempt here whose release failed. Record that an alert is outstanding,
                // or the recovery branch can never run and the mute is never handed back.
                lagAlerted = true;
                // A refusal says a key exists NOW, not when it expires. After a restart it may have
                // minutes left, so re-probe soon rather than blocking locally for a full cooldown.
                lagNextClaimAt = nowSec + Math.min(LAG_COOLDOWN_SEC, 300);
                return;
            }
            console.error('[poller:%s] LAG ALERT: reference block is %ds old', chain, lagSec);
            const behind = lastHead > cursor ? lastHead - cursor : 0;
            const sent = await notifyOwner('\u{1F422} <b>Poller falling behind</b>' + '\n\n' +
                'Chain: ' + chain + '\n' +
                (lastBlockTs ? 'Newest scanned block is ' + Math.round(lagSec / 60) + ' min old' + '\n'
                    : 'No block scanned since start, ' + Math.round(lagSec / 60) + ' min ago' + '\n') +
                'Cursor ' + cursor + ', head ' + (lastHead || 'unknown') + ' (' + behind + ' blocks behind)' + '\n\n' +
                'Muted for this chain for ' + Math.round(LAG_COOLDOWN_SEC / 3600) + 'h.');
            if (sent) {
                lagAlerted = true;
                lagDmFails = 0;
            }
            else {
                // The mute must cover a message that was actually delivered, so give the claim
                // back. Back off geometrically: a blip retries in a minute, a permanently broken
                // DM path decays to roughly hourly instead of hammering forever.
                await releaseClaim(`pollerlag:${chain}`);
                lagDmFails++;
                lagNextClaimAt = nowSec + Math.min(LAG_RETRY_MAX_SEC, LAG_RETRY_SEC * 2 ** Math.min(lagDmFails - 1, 6));
            }
            return;
        }
        // `scanned` is the whole point: after a supervisor restart lagSec is measured from
        // FIRST_SEEN and can read low while the chain is in fact dead. Recovery has to be
        // proven by a block we actually read.
        if (lagAlerted && scanned && lagSec < LAG_RECOVER_SEC) {
            lagAlerted = false;
            // The mute covers ONE episode, not a fixed six hours of wall clock, so hand it back.
            // The floor below is then the only thing bounding a flapping endpoint.
            await releaseClaim(`pollerlag:${chain}`);
            lagNextClaimAt = nowSec + LAG_REALERT_MIN_SEC;
            console.log('[poller:%s] lag recovered (%ds)', chain, lagSec);
            // Tracked separately so a Telegram failure does not lose the all-clear: the state
            // above is cleared immediately (a re-lag must be able to alert), and the message is
            // retried on later ticks.
            lagRecoveryDmAt = (await notifyOwner('\u2705 <b>Poller caught up</b>' + '\n\n' + 'Chain: ' + chain + '\n' + 'Back within ' + lagSec + 's of the head.')) ? 0 : nowSec + LAG_RETRY_SEC;
        }
    };
    for (;;) {
        try {
            if (Date.now() - lastFactoryRefresh > 300_000) {
                await loadFactories(chain);
                lastFactoryRefresh = Date.now();
            }
            const head = Number(await client.getBlockNumber());
            lastHead = head;
            const safeHead = head - conf;
            if (safeHead > cursor) {
                const to = Math.min(safeHead, cursor + MAX_BATCH);
                for (let from = cursor + 1; from <= to; from += CONCURRENCY) {
                    const batch = [];
                    for (let b = from; b < from + CONCURRENCY && b <= to; b++)
                        batch.push(b);
                    const blocks = await Promise.all(batch.map((n) => fetchBlock(client, chain, n)));
                    // If any block failed (null), stop this batch BEFORE advancing past the gap.
                    let advanceTo = cursor;
                    let matched = false;
                    for (let i = 0; i < blocks.length; i++) {
                        if (!blocks[i])
                            break; // leave cursor before the missing block; retry next tick
                        const r = await scanBlock(chain, blocks[i]);
                        if (r.matched)
                            matched = true;
                        // A trigger we recognised but failed to process must NOT be skipped: stop
                        // before this block so the next tick retries it. Previously the cursor
                        // advanced anyway and the event was lost in-process forever.
                        if (r.failed) {
                            console.error('[poller:%s] block %d had a failed handler — holding cursor at %d', chain, batch[i], advanceTo);
                            break;
                        }
                        advanceTo = batch[i];
                        const ts = Number(blocks[i].timestamp);
                        if (Number.isFinite(ts))
                            lastBlockTs = ts;
                    }
                    if (advanceTo > cursor) {
                        cursor = advanceTo;
                        lastProgress = Date.now();
                        // Persist sparingly to keep Upstash command count low: time-based, OR
                        // immediately after a match so a restart never re-posts a handled event.
                        if (matched || Date.now() - lastPersist >= CURSOR_PERSIST_MS) {
                            await setCursor(chain, cursor);
                            lastPersist = Date.now();
                        }
                    }
                    if (advanceTo !== batch[batch.length - 1])
                        break; // had a gap; retry next tick
                }
            }
            // Watchdog: behind head and not progressing => shout (could self-alert later).
            if (head - conf - cursor > MAX_BATCH * 3 && Date.now() - lastProgress > 120_000) {
                console.error('[poller:%s] WATCHDOG: cursor=%d safeHead=%d no-progress>120s', chain, cursor, head - conf);
            }
            lastTickError = '';
        }
        catch (e) {
            console.error('[poller:%s] tick error: %s', chain, e?.message || e);
            lastTickError = String(e?.message || e).slice(0, 200);
        }
        // Outside the try on purpose. When the RPC pool is entirely down, getBlockNumber
        // throws on the first line of the tick and every later statement is skipped — which is
        // how the previous version of this watchdog managed to be silent in the one scenario
        // it was written for.
        try {
            await checkLag();
        }
        catch (e) {
            console.error('[poller:%s] lag check failed: %s', chain, e?.message || e);
        }
        await sleep(INTERVAL);
    }
}
/**
 * Fetch one block with its transactions, as RAW JSON-RPC.
 *
 * Deliberately not viem's getBlock({ includeTransactions: true }). That runs
 * formatTransaction over EVERY transaction in the block, building a second object per
 * transaction with hex->BigInt conversions for value, gas, gasPrice, nonce and the rest.
 * A Base block carries ~460 transactions and a BSC block ~120, and this poller looks at
 * exactly two fields of each: `to`, and the first ten characters of `input`. Measured at
 * 2.2x the CPU of a plain parse, before counting the garbage it hands the collector.
 *
 * That margin is not academic. This runs on a shared-cpu machine whose SUSTAINED CPU
 * allowance is 6.25% of a core (measured 5.7% while catching up on 2026-09-10, against
 * 93% on the idle sister machine). Every millisecond per block is throughput.
 *
 * The raw shape is field-for-field what scanBlock already reads: `timestamp` (hex string,
 * which Number() parses), `transactions[]`, and `input`/`to`/`hash` as plain strings.
 */
async function fetchBlock(client, chain, n) {
    try {
        const block = await client.request({
            method: 'eth_getBlockByNumber',
            params: [`0x${n.toString(16)}`, true],
        });
        // A provider lagging behind the head answers null instead of erroring. Treat that as a
        // miss so the cursor holds BEFORE the gap, exactly as a thrown error would.
        if (!block || block.number == null || !Array.isArray(block.transactions)) {
            console.error('[poller:%s] getBlock %d returned no block', chain, n);
            return null;
        }
        return block;
    }
    catch (e) {
        console.error('[poller:%s] getBlock %d failed: %s', chain, n, e?.message || e);
        return null;
    }
}
// Returns true if the block contained a setTime or tracked-factory deposit we handled
// (used to force a cursor checkpoint so a restart never re-posts it).
async function scanBlock(chain, block) {
    const facs = factoriesFor(chain);
    // Raw JSON-RPC gives a hex string ('0x68c1...'); Number() parses that directly. Guard
    // anyway: a NaN timestamp would silently disable the freshness window in the spam filter.
    const blockTs = Number(block.timestamp);
    if (!Number.isFinite(blockTs)) {
        console.error('[poller:%s] block %s has an unreadable timestamp %j', chain, block.number, block.timestamp);
    }
    let matched = false;
    let failed = false;
    for (const tx of block.transactions || []) {
        const input = (tx.input || '0x');
        if (input.length < 10)
            continue;
        const sel = input.slice(0, 10).toLowerCase();
        const to = (tx.to || '').toLowerCase();
        if (sel === SETTIME_SELECTOR) {
            try {
                const r = await processSetTimeTx({ chainKey: chain, txHash: tx.hash, to, input }, { notify: !isShadow(chain), source: 'poller' });
                if (r?.sent)
                    matched = true; // we actually posted -> force a checkpoint
            }
            catch (e) {
                failed = true;
                console.error('[poller:%s] setTime handler error %s: %s', chain, tx.hash, e?.message || e);
            }
        }
        else if (DEPOSITS_ENABLED && sel === CREATE_DISTRIBUTOR_SELECTOR && to && facs.has(to)) {
            try {
                const r = await processDepositTx(chain, tx.hash, getPollerClient(chain), {
                    notify: !isShadow(chain),
                    // ALWAYS persist, even in shadow. Shadow means "don't post", not "don't learn".
                    // The tracked allowlist is only read by the setTime gate, which is muted in shadow
                    // anyway, so persisting is invisible to subscribers. Gating it on shadow meant a
                    // soak silently produced a PERMANENT setTime blackout: distributors seen during
                    // the soak never entered the allowlist, and their setTime (which lands days later,
                    // and is the higher-value alert) was dropped forever as 'non-tracked'.
                    persist: true,
                    source: 'poller',
                    blockTimestamp: blockTs,
                });
                // Checkpoint on any durable side effect, not just a post: a tracked distributor
                // or a capped tx is state we must not redo on restart.
                if (r && (r.sent > 0 || r.tracked > 0 || r.capped))
                    matched = true;
            }
            catch (e) {
                failed = true;
                console.error('[poller:%s] deposit handler error %s: %s', chain, tx.hash, e?.message || e);
            }
        }
    }
    return { matched, failed };
}
