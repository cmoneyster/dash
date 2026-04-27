// Admin "Customer SMS chat" backend.
//
// Provides:
//   - GET  /admin/messages/by-inquiry/:id  → chat thread
//   - POST /admin/messages/by-inquiry/:id/mark-seen
//   - POST /admin/messages/send            → admin reply to a customer
//   - GET  /admin/messages/unmatched       → unmatched-inbox listing
//   - POST /admin/messages/unmatched/:id/link
//   - DELETE /admin/messages/unmatched/:id
//   - POST /admin/messages/unmatched/bulk-delete
//   - POST /admin/messages/unmatched/:id/block-sender
//   - GET  /admin/messages/badges          → unread counts (per-inquiry + unmatched)
//   - GET  /admin/messages/stream          → Server-Sent Events feed
//   - POST /admin/messages/backfill        → run historical backfill on demand
//   - GET  /admin/messages/backfill/status → last-completed timestamp & in-flight flag
//
// All routes are mounted behind requireAdminAuth in routes/index.ts.
// SSE uses a query-string token because EventSource can't set headers;
// the same admin auth middleware accepts ?token=... and we mount it
// with that handler explicitly applied.

import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  smsMessagesTable,
  phoneBlocklistTable,
  cateringInquiriesTable,
  eventSettingsTable,
} from "@workspace/db/schema";
import { and, desc, eq, isNull, isNotNull, inArray, notInArray, ne, sql } from "drizzle-orm";
import { requireAdminAuth } from "../lib/adminAuth";
import {
  ingestInbound,
  sendToCustomerGuarded,
  block,
  unblock,
  isBlocked,
  normalizePhoneDigits,
  findInquiryForPhone,
} from "../lib/sms-inbox";
import { fetchInboundSms, getChatPort } from "../lib/sms-ejoin";
import { subscribeSmsEvents, publishSmsEvent } from "../lib/sms-events";

const router: IRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseId(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Single dehydration shape for both chat-thread and unmatched listing
// so the UI doesn't have to special-case row variants.
type ApiMessage = {
  id: number;
  direction: "inbound" | "outbound";
  customerPhone: string;
  body: string;
  occurredAt: string;
  port: number | null;
  inquiryId: number | null;
  seenByAdmin: boolean;
  source: string;
};

function shape(row: typeof smsMessagesTable.$inferSelect): ApiMessage {
  return {
    id: row.id,
    direction: row.direction as "inbound" | "outbound",
    customerPhone: row.customerPhone,
    body: row.body,
    occurredAt: row.occurredAt.toISOString(),
    port: row.port ?? null,
    inquiryId: row.inquiryId ?? null,
    seenByAdmin: row.seenByAdmin,
    source: row.source,
  };
}

// ── Chat thread for a single inquiry ──────────────────────────────────────────

router.get("/admin/messages/by-inquiry/:id", async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid inquiry id" });
      return;
    }
    const [inq] = await db
      .select({ id: cateringInquiriesTable.id, clientPhone: cateringInquiriesTable.clientPhone })
      .from(cateringInquiriesTable)
      .where(eq(cateringInquiriesTable.id, id));
    if (!inq) {
      res.status(404).json({ error: "Inquiry not found" });
      return;
    }
    const rows = await db
      .select()
      .from(smsMessagesTable)
      .where(eq(smsMessagesTable.inquiryId, id))
      .orderBy(smsMessagesTable.occurredAt);
    const phoneDigits = normalizePhoneDigits(inq.clientPhone ?? "");
    const blockedReason = phoneDigits ? await isBlocked(phoneDigits) : null;
    res.json({
      messages: rows.map(shape),
      customerPhone: inq.clientPhone ?? null,
      blocked: blockedReason,
      // Lets the UI explain why the composer is disabled.
    });
  } catch (err: unknown) {
    req.log.error({ err }, "Error loading messages for inquiry");
    res.status(500).json({ error: "Failed to load messages" });
  }
});

