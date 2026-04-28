// Customer-chat SMS ingestion + outbound guarding.
//
// This module is the single funnel every inbound message and every
// customer-bound outbound passes through. It owns:
//
//   - dedupe (by gateway message id)
//   - customer phone normalization (digits-only, no country code)
//   - STOP/UNSUBSCRIBE/etc. opt-out detection (auto-blocklists the sender)
//   - blocklist guards on inbound (admin-blocked → drop) and outbound
//     (customer-opt-out OR admin-blocked → refuse)
//   - inquiry matching (phone → most recent active inquiry)
//   - owner forwarding (capped per inquiry per rolling 24h, gated by
//     event_settings.smsOwnerForwardEnabled)
//   - strict-tag owner-reply routing (#<id> body → re-issue body to the
//     inquiry's customer phone, gated by smsOwnerReplyEnabled)
//
// Anything that wants to handle inbound MUST go through ingestInbound().
// Anything that wants to send to a customer SHOULD go through
// sendToCustomerGuarded() — that wrapper logs to sms_messages, enforces
// the blocklist, and publishes the SSE event so the chat UI updates
// without polling.

import { db } from "@workspace/db";
import {
  smsMessagesTable,
  phoneBlocklistTable,
  ownerForwardsTable,
  cateringInquiriesTable,
  eventSettingsTable,
} from "@workspace/db/schema";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { sendSmsToCustomer, sendSmsViaEjoin, getChatPort, BlocklistedRecipientError } from "./sms-ejoin";
import { publishSmsEvent } from "./sms-events";
import { logger } from "./logger";

// ── Phone helpers ─────────────────────────────────────────────────────────────

// Mirror sms-ejoin's normalizer (digits-only, drop leading "1" for NANP)
// so phone columns join directly across tables. Kept private so callers
// stay funneled through this module.
export function normalizePhoneDigits(input: string | null | undefined): string {
  if (!input) return "";
  let digits = String(input).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits;
}

// ── Opt-out detection ─────────────────────────────────────────────────────────

// Industry-standard STOP keywords (case-insensitive, must be the entire
// message after trimming). Matches Twilio's published list; we don't
// auto-resubscribe on START — admin must explicitly remove the entry.
const STOP_KEYWORDS = new Set([
  "stop",
  "stopall",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
  "stop all",
]);

function isStopKeyword(body: string): boolean {
  const t = body.trim().toLowerCase();
  return STOP_KEYWORDS.has(t);
}

// ── Blocklist helpers ─────────────────────────────────────────────────────────

export type BlockReason = "customer-opt-out" | "admin-blocked";

export async function isBlocked(phone: string): Promise<BlockReason | null> {
  const p = normalizePhoneDigits(phone);
  if (!p) return null;
  const [row] = await db
    .select({ reason: phoneBlocklistTable.reason })
    .from(phoneBlocklistTable)
    .where(eq(phoneBlocklistTable.phone, p));
  if (!row) return null;
  return (row.reason as BlockReason) ?? null;
}

export async function block(
  phone: string,
  reason: BlockReason,
  note?: string,
): Promise<void> {
  const p = normalizePhoneDigits(phone);
  if (!p) return;
  // Upsert: if the row already exists with a different reason, prefer
  // the stronger one. admin-blocked > customer-opt-out (admin block
  // means we shouldn't even surface inbounds in the inbox; opt-out
  // only suppresses outbound).
  await db
    .insert(phoneBlocklistTable)
    .values({ phone: p, reason, note: note ?? null })
    .onConflictDoUpdate({
      target: phoneBlocklistTable.phone,
      set: {
        reason: sql`CASE WHEN ${phoneBlocklistTable.reason} = 'admin-blocked' THEN 'admin-blocked' ELSE excluded.reason END`,
        note: note ?? sql`${phoneBlocklistTable.note}`,
      },
    });
  publishSmsEvent({ type: "blocklist-changed", phone: p, blocked: true, reason });
}

