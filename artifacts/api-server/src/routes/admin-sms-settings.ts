// Admin "Communications → SMS" backend.
// Owns every SMS-related setting that used to be scattered across the event
// settings page: the ejointech port pool (multi-port round-robin), the owner
// notification phone, and the kitchen low-stock recipient list. Also exposes
// two test endpoints (low-stock recipients and owner phone) so admins can
// verify delivery without burning through a real low-stock crossing.

import { Router, type IRouter } from "express";
import { randomBytes } from "crypto";
import { db } from "@workspace/db";
import { eventSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { isEjoinConfigured, sendSmsViaEjoin, sendSmsViaChatPort, clearEjoinPortCache, EJOIN_PORT_COUNT, getInboundMode, getChatPort } from "../lib/sms-ejoin";
import { clearSmsInboxSettingsCache, ingestInbound } from "../lib/sms-inbox";
import { runSmsPollOnce } from "../lib/sms-scheduler";

const router: IRouter = Router();

// In-process per-test-endpoint throttle. The UI already enforces a 10s
// per-button cooldown so the buttons can't spam the gateway, but a
// curl-armed admin shouldn't be able to bypass that and burn through
// the SIM either. Keyed by endpoint slug so the chat-owner test
// doesn't gate the regular owner test (they hit different SIMs).
const TEST_SEND_COOLDOWN_MS = 10_000;
const lastTestSendAt = new Map<string, number>();
function checkTestCooldown(slug: string): number {
  const last = lastTestSendAt.get(slug) ?? 0;
  const elapsed = Date.now() - last;
  if (elapsed < TEST_SEND_COOLDOWN_MS) {
    return Math.ceil((TEST_SEND_COOLDOWN_MS - elapsed) / 1000);
  }
  return 0;
}
function markTestSend(slug: string): void {
  lastTestSendAt.set(slug, Date.now());
}

// Update payload typed off the Drizzle schema so we never silently widen
// to `Record<string, unknown>` and accidentally let unknown columns
// through to the DB. Includes only the columns this router owns.
type SmsSettingsUpdate = Partial<
  Pick<
    typeof eventSettingsTable.$inferInsert,
    | "smsActivePorts"
    | "ownerNotificationPhone"
    | "ownerNotificationEmail"
    | "lowStockAlertPhones"
    | "lowStockAlertThreshold"
    | "smsChatPort"
    | "smsChatOwnerPhone"
    | "smsChatOwnerEmail"
    | "smsOwnerForwardEnabled"
    | "smsOwnerForwardCapPer24h"
    | "smsOwnerForwardUnmatchedEnabled"
    | "smsOwnerReplyEnabled"
    | "smsBackfillDays"
    | "updatedAt"
  >
>;

// Tagged validation error so route handlers can re-throw cleanly without
// resorting to ad-hoc `Object.assign`/`any` shapes.
class HttpError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function isHttpError(err: unknown): err is HttpError {
  return err instanceof HttpError;
}

// ── Validation helpers ────────────────────────────────────────────────────────

function normalizePortPool(v: unknown): number[] {
  if (!Array.isArray(v)) {
    throw new HttpError("smsActivePorts must be an array of port numbers");
  }
  if (v.length === 0) {
    throw new HttpError("smsActivePorts must include at least one port");
  }
  if (v.length > EJOIN_PORT_COUNT) {
    throw new HttpError(`smsActivePorts cannot exceed ${EJOIN_PORT_COUNT} entries (gateway has ${EJOIN_PORT_COUNT} physical SIM ports)`);
  }
  const out: number[] = [];
  const seen = new Set<number>();
  v.forEach((raw, idx) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > EJOIN_PORT_COUNT) {
      throw new HttpError(`Port #${idx + 1} must be an integer between 1 and ${EJOIN_PORT_COUNT}`);
    }
    if (seen.has(n)) return; // dedupe silently — order preserved
    seen.add(n);
    out.push(n);
  });
  if (out.length === 0) {
    throw new HttpError("smsActivePorts must include at least one port");
  }
  return out;
}

function normalizeOwnerPhone(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") {
    throw new HttpError("ownerNotificationPhone must be a string");
  }
  const trimmed = v.trim();
  if (trimmed === "") return null;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7) {
    throw new HttpError("ownerNotificationPhone must contain at least 7 digits");
  }
  return trimmed.slice(0, 32);
}

