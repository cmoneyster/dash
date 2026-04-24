import { Router, type IRouter } from "express";
import multer from "multer";
import sharp from "sharp";
import { db } from "@workspace/db";
import { eventSettingsTable, eventOrdersTable } from "@workspace/db/schema";
import { eq, and, gte, lt, inArray } from "drizzle-orm";
import { ObjectStorageService } from "../lib/objectStorage";
import { isEjoinConfigured, sendSmsViaEjoin } from "../lib/sms-ejoin";

const router: IRouter = Router();

async function isTwilioConfigured(): Promise<boolean> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
    ? "depl " + process.env.WEB_REPL_RENEWAL
    : null;
  if (!hostname || !xReplitToken) return false;
  try {
    const data: any = await fetch(
      "https://" + hostname + "/api/v2/connection?include_secrets=true&connector_names=twilio",
      { headers: { Accept: "application/json", "X-Replit-Token": xReplitToken } }
    ).then(r => r.json()).then((d: any) => d.items?.[0]);
    return !!(data?.settings?.account_sid && data?.settings?.api_key);
  } catch {
    return false;
  }
}

router.get("/admin/event-settings", async (req, res) => {
  try {
    const [settings] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
    const twilioConfigured = await isTwilioConfigured();
    res.json({
      eventName: settings?.eventName ?? "",
      hasOrderPassword: !!(settings?.eventPassword),
      hasKitchenPassword: !!(settings?.kitchenPassword),
      hasEventTakerPassword: !!(settings?.eventTakerPassword),
      eventTakerTaxEnabled: settings?.eventTakerTaxEnabled ?? false,
      eventTakerTaxRate: settings?.eventTakerTaxRate != null ? parseFloat(settings.eventTakerTaxRate) : null,
      venmoHandle: settings?.venmoHandle ?? "",
      venmoQrImageUrl: settings?.venmoQrImageUrl ?? null,
      lowStockAlertPhones: settings?.lowStockAlertPhones ?? [],
      lowStockAlertThreshold: settings?.lowStockAlertThreshold ?? null,
      // ── On the Dash Experience pricing config ──
      // Numeric columns are returned as parsed numbers so the admin UI
      // can render them in plain inputs without re-parsing.
      otdSetupFee: settings?.otdSetupFee != null ? parseFloat(settings.otdSetupFee) : 500,
      otdFeeWaiverThreshold: settings?.otdFeeWaiverThreshold != null ? parseFloat(settings.otdFeeWaiverThreshold) : 2000,
      otdIncludedHours: settings?.otdIncludedHours != null ? parseFloat(settings.otdIncludedHours) : 2,
      otdAdditionalHourRate: settings?.otdAdditionalHourRate != null ? parseFloat(settings.otdAdditionalHourRate) : 100,
      otdMaxAdditionalHours: settings?.otdMaxAdditionalHours ?? 3,
      twilioConfigured,
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching event settings");
    res.status(500).json({ error: "Failed to fetch event settings" });
  }
});

router.put("/admin/event-settings", async (req, res) => {
  try {
    const {
      eventName, orderPassword, kitchenPassword,
      eventTakerPassword, eventTakerTaxEnabled, eventTakerTaxRate,
      venmoHandle, venmoQrImageUrl,
      lowStockAlertPhones, lowStockAlertThreshold,
      otdSetupFee, otdFeeWaiverThreshold, otdIncludedHours,
      otdAdditionalHourRate, otdMaxAdditionalHours,
    } = req.body as {
      eventName?: string;
      orderPassword?: string;
      kitchenPassword?: string;
      eventTakerPassword?: string;
      eventTakerTaxEnabled?: boolean;
      eventTakerTaxRate?: number | string | null;
      venmoHandle?: string | null;
      venmoQrImageUrl?: string | null;
      lowStockAlertPhones?: string[] | null;
      lowStockAlertThreshold?: number | string | null;
      otdSetupFee?: number | string | null;
      otdFeeWaiverThreshold?: number | string | null;
      otdIncludedHours?: number | string | null;
      otdAdditionalHourRate?: number | string | null;
      otdMaxAdditionalHours?: number | string | null;
    };
    const [existing] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
    const twilioConfigured = await isTwilioConfigured();

    const buildResponse = (s: typeof eventSettingsTable.$inferSelect) => ({
      eventName: s.eventName,
      hasOrderPassword: !!s.eventPassword,
      hasKitchenPassword: !!s.kitchenPassword,
      hasEventTakerPassword: !!s.eventTakerPassword,
      eventTakerTaxEnabled: s.eventTakerTaxEnabled,
      eventTakerTaxRate: s.eventTakerTaxRate != null ? parseFloat(s.eventTakerTaxRate) : null,
      venmoHandle: s.venmoHandle ?? "",
      venmoQrImageUrl: s.venmoQrImageUrl ?? null,
      lowStockAlertPhones: s.lowStockAlertPhones ?? [],
      lowStockAlertThreshold: s.lowStockAlertThreshold ?? null,
      otdSetupFee: s.otdSetupFee != null ? parseFloat(s.otdSetupFee) : 500,
      otdFeeWaiverThreshold: s.otdFeeWaiverThreshold != null ? parseFloat(s.otdFeeWaiverThreshold) : 2000,
      otdIncludedHours: s.otdIncludedHours != null ? parseFloat(s.otdIncludedHours) : 2,
      otdAdditionalHourRate: s.otdAdditionalHourRate != null ? parseFloat(s.otdAdditionalHourRate) : 100,
      otdMaxAdditionalHours: s.otdMaxAdditionalHours ?? 3,
      twilioConfigured,
    });

    // Recipient list validation: trim each entry, drop empties, dedupe
    // (case-insensitive on digits), and require >= 7 digits per number so the
    // SMS gateway doesn't silently drop garbage. Errors are recipient-indexed
    // so the admin UI can highlight the offending row.
    function normalizeAlertPhones(v: string[] | null | undefined): string[] {
      if (v == null) return [];
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
        if (trimmed === "") return; // silently skip blank rows
        const digits = trimmed.replace(/\D/g, "");
        if (digits.length < 7) {
          throw Object.assign(new Error(`Recipient phone #${idx + 1} must contain at least 7 digits`), { status: 400 });
        }
        if (seen.has(digits)) return; // silently dedupe
        seen.add(digits);
        out.push(trimmed.slice(0, 32));
      });
      return out;
    }
    function normalizeAlertThreshold(v: number | string | null | undefined): number | null {
      if (v === null || v === undefined || v === "") return null;
      const n = Number(v);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 1000) {
        throw Object.assign(new Error("lowStockAlertThreshold must be an integer between 1 and 1000"), { status: 400 });
      }
      return n;
    }
    // OTD numeric helpers — money/hour values stored as numeric strings.
    // We accept anything coerceable to a finite non-negative number with at
    // most two decimals (money) or one decimal (hours). Out-of-range values
    // throw a 400 so admins see the offending field instead of silently
    // saving NaN or zero.
    function normalizeOtdMoney(v: number | string | null | undefined, field: string, max: number): string {
      if (v === null || v === undefined || v === "") {
        throw Object.assign(new Error(`${field} is required`), { status: 400 });
      }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > max) {
        throw Object.assign(new Error(`${field} must be a number between 0 and ${max}`), { status: 400 });
      }
      return n.toFixed(2);
    }
    function normalizeOtdHours(v: number | string | null | undefined, field: string): string {
      if (v === null || v === undefined || v === "") {
        throw Object.assign(new Error(`${field} is required`), { status: 400 });
      }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 24) {
        throw Object.assign(new Error(`${field} must be between 0 and 24 hours`), { status: 400 });
      }
      return n.toFixed(2);
    }
    function normalizeOtdMaxAdditionalHours(v: number | string | null | undefined): number {
      if (v === null || v === undefined || v === "") return 3;
      const n = Number(v);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 24) {
        throw Object.assign(new Error("otdMaxAdditionalHours must be an integer between 0 and 24"), { status: 400 });
      }
      return n;
    }

    if (existing) {
      const updates: Record<string, any> = { updatedAt: new Date() };
      if (eventName !== undefined) updates.eventName = eventName.trim();
      // Guest event password is required (notNull); only update when a non-empty value is supplied.
      // Null or empty string is treated as "no change" rather than clearing.
      if (orderPassword !== undefined && orderPassword !== null && orderPassword !== "") {
        updates.eventPassword = orderPassword;
      }
      if (kitchenPassword !== undefined) {
        updates.kitchenPassword = kitchenPassword == null ? null : (kitchenPassword.trim() || null);
      }
      if (eventTakerPassword !== undefined) {
        updates.eventTakerPassword = eventTakerPassword == null ? null : (eventTakerPassword.trim() || null);
      }
      if (eventTakerTaxEnabled !== undefined) updates.eventTakerTaxEnabled = !!eventTakerTaxEnabled;
      if (eventTakerTaxRate !== undefined) {
        updates.eventTakerTaxRate = (eventTakerTaxRate === null || eventTakerTaxRate === "" || Number.isNaN(Number(eventTakerTaxRate)))
          ? null
          : String(Number(eventTakerTaxRate));
      }
      if (venmoHandle !== undefined) {
        updates.venmoHandle = venmoHandle == null
          ? null
          : (venmoHandle.trim().replace(/^@/, "") || null);
      }
      if (venmoQrImageUrl !== undefined) {
        updates.venmoQrImageUrl = venmoQrImageUrl == null || venmoQrImageUrl === ""
          ? null
          : venmoQrImageUrl;
      }
      if (lowStockAlertPhones !== undefined) {
        updates.lowStockAlertPhones = normalizeAlertPhones(lowStockAlertPhones);
      }
      if (lowStockAlertThreshold !== undefined) {
        updates.lowStockAlertThreshold = normalizeAlertThreshold(lowStockAlertThreshold);
      }
      // OTD pricing config — only validate/update fields that were sent so
      // partial PUTs from older clients still work.
      if (otdSetupFee !== undefined) {
        updates.otdSetupFee = normalizeOtdMoney(otdSetupFee, "otdSetupFee", 100000);
      }
      if (otdFeeWaiverThreshold !== undefined) {
        updates.otdFeeWaiverThreshold = normalizeOtdMoney(otdFeeWaiverThreshold, "otdFeeWaiverThreshold", 1000000);
      }
      if (otdIncludedHours !== undefined) {
        updates.otdIncludedHours = normalizeOtdHours(otdIncludedHours, "otdIncludedHours");
      }
      if (otdAdditionalHourRate !== undefined) {
        updates.otdAdditionalHourRate = normalizeOtdMoney(otdAdditionalHourRate, "otdAdditionalHourRate", 100000);
      }
      if (otdMaxAdditionalHours !== undefined) {
        updates.otdMaxAdditionalHours = normalizeOtdMaxAdditionalHours(otdMaxAdditionalHours);
      }
      const [updated] = await db.update(eventSettingsTable).set(updates).where(eq(eventSettingsTable.id, 1)).returning();
      res.json(buildResponse(updated));
    } else {
      const [created] = await db.insert(eventSettingsTable).values({
        id: 1,
        eventName: eventName?.trim() ?? "",
        eventPassword: orderPassword ?? process.env.EVENT_PASSWORD ?? "",
        kitchenPassword: kitchenPassword?.trim() || null,
        eventTakerPassword: eventTakerPassword?.trim() || null,
        eventTakerTaxEnabled: !!eventTakerTaxEnabled,
        eventTakerTaxRate: (eventTakerTaxRate === undefined || eventTakerTaxRate === null || eventTakerTaxRate === "") ? null : String(Number(eventTakerTaxRate)),
        venmoHandle: venmoHandle == null ? null : (venmoHandle.trim().replace(/^@/, "") || null),
        venmoQrImageUrl: venmoQrImageUrl == null || venmoQrImageUrl === "" ? null : venmoQrImageUrl,
        lowStockAlertPhones: normalizeAlertPhones(lowStockAlertPhones),
        lowStockAlertThreshold: normalizeAlertThreshold(lowStockAlertThreshold),
        otdSetupFee: otdSetupFee !== undefined ? normalizeOtdMoney(otdSetupFee, "otdSetupFee", 100000) : "500.00",
        otdFeeWaiverThreshold: otdFeeWaiverThreshold !== undefined ? normalizeOtdMoney(otdFeeWaiverThreshold, "otdFeeWaiverThreshold", 1000000) : "2000.00",
        otdIncludedHours: otdIncludedHours !== undefined ? normalizeOtdHours(otdIncludedHours, "otdIncludedHours") : "2.00",
        otdAdditionalHourRate: otdAdditionalHourRate !== undefined ? normalizeOtdMoney(otdAdditionalHourRate, "otdAdditionalHourRate", 100000) : "100.00",
        otdMaxAdditionalHours: otdMaxAdditionalHours !== undefined ? normalizeOtdMaxAdditionalHours(otdMaxAdditionalHours) : 3,
      }).returning();
      res.json(buildResponse(created));
    }
  } catch (err: any) {
    if (err?.status === 400) {
      res.status(400).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "Error updating event settings");
    res.status(500).json({ error: "Failed to update event settings" });
  }
});