export async function unblock(phone: string): Promise<void> {
  const p = normalizePhoneDigits(phone);
  if (!p) return;
  await db.delete(phoneBlocklistTable).where(eq(phoneBlocklistTable.phone, p));
  publishSmsEvent({ type: "blocklist-changed", phone: p, blocked: false });
}

// ── Inquiry matching ──────────────────────────────────────────────────────────

// Resolve "the inquiry this inbound belongs to" by matching the
// customer phone to the most recently updated catering inquiry whose
// stored client phone normalizes to the same digits. Returns null
// when no match is found — the message lands in the Unmatched inbox.
export async function findInquiryForPhone(phone: string): Promise<number | null> {
  const p = normalizePhoneDigits(phone);
  if (!p) return null;
  // We can't do a normalized comparison in SQL without a generated
  // column, so we pull a small candidate set and match in JS. The
  // catering volume is low enough (hundreds, not millions) that the
  // simpler approach beats premature indexing complexity. If this
  // becomes hot we can add a `normalized_client_phone` column later.
  const candidates = await db
    .select({
      id: cateringInquiriesTable.id,
      clientPhone: cateringInquiriesTable.clientPhone,
      updatedAt: cateringInquiriesTable.updatedAt,
    })
    .from(cateringInquiriesTable)
    .orderBy(desc(cateringInquiriesTable.updatedAt))
    .limit(500);
  for (const c of candidates) {
    if (normalizePhoneDigits(c.clientPhone ?? "") === p) return c.id;
  }
  return null;
}

// ── Strict-tag owner reply routing ────────────────────────────────────────────

// Owner replies arrive on the chat port as inbound from the OWNER's
// phone. To distinguish "owner reply" from "stranger texting the SIM"
// we require a strict prefix tag of the form `#<inquiryId>` followed
// by whitespace, then the message body. Anything else from the owner
// phone is treated as a normal inbound (likely a misfire) and lands in
// Unmatched, exactly like every other unrecognized inbound.
//
// We gate this entirely behind smsOwnerReplyEnabled so admins who
// don't want owner-from-phone routing aren't surprised.
const OWNER_TAG_RE = /^#\s*(\d{1,9})\b\s*([\s\S]*)$/;

function parseOwnerTag(body: string): { inquiryId: number; reply: string } | null {
  const m = OWNER_TAG_RE.exec(body.trim());
  if (!m) return null;
  const id = Number(m[1]);
  const reply = m[2].trim();
  if (!Number.isInteger(id) || id <= 0 || reply.length === 0) return null;
  return { inquiryId: id, reply };
}

async function getOwnerPhoneDigits(): Promise<string | null> {
  try {
    const [row] = await db
      .select({ ownerNotificationPhone: eventSettingsTable.ownerNotificationPhone })
      .from(eventSettingsTable)
      .where(eq(eventSettingsTable.id, 1));
    const dbPhone = row?.ownerNotificationPhone?.trim();
    const phone = (dbPhone || process.env.OWNER_PHONE || "").trim();
    return phone ? normalizePhoneDigits(phone) : null;
  } catch (err) {
    console.warn("[sms-inbox] resolveOwnerPhone failed", err);
    return null;
  }
}

// ── Owner forwarding ──────────────────────────────────────────────────────────

// Compose a compact forward like:
//   "[Catering #123 · Jane Smith] hey can we add 2 more guests?"
// Reply tip is appended only when owner-reply routing is enabled so
// admins who haven't turned it on don't see misleading instructions.
async function buildForwardBody(
  inquiryId: number | null,
  fromPhone: string,
  body: string,
  ownerReplyEnabled: boolean,
): Promise<string> {
  let label: string;
  if (inquiryId == null) {
    label = `Unmatched · ${fromPhone}`;
  } else {
    const [inq] = await db
      .select({ clientName: cateringInquiriesTable.clientName })
      .from(cateringInquiriesTable)
      .where(eq(cateringInquiriesTable.id, inquiryId));
    label = `Catering #${inquiryId}${inq?.clientName ? ` · ${inq.clientName}` : ""}`;
  }
  const tip = ownerReplyEnabled && inquiryId != null
    ? `\nReply: #${inquiryId} <message>`
    : "";
  // Keep total length under 320 so we don't multi-segment unnecessarily.
  const head = `[${label}]`;
  const remaining = 320 - head.length - tip.length - 1;
  const trimmed = body.length > remaining ? `${body.slice(0, Math.max(20, remaining - 1))}…` : body;
  return `${head} ${trimmed}${tip}`;
}