router.post("/admin/messages/by-inquiry/:id/mark-seen", async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid inquiry id" });
      return;
    }
    await db
      .update(smsMessagesTable)
      .set({ seenByAdmin: true })
      .where(and(eq(smsMessagesTable.inquiryId, id), eq(smsMessagesTable.seenByAdmin, false)));
    publishSmsEvent({ type: "messages-seen", inquiryId: id });
    res.json({ ok: true });
  } catch (err: unknown) {
    req.log.error({ err }, "Error marking messages seen");
    res.status(500).json({ error: "Failed to mark seen" });
  }
});

// Admin composer send. Resolves the customer phone from the inquiry
// (so the admin can't accidentally type a wrong number into the URL)
// and routes through the guarded sender — blocklist enforced, persisted,
// SSE published.
router.post("/admin/messages/send", async (req, res) => {
  try {
    const body = req.body as { inquiryId?: unknown; message?: unknown };
    const inquiryId = parseId(body.inquiryId);
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!inquiryId) {
      res.status(400).json({ error: "inquiryId is required" });
      return;
    }
    if (!message) {
      res.status(400).json({ error: "message cannot be empty" });
      return;
    }
    if (message.length > 1500) {
      res.status(400).json({ error: "message is too long (max 1500 characters)" });
      return;
    }
    const [inq] = await db
      .select({ id: cateringInquiriesTable.id, clientPhone: cateringInquiriesTable.clientPhone })
      .from(cateringInquiriesTable)
      .where(eq(cateringInquiriesTable.id, inquiryId));
    if (!inq) {
      res.status(404).json({ error: "Inquiry not found" });
      return;
    }
    if (!inq.clientPhone?.trim()) {
      res.status(400).json({ error: "No client phone on file for this inquiry" });
      return;
    }
    if ((await getChatPort()) == null) {
      res.status(503).json({ error: "No customer chat port configured. Pick one in Communications → SMS." });
      return;
    }
    const result = await sendToCustomerGuarded({
      to: inq.clientPhone,
      body: message,
      inquiryId,
      source: "admin",
    });
    if (result.status === "blocked") {
      const reasonLabel = result.reason === "customer-opt-out"
        ? "Customer has opted out of SMS (texted STOP). Cannot send."
        : "Number is on the admin blocklist. Cannot send.";
      res.status(403).json({ error: reasonLabel, reason: result.reason });
      return;
    }
    res.json({ ok: true, messageId: result.messageId, port: result.port });
  } catch (err: unknown) {
    req.log.error({ err }, "Error sending admin reply SMS");
    const detail = err instanceof Error ? err.message : "Failed to send";
    res.status(502).json({ error: detail });
  }
});

// ── Unmatched inbox ───────────────────────────────────────────────────────────

router.get("/admin/messages/unmatched", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
    // Inbound + inquiry_id IS NULL + sender NOT on the admin-blocked list.
    // We fetch both lists separately (small data) and filter in JS so the
    // SQL stays portable and the EXCEPT/anti-join doesn't need a key
    // comparison on a normalized column.
    const rows = await db
      .select()
      .from(smsMessagesTable)
      .where(and(
        eq(smsMessagesTable.direction, "inbound"),
        isNull(smsMessagesTable.inquiryId),
        // Owner-relay sentinel rows occupy the gateway-id slot for
        // dedupe but are not real customer inbounds — keep them out
        // of the Unmatched inbox.
        ne(smsMessagesTable.source, "owner_relay_marker"),
      ))
      .orderBy(desc(smsMessagesTable.occurredAt))
      .limit(limit);
    const blocked = new Set(
      (await db.select({ phone: phoneBlocklistTable.phone, reason: phoneBlocklistTable.reason }).from(phoneBlocklistTable))
        .filter(b => b.reason === "admin-blocked")
        .map(b => b.phone),
    );
    const visible = rows.filter(r => !blocked.has(r.customerPhone));
    res.json({ messages: visible.map(shape) });
  } catch (err: unknown) {
    req.log.error({ err }, "Error loading unmatched inbox");
    res.status(500).json({ error: "Failed to load unmatched inbox" });
  }
});