// Same shape as normalizeOwnerPhone but validated under the chat-owner
// label so error messages point the admin at the right input. Empty /
// null clears the override (chat-owner falls back to the regular owner
// notification phone, then OWNER_PHONE).
function normalizeChatOwnerPhone(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") {
    throw new HttpError("smsChatOwnerPhone must be a string");
  }
  const trimmed = v.trim();
  if (trimmed === "") return null;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7) {
    throw new HttpError("smsChatOwnerPhone must contain at least 7 digits");
  }
  return trimmed.slice(0, 32);
}

// Email validators for the new chat-owner / owner notification email
// fields. Empty / null clears the value (caller falls back to the next
// link in the chain). Anything else must look like an email and fit in
// 254 chars (RFC 5321 path limit).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function normalizeOwnerEmail(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") {
    throw new HttpError("ownerNotificationEmail must be a string");
  }
  const trimmed = v.trim();
  if (trimmed === "") return null;
  if (trimmed.length > 254 || !EMAIL_RE.test(trimmed)) {
    throw new HttpError("ownerNotificationEmail must be a valid email address");
  }
  return trimmed;
}
function normalizeChatOwnerEmail(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") {
    throw new HttpError("smsChatOwnerEmail must be a string");
  }
  const trimmed = v.trim();
  if (trimmed === "") return null;
  if (trimmed.length > 254 || !EMAIL_RE.test(trimmed)) {
    throw new HttpError("smsChatOwnerEmail must be a valid email address");
  }
  return trimmed;
}

function normalizeAlertPhones(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) {
    throw new HttpError("lowStockAlertPhones must be an array of phone numbers");
  }
  const out: string[] = [];
  const seen = new Set<string>();
  v.forEach((raw, idx) => {
    if (typeof raw !== "string") {
      throw new HttpError(`Recipient phone #${idx + 1} must be a string`);
    }
    const trimmed = raw.trim();
    if (trimmed === "") return;
    const digits = trimmed.replace(/\D/g, "");
    if (digits.length < 7) {
      throw new HttpError(`Recipient phone #${idx + 1} must contain at least 7 digits`);
    }
    if (seen.has(digits)) return;
    seen.add(digits);
    out.push(trimmed.slice(0, 32));
  });
  return out;
}

// Allow null/empty (= "no chat port chosen yet, feature off"). Otherwise
// must be an integer in 1..EJOIN_PORT_COUNT. Overlap with the
// round-robin pool is checked at the route level since it depends on
// the other field's resolved value.
function normalizeChatPort(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > EJOIN_PORT_COUNT) {
    throw new HttpError(`smsChatPort must be an integer between 1 and ${EJOIN_PORT_COUNT}, or null to disable`);
  }
  return n;
}

function normalizeBool(v: unknown, field: string): boolean {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === 1 || v === "1") return true;
  if (v === "false" || v === 0 || v === "0") return false;
  throw new HttpError(`${field} must be a boolean`);
}

// Cap is one of {1,3,5,10} or null (unlimited). Reject other values
// so the UI and backend stay aligned.
function normalizeForwardCap(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n)) {
    throw new HttpError("smsOwnerForwardCapPer24h must be an integer or null");
  }
  if (![1, 3, 5, 10].includes(n)) {
    throw new HttpError("smsOwnerForwardCapPer24h must be one of 1, 3, 5, 10, or null (unlimited)");
  }
  return n;
}

function normalizeBackfillDays(v: unknown): number {
  const n = Number(v);
  // Hard cap at 365 — the gateway's inbox page typically doesn't go
  // back further than ~3 months on most firmware revisions, but we
  // accept up to a year so admins can self-discover the practical
  // ceiling.
  if (!Number.isInteger(n) || n < 1 || n > 365) {
    throw new HttpError("smsBackfillDays must be an integer between 1 and 365");
  }
  return n;
}

function normalizeAlertThreshold(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  // The runtime crossing rule in lowStockAlerts.ts excludes items at
  // newStock <= 0 (out-of-stock has its own flow), so a threshold of 0
  // would silently never fire. Require >= 1 so configured semantics
  // match actual alerting behavior. Cap at 10000 as a fat-finger guard.
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 10000) {
    throw new HttpError("lowStockAlertThreshold must be an integer between 1 and 10000");
  }
  return n;
}

// ── Response shape ────────────────────────────────────────────────────────────

