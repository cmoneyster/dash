import { Router, type IRouter } from "express";
import multer from "multer";
import sharp from "sharp";
import { db } from "@workspace/db";
import { eventSettingsTable, eventOrdersTable, cateringInquiriesTable } from "@workspace/db/schema";
import { eq, and, gte, lt, inArray, sql } from "drizzle-orm";
import { ObjectStorageService } from "../lib/objectStorage";
import { isEjoinConfigured } from "../lib/sms-ejoin";
import { getSquareConfig, listTerminalDevices, SquareApiError } from "../lib/square";

const router: IRouter = Router();

router.get("/admin/event-settings", async (req, res) => {
  try {
    const [settings] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
    res.json({
      eventName: settings?.eventName ?? "",
      hasOrderPassword: !!(settings?.eventPassword),
      hasKitchenPassword: !!(settings?.kitchenPassword),
      hasEventTakerPassword: !!(settings?.eventTakerPassword),
      eventTakerTaxEnabled: settings?.eventTakerTaxEnabled ?? false,
      eventTakerTaxRate: settings?.eventTakerTaxRate != null ? parseFloat(settings.eventTakerTaxRate) : null,
      cateringTaxEnabled: settings?.cateringTaxEnabled ?? false,
      cateringTaxRate: settings?.cateringTaxRate != null ? parseFloat(settings.cateringTaxRate) : null,
      venmoHandle: settings?.venmoHandle ?? "",
      venmoQrImageUrl: settings?.venmoQrImageUrl ?? null,
      squareTerminalDeviceId: settings?.squareTerminalDeviceId ?? null,
      guestNotesEnabled: settings?.guestNotesEnabled ?? false,
      staffNotesEnabled: settings?.staffNotesEnabled ?? false,
      // Replaces the legacy `twilioConfigured` flag — used by the admin
      // shell to badge SMS-related links when the gateway is unreachable.
      ejoinConfigured: isEjoinConfigured(),
      // ── On the Dash Experience pricing config ──
      // Numeric columns are returned as parsed numbers so the admin UI
      // can render them in plain inputs without re-parsing.
      otdSetupFee: settings?.otdSetupFee != null ? parseFloat(settings.otdSetupFee) : 500,
      otdFeeWaiverThreshold: settings?.otdFeeWaiverThreshold != null ? parseFloat(settings.otdFeeWaiverThreshold) : 2000,
      otdIncludedHours: settings?.otdIncludedHours != null ? parseFloat(settings.otdIncludedHours) : 2,
      otdAdditionalHourRate: settings?.otdAdditionalHourRate != null ? parseFloat(settings.otdAdditionalHourRate) : 100,
      otdMaxAdditionalHours: settings?.otdMaxAdditionalHours ?? 3,
      // ── Daily booking capacity (Option B: per-style slots) ──
      // NULL on any field is the wire-level "unlimited" signal — admin
      // UI surfaces blank inputs for those, server treats them as no
      // cap when computing day load.
      dailyGuestCap: settings?.dailyGuestCap ?? null,
      dailyDropOffSlots: settings?.dailyDropOffSlots ?? null,
      dailyOnTheDashSlots: settings?.dailyOnTheDashSlots ?? null,
      dailyBuffetSlots: settings?.dailyBuffetSlots ?? null,
      dailyGrazingSlots: settings?.dailyGrazingSlots ?? null,
      dailyMadeToOrderSlots: settings?.dailyMadeToOrderSlots ?? null,
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
      cateringTaxEnabled, cateringTaxRate,
      venmoHandle, venmoQrImageUrl, squareTerminalDeviceId,
      guestNotesEnabled, staffNotesEnabled,
      otdSetupFee, otdFeeWaiverThreshold, otdIncludedHours,
      otdAdditionalHourRate, otdMaxAdditionalHours,
      dailyGuestCap, dailyDropOffSlots, dailyOnTheDashSlots,
      dailyBuffetSlots, dailyGrazingSlots, dailyMadeToOrderSlots,
    } = req.body as {
      eventName?: string;
      orderPassword?: string;
      kitchenPassword?: string;
      eventTakerPassword?: string;
      eventTakerTaxEnabled?: boolean;
      eventTakerTaxRate?: number | string | null;
      cateringTaxEnabled?: boolean;
      cateringTaxRate?: number | string | null;
      venmoHandle?: string | null;
      venmoQrImageUrl?: string | null;
      squareTerminalDeviceId?: string | null;
      guestNotesEnabled?: boolean;
      staffNotesEnabled?: boolean;
      otdSetupFee?: number | string | null;
      otdFeeWaiverThreshold?: number | string | null;
      otdIncludedHours?: number | string | null;
      otdAdditionalHourRate?: number | string | null;
      otdMaxAdditionalHours?: number | string | null;
      dailyGuestCap?: number | string | null;
      dailyDropOffSlots?: number | string | null;
      dailyOnTheDashSlots?: number | string | null;
      dailyBuffetSlots?: number | string | null;
      dailyGrazingSlots?: number | string | null;
      dailyMadeToOrderSlots?: number | string | null;
    };
    const [existing] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));

    const buildResponse = (s: typeof eventSettingsTable.$inferSelect) => ({
      eventName: s.eventName,
      hasOrderPassword: !!s.eventPassword,
      hasKitchenPassword: !!s.kitchenPassword,
      hasEventTakerPassword: !!s.eventTakerPassword,
      eventTakerTaxEnabled: s.eventTakerTaxEnabled,
      eventTakerTaxRate: s.eventTakerTaxRate != null ? parseFloat(s.eventTakerTaxRate) : null,
      cateringTaxEnabled: s.cateringTaxEnabled,
      cateringTaxRate: s.cateringTaxRate != null ? parseFloat(s.cateringTaxRate) : null,
      venmoHandle: s.venmoHandle ?? "",
      venmoQrImageUrl: s.venmoQrImageUrl ?? null,
      squareTerminalDeviceId: s.squareTerminalDeviceId ?? null,
      guestNotesEnabled: s.guestNotesEnabled ?? false,
      staffNotesEnabled: s.staffNotesEnabled ?? false,
      ejoinConfigured: isEjoinConfigured(),
      otdSetupFee: s.otdSetupFee != null ? parseFloat(s.otdSetupFee) : 500,
      otdFeeWaiverThreshold: s.otdFeeWaiverThreshold != null ? parseFloat(s.otdFeeWaiverThreshold) : 2000,
      otdIncludedHours: s.otdIncludedHours != null ? parseFloat(s.otdIncludedHours) : 2,
      otdAdditionalHourRate: s.otdAdditionalHourRate != null ? parseFloat(s.otdAdditionalHourRate) : 100,
      otdMaxAdditionalHours: s.otdMaxAdditionalHours ?? 3,
      dailyGuestCap: s.dailyGuestCap ?? null,
      dailyDropOffSlots: s.dailyDropOffSlots ?? null,
      dailyOnTheDashSlots: s.dailyOnTheDashSlots ?? null,
      dailyBuffetSlots: s.dailyBuffetSlots ?? null,
      dailyGrazingSlots: s.dailyGrazingSlots ?? null,
      dailyMadeToOrderSlots: s.dailyMadeToOrderSlots ?? null,
    });

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
    // Capacity helper — null/empty/undefined are all treated as
    // "unlimited" and stored as NULL. Anything else must coerce to a
    // non-negative integer between 0 and 1000 (enough headroom for any
    // realistic per-day cap; rejects bad UI input early).
    function normalizeCap(v: number | string | null | undefined, field: string): number | null {
      if (v === null || v === undefined || v === "") return null;
      const n = Number(v);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 1000) {
        throw Object.assign(
          new Error(`${field} must be a whole number between 0 and 1000, or blank for unlimited`),
          { status: 400 },
        );
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
      if (cateringTaxEnabled !== undefined) updates.cateringTaxEnabled = !!cateringTaxEnabled;
      if (cateringTaxRate !== undefined) {
        updates.cateringTaxRate = (cateringTaxRate === null || cateringTaxRate === "" || Number.isNaN(Number(cateringTaxRate)))
          ? null
          : String(Number(cateringTaxRate));
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
      if (squareTerminalDeviceId !== undefined) {
        updates.squareTerminalDeviceId = squareTerminalDeviceId == null || squareTerminalDeviceId === ""
          ? null
          : squareTerminalDeviceId.trim();
      }
      if (guestNotesEnabled !== undefined) updates.guestNotesEnabled = !!guestNotesEnabled;
      if (staffNotesEnabled !== undefined) updates.staffNotesEnabled = !!staffNotesEnabled;
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
      if (dailyGuestCap !== undefined) updates.dailyGuestCap = normalizeCap(dailyGuestCap, "dailyGuestCap");
      if (dailyDropOffSlots !== undefined) updates.dailyDropOffSlots = normalizeCap(dailyDropOffSlots, "dailyDropOffSlots");
      if (dailyOnTheDashSlots !== undefined) updates.dailyOnTheDashSlots = normalizeCap(dailyOnTheDashSlots, "dailyOnTheDashSlots");
      if (dailyBuffetSlots !== undefined) updates.dailyBuffetSlots = normalizeCap(dailyBuffetSlots, "dailyBuffetSlots");
      if (dailyGrazingSlots !== undefined) updates.dailyGrazingSlots = normalizeCap(dailyGrazingSlots, "dailyGrazingSlots");
      if (dailyMadeToOrderSlots !== undefined) updates.dailyMadeToOrderSlots = normalizeCap(dailyMadeToOrderSlots, "dailyMadeToOrderSlots");
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
        cateringTaxEnabled: !!cateringTaxEnabled,
        cateringTaxRate: (cateringTaxRate === undefined || cateringTaxRate === null || cateringTaxRate === "") ? null : String(Number(cateringTaxRate)),
        venmoHandle: venmoHandle == null ? null : (venmoHandle.trim().replace(/^@/, "") || null),
        venmoQrImageUrl: venmoQrImageUrl == null || venmoQrImageUrl === "" ? null : venmoQrImageUrl,
        squareTerminalDeviceId: squareTerminalDeviceId == null || squareTerminalDeviceId === "" ? null : squareTerminalDeviceId.trim(),
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
    type: "event";
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
    // True for soft-voided rows. Voids are listed in the orders array so
    // admins can see them in chronological context, but they are excluded
    // from every aggregate (revenue, items, payment buckets, time stats).
    voided: boolean;
    voidedAt: string | null;
    voidedBy: string | null;
    voidReason: string | null;
    refundRequired: boolean;
  }> = [];
  // Collect per-order durations (seconds) for averaging across the report.
  const prepDurations: number[] = [];
  const readyToPickupDurations: number[] = [];
  const pickupDurations: number[] = [];

  // Track non-voided orders separately for the orderCount / avgOrderValue
  // numbers — voided rows are listed for context but never count toward
  // revenue, items, or service-time aggregates.
  let activeOrderCount = 0;
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
    const bucket = paymentBucket(o);
    const isVoided = o.voidedAt != null;
    if (!isVoided) {
      activeOrderCount += 1;
      revenue += orderTotal;
      subtotal += orderSubtotal;
      tax += orderTax;
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
        type: "event" as const,
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
        voided: false,
        voidedAt: null,
        voidedBy: null,
        voidReason: null,
        refundRequired: false,
      });
    } else {
      // Voided: include in the orders array so the UI can render it dimmed
      // in chronological context, but skip every aggregate above.
      orderRows.push({
        type: "event" as const,
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
        timeToReadySec: null,
        timeReadyToPickupSec: null,
        timeToPickupSec: null,
        voided: true,
        voidedAt: o.voidedAt ? o.voidedAt.toISOString() : null,
        voidedBy: o.voidedBy ?? null,
        voidReason: o.voidReason ?? null,
        refundRequired: !!o.refundRequired,
      });
    }
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

  // Voids summary — separate from `totals` so the UI can show count and
  // dollar amount voided without re-walking the orders array. Excluded
  // from every aggregate above by design.
  const voidedRows = orders
    .filter(o => o.voidedAt != null)
    .map(o => {
      const items = (o.items ?? []) as SnapshotItem[];
      const computedSubtotal = items.reduce((s, i) => {
        const unit = i.unitPrice != null ? Number(i.unitPrice) : Number(i.price) || 0;
        return s + (i.lineTotal != null ? Number(i.lineTotal) : round2(unit * i.quantity));
      }, 0);
      const orderSubtotal = o.subtotal != null ? parseFloat(o.subtotal) : computedSubtotal;
      const orderTax = o.taxAmount != null ? parseFloat(o.taxAmount) : 0;
      const orderTotal = o.total != null ? parseFloat(o.total) : orderSubtotal + orderTax;
      return {
        id: o.id,
        createdAt: o.createdAt.toISOString(),
        voidedAt: o.voidedAt!.toISOString(),
        voidedBy: o.voidedBy ?? null,
        voidReason: o.voidReason ?? null,
        guestName: o.guestName,
        source: o.orderSource ?? "guest",
        paymentMethod: paymentBucket(o),
        total: round2(orderTotal),
        refundRequired: !!o.refundRequired,
      };
    })
    .sort((a, b) => b.voidedAt.localeCompare(a.voidedAt));
  const voidedTotalAmount = voidedRows.reduce((s, v) => s + v.total, 0);
  const refundOwedAmount = voidedRows
    .filter(v => v.refundRequired)
    .reduce((s, v) => s + v.total, 0);

  return {
    // `orderCount` excludes voids so the headline number lines up with the
    // cash drawer at end of day. The voids sub-card surfaces them separately.
    orderCount: activeOrderCount,
    itemCount,
    subtotal: round2(subtotal),
    tax: round2(tax),
    revenue: round2(revenue),
    avgOrderValue: activeOrderCount ? round2(revenue / activeOrderCount) : 0,
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
    voids: {
      count: voidedRows.length,
      totalAmount: round2(voidedTotalAmount),
      refundOwedAmount: round2(refundOwedAmount),
      list: voidedRows,
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Unified / scope-aware totals ─────────────────────────────────────────────
// Builds the `totals` field for the JSON response. For scope=events (default)
// returns the event report unchanged. For scope=catering returns a ReportTotals-
// shaped object populated from cateringTotals (event-specific fields zeroed).
// For scope=all merges revenue/order/item counts and the items breakdown.

function buildScopedTotals(
  eventTotals: ReturnType<typeof buildReport>,
  cateringTotals: CateringTotals | null,
  scope: string,
): ReturnType<typeof buildReport> {
  if (scope === "events" || !cateringTotals) return eventTotals;

  if (scope === "catering") {
    return {
      ...eventTotals,
      orderCount: cateringTotals.orderCount,
      itemCount: cateringTotals.itemCount,
      subtotal: 0,
      tax: 0,
      revenue: cateringTotals.revenue,
      avgOrderValue: cateringTotals.avgOrderValue,
      items: cateringTotals.items.map(i => ({ ...i })),
      orders: [],
      byPaymentMethod: [],
      pickupStats: {
        pickedUpCount: 0, avgPickupSec: null, medianPickupSec: null,
        prepCount: 0, avgPrepSec: null, medianPrepSec: null,
        readyToPickupCount: 0, avgReadyToPickupSec: null, medianReadyToPickupSec: null,
      },
      voids: { count: 0, totalAmount: 0, refundOwedAmount: 0, list: [] },
    };
  }

  // scope=all: merge event + catering into a unified summary.
  // Event-only metrics (tax, voids, pickup stats, byPaymentMethod) are preserved
  // from the event side; catering revenue/counts are added on top.
  const mergedRevenue = round2(eventTotals.revenue + cateringTotals.revenue);
  const mergedOrderCount = eventTotals.orderCount + cateringTotals.orderCount;
  const mergedItemCount = eventTotals.itemCount + cateringTotals.itemCount;
  const itemMerge = new Map<string, { name: string; quantity: number; revenue: number }>();
  for (const i of eventTotals.items) itemMerge.set(i.name, { ...i });
  for (const i of cateringTotals.items) {
    const cur = itemMerge.get(i.name);
    if (cur) {
      cur.quantity += i.quantity;
      cur.revenue = round2(cur.revenue + i.revenue);
    } else {
      itemMerge.set(i.name, { ...i });
    }
  }
  return {
    ...eventTotals,
    orderCount: mergedOrderCount,
    itemCount: mergedItemCount,
    revenue: mergedRevenue,
    avgOrderValue: mergedOrderCount > 0 ? round2(mergedRevenue / mergedOrderCount) : 0,
    items: [...itemMerge.values()].sort((a, b) => b.revenue - a.revenue),
  };
}

// ── Catering totals ─────────────────────────────────────────────────────────
// Aggregates paid catering inquiries (squareAmountPaid > 0) for the unified
// sales report. Revenue = squareAmountPaid; items come from lineItems JSONB.

type CateringReportItem = { name: string; quantity: number; revenue: number };
type CateringReportOrder = {
  id: number;
  type: "catering";
  clientName: string;
  eventDate: string | null;
  eventTime: string | null;
  createdAt: string;
  status: string;
  squareInvoiceStatus: string | null;
  squareAmountPaid: number;
  items: CateringReportItem[];
};
type CateringTotals = {
  orderCount: number;
  itemCount: number;
  revenue: number;
  avgOrderValue: number;
  orders: CateringReportOrder[];
  items: CateringReportItem[];
};

function buildCateringTotals(rows: typeof cateringInquiriesTable.$inferSelect[]): CateringTotals {
  let revenue = 0;
  let itemCount = 0;
  const itemAgg: Record<string, CateringReportItem> = {};
  const orderRows: CateringReportOrder[] = [];

  for (const c of rows) {
    const amountPaid = c.squareAmountPaid != null ? parseFloat(c.squareAmountPaid) : 0;
    revenue += amountPaid;
    const lineItems = c.lineItems ?? [];
    let orderItemCount = 0;
    const itemsForRow: CateringReportItem[] = [];
    for (const li of lineItems) {
      const qty = li.quantity ?? 0;
      const unit = li.unitPrice ?? 0;
      const lineRev = round2(qty * unit);
      orderItemCount += qty;
      itemsForRow.push({ name: li.name, quantity: qty, revenue: lineRev });
      if (!itemAgg[li.name]) itemAgg[li.name] = { name: li.name, quantity: 0, revenue: 0 };
      itemAgg[li.name].quantity += qty;
      itemAgg[li.name].revenue += lineRev;
    }
    itemCount += orderItemCount;
    orderRows.push({
      id: c.id,
      type: "catering",
      clientName: c.clientName,
      eventDate: c.eventDate ?? null,
      eventTime: c.eventTime ?? null,
      createdAt: c.createdAt.toISOString(),
      status: c.status,
      squareInvoiceStatus: c.squareInvoiceStatus ?? null,
      squareAmountPaid: amountPaid,
      items: itemsForRow,
    });
  }

  const orderCount = orderRows.length;
  return {
    orderCount,
    itemCount,
    revenue: round2(revenue),
    avgOrderValue: orderCount > 0 ? round2(revenue / orderCount) : 0,
    orders: orderRows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    items: Object.values(itemAgg)
      .map(i => ({ ...i, revenue: round2(i.revenue) }))
      .sort((a, b) => b.revenue - a.revenue),
  };
}

router.get("/admin/sales-reports", async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const monthAgo = new Date(today);
    monthAgo.setDate(monthAgo.getDate() - 30);

    const from = parseDate(req.query.from, monthAgo);
    const to = parseDate(req.query.to, new Date());
    const source = typeof req.query.source === "string" ? req.query.source : "staff";
    const rawStatus = typeof req.query.status === "string" ? req.query.status : "all";
    const statusFilter = rawStatus === "completed" ? "completed" : "all";
    const rawScope = typeof req.query.scope === "string" ? req.query.scope : "events";
    const scope = (["events", "catering", "all"] as const).includes(rawScope as "events" | "catering" | "all")
      ? rawScope as "events" | "catering" | "all"
      : "events";

    const fromStart = new Date(from); fromStart.setHours(0, 0, 0, 0);
    const toEnd = new Date(to); toEnd.setHours(0, 0, 0, 0); toEnd.setDate(toEnd.getDate() + 1);

    let eventOrders: typeof eventOrdersTable.$inferSelect[] = [];
    if (scope !== "catering") {
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
      eventOrders = await db.select().from(eventOrdersTable).where(and(...conditions));
    }

    let cateringTotals: CateringTotals | null = null;
    if (scope === "catering" || scope === "all") {
      const cateringRows = await db.select().from(cateringInquiriesTable).where(
        and(
          gte(cateringInquiriesTable.createdAt, fromStart),
          lt(cateringInquiriesTable.createdAt, toEnd),
          sql`${cateringInquiriesTable.squareAmountPaid} > 0`,
        )
      );
      cateringTotals = buildCateringTotals(cateringRows);
    }

    // Build event totals once; derive bySource and unified totals from it.
    const eventTotals = buildReport(scope !== "catering" ? eventOrders : []);
    const guestOrders = scope !== "catering" ? eventOrders.filter(o => o.orderSource === "guest") : [];
    const staffOrders = scope !== "catering" ? eventOrders.filter(o => o.orderSource === "staff") : [];
    const unifiedTotals = buildScopedTotals(eventTotals, cateringTotals, scope);

    // Combined order list — event orders tagged with type="event", catering orders
    // already have type="catering". Sorted by createdAt desc. Exposed via
    // byType.allOrders so clients can render a single chronological table.
    const allOrders: Array<(typeof eventTotals.orders)[number] & { type: "event" } | CateringReportOrder> = [
      ...eventTotals.orders.map(o => ({ ...o, type: "event" as const })),
      ...(scope !== "events" && cateringTotals ? cateringTotals.orders : []),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    res.json({
      from: fromStart.toISOString(),
      to: toEnd.toISOString(),
      source,
      scope,
      status: statusFilter,
      totals: unifiedTotals,
      bySource: {
        guest: buildReport(guestOrders),
        staff: buildReport(staffOrders),
      },
      catering: cateringTotals,
      byType: {
        events: eventTotals,
        catering: cateringTotals,
        allOrders,
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
    const source = typeof req.query.source === "string" ? req.query.source : "staff";
    const rawStatus = typeof req.query.status === "string" ? req.query.status : "all";
    const statusFilter = rawStatus === "completed" ? "completed" : "all";
    const type = (typeof req.query.type === "string" ? req.query.type : "orders") as "orders" | "items" | "voids";
    const rawScope = typeof req.query.scope === "string" ? req.query.scope : "events";
    const scope = (["events", "catering", "all"] as const).includes(rawScope as "events" | "catering" | "all")
      ? rawScope as "events" | "catering" | "all"
      : "events";

    const fromStart = new Date(from); fromStart.setHours(0, 0, 0, 0);
    const toEnd = new Date(to); toEnd.setHours(0, 0, 0, 0); toEnd.setDate(toEnd.getDate() + 1);

    let orders: typeof eventOrdersTable.$inferSelect[] = [];
    if (scope !== "catering") {
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
      orders = await db.select().from(eventOrdersTable).where(and(...conditions));
    }

    let cateringRows: typeof cateringInquiriesTable.$inferSelect[] = [];
    if ((scope === "catering" || scope === "all") && type !== "voids") {
      cateringRows = await db.select().from(cateringInquiriesTable).where(
        and(
          gte(cateringInquiriesTable.createdAt, fromStart),
          lt(cateringInquiriesTable.createdAt, toEnd),
          sql`${cateringInquiriesTable.squareAmountPaid} > 0`,
        )
      );
    }

    const escape = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const rows: string[] = [];
    const filenameBase = `sales-report_${type}_${fromStart.toISOString().slice(0, 10)}_to_${toEnd.toISOString().slice(0, 10)}`;

    if (type === "items") {
      // Aggregated per-item CSV — one row per item across all orders in range.
      // Catering line items are merged by name when scope includes catering.
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
      // Merge catering line items
      for (const c of cateringRows) {
        for (const li of (c.lineItems ?? [])) {
          const qty = li.quantity ?? 0;
          const unit = li.unitPrice ?? 0;
          const line = round2(qty * unit);
          const cur = agg.get(li.name) ?? { quantity: 0, revenue: 0 };
          cur.quantity += qty;
          cur.revenue += line;
          agg.set(li.name, cur);
        }
      }
      rows.push(["Item", "Quantity Sold", "Revenue"].join(","));
      for (const [name, totals] of [...agg.entries()].sort((a, b) => b[1].quantity - a[1].quantity)) {
        rows.push([name, totals.quantity, totals.revenue.toFixed(2)].map(escape).join(","));
      }
    } else if (type === "voids") {
      // Voids-only CSV — mirrors the on-page Voids table. Sorted by voided
      // timestamp descending so the most recent voids float to the top, just
      // like the UI.
      rows.push([
        "Order ID", "Created", "Voided At", "Voided By", "Reason",
        "Source", "Guest Name", "Payment Method", "Total", "Refund Owed",
      ].join(","));
      const voids = orders
        .filter(o => o.voidedAt != null)
        .sort((a, b) => (b.voidedAt!.getTime() - a.voidedAt!.getTime()));
      for (const o of voids) {
        const items = (o.items ?? []) as SnapshotItem[];
        const computedSubtotal = items.reduce((s, i) => {
          const unit = i.unitPrice != null ? Number(i.unitPrice) : Number(i.price) || 0;
          return s + (i.lineTotal != null ? Number(i.lineTotal) : round2(unit * i.quantity));
        }, 0);
        const orderSubtotal = o.subtotal != null ? parseFloat(o.subtotal) : computedSubtotal;
        const orderTax = o.taxAmount != null ? parseFloat(o.taxAmount) : 0;
        const total = o.total != null ? parseFloat(o.total) : orderSubtotal + orderTax;
        rows.push([
          o.id,
          o.createdAt.toISOString(),
          o.voidedAt!.toISOString(),
          o.voidedBy ?? "",
          o.voidReason ?? "",
          o.orderSource,
          o.guestName,
          paymentBucket(o),
          total.toFixed(2),
          o.refundRequired ? "yes" : "no",
        ].map(escape).join(","));
      }
    } else {
      // Order-level CSV — one row per order. Catering rows appended after
      // event orders when scope includes catering (ID prefix "C-" to distinguish).
      rows.push([
        "Order ID", "Created", "Source", "Guest Name", "Phone", "Status",
        "payment_method", "Items", "Subtotal", "Tax Rate (%)", "Tax", "Total",
        "Ready At", "Picked Up At", "Time to Ready (min)", "Ready to Pickup (min)", "Time to Pickup (min)",
      ].join(","));
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
      // Append catering inquiry rows when scope includes catering
      for (const c of cateringRows) {
        const lineItems = c.lineItems ?? [];
        const itemsStr = lineItems.map(li => `${li.quantity}× ${li.name}`).join("; ");
        const amountPaid = c.squareAmountPaid != null ? parseFloat(c.squareAmountPaid) : 0;
        rows.push([
          `C-${c.id}`,
          c.createdAt.toISOString(),
          "catering",
          c.clientName,
          c.clientPhone ?? "",
          c.status,
          c.squareInvoiceStatus ?? "",
          itemsStr,
          amountPaid.toFixed(2),
          "",
          "",
          amountPaid.toFixed(2),
          c.eventDate ?? "",
          "",
          "",
          "",
          "",
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

// ── Square Terminal device list ───────────────────────────────────────────────
// Returns the list of Terminal devices registered to the Square account so the
// admin can pick a device ID from a UI instead of finding the UUID manually.
router.get("/admin/square/terminal-devices", async (req, res) => {
  if (!getSquareConfig()) {
    res.status(424).json({ error: "Square is not configured. Set SQUARE_ACCESS_TOKEN and SQUARE_LOCATION_ID on the server." });
    return;
  }
  try {
    const devices = await listTerminalDevices();
    res.json(devices);
  } catch (err) {
    if (err instanceof SquareApiError) {
      req.log.warn({ err }, "Square API error listing terminal devices");
      res.status(502).json({ error: `Square API error: ${err.userMessage}` });
      return;
    }
    req.log.error({ err }, "Error listing terminal devices");
    res.status(500).json({ error: "Failed to list Terminal devices" });
  }
});

export default router;