// Link a single unmatched message into an inquiry. Also catches any
// other unmatched messages from the same phone (so the admin doesn't
// have to click each one individually) — a deliberate ergonomic
// choice driven by how often the same customer texts twice before
// landing in the inquiry list.
router.post("/admin/messages/unmatched/:id/link", async (req, res) => {
  try {
    const messageId = parseId(req.params.id);
    const targetInquiryId = parseId((req.body as { inquiryId?: unknown })?.inquiryId);
    if (!messageId || !targetInquiryId) {
      res.status(400).json({ error: "messageId and inquiryId are required" });
      return;
    }
    const [msg] = await db.select().from(smsMessagesTable).where(eq(smsMessagesTable.id, messageId));
    if (!msg) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    const [inq] = await db.select({ id: cateringInquiriesTable.id }).from(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, targetInquiryId));
    if (!inq) {
      res.status(404).json({ error: "Target inquiry not found" });
      return;
    }
    await db
      .update(smsMessagesTable)
      .set({ inquiryId: targetInquiryId })
      .where(and(eq(smsMessagesTable.customerPhone, msg.customerPhone), isNull(smsMessagesTable.inquiryId)));
    publishSmsEvent({ type: "unmatched-changed" });
    res.json({ ok: true, linkedInquiryId: targetInquiryId });
  } catch (err: unknown) {
    req.log.error({ err }, "Error linking unmatched message");
    res.status(500).json({ error: "Failed to link message" });
  }
});

router.delete("/admin/messages/unmatched/:id", async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    // Only inbound + unmatched rows are deletable. Outbound and matched
    // chat history stays put.
    const result = await db
      .delete(smsMessagesTable)
      .where(and(eq(smsMessagesTable.id, id), eq(smsMessagesTable.direction, "inbound"), isNull(smsMessagesTable.inquiryId)))
      .returning({ id: smsMessagesTable.id });
    if (result.length === 0) {
      res.status(404).json({ error: "Message not found or not deletable" });
      return;
    }
    publishSmsEvent({ type: "unmatched-changed" });
    res.json({ ok: true });
  } catch (err: unknown) {
    req.log.error({ err }, "Error deleting unmatched message");
    res.status(500).json({ error: "Failed to delete" });
  }
});

// Marks every unmatched inbound row seen. Called by the Unmatched
// inbox page on mount so the sidebar badge clears the moment the
// admin actually looks at the backlog. Phones still on the
// admin-blocked list are excluded — they were already invisible in
// the inbox and their counts shouldn't have flowed into the badge.
router.post("/admin/messages/unmatched/mark-seen", async (req, res) => {
  try {
    const blocked = (
      await db
        .select({ phone: phoneBlocklistTable.phone, reason: phoneBlocklistTable.reason })
        .from(phoneBlocklistTable)
    )
      .filter(b => b.reason === "admin-blocked")
      .map(b => b.phone);
    const baseConds = [
      eq(smsMessagesTable.direction, "inbound"),
      isNull(smsMessagesTable.inquiryId),
      eq(smsMessagesTable.seenByAdmin, false),
      ne(smsMessagesTable.source, "owner_relay_marker"),
    ];
    const cond = blocked.length > 0
      ? and(...baseConds, notInArray(smsMessagesTable.customerPhone, blocked))
      : and(...baseConds);
    const updated = await db
      .update(smsMessagesTable)
      .set({ seenByAdmin: true })
      .where(cond)
      .returning({ id: smsMessagesTable.id });
    if (updated.length > 0) {
      // The sidebar/list badge listener refetches on unmatched-changed,
      // so reusing that event clears the badge state on every open
      // admin client without needing a new event type.
      publishSmsEvent({ type: "unmatched-changed" });
    }
    res.json({ ok: true, updatedCount: updated.length });
  } catch (err: unknown) {
    req.log.error({ err }, "Error marking unmatched seen");
    res.status(500).json({ error: "Failed to mark unmatched seen" });
  }
});

router.post("/admin/messages/unmatched/bulk-delete", async (req, res) => {
  try {
    const body = req.body as { ids?: unknown };
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      res.status(400).json({ error: "ids must be a non-empty array" });
      return;
    }
    const ids = body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (ids.length === 0) {
      res.status(400).json({ error: "no valid ids supplied" });
      return;
    }
    const deleted = await db
      .delete(smsMessagesTable)
      .where(and(inArray(smsMessagesTable.id, ids), eq(smsMessagesTable.direction, "inbound"), isNull(smsMessagesTable.inquiryId)))
      .returning({ id: smsMessagesTable.id });
    publishSmsEvent({ type: "unmatched-changed" });
    res.json({ ok: true, deletedCount: deleted.length });
  } catch (err: unknown) {
    req.log.error({ err }, "Error bulk-deleting unmatched");
    res.status(500).json({ error: "Failed to bulk delete" });
  }
});