// Count forwards for an inquiry in the last 24h, used to enforce the
// configured cap. NULL inquiry rows aren't counted — unmatched
// forwards aren't capped (the volume is low and admins want to see
// strange traffic). When cap is null the helper short-circuits.
async function isForwardCapReached(inquiryId: number | null, cap: number | null): Promise<boolean> {
  if (cap == null) return false;
  if (inquiryId == null) return false;
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [{ c }] = await db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(ownerForwardsTable)
    .where(and(eq(ownerForwardsTable.inquiryId, inquiryId), gt(ownerForwardsTable.forwardedAt, cutoff)));
  return Number(c ?? 0) >= cap;
}

// ── Settings cache ────────────────────────────────────────────────────────────

const SETTINGS_TTL_MS = 5_000;
let settingsCache:
  | {
      expiresAt: number;
      data: {
        ownerForwardEnabled: boolean;
        ownerForwardCap: number | null;
        ownerReplyEnabled: boolean;
      };
    }
  | null = null;

async function getRelevantSettings() {
  const now = Date.now();
  if (settingsCache && settingsCache.expiresAt > now) return settingsCache.data;
  const [row] = await db
    .select({
      ownerForwardEnabled: eventSettingsTable.smsOwnerForwardEnabled,
      ownerForwardCap: eventSettingsTable.smsOwnerForwardCapPer24h,
      ownerReplyEnabled: eventSettingsTable.smsOwnerReplyEnabled,
    })
    .from(eventSettingsTable)
    .where(eq(eventSettingsTable.id, 1));
  const data = {
    ownerForwardEnabled: !!row?.ownerForwardEnabled,
    ownerForwardCap: row?.ownerForwardCap ?? null,
    ownerReplyEnabled: !!row?.ownerReplyEnabled,
  };
  settingsCache = { expiresAt: now + SETTINGS_TTL_MS, data };
  return data;
}

export function clearSmsInboxSettingsCache(): void {
  settingsCache = null;
}

// ── Ingest ────────────────────────────────────────────────────────────────────

export type OwnerRejectReason =
  | "owner-reply-disabled"
  | "owner-reply-malformed"
  | "owner-reply-no-inquiry"
  | "owner-reply-no-phone";

export type IngestResult =
  | { status: "stored"; messageId: number; inquiryId: number | null }
  | { status: "dedup"; messageId: number }
  | { status: "owner-reply-relayed"; inquiryId: number }
  | { status: "owner-reply-rejected"; reason: OwnerRejectReason }
  | { status: "blocked"; reason: BlockReason }
  | { status: "opted-out" }
  | { status: "skipped-empty" };

// Corrective SMS bodies sent back to the owner phone when an inbound
// FROM the owner can't be relayed. Kept short so they fit a single
// SMS segment. The text is deliberately actionable so the owner knows
// exactly how to retry.
const OWNER_REJECT_MESSAGES: Record<OwnerRejectReason, string> = {
  "owner-reply-disabled":
    "Couldn't relay your reply: customer-chat owner replies are disabled. Enable them in Admin → SMS → Customer Chat.",
  "owner-reply-malformed":
    "Couldn't relay your reply. Use this format: #<inquiryId> <message>. Example: #123 we'll bring extra trays.",
  "owner-reply-no-inquiry":
    "Couldn't relay your reply: that inquiry id wasn't found. Check the #<id> tag and try again.",
  "owner-reply-no-phone":
    "Couldn't relay your reply: that inquiry has no customer phone on file.",
};

// Best-effort corrective text back to the owner. Failures are logged
// but never thrown — we don't want to crash ingest because the owner's
// phone is temporarily unreachable.
async function notifyOwnerOfRejection(
  ownerDigits: string,
  reason: OwnerRejectReason,
): Promise<void> {
  try {
    await sendSmsViaEjoin(ownerDigits, OWNER_REJECT_MESSAGES[reason]);
  } catch (err) {
    console.warn("[sms-inbox] owner-reject notify failed", { reason, err });
  }
}

