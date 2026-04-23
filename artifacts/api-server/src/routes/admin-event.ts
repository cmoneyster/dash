import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { eventSettingsTable, eventOrdersTable } from "@workspace/db/schema";
import { eq, and, gte, lt } from "drizzle-orm";

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
    } = req.body as {
      eventName?: string;
      orderPassword?: string;
      kitchenPassword?: string;
      eventTakerPassword?: string;
      eventTakerTaxEnabled?: boolean;
      eventTakerTaxRate?: number | string | null;
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
      twilioConfigured,
    });

    if (existing) {
      const updates: Record<string, any> = { updatedAt: new Date() };
      if (eventName !== undefined) updates.eventName = eventName.trim();
      if (orderPassword !== undefined && orderPassword !== "") updates.eventPassword = orderPassword;
      if (kitchenPassword !== undefined) {
        updates.kitchenPassword = kitchenPassword.trim() || null;
      }
      if (eventTakerPassword !== undefined) {
        updates.eventTakerPassword = eventTakerPassword.trim() || null;
      }
      if (eventTakerTaxEnabled !== undefined) updates.eventTakerTaxEnabled = !!eventTakerTaxEnabled;
      if (eventTakerTaxRate !== undefined) {
        updates.eventTakerTaxRate = (eventTakerTaxRate === null || eventTakerTaxRate === "" || Number.isNaN(Number(eventTakerTaxRate)))
          ? null
          : String(Number(eventTakerTaxRate));
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
      }).returning();
      res.json(buildResponse(created));
    }
  } catch (err) {
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

function buildReport(orders: typeof eventOrdersTable.$inferSelect[]) {
  let revenue = 0;
  let subtotal = 0;
  let tax = 0;
  let itemCount = 0;
  const itemBreakdown: Record<string, { name: string; quantity: number; revenue: number }> = {};
  const orderRows: Array<{
    id: number;
    createdAt: string;
    source: string;
    guestName: string;
    phoneNumber: string | null;
    status: string;
    items: Array<{ itemId: number; name: string; quantity: number; unitPrice: number; lineTotal: number }>;
    subtotal: number;
    taxRate: number | null;
    tax: number;
    total: number;
  }> = [];

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
    for (const i of lineSnapshots) {
      itemCount += i.quantity;
      const key = `${i.itemId}::${i.name}`;
      if (!itemBreakdown[key]) itemBreakdown[key] = { name: i.name, quantity: 0, revenue: 0 };
      itemBreakdown[key].quantity += i.quantity;
      itemBreakdown[key].revenue += i.lineTotal;
    }
    orderRows.push({
      id: o.id,
      createdAt: o.createdAt.toISOString(),
      source: o.orderSource ?? "guest",
      guestName: o.guestName,
      phoneNumber: o.phoneNumber ?? null,
      status: o.status,
      items: lineSnapshots,
      subtotal: round2(orderSubtotal),
      taxRate: o.taxRate != null ? parseFloat(o.taxRate) : null,
      tax: round2(orderTax),
      total: round2(orderTotal),
    });
  }

  return {
    orderCount: orders.length,
    itemCount,
    subtotal: round2(subtotal),
    tax: round2(tax),
    revenue: round2(revenue),
    avgOrderValue: orders.length ? round2(revenue / orders.length) : 0,
    items: Object.values(itemBreakdown)
      .map(i => ({ ...i, revenue: round2(i.revenue) }))
      .sort((a, b) => b.revenue - a.revenue),
    orders: orderRows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
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
    const orders = await db.select().from(eventOrdersTable).where(and(...conditions));

    const guestOrders = orders.filter(o => o.orderSource === "guest");
    const staffOrders = orders.filter(o => o.orderSource === "staff");

    res.json({
      from: fromStart.toISOString(),
      to: toEnd.toISOString(),
      source,
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
    const orders = await db.select().from(eventOrdersTable).where(and(...conditions));

    const escape = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const rows: string[] = [];
    const filenameBase = `sales-report_${type}_${fromStart.toISOString().slice(0, 10)}_to_${toEnd.toISOString().slice(0, 10)}`;

    if (type === "items") {
      // Itemized CSV — one row per (order, line item)
      rows.push(["Order ID", "Created", "Source", "Item", "Qty", "Unit Price", "Line Total"].join(","));
      for (const o of orders) {
        const items = (o.items ?? []) as SnapshotItem[];
        for (const i of items) {
          const unit = i.unitPrice != null ? Number(i.unitPrice) : Number(i.price) || 0;
          const line = i.lineTotal != null ? Number(i.lineTotal) : round2(unit * i.quantity);
          rows.push([
            o.id,
            o.createdAt.toISOString(),
            o.orderSource,
            i.name,
            i.quantity,
            unit.toFixed(2),
            line.toFixed(2),
          ].map(escape).join(","));
        }
      }
    } else {
      // Order-level CSV — one row per order
      rows.push(["Order ID", "Created", "Source", "Guest Name", "Phone", "Status", "Items", "Subtotal", "Tax Rate (%)", "Tax", "Total"].join(","));
      for (const o of orders) {
        const items = (o.items ?? []) as SnapshotItem[];
        const itemsStr = items.map(i => `${i.quantity}× ${i.name}`).join("; ");
        const subtotal = o.subtotal != null ? parseFloat(o.subtotal) : items.reduce((s, i) => {
          const unit = i.unitPrice != null ? Number(i.unitPrice) : Number(i.price) || 0;
          return s + unit * i.quantity;
        }, 0);
        const total = o.total != null ? parseFloat(o.total) : subtotal;
        rows.push([
          o.id,
          o.createdAt.toISOString(),
          o.orderSource,
          o.guestName,
          o.phoneNumber ?? "",
          o.status,
          itemsStr,
          subtotal.toFixed(2),
          o.taxRate != null ? parseFloat(o.taxRate).toFixed(2) : "",
          o.taxAmount != null ? parseFloat(o.taxAmount).toFixed(2) : "0.00",
          total.toFixed(2),
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

export default router;