// "Block sender" from the Unmatched inbox: blocklists the phone with
// reason 'admin-blocked' AND deletes every unmatched inbound from that
// number so the inbox is cleaned in one click. Matched chat history is
// untouched (admins still want to see the prior conversation).
router.post("/admin/messages/unmatched/:id/block-sender", async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [msg] = await db.select().from(smsMessagesTable).where(eq(smsMessagesTable.id, id));
    if (!msg) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    await block(msg.customerPhone, "admin-blocked");
    const deleted = await db
      .delete(smsMessagesTable)
      .where(and(eq(smsMessagesTable.customerPhone, msg.customerPhone), eq(smsMessagesTable.direction, "inbound"), isNull(smsMessagesTable.inquiryId)))
      .returning({ id: smsMessagesTable.id });
    publishSmsEvent({ type: "unmatched-changed" });
    res.json({ ok: true, blocked: msg.customerPhone, removedCount: deleted.length });
  } catch (err: unknown) {
    req.log.error({ err }, "Error blocking sender");
    res.status(500).json({ error: "Failed to block sender" });
  }
});

router.post("/admin/messages/unblock", async (req, res) => {
  try {
    const phone = typeof (req.body as { phone?: unknown })?.phone === "string" ? (req.body as { phone: string }).phone : "";
    if (!phone.trim()) {
      res.status(400).json({ error: "phone is required" });
      return;
    }
    await unblock(phone);
    res.json({ ok: true });
  } catch (err: unknown) {
    req.log.error({ err }, "Error unblocking sender");
    res.status(500).json({ error: "Failed to unblock" });
  }
});

// ── Badges (sidebar nav + per-inquiry badge) ─────────────────────────────────

router.get("/admin/messages/badges", async (req, res) => {
  try {
    // Per-inquiry unread counts.
    const perInquiry = await db
      .select({
        inquiryId: smsMessagesTable.inquiryId,
        unread: sql<number>`COUNT(*)::int`,
      })
      .from(smsMessagesTable)
      .where(and(
        eq(smsMessagesTable.direction, "inbound"),
        eq(smsMessagesTable.seenByAdmin, false),
        isNotNull(smsMessagesTable.inquiryId),
      ))
      .groupBy(smsMessagesTable.inquiryId);

    // Unmatched inbox count (admin-blocked numbers excluded).
    const blocked = new Set(
      (await db.select({ phone: phoneBlocklistTable.phone, reason: phoneBlocklistTable.reason }).from(phoneBlocklistTable))
        .filter(b => b.reason === "admin-blocked")
        .map(b => b.phone),
    );
    // Per spec: unmatched badge counts UNREAD inbound rows only (not
    // total backlog). seenByAdmin is flipped when the admin opens the
    // Unmatched inbox via /admin/messages/unmatched/mark-seen.
    const unmatchedRows = await db
      .select({ phone: smsMessagesTable.customerPhone })
      .from(smsMessagesTable)
      .where(and(
        eq(smsMessagesTable.direction, "inbound"),
        isNull(smsMessagesTable.inquiryId),
        eq(smsMessagesTable.seenByAdmin, false),
        ne(smsMessagesTable.source, "owner_relay_marker"),
      ));
    const unmatchedCount = unmatchedRows.filter(r => !blocked.has(r.phone)).length;

    res.json({
      perInquiry: perInquiry
        .filter(r => r.inquiryId != null)
        .map(r => ({ inquiryId: r.inquiryId as number, unread: Number(r.unread) })),
      unmatchedCount,
    });
  } catch (err: unknown) {
    req.log.error({ err }, "Error loading message badges");
    res.status(500).json({ error: "Failed to load badges" });
  }
});

// ── SSE stream ────────────────────────────────────────────────────────────────