const DEFAULT_EVENT_NAME = "dash by Hollywood East Cafe";

function buildResponse(s: typeof eventSettingsTable.$inferSelect | undefined, webhookSecret: string | null): {
  smsActivePorts: number[];
  ownerNotificationPhone: string | null;
  ownerNotificationEmail: string | null;
  ownerNotificationEmailSource: "db" | "hardcoded";
  lowStockAlertPhones: string[];
  lowStockAlertThreshold: number | null;
  ejoinConfigured: boolean;
  ownerNotificationPhoneSource: "db" | "env" | "none";
  smsChatPort: number | null;
  smsChatOwnerPhone: string | null;
  smsChatOwnerPhoneSource: "db-chat" | "db-owner" | "env" | "none";
  smsChatOwnerEmail: string | null;
  smsChatOwnerEmailSource: "db-chat" | "db-owner" | "hardcoded";
  smsOwnerForwardEnabled: boolean;
  smsOwnerForwardCapPer24h: number | null;
  smsOwnerForwardUnmatchedEnabled: boolean;
  smsOwnerReplyEnabled: boolean;
  smsBackfillDays: number;
  smsBackfillCompletedAt: string | null;
  smsInboundMode: "push" | "poll";
  ejoinPortCount: number;
  smsWebhookUrl: string | null;
} {
  const dbOwner = s?.ownerNotificationPhone?.trim() || null;
  const envOwner = process.env.OWNER_PHONE?.trim() || null;
  const ownerNotificationPhoneSource: "db" | "env" | "none" = dbOwner ? "db" : envOwner ? "env" : "none";
  // Same fallback chain that getChatOwnerPhoneDigits resolves at send
  // time, surfaced so the UI can label which value is actually in use.
  const dbChatOwner = s?.smsChatOwnerPhone?.trim() || null;
  const smsChatOwnerPhoneSource: "db-chat" | "db-owner" | "env" | "none" =
    dbChatOwner ? "db-chat" : dbOwner ? "db-owner" : envOwner ? "env" : "none";
  // Email fallback chain mirrors the phone one but has no env link —
  // the legacy fallback is the hardcoded ALERT_TO in lib/mail.ts.
  const dbOwnerEmail = s?.ownerNotificationEmail?.trim() || null;
  const dbChatOwnerEmail = s?.smsChatOwnerEmail?.trim() || null;
  const ownerNotificationEmailSource: "db" | "hardcoded" = dbOwnerEmail ? "db" : "hardcoded";
  const smsChatOwnerEmailSource: "db-chat" | "db-owner" | "hardcoded" =
    dbChatOwnerEmail ? "db-chat" : dbOwnerEmail ? "db-owner" : "hardcoded";
  return {
    smsActivePorts: s?.smsActivePorts ?? [7],
    ownerNotificationPhone: dbOwner,
    ownerNotificationEmail: dbOwnerEmail,
    ownerNotificationEmailSource,
    lowStockAlertPhones: s?.lowStockAlertPhones ?? [],
    lowStockAlertThreshold: s?.lowStockAlertThreshold ?? null,
    ejoinConfigured: isEjoinConfigured(),
    // Lets the UI show "currently using OWNER_PHONE env var (legacy)" when
    // the admin hasn't entered a DB-managed number yet.
    ownerNotificationPhoneSource,
    smsChatPort: s?.smsChatPort ?? null,
    smsChatOwnerPhone: dbChatOwner,
    smsChatOwnerPhoneSource,
    smsChatOwnerEmail: dbChatOwnerEmail,
    smsChatOwnerEmailSource,
    smsOwnerForwardEnabled: !!s?.smsOwnerForwardEnabled,
    smsOwnerForwardCapPer24h: s?.smsOwnerForwardCapPer24h ?? null,
    smsOwnerForwardUnmatchedEnabled: !!s?.smsOwnerForwardUnmatchedEnabled,
    smsOwnerReplyEnabled: !!s?.smsOwnerReplyEnabled,
    smsBackfillDays: s?.smsBackfillDays ?? 90,
    smsBackfillCompletedAt: s?.smsBackfillCompletedAt ? s.smsBackfillCompletedAt.toISOString() : null,
    smsInboundMode: getInboundMode(),
    ejoinPortCount: EJOIN_PORT_COUNT,
    // Webhook push mode — return the full ready-to-copy URL with the real
    // secret embedded so the admin can paste it directly into eJoinTech.
    smsWebhookUrl: (() => {
      if (!webhookSecret) return null;
      // Prefer the canonical public URL; fall back to Replit's hostname.
      const replitDomain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
      const origin =
        process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") ||
        (replitDomain ? `https://${replitDomain}` : null);
      if (!origin) return null;
      // No template variables in the URL — the gateway appends its own
      // fields (sender, receiver, content, port, etc.) automatically.
      // Adding $port/$sn/$sm caused the gateway to send them as literal
      // strings rather than expanding them, breaking port detection.
      return `${origin}/api/sms/inbound?secret=${encodeURIComponent(webhookSecret)}`;
    })(),
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Returns the effective webhook secret: DB value takes priority, env var
// is the legacy fallback for deployments that pre-date the DB column.
function resolveWebhookSecret(s: typeof eventSettingsTable.$inferSelect | undefined): string | null {
  return s?.smsWebhookSecret?.trim() || process.env.SMS_WEBHOOK_SECRET?.trim() || null;
}

router.get("/admin/sms-settings", async (req, res) => {
  try {
    let [settings] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
    // Auto-generate a webhook secret on first load so the admin gets a
    // ready-to-copy URL without any manual secret management.
    if (settings && !settings.smsWebhookSecret?.trim()) {
      const generated = randomBytes(4).toString("hex");
      const [updated] = await db
        .update(eventSettingsTable)
        .set({ smsWebhookSecret: generated, updatedAt: new Date() })
        .where(eq(eventSettingsTable.id, 1))
        .returning();
      settings = updated;
    }
    res.json(buildResponse(settings, resolveWebhookSecret(settings)));
  } catch (err: unknown) {
    req.log.error({ err }, "Error fetching SMS settings");
    res.status(500).json({ error: "Failed to fetch SMS settings" });
  }
});

router.put("/admin/sms-settings", async (req, res) => {
  try {
    const body = req.body as {
      smsActivePorts?: unknown;
      ownerNotificationPhone?: unknown;
      ownerNotificationEmail?: unknown;
      lowStockAlertPhones?: unknown;
      lowStockAlertThreshold?: unknown;
      smsChatPort?: unknown;
      smsChatOwnerPhone?: unknown;
      smsChatOwnerEmail?: unknown;
      smsOwnerForwardEnabled?: unknown;
      smsOwnerForwardCapPer24h?: unknown;
      smsOwnerForwardUnmatchedEnabled?: unknown;
      smsOwnerReplyEnabled?: unknown;
      smsBackfillDays?: unknown;
    };
    const updates: SmsSettingsUpdate = { updatedAt: new Date() };
    if (body.smsActivePorts !== undefined) {
      updates.smsActivePorts = normalizePortPool(body.smsActivePorts);
    }
    if (body.ownerNotificationPhone !== undefined) {
      updates.ownerNotificationPhone = normalizeOwnerPhone(body.ownerNotificationPhone);
    }
    if (body.ownerNotificationEmail !== undefined) {
      updates.ownerNotificationEmail = normalizeOwnerEmail(body.ownerNotificationEmail);
    }
    if (body.lowStockAlertPhones !== undefined) {
      updates.lowStockAlertPhones = normalizeAlertPhones(body.lowStockAlertPhones);
    }
    if (body.lowStockAlertThreshold !== undefined) {
      updates.lowStockAlertThreshold = normalizeAlertThreshold(body.lowStockAlertThreshold);
    }
    if (body.smsChatPort !== undefined) {
      updates.smsChatPort = normalizeChatPort(body.smsChatPort);
    }
    if (body.smsChatOwnerPhone !== undefined) {
      updates.smsChatOwnerPhone = normalizeChatOwnerPhone(body.smsChatOwnerPhone);
    }
    if (body.smsChatOwnerEmail !== undefined) {
      updates.smsChatOwnerEmail = normalizeChatOwnerEmail(body.smsChatOwnerEmail);
    }
    if (body.smsOwnerForwardEnabled !== undefined) {
      updates.smsOwnerForwardEnabled = normalizeBool(body.smsOwnerForwardEnabled, "smsOwnerForwardEnabled");
    }
    if (body.smsOwnerForwardCapPer24h !== undefined) {
      updates.smsOwnerForwardCapPer24h = normalizeForwardCap(body.smsOwnerForwardCapPer24h);
    }
    if (body.smsOwnerForwardUnmatchedEnabled !== undefined) {
      updates.smsOwnerForwardUnmatchedEnabled = normalizeBool(
        body.smsOwnerForwardUnmatchedEnabled,
        "smsOwnerForwardUnmatchedEnabled",
      );
    }
    if (body.smsOwnerReplyEnabled !== undefined) {
      updates.smsOwnerReplyEnabled = normalizeBool(body.smsOwnerReplyEnabled, "smsOwnerReplyEnabled");
    }
    if (body.smsBackfillDays !== undefined) {
      updates.smsBackfillDays = normalizeBackfillDays(body.smsBackfillDays);
    }

    const [existing] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));

    // Cross-field validation: chat port must NOT overlap with the
    // round-robin pool. If either field is changing this save, evaluate
    // against the resolved post-update values.
    const resolvedChatPort = updates.smsChatPort !== undefined ? updates.smsChatPort : existing?.smsChatPort ?? null;
    const resolvedPool = updates.smsActivePorts !== undefined ? updates.smsActivePorts : existing?.smsActivePorts ?? [7];
    if (resolvedChatPort != null && resolvedPool.includes(resolvedChatPort)) {
      throw new HttpError(
        `Customer chat port (port ${resolvedChatPort}) cannot also be in the staff round-robin pool. ` +
        `Remove it from the pool or pick a different chat port.`,
      );
    }
    let row: typeof eventSettingsTable.$inferSelect | undefined;
    if (existing) {
      const [updated] = await db
        .update(eventSettingsTable)
        .set(updates)
        .where(eq(eventSettingsTable.id, 1))
        .returning();
      row = updated;
    } else {
      // Bootstrap row if event_settings(1) somehow doesn't exist yet —
      // mirrors the same pattern used by the event-settings PUT handler so
      // first-run admins aren't blocked by a missing seed.
      const [created] = await db
        .insert(eventSettingsTable)
        .values({
          id: 1,
          eventName: "",
          eventPassword: process.env.EVENT_PASSWORD ?? "",
          smsActivePorts: updates.smsActivePorts ?? [7],
          ownerNotificationPhone: updates.ownerNotificationPhone ?? null,
          ownerNotificationEmail: updates.ownerNotificationEmail ?? null,
          lowStockAlertPhones: updates.lowStockAlertPhones ?? [],
          lowStockAlertThreshold: updates.lowStockAlertThreshold ?? null,
          smsChatOwnerPhone: updates.smsChatOwnerPhone ?? null,
          smsChatOwnerEmail: updates.smsChatOwnerEmail ?? null,
          smsOwnerForwardEnabled: updates.smsOwnerForwardEnabled ?? false,
          smsOwnerForwardCapPer24h: updates.smsOwnerForwardCapPer24h ?? 1,
          smsOwnerForwardUnmatchedEnabled: updates.smsOwnerForwardUnmatchedEnabled ?? false,
          smsOwnerReplyEnabled: updates.smsOwnerReplyEnabled ?? false,
          smsBackfillDays: updates.smsBackfillDays ?? 90,
        })
        .returning();
      row = created;
    }

    // Port cache is short-lived but the admin expects "Save → next test uses
    // the new pool" to be instant. Invalidate explicitly.
    clearEjoinPortCache();
    // Owner-forward / opt-out / reply settings are read on the inbound
    // ingest hot path and cached for 5s. Invalidate so toggles take
    // effect on the very next inbound.
    clearSmsInboxSettingsCache();

    res.json(buildResponse(row, resolveWebhookSecret(row)));
  } catch (err: unknown) {
    if (isHttpError(err)) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "Error updating SMS settings");
    res.status(500).json({ error: "Failed to update SMS settings" });
  }
});