// ── Read-only classifier (diagnostics) ───────────────────────────────────────
//
// Mirrors every gating decision ingestInbound makes, but never writes
// anything to the DB and never sends any SMS. The admin diagnostics
// endpoint uses this to annotate the gateway's parsed inbox rows so an
// operator can answer at a glance: "this row would be matched to
// inquiry #N", "this row would land in Unmatched", "this row is from
// the owner phone and needs the #<id> tag", "this row is a STOP
// keyword", "this sender is admin-blocked".
export type InboundClassification =
  | { kind: "skipped-empty" }
  // Owner-from-phone outcomes mirror ingestInboundImpl's owner branch
  // 1:1 so an operator can read the diagnostics annotation and know
  // exactly what would happen to a real send from the owner phone
  // without actually sending it. STOP keywords from the owner phone
  // map to "owner-reply-malformed" (matching the impl, which rejects
  // STOP-from-owner as a misfire rather than treating it as opt-out).
  | { kind: "owner-reply-disabled" }
  | { kind: "owner-reply-malformed" }
  | {
      kind: "owner-reply-no-inquiry";
      tag: { inquiryId: number; reply: string };
    }
  | { kind: "owner-reply-no-phone"; inquiryId: number }
  | { kind: "owner-reply-relay-eligible"; inquiryId: number }
  | { kind: "stop-keyword" }
  | { kind: "admin-blocked" }
  | { kind: "matched-inquiry"; inquiryId: number }
  | {
      kind: "unmatched";
      reason: "no-inquiry-with-phone";
      customerOptedOut: boolean;
    };

export async function classifyInbound(input: {
  fromPhone: string;
  body: string;
}): Promise<InboundClassification> {
  const fromDigits = normalizePhoneDigits(input.fromPhone);
  const body = (input.body ?? "").trim();
  if (!fromDigits || !body) return { kind: "skipped-empty" };
  const ownerDigits = await getOwnerPhoneDigits();
  if (ownerDigits && fromDigits === ownerDigits) {
    // Mirror the order of checks in ingestInboundImpl exactly so the
    // diagnostics outcome can never disagree with the live pipeline.
    if (isStopKeyword(body)) return { kind: "owner-reply-malformed" };
    const settings = await getRelevantSettings();
    if (!settings.ownerReplyEnabled) return { kind: "owner-reply-disabled" };
    const tag = parseOwnerTag(body);
    if (!tag) return { kind: "owner-reply-malformed" };
    const [inq] = await db
      .select({
        id: cateringInquiriesTable.id,
        clientPhone: cateringInquiriesTable.clientPhone,
      })
      .from(cateringInquiriesTable)
      .where(eq(cateringInquiriesTable.id, tag.inquiryId));
    if (!inq) return { kind: "owner-reply-no-inquiry", tag };
    const customerDigits = normalizePhoneDigits(inq.clientPhone ?? "");
    if (!customerDigits) {
      return { kind: "owner-reply-no-phone", inquiryId: inq.id };
    }
    return { kind: "owner-reply-relay-eligible", inquiryId: inq.id };
  }
  if (isStopKeyword(body)) return { kind: "stop-keyword" };
  const blockedReason = await isBlocked(fromDigits);
  if (blockedReason === "admin-blocked") return { kind: "admin-blocked" };
  const inquiryId = await findInquiryForPhone(fromDigits);
  if (inquiryId != null) return { kind: "matched-inquiry", inquiryId };
  return {
    kind: "unmatched",
    reason: "no-inquiry-with-phone",
    customerOptedOut: blockedReason === "customer-opt-out",
  };
}