// Mounted with explicit auth (the global mount uses requireAdminAuth, but
// EventSource can't set Authorization headers — clients pass ?token=...
// and the existing requireAdminAuth middleware accepts it).
router.get("/admin/messages/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  // Initial hello so the client knows the connection is live.
  res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);

  const unsubscribe = subscribeSmsEvents(ev => {
    try {
      res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    } catch {
      // Write failure means the client closed; cleanup happens in 'close'.
    }
  });

  // Heartbeat every 25s to defeat aggressive intermediaries that drop
  // idle connections.
  const heartbeat = setInterval(() => {
    try {
      res.write(`event: ping\ndata: ${Date.now()}\n\n`);
    } catch {
      // ignored
    }
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    try { res.end(); } catch { /* ignored */ }
  });
});

// ── Backfill ──────────────────────────────────────────────────────────────────

let backfillInFlight = false;
let lastBackfillStartedAt: Date | null = null;
let lastBackfillResult:
  | { startedAt: string; finishedAt: string; ingested: number; skipped: number; errors: number }
  | null = null;

export async function runBackfill(daysOverride?: number): Promise<typeof lastBackfillResult> {
  if (backfillInFlight) {
    return lastBackfillResult;
  }
  backfillInFlight = true;
  const startedAt = new Date();
  lastBackfillStartedAt = startedAt;
  let ingested = 0;
  let skipped = 0;
  let errors = 0;
  try {
    const [settings] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
    const days = daysOverride ?? settings?.smsBackfillDays ?? 90;
    const port = await getChatPort();
    if (port == null) {
      throw new Error("No customer chat port configured — backfill needs a port to filter on.");
    }
    const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const list = await fetchInboundSms({ sinceMs, portFilter: port });
    for (const m of list) {
      try {
        const r = await ingestInbound({
          gatewayMessageId: m.gatewayMessageId,
          fromPhone: m.fromPhone,
          body: m.body,
          occurredAt: m.occurredAt,
          port: m.port,
        });
        if (r.status === "stored" || r.status === "owner-reply-relayed" || r.status === "opted-out") ingested++;
        else skipped++;
      } catch (err) {
        errors++;
        console.warn("[backfill] ingest error", err);
      }
    }
    const finishedAt = new Date();
    lastBackfillResult = {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      ingested,
      skipped,
      errors,
    };
    // Stamp the column so we don't auto-rerun on next boot.
    await db
      .update(eventSettingsTable)
      .set({ smsBackfillCompletedAt: finishedAt })
      .where(eq(eventSettingsTable.id, 1));
    return lastBackfillResult;
  } finally {
    backfillInFlight = false;
  }
}

router.post("/admin/messages/backfill", async (req, res) => {
  try {
    const body = req.body as { days?: unknown } | undefined;
    let daysOverride: number | undefined;
    if (body?.days !== undefined) {
      const n = Number(body.days);
      if (!Number.isInteger(n) || n < 1 || n > 365) {
        res.status(400).json({ error: "days must be an integer between 1 and 365" });
        return;
      }
      daysOverride = n;
    }
    if (backfillInFlight) {
      res.status(409).json({ error: "Backfill already in flight", startedAt: lastBackfillStartedAt?.toISOString() ?? null });
      return;
    }
    const result = await runBackfill(daysOverride);
    res.json({ ok: true, result });
  } catch (err: unknown) {
    req.log.error({ err }, "Error running backfill");
    const detail = err instanceof Error ? err.message : "Backfill failed";
    res.status(500).json({ error: detail });
  }
});

router.get("/admin/messages/backfill/status", async (req, res) => {
  try {
    const [settings] = await db.select({ at: eventSettingsTable.smsBackfillCompletedAt, days: eventSettingsTable.smsBackfillDays }).from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
    res.json({
      inFlight: backfillInFlight,
      startedAt: lastBackfillStartedAt?.toISOString() ?? null,
      lastResult: lastBackfillResult,
      backfillDays: settings?.days ?? 90,
      completedAt: settings?.at ? settings.at.toISOString() : null,
    });
  } catch (err: unknown) {
    req.log.error({ err }, "Error reading backfill status");
    res.status(500).json({ error: "Failed to read backfill status" });
  }
});

export default router;

// Re-export the runBackfill helper for the boot-time scheduler.
export { runBackfill as runSmsBackfill };
