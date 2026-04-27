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
import { fetchInboundSms, getChatPort, getInboundMode, isEjoinConfigured } from "./sms-ejoin";
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
    const list = await fetchInboundSms({ sinceMs, portFilter: port });
    for (const m of list) {
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
  logger.info({ mode: getInboundMode(), intervalMs: interval }, "[sms-scheduler] started");
}