// Single ingest call for both poller and webhook deliveries. Idempotent
// on gatewayMessageId — a message that's already been stored returns
// status 'dedup' without further side effects, so the poller can re-run
// on overlapping windows.
//
// This wrapper exists purely to log one structured line per inbound
// message regardless of which return path the impl took. The poller,
// the backfill loop, and the webhook all funnel through here, so a
// single line per message is enough to reconstruct what the pipeline
// did. Operators rely on this when debugging "I texted in but it
// didn't show up" reports.
export async function ingestInbound(input: {
  gatewayMessageId: string;
  fromPhone: string;
  body: string;
  occurredAt: Date;
  port: number;
}): Promise<IngestResult> {
  const result = await ingestInboundImpl(input);
  const inquiryIdLogged =
    result.status === "stored" ? result.inquiryId :
    result.status === "owner-reply-relayed" ? result.inquiryId :
    null;
  // Derived operator-readable outcome. Splits "stored" into the two
  // sub-cases an operator actually cares about — "stored-matched"
  // (chat bubble appears in an inquiry thread) vs "stored-unmatched"
  // (lands in the Unmatched inbox) — so log scans don't have to
  // infer it from inquiryId being null. All other ingest results
  // pass through unchanged.
  const outcome =
    result.status === "stored"
      ? result.inquiryId != null
        ? "stored-matched"
        : "stored-unmatched"
      : result.status;
  logger.info(
    {
      gid: input.gatewayMessageId,
      fromDigits: normalizePhoneDigits(input.fromPhone),
      port: input.port,
      bodyLen: (input.body ?? "").length,
      occurredAt: input.occurredAt.toISOString(),
      status: result.status,
      outcome,
      inquiryId: inquiryIdLogged,
      rejectReason: result.status === "owner-reply-rejected" ? result.reason : undefined,
      blockReason: result.status === "blocked" ? result.reason : undefined,
      messageId:
        result.status === "stored" || result.status === "dedup"
          ? result.messageId
          : undefined,
    },
    "[sms-inbox] ingest",
  );
  return result;
}

