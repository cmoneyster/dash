// Admin "Communications → SMS" backend.
// Owns every SMS-related setting that used to be scattered across the event
// settings page: the ejointech port pool (multi-port round-robin), the owner
// notification phone, and the kitchen low-stock recipient list. Also exposes
// three test endpoints (arbitrary phone, low-stock recipients, owner phone)
// so admins can verify delivery without burning through a real low-stock
// crossing.

import { Router, type IRouter, type Request } from "express";
import { db } from "@workspace/db";
import { eventSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { isEjoinConfigured, sendSmsViaEjoin, clearEjoinPortCache, EJOIN_PORT_COUNT } from "../lib/sms-ejoin";

const router: IRouter = Router();

// Update payload typed off the Drizzle schema so we never silently widen
// to `Record<string, unknown>` and accidentally let unknown columns
// through to the DB. Includes only the columns this router owns.
type SmsSettingsUpdate = Partial<
  Pick<
    typeof eventSettingsTable.$inferInsert,
    "smsActivePorts" | "ownerNotificationPhone" | "lowStockAlertPhones" | "lowStockAlertThreshold" | "updatedAt"
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

function buildResponse(s: typeof eventSettingsTable.$inferSelect | undefined): {
  smsActivePorts: number[];
  ownerNotificationPhone: string | null;
  lowStockAlertPhones: string[];
  lowStockAlertThreshold: number | null;
  ejoinConfigured: boolean;
  eventName: string;
  ownerNotificationPhoneSource: "db" | "env" | "none";
} {
  const dbOwner = s?.ownerNotificationPhone?.trim() || null;
  const envOwner = process.env.OWNER_PHONE?.trim() || null;
  const ownerNotificationPhoneSource: "db" | "env" | "none" = dbOwner ? "db" : envOwner ? "env" : "none";
  return {
    smsActivePorts: s?.smsActivePorts ?? [7],
    ownerNotificationPhone: dbOwner,
    lowStockAlertPhones: s?.lowStockAlertPhones ?? [],
    lowStockAlertThreshold: s?.lowStockAlertThreshold ?? null,
    ejoinConfigured: isEjoinConfigured(),
    // Surfaced so the UI can pre-populate the test-send default body
    // ("Test SMS from <eventName>") to match what the server uses.
    eventName: s?.eventName?.trim() || DEFAULT_EVENT_NAME,
    // Lets the UI show "currently using OWNER_PHONE env var (legacy)" when
    // the admin hasn't entered a DB-managed number yet.
    ownerNotificationPhoneSource,
  };
}

// ── Test-send rate limiter ──────────────────────────────────────────────────
// Per-admin-token cooldown so a slip on the keyboard (or a bug in the UI)
// can't spam real SMS through the gateway. Keyed by the bearer token; falls
// back to the source IP when no token is present (shouldn't happen because
// the route is mounted under requireAdminAuth, but belt-and-suspenders).
const TEST_SEND_COOLDOWN_MS = 5_000;
const lastTestSendAt = new Map<string, number>();

function testSendKey(req: Request): string {
  const raw = req.headers.authorization;
  const auth = typeof raw === "string" ? raw : "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return token || req.ip || "unknown";
}

function checkTestSendRateLimit(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
  const now = Date.now();
  const prev = lastTestSendAt.get(key);
  if (prev != null && now - prev < TEST_SEND_COOLDOWN_MS) {
    return { ok: false, retryAfterMs: TEST_SEND_COOLDOWN_MS - (now - prev) };
  }
  lastTestSendAt.set(key, now);
  return { ok: true };
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get("/admin/sms-settings", async (req, res) => {
  try {
    const [settings] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
    res.json(buildResponse(settings));
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
      lowStockAlertPhones?: unknown;
      lowStockAlertThreshold?: unknown;
    };
    const updates: SmsSettingsUpdate = { updatedAt: new Date() };
    if (body.smsActivePorts !== undefined) {
      updates.smsActivePorts = normalizePortPool(body.smsActivePorts);
    }
    if (body.ownerNotificationPhone !== undefined) {
      updates.ownerNotificationPhone = normalizeOwnerPhone(body.ownerNotificationPhone);
    }
    if (body.lowStockAlertPhones !== undefined) {
      updates.lowStockAlertPhones = normalizeAlertPhones(body.lowStockAlertPhones);
    }
    if (body.lowStockAlertThreshold !== undefined) {
      updates.lowStockAlertThreshold = normalizeAlertThreshold(body.lowStockAlertThreshold);
    }

    const [existing] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
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
          lowStockAlertPhones: updates.lowStockAlertPhones ?? [],
          lowStockAlertThreshold: updates.lowStockAlertThreshold ?? null,
        })
        .returning();
      row = created;
    }

    // Port cache is short-lived but the admin expects "Save → next test uses
    // the new pool" to be instant. Invalidate explicitly.
    clearEjoinPortCache();

    res.json(buildResponse(row));
  } catch (err: unknown) {
    if (isHttpError(err)) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "Error updating SMS settings");
    res.status(500).json({ error: "Failed to update SMS settings" });
  }
});

