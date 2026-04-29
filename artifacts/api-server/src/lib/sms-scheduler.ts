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
//      inbox every POLL_INTERVAL_MS to pick up messages the gateway
//      hasn't been configured to push.
//
// In push mode we still run the periodic poller as a safety net
// (it's cheap, and dedupe protects against double-ingest) but at a
// much longer interval.

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

// Live poller cadence. 3s keeps perceived latency close to real-time
// (the spec calls for inbound bubbles appearing in-thread within a
// couple seconds). The gateway scrape is cheap (a single small HTML
// page) and dedupe in ingestInbound() makes overlapping windows safe.
// Push mode bypasses this entirely — see POLL_INTERVAL_MS_SAFETY_NET.
const POLL_INTERVAL_MS_LIVE = 3_000;
// In push mode the webhook does the heavy lifting; the safety-net
// poller runs at a lazy 10-minute cadence.
const POLL_INTERVAL_MS_SAFETY_NET = 10 * 60_000;

let pollHandle: NodeJS.Timeout | null = null;

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

async function pollOnce(): Promise<void> {
  try {
    if (!isEjoinConfigured()) return;
    const port = await getChatPort();
    if (port == null) return;
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
      }
    }

    for (const m of toIngest) {
      try {
        await ingestInbound({
          gatewayMessageId: m.gatewayMessageId,
          fromPhone: m.fromPhone,
          body: m.body,
          occurredAt: m.occurredAt,
          port: m.port,
        });
      } catch (err) {
        logger.warn({ err, gid: m.gatewayMessageId }, "[sms-scheduler] ingest error");
      }
    }
  } catch (err) {
    logger.warn({ err }, "[sms-scheduler] poll cycle failed");
  }
}

// Test-only export so unit tests can drive a single poll cycle without
// having to start the interval / wait on real time.
export const _pollOnceForTests = pollOnce;

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

  // Periodic poller — runs in both push and poll modes (push as a
  // safety net, poll as the primary inbound path).
  const interval = getInboundMode() === "push" ? POLL_INTERVAL_MS_SAFETY_NET : POLL_INTERVAL_MS_LIVE;
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = setInterval(() => {
    void pollOnce();
  }, interval);
  // Kick a poll shortly after boot so we don't wait a full minute on
  // first request after a deploy.
  setTimeout(() => {
    void pollOnce();
  }, 15_000);
  // Surface BOTH modes at startup. The outbound mode is the only
  // operator-visible signal that this process has been silenced — easy
  // to grep ("[sms-scheduler] started") on a confused production box
  // to confirm whether SMS_OUTBOUND_MODE was accidentally set there.
  logger.info(
    { mode: getInboundMode(), intervalMs: interval, outboundMode: getSmsOutboundMode() },
    "[sms-scheduler] started",
  );
}