async function ingestInboundImpl(input: {
  gatewayMessageId: string;
  fromPhone: string;
  body: string;
  occurredAt: Date;
  port: number;
}): Promise<IngestResult> {
  const fromDigits = normalizePhoneDigits(input.fromPhone);
  const body = (input.body ?? "").trim();
  if (!fromDigits || !body) return { status: "skipped-empty" };

  // ── Owner-from-phone strict-tag relay ─────────────────────────────────────
  // Detect BEFORE writing the inbound row so anything originating from
  // the owner phone never pollutes the customer's chat thread or the
  // Unmatched inbox. Per spec: every inbound from the owner is treated
  // as an attempted relay — even when the tag is missing/malformed,
  // we reject with a corrective text and never ingest the body.
  const settings = await getRelevantSettings();
  const ownerDigits = await getOwnerPhoneDigits();
  if (ownerDigits && fromDigits === ownerDigits) {
    // STOP coming from the owner phone is almost certainly a misfire,
    // not a real opt-out request. Don't blocklist our own owner.
    if (isStopKeyword(body)) {
      await notifyOwnerOfRejection(ownerDigits, "owner-reply-malformed");
      return { status: "owner-reply-rejected", reason: "owner-reply-malformed" };
    }
    if (!settings.ownerReplyEnabled) {
      await notifyOwnerOfRejection(ownerDigits, "owner-reply-disabled");
      return { status: "owner-reply-rejected", reason: "owner-reply-disabled" };
    }
    const tag = parseOwnerTag(body);
    if (!tag) {
      await notifyOwnerOfRejection(ownerDigits, "owner-reply-malformed");
      return { status: "owner-reply-rejected", reason: "owner-reply-malformed" };
    }
    const [inq] = await db
      .select({ id: cateringInquiriesTable.id, clientPhone: cateringInquiriesTable.clientPhone })
      .from(cateringInquiriesTable)
      .where(eq(cateringInquiriesTable.id, tag.inquiryId));
    if (!inq) {
      await notifyOwnerOfRejection(ownerDigits, "owner-reply-no-inquiry");
      return { status: "owner-reply-rejected", reason: "owner-reply-no-inquiry" };
    }
    const customerDigits = normalizePhoneDigits(inq.clientPhone ?? "");
    if (!customerDigits) {
      await notifyOwnerOfRejection(ownerDigits, "owner-reply-no-phone");
      return { status: "owner-reply-rejected", reason: "owner-reply-no-phone" };
    }
    // Dedupe BEFORE sending. The poller re-runs every few seconds and
    // the same gateway row can be returned in successive overlap
    // windows. We claim the gatewayMessageId by inserting a sentinel
    // inbound row with a distinct source — if the unique index trips
    // (returning [] from .returning()) the relay has already happened
    // on a previous poll and we must NOT re-send to the customer.
    // The sentinel is marked seenByAdmin=true and excluded from the
    // Unmatched query (see admin-sms-messages.ts) so it stays invisible
    // in the UI while still occupying the gatewayMessageId slot.
    const [marker] = await db
      .insert(smsMessagesTable)
      .values({
        direction: "inbound",
        customerPhone: ownerDigits,
        body: body,
        occurredAt: input.occurredAt,
        port: input.port,
        inquiryId: null,
        seenByAdmin: true,
        gatewayMessageId: input.gatewayMessageId,
        source: "owner_relay_marker",
      })
      .onConflictDoNothing({ target: smsMessagesTable.gatewayMessageId })
      .returning();
    if (!marker) {
      // Already relayed on a prior poll — no-op.
      return { status: "owner-reply-relayed", inquiryId: inq.id };
    }
    // Send through the guarded sender so blocklist still applies.
    await sendToCustomerGuarded({
      to: customerDigits,
      body: tag.reply,
      inquiryId: inq.id,
      source: "owner_relay",
    });
    return { status: "owner-reply-relayed", inquiryId: inq.id };
  }

  // ── STOP keyword: opt-out the sender, suppress this message ──────────────
  if (isStopKeyword(body)) {
    await block(fromDigits, "customer-opt-out", `STOP keyword "${body.toLowerCase()}"`);
    // Still log the inbound so the chat thread (if any) shows the opt-out
    // event explicitly and admins understand why outbound is disabled.
    const stored = await insertInboundRow({
      ...input,
      fromPhone: fromDigits,
      body,
    });
    if (stored.status === "stored" || stored.status === "dedup") {
      return { status: "opted-out" };
    }
    return stored;
  }

  // ── Admin-blocked: drop entirely (do not even surface in Unmatched) ──────
  const blockedReason = await isBlocked(fromDigits);
  if (blockedReason === "admin-blocked") {
    return { status: "blocked", reason: "admin-blocked" };
  }
  // customer-opt-out doesn't suppress inbound — the customer is allowed
  // to text us back even after STOP; we just can't text them.

  // ── Normal ingest ────────────────────────────────────────────────────────
  const stored = await insertInboundRow({ ...input, fromPhone: fromDigits, body });
  if (stored.status !== "stored") return stored;

  // ── Owner forwarding (best-effort) ───────────────────────────────────────
  if (settings.ownerForwardEnabled && ownerDigits) {
    if (await isForwardCapReached(stored.inquiryId, settings.ownerForwardCap)) {
      // Cap reached — silently skip, we don't want to spam either side.
      // The chat UI surfaces the cap separately.
    } else {
      try {
        const forwardBody = await buildForwardBody(
          stored.inquiryId,
          fromDigits,
          body,
          settings.ownerReplyEnabled,
        );
        await sendSmsViaEjoin(ownerDigits, forwardBody);
        await db.insert(ownerForwardsTable).values({
          inquiryId: stored.inquiryId,
          ownerPhone: ownerDigits,
          sourceGatewayMessageId: input.gatewayMessageId,
        });
      } catch (err) {
        console.warn("[sms-inbox] owner forward failed", err);
      }
    }
  }

  return stored;
}

// Insert + match + publish. Split out so the STOP-keyword path above
// can reuse the dedupe + match + SSE plumbing without recursing.
async function insertInboundRow(input: {
  gatewayMessageId: string;
  fromPhone: string;
  body: string;
  occurredAt: Date;
  port: number;
}): Promise<
  | { status: "stored"; messageId: number; inquiryId: number | null }
  | { status: "dedup"; messageId: number }
