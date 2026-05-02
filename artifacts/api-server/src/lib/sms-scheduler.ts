// Boot-time scheduler for the customer-chat SMS feature.
//
// Two periodic jobs:
//   1. One-shot historical backfill on first deploy. We pull the last
//      smsBackfillDays of inbound messages on the chat port and ingest
//      them through the same pipeline live messages use, so the chat
//      threads inside catering inquiries aren't blank for migrations
//      that happen after customers have already been texting in. The
//      run is gated on event_settings.smsBackfillCompletedAt — if it
//      already has a value we skip; the admin can manually re-trigger
//      via POST /admin/messages/backfill at any time.
//   2. Continuous live poller (poll mode only). Hits the gateway's
//      inbox on a self-rescheduling loop; cadence is configured by
//      `event_settings.sms_poll_interval_seconds` and the loop honors
//      the `sms_poll_enabled` toggle on every tick so an admin pause
//      takes effect within at most one current cycle. Push-mode keeps
//      a much lazier safety-net cadence.
//
// In push mode we still run the periodic poller as a safety net
// (it's cheap, and dedupe protects against double-ingest) but at a
// much longer interval and ignoring the operator-tunable seconds
// value (push mode is doing the real work).

import { db } from "@workspace/db";
import { eventSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import {
  fetchInbound,
  fetchInboundSmsForPort,
  getChatPort,
  getInboundMode,
  getSmsOutboundMode,
  isEjoinConfigured,
} from "./sms-ejoin";
import { ingestInbound } from "./sms-inbox";
import { runSmsBackfill } from "../routes/admin-sms-messages";

// In push mode the webhook does the heavy lifting; the safety-net
// poller runs at a lazy 10-minute cadence. Operator-tunable interval
// only applies in poll mode.
const POLL_INTERVAL_MS_SAFETY_NET = 10 * 60_000;
// Operator-tunable seconds clamp. The 3s lower bound mirrors the
// gateway's practical refresh ceiling (faster polls just re-fetch
// the same listing without picking up new rows). The 600s upper
// bound matches the safety-net cadence so a misconfigured value
// doesn't accidentally make poll mode lazier than push mode.
const MIN_POLL_INTERVAL_SECONDS = 3;
const MAX_POLL_INTERVAL_SECONDS = 600;
const DEFAULT_POLL_INTERVAL_SECONDS = 3;

let pollTimer: NodeJS.Timeout | null = null;
let pollSchedulerStarted = false;
// Tracks whether a poll cycle is currently in flight so the manual
// "Run now" button and the scheduled tick can't double-fire on top
// of each other (the scheduled tick already self-defers, but the
// manual endpoint is operator-driven so it gets its own guard too).
let pollInFlight = false;
// Snapshot of the most recent settings the loop saw so the admin
// page can render "currently in effect: enabled, every 30s" without
// having to re-read the DB on every UI refresh.
let lastEffectiveEnabled = true;
let lastEffectiveIntervalSeconds: number = DEFAULT_POLL_INTERVAL_SECONDS;

// Per-port state tracked between poll cycles so we can escalate to the
// per-port detail page only when something actually changed. The cheap
// listing page exposes a `count` column (total messages on that SIM)
// and a "latest message" row; either growing means the gateway received
// new messages we haven't ingested yet. Without this state, we'd have
// to drill into the per-port detail page on every 3s cycle, which is
// wasteful and risks tripping the gateway's login rate limiter.
const lastSeenCountByPort = new Map<number, number>();
const lastSeenLatestIdByPort = new Map<number, string | null>();

// Test-only escape hatch so unit tests can drive pollOnce() through
// a fresh first-cycle / counts-changed transition without the global
// caches retaining stale state from earlier tests.
export function _resetSmsPollerStateForTests(): void {
  lastSeenCountByPort.clear();
  lastSeenLatestIdByPort.clear();
}

// Result surfaced by both the scheduled and manual entry points so
// the admin "Run now" button can render a friendly summary.
export type SmsPollResult = {
  ranAt: string;
  skipped: boolean;
  skipReason?: "already-running" | "ejoin-not-configured" | "no-chat-port";
  port?: number;
  fetchedCount: number;
  ingested: number;
  errors: number;
};

async function pollOnce(): Promise<SmsPollResult> {
  const ranAt = new Date().toISOString();
  if (pollInFlight) {
    return { ranAt, skipped: true, skipReason: "already-running", fetchedCount: 0, ingested: 0, errors: 0 };
  }
  pollInFlight = true;
  try {
    if (!isEjoinConfigured()) {
      return { ranAt, skipped: true, skipReason: "ejoin-not-configured", fetchedCount: 0, ingested: 0, errors: 0 };
    }
    const port = await getChatPort();
    if (port == null) {
      return { ranAt, skipped: true, skipReason: "no-chat-port", fetchedCount: 0, ingested: 0, errors: 0 };
    }
    let fetchedCount = 0;
    let ingested = 0;
    let errors = 0;
    try {
      // Live poll only looks at the last 24h to keep the parse + dedupe
      // path fast. Anything older was either picked up by an earlier
      // poll (and is dedup'd by gateway message id) or by the historical
      // backfill.
      const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
      // Step 1: cheap listing fetch. Returns the latest message per SIM
      // plus a per-port summary (count + latest id) we use for change
      // detection on the next step.
      const peek = await fetchInbound({ sinceMs, portFilter: port });
      const summary = peek.ports.find(p => p.port === port) ?? null;
      const newCount = summary?.count ?? 0;
      const newLatestId = summary?.latestId ?? null;
      const lastCount = lastSeenCountByPort.get(port);
      const lastLatestId = lastSeenLatestIdByPort.get(port) ?? null;
      const firstCycle = lastCount === undefined;
      // Escalate when:
      //   (a) we have no in-memory baseline (cold start / process
      //       restart) AND the gateway reports messages on this SIM —
      //       we can't tell what arrived during downtime from the
      //       listing alone, so always pull the full history once. The
      //       boot-time backfill stamps a completion marker and won't
      //       auto-rerun on subsequent restarts, so without this the
      //       second-and-later restarts could permanently miss any
      //       customer texts that landed while we were down.
      //   (b) the gateway reports MORE messages than last cycle (covers
      //       "count = total messages on SIM" interpretation), OR
      //   (c) the latest-message id changed (covers "count = unread,
      //       gets marked read on display" firmware that would
      //       otherwise hide a new message that just arrived).
      const countIncreased = !firstCycle && lastCount !== undefined && newCount > lastCount;
      const latestChanged =
        !firstCycle && newLatestId != null && newLatestId !== lastLatestId;
      const shouldEscalate = newCount > 0 && (firstCycle || countIncreased || latestChanged);

      // Update the trackers BEFORE ingest so a thrown error mid-ingest
      // doesn't make the next cycle escalate twice for the same change.
      lastSeenCountByPort.set(port, newCount);
      lastSeenLatestIdByPort.set(port, newLatestId);

      let toIngest = peek.rows;
      if (shouldEscalate) {
        // Drill into the per-port detail page to recover the
        // older-than-latest messages the listing was hiding. Same-id
        // rows from the listing dedupe naturally — the detail row wins
        // because the per-port page is the authoritative full history.
        try {
          const detail = await fetchInboundSmsForPort(port, { sinceMs });
          if (detail.length > 0) {
            const detailIds = new Set(detail.map(m => m.gatewayMessageId));
            toIngest = [
              ...detail,
              ...peek.rows.filter(r => !detailIds.has(r.gatewayMessageId)),
            ];
            logger.info(
              {
                port,
                detailCount: detail.length,
                listingCount: peek.rows.length,
                newCount,
                lastCount: lastCount ?? null,
              },
              "[sms-scheduler] escalated to per-port detail walk",
            );
          }
        } catch (err) {
          logger.warn({ err, port }, "[sms-scheduler] per-port detail fetch failed");
          errors++;
        }
      }

      fetchedCount = toIngest.length;
      for (const m of toIngest) {
        try {
          await ingestInbound({
            gatewayMessageId: m.gatewayMessageId,
            fromPhone: m.fromPhone,
            body: m.body,
            occurredAt: m.occurredAt,
            port: m.port,
          });
          ingested++;
        } catch (err) {
          errors++;
          logger.warn({ err, gid: m.gatewayMessageId }, "[sms-scheduler] ingest error");
        }
      }
    } catch (err) {
      logger.warn({ err }, "[sms-scheduler] poll cycle failed");
      errors++;
    }
    return { ranAt, skipped: false, port, fetchedCount, ingested, errors };
  } finally {
    pollInFlight = false;
  }
}

// Test-only export so unit tests can drive a single poll cycle without
// having to start the interval / wait on real time.
export const _pollOnceForTests = pollOnce;

/**
 * Manual one-shot trigger for the admin "Run now" button. Always
 * runs the same single-cycle path the scheduler uses, even if the
 * persisted enabled flag is OFF — that's the entire point of the
 * button. Overlap with a scheduled or another manual run is gated
 * by the in-process pollInFlight flag.
 */
export async function runSmsPollOnce(): Promise<SmsPollResult> {
  return pollOnce();
}

// Read the operator-tunable interval/enabled with safe fallbacks so
// a transient DB hiccup never kills the loop. We default to "enabled
// at 3s" because that matches historical behavior and is what an
// admin would expect on a fresh deploy.
async function readPollerSettings(): Promise<{ enabled: boolean; intervalSeconds: number }> {
  try {
    const [row] = await db
      .select({
        enabled: eventSettingsTable.smsPollEnabled,
        seconds: eventSettingsTable.smsPollIntervalSeconds,
      })
      .from(eventSettingsTable)
      .where(eq(eventSettingsTable.id, 1));
    const enabled = row?.enabled ?? true;
    const raw = row?.seconds ?? DEFAULT_POLL_INTERVAL_SECONDS;
    const clamped = Math.max(MIN_POLL_INTERVAL_SECONDS, Math.min(MAX_POLL_INTERVAL_SECONDS, raw));
    return { enabled, intervalSeconds: clamped };
  } catch (err) {
    logger.warn({ err }, "[sms-scheduler] settings read failed; using defaults");
    return { enabled: true, intervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS };
  }
}

// Self-rescheduling tick. Reads settings every cycle so an admin
// change to enabled/interval is honored within at most one current
// cycle without restarting the API server.
async function tick(): Promise<void> {
  let nextDelayMs: number;
  try {
    if (getInboundMode() === "push") {
      // Push mode: cadence is fixed (safety-net), enabled flag is
      // ignored — push mode operators almost never want the safety
      // net silenced.
      lastEffectiveEnabled = true;
      lastEffectiveIntervalSeconds = Math.floor(POLL_INTERVAL_MS_SAFETY_NET / 1000);
      nextDelayMs = POLL_INTERVAL_MS_SAFETY_NET;
      await pollOnce();
    } else {
      const { enabled, intervalSeconds } = await readPollerSettings();
      lastEffectiveEnabled = enabled;
      lastEffectiveIntervalSeconds = intervalSeconds;
      nextDelayMs = intervalSeconds * 1000;
      if (enabled) {
        await pollOnce();
      }
      // Disabled: keep the loop alive (so toggling back ON resumes
      // immediately) but skip the actual gateway fetch — that's the
      // whole point of the operator-disable knob.
    }
  } catch (err) {
    logger.warn({ err }, "[sms-scheduler] tick failed");
    // Defensive default so a thrown error can't burn a tight loop.
    nextDelayMs = (lastEffectiveIntervalSeconds || DEFAULT_POLL_INTERVAL_SECONDS) * 1000;
  } finally {
    pollTimer = setTimeout(() => { void tick(); }, nextDelayMs!);
    pollTimer.unref?.();
  }
}

/**
 * Operator-visible snapshot for the admin Idle Activity card. Reflects
 * the last values the loop saw (or the in-memory defaults if the loop
 * hasn't ticked yet). `inboundMode` is exposed so the UI can hint that
 * push-mode ignores the operator interval.
 */
export function getSmsPollerStatus(): {
  enabled: boolean;
  intervalSeconds: number;
  inboundMode: "push" | "poll";
  minSeconds: number;
  maxSeconds: number;
} {
  return {
    enabled: lastEffectiveEnabled,
    intervalSeconds: lastEffectiveIntervalSeconds,
    inboundMode: getInboundMode(),
    minSeconds: MIN_POLL_INTERVAL_SECONDS,
    maxSeconds: MAX_POLL_INTERVAL_SECONDS,
  };
}

export const SMS_POLL_INTERVAL_RANGE = {
  min: MIN_POLL_INTERVAL_SECONDS,
  max: MAX_POLL_INTERVAL_SECONDS,
  default: DEFAULT_POLL_INTERVAL_SECONDS,
};

export function startSmsScheduler(): void {
  // Stagger boot work so we don't compete with seedIfEmpty / instagram
  // scheduler. 5s is enough to clear app-startup contention.
  setTimeout(async () => {
    try {
      const [settings] = await db
        .select({ at: eventSettingsTable.smsBackfillCompletedAt })
        .from(eventSettingsTable)
        .where(eq(eventSettingsTable.id, 1));
      if (!settings?.at && isEjoinConfigured() && (await getChatPort()) != null) {
        logger.info("[sms-scheduler] running first-deploy backfill");
        try {
          const result = await runSmsBackfill();
          logger.info({ result }, "[sms-scheduler] backfill complete");
        } catch (err) {
          logger.warn({ err }, "[sms-scheduler] backfill failed (will retry on manual trigger)");
        }
      }
    } catch (err) {
      logger.warn({ err }, "[sms-scheduler] backfill bootstrap failed");
    }
  }, 5_000);

  // Idempotent: a re-call wouldn't double-tick because each timer
  // chains the next one, but starting a second chain would.
  if (pollSchedulerStarted) return;
  pollSchedulerStarted = true;

  // Kick a poll shortly after boot so we don't wait a full interval
  // on first request after a deploy.
  setTimeout(() => { void tick(); }, 15_000).unref?.();

  // Surface BOTH modes at startup. The outbound mode is the only
  // operator-visible signal that this process has been silenced — easy
  // to grep ("[sms-scheduler] started") on a confused production box
  // to confirm whether SMS_OUTBOUND_MODE was accidentally set there.
  logger.info(
    { mode: getInboundMode(), outboundMode: getSmsOutboundMode() },
    "[sms-scheduler] started",
  );
}