// Direct test send to an arbitrary phone, optionally pinned to a specific
// port so admins can verify each SIM/port individually before adding it to
// the round-robin pool. Bypasses sendSms() so gateway errors surface in the
// HTTP response instead of being swallowed.
//
// Body shape: { to: string, message?: string, port?: number }.
//   - `port`, when provided, must be one of the currently-saved active
//     ports (we don't let admins poke arbitrary hardware ports from the
//     test endpoint).
//   - A short per-admin cooldown prevents accidental SMS spam.
router.post("/admin/sms-settings/test-send", async (req, res) => {
  try {
    const body = req.body as { to?: unknown; port?: unknown; message?: unknown };
    const to = typeof body.to === "string" ? body.to.trim() : "";
    if (!to || to.replace(/\D/g, "").length < 7) {
      res.status(400).json({ error: "to is required and must contain at least 7 digits" });
      return;
    }

    if (!isEjoinConfigured()) {
      res.status(503).json({ error: "SMS gateway is not configured." });
      return;
    }

    const [settings] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
    const activePorts = settings?.smsActivePorts ?? [7];

    let portOverride: number | undefined;
    if (body.port !== undefined && body.port !== null && body.port !== "") {
      const n = Number(body.port);
      if (!Number.isInteger(n) || n < 1 || n > EJOIN_PORT_COUNT) {
        res.status(400).json({ error: `port must be an integer between 1 and ${EJOIN_PORT_COUNT}` });
        return;
      }
      if (!activePorts.includes(n)) {
        res.status(400).json({
          error: `port ${n} is not in the saved active port pool (${activePorts.join(", ")}). Save it as active first or pick "Auto".`,
        });
        return;
      }
      portOverride = n;
    }

    const limit = checkTestSendRateLimit(testSendKey(req));
    if (!limit.ok) {
      res.status(429).json({
        error: `Slow down — wait ${Math.ceil(limit.retryAfterMs / 1000)}s before sending another test SMS.`,
        retryAfterMs: limit.retryAfterMs,
      });
      return;
    }

    const event = settings?.eventName?.trim() || DEFAULT_EVENT_NAME;
    const customMessage = typeof body.message === "string" ? body.message.trim() : "";
    const message = customMessage || `Test SMS from ${event}`;

    let result: { port: number; gatewayResponse: string };
    try {
      result = await sendSmsViaEjoin(to, message, portOverride != null ? { portOverride } : undefined);
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : "send failed";
      res.status(502).json({ error: `Failed to send test SMS: ${detail}` });
      return;
    }
    res.json({
      ok: true,
      sentTo: to,
      // The port that was actually used. When portOverride is unset this is
      // the next entry the round-robin counter picked from the saved pool.
      port: result.port,
      portSource: portOverride != null ? "override" : "round-robin",
      gatewayResponse: result.gatewayResponse,
    });
  } catch (err: unknown) {
    req.log.error({ err }, "Error sending test SMS");
    res.status(500).json({ error: "Failed to send test SMS" });
  }
});

// Re-issue the same low-stock alert that fires automatically when an item
// crosses the threshold, but to whatever recipients are currently saved.
// Mirrors the previous /admin/event-settings/test-low-stock-alert behavior.
router.post("/admin/sms-settings/test-low-stock-alert", async (req, res) => {
  try {
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

export default router;