// Re-issue the same low-stock alert that fires automatically when an item
// crosses the threshold, but to whatever recipients are currently saved.
// Mirrors the previous /admin/event-settings/test-low-stock-alert behavior.
router.post("/admin/sms-settings/test-low-stock-alert", async (req, res) => {
  try {
    const cooldown = checkTestCooldown("low-stock");
    if (cooldown > 0) {
      res.status(429).json({ error: `Cooling down — try again in ${cooldown}s.`, retryAfter: cooldown });
      return;
    }
    const [settings] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
    const phones = (settings?.lowStockAlertPhones ?? []).map(p => p.trim()).filter(Boolean);
    if (phones.length === 0) {
      res.status(400).json({ error: "No recipient phone numbers saved. Add at least one and save before testing." });
      return;
    }
    if (!isEjoinConfigured()) {
      res.status(503).json({ error: "SMS gateway is not configured." });
      return;
    }
    markTestSend("low-stock");
    const event = settings?.eventName?.trim() || DEFAULT_EVENT_NAME;
    const message = `Test alert from ${event}`;
    const results: Array<{ phone: string; ok: boolean; port?: number; gatewayResponse?: string; error?: string }> = [];
    for (const phone of phones) {
      try {
        const r = await sendSmsViaEjoin(phone, message);
        results.push({ phone, ok: true, port: r.port, gatewayResponse: r.gatewayResponse });
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : "send failed";
        results.push({ phone, ok: false, error: detail });
      }
    }
    const okCount = results.filter(r => r.ok).length;
    if (okCount === 0) {
      res.status(502).json({
        error: `Failed to send test alert to ${results[0].phone}: ${results[0].error}`,
        results,
      });
      return;
    }
    res.json({ ok: true, sentCount: okCount, totalCount: results.length, results });
  } catch (err: unknown) {
    req.log.error({ err }, "Error sending test low-stock alert");
    const detail = err instanceof Error ? err.message : "Failed to send test alert";
    res.status(502).json({ error: `Failed to send test alert: ${detail}` });
  }
});