> {
  const inquiryId = await findInquiryForPhone(input.fromPhone);
  // Insert with ON CONFLICT DO NOTHING so concurrent webhook+poller
  // deliveries don't both succeed. Drizzle's returning() returns []
  // when nothing was inserted, which we treat as the dedupe case.
  const [inserted] = await db
    .insert(smsMessagesTable)
    .values({
      direction: "inbound",
      customerPhone: input.fromPhone,
      body: input.body,
      occurredAt: input.occurredAt,
      port: input.port,
      inquiryId,
      seenByAdmin: false,
      gatewayMessageId: input.gatewayMessageId,
      source: "inbound",
    })
    .onConflictDoNothing({ target: smsMessagesTable.gatewayMessageId })
    .returning();
  if (!inserted) {
    // Look up the existing row id so callers get a stable handle.
    const [existing] = await db
      .select({ id: smsMessagesTable.id })
      .from(smsMessagesTable)
      .where(eq(smsMessagesTable.gatewayMessageId, input.gatewayMessageId));
    return { status: "dedup", messageId: existing?.id ?? -1 };
  }
  publishSmsEvent({
    type: "inbound",
    messageId: inserted.id,
    inquiryId,
    customerPhone: input.fromPhone,
    body: input.body,
    occurredAt: input.occurredAt.toISOString(),
  });
  if (inquiryId == null) {
    publishSmsEvent({ type: "unmatched-changed" });
  }
  return { status: "stored", messageId: inserted.id, inquiryId };
}

// ── Outbound guarded send ─────────────────────────────────────────────────────

export type OutboundSource = "admin" | "owner_relay" | "system";

export type OutboundResult =
  | { status: "sent"; messageId: number; port: number; gatewayResponse: string }
  | { status: "blocked"; reason: BlockReason };

// Single outbound funnel for everything customer-bound. Enforces
// blocklist (both opt-out and admin-blocked), sends via the dedicated
// chat port, persists to sms_messages, publishes the SSE event.
export async function sendToCustomerGuarded(opts: {
  to: string;
  body: string;
  inquiryId: number | null;
  source: OutboundSource;
}): Promise<OutboundResult> {
  const phone = normalizePhoneDigits(opts.to);
  // Fast-path: avoid talking to the gateway at all for known-blocked
  // recipients. The actual send boundary (sendSmsViaEjoin) also
  // re-checks via BlocklistedRecipientError, which we catch below as a
  // defense-in-depth in case a row was added between these two reads.
  const blocked = await isBlocked(phone);
  if (blocked) {
    return { status: "blocked", reason: blocked };
  }
  let result: { port: number; gatewayResponse: string };
  try {
    result = await sendSmsToCustomer(phone, opts.body);
  } catch (err) {
    if (err instanceof BlocklistedRecipientError) {
      return { status: "blocked", reason: err.reason };
    }
    throw err;
  }
  const occurredAt = new Date();
  // Synthesize a stable id; dedupe is a no-op for outbound but the
  // column is NOT NULL so we still need a value.
  const gatewayMessageId = `out:${randomUUID()}`;
  const [row] = await db
    .insert(smsMessagesTable)
    .values({
      direction: "outbound",
      customerPhone: phone,
      body: opts.body,
      occurredAt,
      port: result.port,
      inquiryId: opts.inquiryId,
      seenByAdmin: true,
      gatewayMessageId,
      source: opts.source,
      gatewayResponse: result.gatewayResponse,
    })
    .returning();
  publishSmsEvent({
    type: "outbound",
    messageId: row.id,
    inquiryId: opts.inquiryId,
    customerPhone: phone,
    body: opts.body,
    occurredAt: occurredAt.toISOString(),
    source: opts.source,
  });
  return { status: "sent", messageId: row.id, port: result.port, gatewayResponse: result.gatewayResponse };
}

// Re-export the chat-port resolver so route handlers can show
// "feature not configured" responses without importing sms-ejoin
// directly. Keeps the boundary surface tight.
export { getChatPort };