// Sends a one-line "Test alert from <event name>" SMS to every saved
// kitchen recipient so the admin can verify delivery before crossing the
// real threshold. Uses sendSmsViaEjoin directly (not sendSms) so gateway
// failures surface in the response instead of being swallowed. Sends to
// all recipients sequentially and reports per-recipient outcomes; the
// HTTP status reflects whether at least one delivery succeeded.
router.post("/admin/event-settings/test-low-stock-alert", async (req, res) => {
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
      res.status(502).json({ error: `Failed to send test alert to ${results[0].phone}: ${results[0].error}`, results });
      return;
    }
    res.json({ ok: true, sentCount: okCount, totalCount: results.length, results });
  } catch (err: any) {
    req.log.error({ err }, "Error sending test low-stock alert");
    const detail = typeof err?.message === "string" ? err.message : "Failed to send test alert";
    res.status(502).json({ error: `Failed to send test alert: ${detail}` });
  }
});

// ── Sales Reports ───────────────────────────────────────────────────────────
// Aggregates over event_orders rows in a date range with optional source filter.

function parseDate(v: unknown, fallback: Date): Date {
  if (typeof v !== "string" || !v) return fallback;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

type SnapshotItem = {
  itemId: number;
  name: string;
  quantity: number;
  price: number;
  unitPrice?: number;
  lineTotal?: number;
};

// Bucket an order by its payment method for the cash-drawer reconcile view.
// 'override' is a payment status (sent to kitchen unpaid), not a method, but
// the owner still wants it broken out alongside cash/card/venmo. 'other'
// catches anything that doesn't fit (mostly guest orders that never went
// through the POS payment flow).
type PaymentBucket = "cash" | "card" | "venmo" | "override" | "other";
function paymentBucket(o: typeof eventOrdersTable.$inferSelect): PaymentBucket {
  if (o.paymentStatus === "override") return "override";
  const m = o.paymentMethod;
  if (m === "cash" || m === "card" || m === "venmo") return m;
  return "other";
}

function buildReport(orders: typeof eventOrdersTable.$inferSelect[]) {
  let revenue = 0;
  let subtotal = 0;
  let tax = 0;
  let itemCount = 0;
  const itemBreakdown: Record<string, { name: string; quantity: number; revenue: number }> = {};
  const paymentBuckets: Record<PaymentBucket, { orderCount: number; revenue: number }> = {
    cash: { orderCount: 0, revenue: 0 },
    card: { orderCount: 0, revenue: 0 },
    venmo: { orderCount: 0, revenue: 0 },
    override: { orderCount: 0, revenue: 0 },
    other: { orderCount: 0, revenue: 0 },
  };
  const orderRows: Array<{
    id: number;
    createdAt: string;
    source: string;
    guestName: string;
    phoneNumber: string | null;
    status: string;
    paymentMethod: PaymentBucket;
    items: Array<{ itemId: number; name: string; quantity: number; unitPrice: number; lineTotal: number }>;
    subtotal: number;
    taxRate: number | null;
    tax: number;
    total: number;
    readyAt: string | null;
    pickedUpAt: string | null;
    timeToReadySec: number | null;
    timeReadyToPickupSec: number | null;
    timeToPickupSec: number | null;
  }> = [];
  // Collect per-order durations (seconds) for averaging across the report.
  const prepDurations: number[] = [];
  const readyToPickupDurations: number[] = [];
  const pickupDurations: number[] = [];

  for (const o of orders) {
    const items = (o.items ?? []) as SnapshotItem[];
    const lineSnapshots = items.map(i => {
      const unit = i.unitPrice != null ? Number(i.unitPrice) : Number(i.price) || 0;
      const line = i.lineTotal != null ? Number(i.lineTotal) : round2(unit * i.quantity);
      return { itemId: i.itemId, name: i.name, quantity: i.quantity, unitPrice: unit, lineTotal: line };
    });
    const computedSubtotal = lineSnapshots.reduce((s, i) => s + i.lineTotal, 0);
    const orderSubtotal = o.subtotal != null ? parseFloat(o.subtotal) : computedSubtotal;
    const orderTax = o.taxAmount != null ? parseFloat(o.taxAmount) : 0;
    const orderTotal = o.total != null ? parseFloat(o.total) : orderSubtotal + orderTax;
    revenue += orderTotal;
    subtotal += orderSubtotal;
    tax += orderTax;
    const bucket = paymentBucket(o);
    paymentBuckets[bucket].orderCount += 1;
    paymentBuckets[bucket].revenue += orderTotal;
    for (const i of lineSnapshots) {
      itemCount += i.quantity;
      const key = `${i.itemId}::${i.name}`;
      if (!itemBreakdown[key]) itemBreakdown[key] = { name: i.name, quantity: 0, revenue: 0 };
      itemBreakdown[key].quantity += i.quantity;
      itemBreakdown[key].revenue += i.lineTotal;
    }
    const timeToReadySec = o.readyAt
      ? Math.max(0, Math.round((o.readyAt.getTime() - o.createdAt.getTime()) / 1000))
      : null;
    const timeReadyToPickupSec = o.readyAt && o.pickedUpAt
      ? Math.max(0, Math.round((o.pickedUpAt.getTime() - o.readyAt.getTime()) / 1000))
      : null;
    const timeToPickupSec = o.pickedUpAt
      ? Math.max(0, Math.round((o.pickedUpAt.getTime() - o.createdAt.getTime()) / 1000))
      : null;
    if (timeToReadySec != null) prepDurations.push(timeToReadySec);
    if (timeReadyToPickupSec != null) readyToPickupDurations.push(timeReadyToPickupSec);
    if (timeToPickupSec != null) pickupDurations.push(timeToPickupSec);
    orderRows.push({
      id: o.id,
      createdAt: o.createdAt.toISOString(),
      source: o.orderSource ?? "guest",
      guestName: o.guestName,
      phoneNumber: o.phoneNumber ?? null,
      status: o.status,
      paymentMethod: bucket,
      items: lineSnapshots,
      subtotal: round2(orderSubtotal),
      taxRate: o.taxRate != null ? parseFloat(o.taxRate) : null,
      tax: round2(orderTax),
      total: round2(orderTotal),
      readyAt: o.readyAt ? o.readyAt.toISOString() : null,
      pickedUpAt: o.pickedUpAt ? o.pickedUpAt.toISOString() : null,
      timeToReadySec,
      timeReadyToPickupSec,
      timeToPickupSec,
    });
  }

  // Service-time aggregates. Prep = placed → ready (kitchen flow).
  // Ready→Pickup = ready → picked up (counter wait). Pickup = full placed → picked up.
  function aggregate(durations: number[]) {
    if (durations.length === 0) return { count: 0, avgSec: null as number | null, medianSec: null as number | null };
    const sorted = [...durations].sort((a, b) => a - b);
    const avgSec = Math.round(sorted.reduce((s, n) => s + n, 0) / sorted.length);
    const mid = Math.floor(sorted.length / 2);
    const medianSec = sorted.length % 2
      ? sorted[mid]
      : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
    return { count: sorted.length, avgSec, medianSec };
  }
  const prepAgg = aggregate(prepDurations);
  const readyToPickupAgg = aggregate(readyToPickupDurations);
  const pickupAgg = aggregate(pickupDurations);

  return {
    orderCount: orders.length,
    itemCount,
    subtotal: round2(subtotal),
    tax: round2(tax),
    revenue: round2(revenue),
    avgOrderValue: orders.length ? round2(revenue / orders.length) : 0,
    pickupStats: {
      pickedUpCount: pickupAgg.count,
      avgPickupSec: pickupAgg.avgSec,
      medianPickupSec: pickupAgg.medianSec,
      prepCount: prepAgg.count,
      avgPrepSec: prepAgg.avgSec,
      medianPrepSec: prepAgg.medianSec,
      readyToPickupCount: readyToPickupAgg.count,
      avgReadyToPickupSec: readyToPickupAgg.avgSec,
      medianReadyToPickupSec: readyToPickupAgg.medianSec,
    },
    items: Object.values(itemBreakdown)
      .map(i => ({ ...i, revenue: round2(i.revenue) }))
      .sort((a, b) => b.revenue - a.revenue),
    orders: orderRows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    byPaymentMethod: (Object.entries(paymentBuckets) as Array<[PaymentBucket, { orderCount: number; revenue: number }]>)
      .map(([method, t]) => ({ method, orderCount: t.orderCount, revenue: round2(t.revenue) })),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

router.get("/admin/sales-reports", async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const monthAgo = new Date(today);
    monthAgo.setDate(monthAgo.getDate() - 30);

    const from = parseDate(req.query.from, monthAgo);
    const to = parseDate(req.query.to, new Date());
    const source = typeof req.query.source === "string" ? req.query.source : "all"; // 'guest' | 'staff' | 'all'
    const rawStatus = typeof req.query.status === "string" ? req.query.status : "all";
    const statusFilter = rawStatus === "completed" ? "completed" : "all"; // whitelist

    // Inclusive date range — bump `to` to next-day midnight
    const fromStart = new Date(from); fromStart.setHours(0, 0, 0, 0);
    const toEnd = new Date(to); toEnd.setHours(0, 0, 0, 0); toEnd.setDate(toEnd.getDate() + 1);

    const conditions = [
      gte(eventOrdersTable.createdAt, fromStart),
      lt(eventOrdersTable.createdAt, toEnd),
    ];
    if (source === "guest" || source === "staff") {
      conditions.push(eq(eventOrdersTable.orderSource, source));
    }
    if (statusFilter === "completed") {
      conditions.push(inArray(eventOrdersTable.status, ["done", "picked_up"]));
    }
    const orders = await db.select().from(eventOrdersTable).where(and(...conditions));

    const guestOrders = orders.filter(o => o.orderSource === "guest");
    const staffOrders = orders.filter(o => o.orderSource === "staff");

    res.json({
      from: fromStart.toISOString(),
      to: toEnd.toISOString(),
      source,
      status: statusFilter,
      totals: buildReport(orders),
      bySource: {
        guest: buildReport(guestOrders),
        staff: buildReport(staffOrders),
      },
    });
  } catch (err) {
    req.log.error({ err }, "Error generating sales report");
    res.status(500).json({ error: "Failed to generate sales report" });
  }
});

router.get("/admin/sales-reports.csv", async (req, res) => {
  try {
    const today = new Date();
    const monthAgo = new Date(today);
    monthAgo.setDate(monthAgo.getDate() - 30);

    const from = parseDate(req.query.from, monthAgo);
    const to = parseDate(req.query.to, new Date());
    const source = typeof req.query.source === "string" ? req.query.source : "all";
    const rawStatus = typeof req.query.status === "string" ? req.query.status : "all";
    const statusFilter = rawStatus === "completed" ? "completed" : "all";
    const type = (typeof req.query.type === "string" ? req.query.type : "orders") as "orders" | "items";

    const fromStart = new Date(from); fromStart.setHours(0, 0, 0, 0);
    const toEnd = new Date(to); toEnd.setHours(0, 0, 0, 0); toEnd.setDate(toEnd.getDate() + 1);

    const conditions = [
      gte(eventOrdersTable.createdAt, fromStart),
      lt(eventOrdersTable.createdAt, toEnd),
    ];
    if (source === "guest" || source === "staff") {
      conditions.push(eq(eventOrdersTable.orderSource, source));
    }
    if (statusFilter === "completed") {
      conditions.push(inArray(eventOrdersTable.status, ["done", "picked_up"]));
    }
    const orders = await db.select().from(eventOrdersTable).where(and(...conditions));

    const escape = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const rows: string[] = [];
    const filenameBase = `sales-report_${type}_${fromStart.toISOString().slice(0, 10)}_to_${toEnd.toISOString().slice(0, 10)}`;

    if (type === "items") {
      // Aggregated per-item CSV — one row per item across all orders in range
      const agg = new Map<string, { quantity: number; revenue: number }>();
      for (const o of orders) {
        const items = (o.items ?? []) as SnapshotItem[];
        for (const i of items) {
          const unit = i.unitPrice != null ? Number(i.unitPrice) : Number(i.price) || 0;
          const line = i.lineTotal != null ? Number(i.lineTotal) : round2(unit * i.quantity);
          const cur = agg.get(i.name) ?? { quantity: 0, revenue: 0 };
          cur.quantity += i.quantity;
          cur.revenue += line;
          agg.set(i.name, cur);
        }
      }
      rows.push(["Item", "Quantity Sold", "Revenue"].join(","));
      for (const [name, totals] of [...agg.entries()].sort((a, b) => b[1].quantity - a[1].quantity)) {
        rows.push([name, totals.quantity, totals.revenue.toFixed(2)].map(escape).join(","));
      }
    } else {
      // Order-level CSV — one row per order
      rows.push(["Order ID", "Created", "Source", "Guest Name", "Phone", "Status", "payment_method", "Items", "Subtotal", "Tax Rate (%)", "Tax", "Total", "Ready At", "Picked Up At", "Time to Ready (min)", "Ready to Pickup (min)", "Time to Pickup (min)"].join(","));
      for (const o of orders) {
        const items = (o.items ?? []) as SnapshotItem[];
        const itemsStr = items.map(i => `${i.quantity}× ${i.name}`).join("; ");
        const subtotal = o.subtotal != null ? parseFloat(o.subtotal) : items.reduce((s, i) => {
          const unit = i.unitPrice != null ? Number(i.unitPrice) : Number(i.price) || 0;
          return s + unit * i.quantity;
        }, 0);
        const total = o.total != null ? parseFloat(o.total) : subtotal;
        const prepMin = o.readyAt
          ? (Math.max(0, o.readyAt.getTime() - o.createdAt.getTime()) / 60000).toFixed(1)
          : "";
        const readyToPickupMin = o.readyAt && o.pickedUpAt
          ? (Math.max(0, o.pickedUpAt.getTime() - o.readyAt.getTime()) / 60000).toFixed(1)
          : "";
        const pickupMin = o.pickedUpAt
          ? (Math.max(0, o.pickedUpAt.getTime() - o.createdAt.getTime()) / 60000).toFixed(1)
          : "";
        rows.push([
          o.id,
          o.createdAt.toISOString(),
          o.orderSource,
          o.guestName,
          o.phoneNumber ?? "",
          o.status,
          paymentBucket(o),
          itemsStr,
          subtotal.toFixed(2),
          o.taxRate != null ? parseFloat(o.taxRate).toFixed(2) : "",
          o.taxAmount != null ? parseFloat(o.taxAmount).toFixed(2) : "0.00",
          total.toFixed(2),
          o.readyAt ? o.readyAt.toISOString() : "",
          o.pickedUpAt ? o.pickedUpAt.toISOString() : "",
          prepMin,
          readyToPickupMin,
          pickupMin,
        ].map(escape).join(","));
      }
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filenameBase}.csv"`);
    res.send(rows.join("\n"));
  } catch (err) {
    req.log.error({ err }, "Error generating sales report CSV");
    res.status(500).json({ error: "Failed to generate sales report CSV" });
  }
});

// ── Venmo QR upload ────────────────────────────────────────────────────
// Accepts a single image, normalizes it to a square JPEG, uploads it to
// object storage and returns the public serving URL. The caller is then
// expected to PUT /admin/event-settings with `venmoQrImageUrl` to persist it.
const venmoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
});

const venmoObjectStorage = new ObjectStorageService();

router.post("/admin/event-settings/venmo-qr", venmoUpload.single("image"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No image file provided" });
    return;
  }
  try {
    const processed = await sharp(req.file.buffer)
      .resize(600, 600, { fit: "cover", position: "centre" })
      .jpeg({ quality: 92, progressive: true })
      .toBuffer();

    const uploadUrl = await venmoObjectStorage.getObjectEntityUploadURL();
    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      body: processed,
    });
    if (!uploadRes.ok) throw new Error(`GCS upload failed: ${uploadRes.status}`);

    const objectPath = venmoObjectStorage.normalizeObjectEntityPath(uploadUrl);
    const servingUrl = `/api/storage${objectPath}`;
    res.status(201).json({ url: servingUrl });
  } catch (err) {
    req.log.error({ err }, "Error uploading Venmo QR");
    res.status(500).json({ error: "Failed to upload Venmo QR" });
  }
});

export default router;