// Send a one-line "Test owner alert from <event>" SMS to whichever phone
// the inquiry-arrival/quote-response alerts would actually use right now
// (DB → env fallback). Lets admins verify the OWNER_PHONE migration without
// triggering a real catering inquiry.
router.post("/admin/sms-settings/test-owner-alert", async (req, res) => {
  try {
    const cooldown = checkTestCooldown("owner");
    if (cooldown > 0) {
      res.status(429).json({ error: `Cooling down — try again in ${cooldown}s.`, retryAfter: cooldown });
      return;
    }
    const [settings] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
    const dbPhone = settings?.ownerNotificationPhone?.trim();
    const envPhone = process.env.OWNER_PHONE?.trim();
    const ownerPhone = dbPhone || envPhone || "";
    if (!ownerPhone) {
      res.status(400).json({
        error: "No owner notification phone configured. Save one above (or set OWNER_PHONE) before testing.",
      });
      return;
    }
    if (!isEjoinConfigured()) {
      res.status(503).json({ error: "SMS gateway is not configured." });
      return;
    }
    markTestSend("owner");
    const event = settings?.eventName?.trim() || DEFAULT_EVENT_NAME;
    const message = `Test owner alert from ${event}`;
    let result: { port: number; gatewayResponse: string };
    try {
      result = await sendSmsViaEjoin(ownerPhone, message);
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : "send failed";
      res.status(502).json({ error: `Failed to send owner test alert: ${detail}` });
      return;
    }
    res.json({
      ok: true,
      sentTo: ownerPhone,
      port: result.port,
      gatewayResponse: result.gatewayResponse,
      ownerNotificationPhoneSource: dbPhone ? "db" : "env",
    });
  } catch (err: unknown) {
    req.log.error({ err }, "Error sending test owner alert");
    res.status(500).json({ error: "Failed to send test owner alert" });
  }
});

