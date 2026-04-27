// Admin "Communications → SMS" backend.
// Owns every SMS-related setting that used to be scattered across the event
// settings page: the ejointech port pool (multi-port round-robin), the owner
// notification phone, and the kitchen low-stock recipient list. Also exposes
// three test endpoints (arbitrary phone, low-stock recipients, owner phone)
// so admins can verify delivery without burning through a real low-stock
// crossing.

import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { eventSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { isEjoinConfigured, sendSmsViaEjoin, clearEjoinPortCache } from "../lib/sms-ejoin";

const router: IRouter = Router();

// ── Validation helpers ────────────────────────────────────────────────────────

function normalizePortPool(v: unknown): number[] {
  if (!Array.isArray(v)) {
    throw Object.assign(new Error("smsActivePorts must be an array of port numbers"), { status: 400 });
  }
  if (v.length === 0) {
    throw Object.assign(new Error("smsActivePorts must include at least one port"), { status: 400 });
  }
  if (v.length > 32) {
    throw Object.assign(new Error("smsActivePorts cannot exceed 32 entries (gateway hardware limit)"), { status: 400 });
  }
  const out: number[] = [];
  const seen = new Set<number>();
  v.forEach((raw, idx) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 32) {
      throw Object.assign(new Error(`Port #${idx + 1} must be an integer between 1 and 32`), { status: 400 });
    }
    if (seen.has(n)) return; // dedupe silently — order preserved
    seen.add(n);
    out.push(n);
  });
  if (out.length === 0) {
    throw Object.assign(new Error("smsActivePorts must include at least one port"), { status: 400 });
  }
  return out;
}

function normalizeOwnerPhone(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") {
    throw Object.assign(new Error("ownerNotificationPhone must be a string"), { status: 400 });
  }
  const trimmed = v.trim();
  if (trimmed === "") return null;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7) {
    throw Object.assign(new Error("ownerNotificationPhone must contain at least 7 digits"), { status: 400 });
  }
  return trimmed.slice(0, 32);
}

function normalizeAlertPhones(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) {
    throw Object.assign(new Error("lowStockAlertPhones must be an array of phone numbers"), { status: 400 });
  }
  const out: string[] = [];
  const seen = new Set<string>();
  v.forEach((raw, idx) => {
    if (typeof raw !== "string") {
      throw Object.assign(new Error(`Recipient phone #${idx + 1} must be a string`), { status: 400 });
    }
    const trimmed = raw.trim();
    if (trimmed === "") return;
    const digits = trimmed.replace(/\D/g, "");
    if (digits.length < 7) {
      throw Object.assign(new Error(`Recipient phone #${idx + 1} must contain at least 7 digits`), { status: 400 });
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
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 1000) {
    throw Object.assign(new Error("lowStockAlertThreshold must be an integer between 1 and 1000"), { status: 400 });
  }
  return n;
}

// ── Response shape ────────────────────────────────────────────────────────────

function buildResponse(s: typeof eventSettingsTable.$inferSelect | undefined): {
  smsActivePorts: number[];
  ownerNotificationPhone: string | null;
  lowStockAlertPhones: string[];
  lowStockAlertThreshold: number | null;
  ejoinConfigured: boolean;
  ownerPhoneSource: "db" | "env" | "none";
} {
  const dbOwner = s?.ownerNotificationPhone?.trim() || null;
  const envOwner = process.env.OWNER_PHONE?.trim() || null;
  const ownerPhoneSource: "db" | "env" | "none" = dbOwner ? "db" : envOwner ? "env" : "none";
  return {
    smsActivePorts: s?.smsActivePorts ?? [7],
    ownerNotificationPhone: dbOwner,
    lowStockAlertPhones: s?.lowStockAlertPhones ?? [],
    lowStockAlertThreshold: s?.lowStockAlertThreshold ?? null,
    ejoinConfigured: isEjoinConfigured(),
    // Lets the UI show "currently using OWNER_PHONE env var (legacy)" when
    // the admin hasn't entered a DB-managed number yet.
    ownerPhoneSource,
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get("/admin/sms-settings", async (req, res) => {
  try {
    const [settings] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
    res.json(buildResponse(settings));
  } catch (err) {
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
    const updates: Record<string, any> = { updatedAt: new Date() };
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
  } catch (err: any) {
    if (err?.status === 400) {
      res.status(400).json({ error: err.message });
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
router.post("/admin/sms-settings/test-send", async (req, res) => {
  try {
    const body = req.body as { phone?: unknown; port?: unknown; message?: unknown };
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    if (!phone || phone.replace(/\D/g, "").length < 7) {
      res.status(400).json({ error: "phone is required and must contain at least 7 digits" });
      return;
    }
    let portOverride: number | undefined;
    if (body.port !== undefined && body.port !== null && body.port !== "") {
      const n = Number(body.port);
      if (!Number.isInteger(n) || n < 1 || n > 32) {
        res.status(400).json({ error: "port must be an integer between 1 and 32" });
        return;
      }
      portOverride = n;
    }
    if (!isEjoinConfigured()) {
      res.status(503).json({ error: "SMS gateway is not configured." });
      return;
    }
    const [settings] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
    const event = settings?.eventName?.trim() || "dash by Hollywood East Cafe";
    const customMessage = typeof body.message === "string" ? body.message.trim() : "";
    const message = customMessage || `Test SMS from ${event}`;
    let usedPort: number;
    try {
      usedPort = await sendSmsViaEjoin(phone, message, portOverride != null ? { portOverride } : undefined);
    } catch (err: any) {
      const detail = typeof err?.message === "string" ? err.message : "send failed";
      res.status(502).json({ error: `Failed to send test SMS: ${detail}` });
      return;
    }
    res.json({
      ok: true,
      sentTo: phone,
      // The port that was actually used. When portOverride is unset this is
      // the next entry the round-robin counter picked from the saved pool.
      port: usedPort,
      portSource: portOverride != null ? "override" : "round-robin",
    });
  } catch (err: any) {
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
    const event = settings?.eventName?.trim() || "dash by Hollywood East Cafe";
    const message = `Test alert from ${event}`;
    const results: Array<{ phone: string; ok: boolean; error?: string }> = [];
    for (const phone of phones) {
      try {
        await sendSmsViaEjoin(phone, message);
        results.push({ phone, ok: true });
      } catch (err: any) {
        const detail = typeof err?.message === "string" ? err.message : "send failed";
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
  } catch (err: any) {
    req.log.error({ err }, "Error sending test low-stock alert");
    const detail = typeof err?.message === "string" ? err.message : "Failed to send test alert";
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
    const event = settings?.eventName?.trim() || "dash by Hollywood East Cafe";
    const message = `Test owner alert from ${event}`;
    try {
      await sendSmsViaEjoin(ownerPhone, message);
    } catch (err: any) {
      const detail = typeof err?.message === "string" ? err.message : "send failed";
      res.status(502).json({ error: `Failed to send owner test alert: ${detail}` });
      return;
    }
    res.json({
      ok: true,
      sentTo: ownerPhone,
      source: dbPhone ? "db" : "env",
    });
  } catch (err: any) {
    req.log.error({ err }, "Error sending test owner alert");
    res.status(500).json({ error: "Failed to send test owner alert" });
  }
});

export default router;
