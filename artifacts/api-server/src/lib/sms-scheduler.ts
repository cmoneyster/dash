// Boot-time jobs for the customer-chat SMS feature. Nothing here
// repeats on a timer, so an idle server can sleep.
//
//   1. One-shot historical backfill on first deploy. We pull the last
//      smsBackfillDays of inbound messages on the chat port and ingest
//      them through the same pipeline live messages use, so the chat
//      threads inside catering inquiries aren't blank for migrations
//      that happen after customers have already been texting in. The
//      run is gated on event_settings.smsBackfillCompletedAt — if it
//      already has a value we skip; the admin can manually re-trigger
//      via POST /admin/messages/backfill at any time.
//   2. One catch-up poll shortly after every startup. Live texts arrive
//      via the gateway's push webhook; if a push lands while the server
//      is asleep, it wakes the server but may time out during startup.
//      This catch-up picks that text up within seconds, while it's still
//      inside the owner-forward recency window. Beyond that, missed texts
//      are recovered with the admin "Run now" button.

import { db } from "@workspace/db";
import { eventSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import {
  fetchInbound,
  fetchInboundSmsForPortResult,
  getChatPort,
  getInboundMode,
  getSmsOutboundMode,
  isEjoinConfigured,
} from "./sms-ejoin";
import { ingestInbound } from "./sms-inbox";
import { runSmsBackfill } from "../routes/admin-sms-messages";

// Guards against the startup catch-up and the manual "Run now" button
// firing on top of each other.
let pollInFlight = false;

// Per-port state tracked between poll cycles so we can escalate to the
// per-port detail page only when something actually changed. The cheap
// listing page exposes a `count` column (total messages on that SIM)
// and a "latest message" row; either growing means the gateway received
// new messages we haven't ingested yet. Without this state, we'd have
// to drill into the per-port detail page on every cycle, which is
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

// Result surfaced by both the startup and manual entry points so
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

      let toIngest = peek.rows;
      let detailFetchUsable = !shouldEscalate;
      if (shouldEscalate) {
        // Drill into the per-port detail page to recover the
        // older-than-latest messages the listing was hiding. Same-id
        // rows from the listing dedupe naturally — the detail row wins
        // because the per-port page is the authoritative full history.
        try {
          const detailResult = await fetchInboundSmsForPortResult(port, { sinceMs });
          const detail = detailResult.rows;
          detailFetchUsable = detailResult.parseStatus === "parsed";
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
          if (!detailFetchUsable) {
            errors++;
            logger.warn(
              { port, parseStatus: detailResult.parseStatus, newCount },
              "[sms-scheduler] detail fetch unusable; retaining prior baseline so next poll retries",
            );
          }
        } catch (err) {
          logger.warn({ err, port }, "[sms-scheduler] per-port detail fetch failed");
          errors++;
        }
      }
      // Commit the listing baseline only after the detail page proved
      // usable. If it failed or parsed an unrecognized/wrong-port page,
      // retaining the old baseline makes the next cycle retry instead of
      // permanently hiding messages behind the listing's latest row.
      if (detailFetchUsable) {
        lastSeenCountByPort.set(port, newCount);
        lastSeenLatestIdByPort.set(port, newLatestId);
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
 * Manual one-shot trigger for the admin "Run now" button. Overlap with
 * the startup catch-up or another manual run is gated by the in-process
 * pollInFlight flag.
 */
export async function runSmsPollOnce(): Promise<SmsPollResult> {
  return pollOnce();
}

let schedulerStarted = false;

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

  if (schedulerStarted) return;
  schedulerStarted = true;

  // Catch-up poll shortly after boot (see header note 2).
  setTimeout(() => { void pollOnce(); }, 15_000).unref?.();

  // Surface BOTH modes at startup. The outbound mode is the only
  // operator-visible signal that this process has been silenced — easy
  // to grep ("[sms-scheduler] started") on a confused production box
  // to confirm whether SMS_OUTBOUND_MODE was accidentally set there.
  logger.info(
    { mode: getInboundMode(), outboundMode: getSmsOutboundMode() },
    "[sms-scheduler] started",
  );
}