// Send a one-line "This is a test from <event>" SMS through the dedicated
// customer-chat port to whichever phone the chat-owner forwards would
// actually use right now (chat → owner notification → OWNER_PHONE env).
// Mirrors test-owner-alert above, but routes via sendSmsViaChatPort so
// it also validates the chat-port configuration end-to-end.
router.post("/admin/sms-settings/test-chat-owner-alert", async (req, res) => {
  try {
    const cooldown = checkTestCooldown("chat-owner");
    if (cooldown > 0) {
      res.status(429).json({ error: `Cooling down — try again in ${cooldown}s.`, retryAfter: cooldown });
      return;
    }
    const [settings] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
    const dbChatPhone = settings?.smsChatOwnerPhone?.trim();
    const dbOwnerPhone = settings?.ownerNotificationPhone?.trim();
    const envPhone = process.env.OWNER_PHONE?.trim();
    const chatOwnerPhone = dbChatPhone || dbOwnerPhone || envPhone || "";
    const source: "db-chat" | "db-owner" | "env" | "none" =
      dbChatPhone ? "db-chat" : dbOwnerPhone ? "db-owner" : envPhone ? "env" : "none";
    if (!chatOwnerPhone) {
      res.status(400).json({
        error:
          "No chat-owner phone configured. Save one above (or fall back to the Owner Notifications phone / OWNER_PHONE) before testing.",
      });
      return;
    }
    if (!isEjoinConfigured()) {
      res.status(503).json({ error: "SMS gateway is not configured." });
      return;
    }
    if (settings?.smsChatPort == null) {
      res.status(400).json({
        error: "No customer chat port configured. Pick one above before testing.",
      });
      return;
    }
    markTestSend("chat-owner");
    const event = settings?.eventName?.trim() || DEFAULT_EVENT_NAME;
    const message = `This is a test from ${event}`;
    let result: { port: number; gatewayResponse: string };
    try {
      result = await sendSmsViaChatPort(chatOwnerPhone, message);
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : "send failed";
      res.status(502).json({ error: `Failed to send chat-owner test: ${detail}` });
      return;
    }
    res.json({
      ok: true,
      sentTo: chatOwnerPhone,
      port: result.port,
      gatewayResponse: result.gatewayResponse,
      smsChatOwnerPhoneSource: source,
    });
  } catch (err: unknown) {
    req.log.error({ err }, "Error sending test chat-owner alert");
    res.status(500).json({ error: "Failed to send test chat-owner alert" });
  }
});

// Rotates the webhook secret — generates a new random 64-char hex string,
// saves it to the DB, and returns the updated settings response (including
// the new ready-to-copy URL). The admin must update their eJoinTech gateway
// URL after regenerating.
router.post("/admin/sms-settings/regenerate-webhook-secret", async (req, res) => {
  try {
    const newSecret = randomBytes(4).toString("hex");
    const [updated] = await db
      .update(eventSettingsTable)
      .set({ smsWebhookSecret: newSecret, updatedAt: new Date() })
      .where(eq(eventSettingsTable.id, 1))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Settings not found" });
      return;
    }
    res.json(buildResponse(updated, resolveWebhookSecret(updated)));
  } catch (err: unknown) {
    req.log.error({ err }, "Error regenerating webhook secret");
    res.status(500).json({ error: "Failed to regenerate webhook secret" });
  }
});

// Synthetic end-to-end pipeline test for the webhook push setup card.
// Injects a fake inbound message through ingestInbound() so the admin
// can verify the full pipeline (auth → parse → DB write → chat thread)
// without waiting for the real eJoinTech gateway to fire. Uses a
// guaranteed-fake phone number (+10000000001) so the message lands in
// Unmatched Messages, never in a real inquiry thread.
router.post("/admin/sms-settings/test-webhook-inbound", async (req, res) => {
  try {
    const cooldown = checkTestCooldown("webhook-inbound");
    if (cooldown > 0) {
      res.status(429).json({ error: `Cooling down — try again in ${cooldown}s.`, retryAfter: cooldown });
      return;
    }
    const chatPort = await getChatPort();
    if (chatPort == null) {
      res.status(400).json({
        error: "No customer chat port configured. Set one under Customer Chat Port first.",
      });
      return;
    }
    markTestSend("webhook-inbound");
    await ingestInbound({
      gatewayMessageId: `admin-test:${Date.now()}`,
      fromPhone: "+10000000001",
      body: "[Admin test] Webhook inbound check — sent from SMS Settings",
      occurredAt: new Date(),
      port: chatPort,
    });
    res.json({ ok: true });
  } catch (err: unknown) {
    req.log.error({ err }, "Error running webhook inbound test");
    const detail = err instanceof Error ? err.message : "Test failed";
    res.status(500).json({ error: detail });
  }
});

// Manual one-shot trigger for the operator's "Run now" button on the
// SMS Settings inbound polling card. Always runs even when the
// persisted enabled flag is OFF — that's the entire point of the
// button. Overlap with a scheduled or another manual run is gated by
// an in-process flag inside the scheduler so two clicks in quick
// succession can't double-fire.
router.post("/admin/sms-settings/poller/run-now", async (req, res) => {
  try {
    const result = await runSmsPollOnce();
    res.json(result);
  } catch (err: unknown) {
    req.log.error({ err }, "sms: manual poller run failed");
    res.status(500).json({ error: "Failed to run SMS poll" });
  }
});

export default router;
