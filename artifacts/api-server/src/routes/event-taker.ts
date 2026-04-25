import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { menuItemsTable, eventOrdersTable, eventSettingsTable } from "@workspace/db/schema";
import { eq, sql, inArray, and, desc } from "drizzle-orm";
import { sendOrderConfirmation } from "../lib/sms";
import { getOrderingChannelStates } from "./event-ordering";
import { detectAndMarkLowStockCrossings, fireLowStockAlertIfAny, DEFAULT_LOW_STOCK_THRESHOLD } from "../lib/lowStockAlerts";

const router: IRouter = Router();

function serializeOrder(o: typeof eventOrdersTable.$inferSelect) {
  return {
    ...o,
    subtotal: o.subtotal != null ? parseFloat(o.subtotal) : null,
    taxRate: o.taxRate != null ? parseFloat(o.taxRate) : null,
    taxAmount: o.taxAmount != null ? parseFloat(o.taxAmount) : null,
    total: o.total != null ? parseFloat(o.total) : null,
    cashReceived: o.cashReceived != null ? parseFloat(o.cashReceived) : null,
    changeDue: o.changeDue != null ? parseFloat(o.changeDue) : null,
    plateGroups: o.plateGroups ?? null,
    kitchenProgress: o.kitchenProgress ?? null,
  };
}

// Validate a staff-supplied plating layout against the order's items list.
// Returns the cleaned plate array (empty plates dropped, item lines with
// quantity 0 stripped) or throws an error tagged with status=400.
type PlateGroupInput = { label?: unknown; items?: unknown };
type CartLine = { itemId: number; name: string; quantity: number };
function validateAndCleanPlateGroups(
  raw: unknown,
  cartItems: CartLine[],
): { label: string; items: { itemId: number; quantity: number }[] }[] | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) {
    throw Object.assign(new Error("plateGroups must be an array"), { status: 400 });
  }
  const cartByItem = new Map(cartItems.map(c => [c.itemId, c]));
  // Track running per-item allocation so we can index errors precisely.
  const allocByItem = new Map<number, number>();
  const cleaned: { label: string; items: { itemId: number; quantity: number }[] }[] = [];
  raw.forEach((p, plateIdx) => {
    const plate = p as PlateGroupInput;
    const labelRaw = typeof plate.label === "string" ? plate.label.trim() : "";
    const label = labelRaw || `Plate ${plateIdx + 1}`;
    if (!Array.isArray(plate.items)) {
      throw Object.assign(new Error(`Plate ${plateIdx + 1} items must be an array`), { status: 400 });
    }
    // Aggregate within a single plate so duplicate item lines collapse cleanly.
    const perPlate = new Map<number, number>();
    for (const ln of plate.items as unknown[]) {
      const line = ln as { itemId?: unknown; quantity?: unknown };
      const itemId = Number(line?.itemId);
      const qty = Number(line?.quantity);
      if (!Number.isInteger(itemId) || itemId <= 0) {
        throw Object.assign(new Error(`Plate ${plateIdx + 1} has an invalid itemId`), { status: 400 });
      }
      if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty < 0) {
        throw Object.assign(new Error(`Plate ${plateIdx + 1} quantities must be whole numbers`), { status: 400 });
      }
      if (qty === 0) continue;
      if (!cartByItem.has(itemId)) {
        throw Object.assign(new Error(`Plate ${plateIdx + 1} references an item not in the order`), { status: 400 });
      }
      perPlate.set(itemId, (perPlate.get(itemId) ?? 0) + qty);
    }
    const items: { itemId: number; quantity: number }[] = [];
    for (const [itemId, qty] of perPlate) {
      const cart = cartByItem.get(itemId)!;
      const next = (allocByItem.get(itemId) ?? 0) + qty;
      if (next > cart.quantity) {
        throw Object.assign(
          new Error(`Plate ${plateIdx + 1} has too many of "${cart.name}" (only ${cart.quantity} in cart)`),
          { status: 400 },
        );
      }
      allocByItem.set(itemId, next);
      items.push({ itemId, quantity: qty });
    }
    if (items.length === 0) return; // drop empty plates
    cleaned.push({ label, items });
  });
  return cleaned.length > 0 ? cleaned : null;
}

async function getSettings() {
  const [settings] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
  return settings ?? null;
}

// Resolve taker password — falls back to guest event password if not set
async function resolveTakerPassword(): Promise<string | null> {
  const s = await getSettings();
  if (s?.eventTakerPassword) return s.eventTakerPassword;
  if (s?.eventPassword) return s.eventPassword;
  return process.env.EVENT_PASSWORD ?? null;
}

const verifyTakerPassword = async function (req: Request, res: Response, next: NextFunction) {
  const password = await resolveTakerPassword();
  if (!password) {
    res.status(503).json({ error: "Event Order Taker is not configured" });
    return;
  }
  const authHeader = req.headers["authorization"];
  const supplied = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!supplied || supplied !== password) {
    res.status(401).json({ error: "Invalid password" });
    return;
  }
  next();
};

router.get("/event-taker/settings", async (req, res) => {
  try {
    const s = await getSettings();
    const resolved = await resolveTakerPassword();
    const channels = await getOrderingChannelStates();
    res.json({
      eventName: s?.eventName ?? "",
      taxEnabled: s?.eventTakerTaxEnabled ?? false,
      taxRate: s?.eventTakerTaxRate != null ? parseFloat(s.eventTakerTaxRate) : null,
      hasPassword: !!resolved,
      venmoHandle: s?.venmoHandle ?? null,
      venmoQrImageUrl: s?.venmoQrImageUrl ?? null,
      orderingState: channels.taker.state,
      orderingPausedUntil: channels.taker.pausedUntil,
      orderingRemainingSec: channels.taker.remainingSec,
      orderingPausedMessage: channels.taker.pausedMessage,
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching taker settings");
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

router.post("/event-taker/verify", async (req, res) => {
  const { password } = req.body as { password?: string };
  const expected = await resolveTakerPassword();
  if (!expected) {
    res.status(503).json({ error: "Event Order Taker is not configured" });
    return;
  }
  if (!password || password !== expected) {
    res.status(401).json({ error: "Invalid password" });
    return;
  }
  res.json({ ok: true });
});

router.get("/event-taker/menu", verifyTakerPassword, async (req, res) => {
  try {
    const items = await db
      .select({
        id: menuItemsTable.id,
        name: menuItemsTable.name,
        description: menuItemsTable.description,
        category: menuItemsTable.category,
        price: menuItemsTable.price,
        eventTakerPrice: menuItemsTable.eventTakerPrice,
        unit: menuItemsTable.unit,
        servingSize: menuItemsTable.servingSize,
        imageUrl: menuItemsTable.imageUrl,
        eventStock: menuItemsTable.eventStock,
        internalNotes: menuItemsTable.internalNotes,
      })
      .from(menuItemsTable)
      .where(eq(menuItemsTable.eventTakerVisible, true))
      .orderBy(menuItemsTable.category, menuItemsTable.name);

    // Strict: only items with an explicit event_taker_price are sellable on the POS.
    const formatted = items
      .filter(item => item.eventTakerPrice != null)
      .map(item => {
        const taker = parseFloat(item.eventTakerPrice as string);
        const base = parseFloat(item.price);
        return {
          ...item,
          price: base,
          eventTakerPrice: taker,
          effectivePrice: taker,
        };
      });
    res.json(formatted);
  } catch (err) {
    req.log.error({ err }, "Error fetching taker menu");
    res.status(500).json({ error: "Failed to fetch menu" });
  }
});

router.post("/event-taker/orders", verifyTakerPassword, async (req, res) => {
  try {
    const { guestName, phoneNumber, items, statusUrlBase, plateGroups } = req.body as {
      guestName?: string;
      phoneNumber?: string | null;
      items?: { itemId: number; quantity: number }[];
      statusUrlBase?: string;
      plateGroups?: unknown;
    };
    if (!guestName?.trim() || !items?.length) {
      res.status(400).json({ error: "guestName and items are required" });
      return;
    }

    // Gate: kitchen may have paused or stopped staff order taking.
    const channels = await getOrderingChannelStates();
    if (channels.taker.state !== "accepting") {
      res.status(423).json({
        error: channels.taker.state === "paused"
          ? "Order taking is paused — try again shortly."
          : "Order taking is currently stopped.",
        state: channels.taker.state,
        pausedUntil: channels.taker.pausedUntil,
        remainingSec: channels.taker.remainingSec,
      });
      return;
    }

    // Validate quantities and aggregate duplicate item lines up-front.
    const aggregated = new Map<number, number>();
    for (const i of items) {
      const id = Number(i?.itemId);
      const q = Number(i?.quantity);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: "Invalid itemId" });
        return;
      }
      if (!Number.isFinite(q) || !Number.isInteger(q) || q <= 0) {
        res.status(400).json({ error: "Quantity must be a positive integer" });
        return;
      }
      aggregated.set(id, (aggregated.get(id) ?? 0) + q);
    }

    const settings = await getSettings();
    const taxEnabled = !!settings?.eventTakerTaxEnabled;
    const taxRate = settings?.eventTakerTaxRate != null ? parseFloat(settings.eventTakerTaxRate) : 0;

    const { order, lowStockCrossings, lowStockSettings } = await db.transaction(async (tx) => {
      // Re-check the kitchen toggle inside the transaction to avoid a race
      // between the gate above and the row commit.
      const [s] = await tx.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1)).for("update");
      // Recompute the effective channel state from the row we just locked, so a
      // concurrent toggle write blocks behind us instead of slipping orders through.
      const liveTaker = (function () {
        const raw = (s?.takerOrderingState ?? "accepting") as "accepting" | "paused" | "closed";
        const pu = s?.takerOrderingPausedUntil ?? null;
        if (raw === "paused" && pu) {
          const ms = pu.getTime() - Date.now();
          if (ms > 0) return { state: "paused" as const, pausedUntil: pu.toISOString(), remainingSec: Math.ceil(ms / 1000) };
          return { state: "accepting" as const, pausedUntil: null, remainingSec: null };
        }
        if (raw === "closed") return { state: "closed" as const, pausedUntil: null, remainingSec: null };
        return { state: "accepting" as const, pausedUntil: null, remainingSec: null };
      })();
      if (liveTaker.state !== "accepting") {
        throw Object.assign(new Error(liveTaker.state === "paused"
          ? "Order taking is paused — try again shortly."
          : "Order taking is currently stopped."),
          { status: 423, channelState: liveTaker });
      }
      const itemIds = Array.from(aggregated.keys());
      const rows = await tx
        .select()
        .from(menuItemsTable)
        .where(inArray(menuItemsTable.id, itemIds))
        .for("update");
      const byId = new Map(rows.map(r => [r.id, r]));

      const orderItems: {
        itemId: number;
        name: string;
        quantity: number;
        price: number;
        unitPrice: number;
        lineTotal: number;
      }[] = [];
      let subtotal = 0;
      // Track post-decrement stock per item so we can run one batched
      // low-stock crossing check after all updates land.
      const stockChanges: Array<{ itemId: number; name: string; newStock: number }> = [];

      const round2 = (n: number) => Math.round(n * 100) / 100;

      for (const [itemId, qty] of aggregated) {
        const row = byId.get(itemId);
        if (!row) throw Object.assign(new Error(`Item ${itemId} not found`), { status: 404 });
        if (!row.eventTakerVisible) throw Object.assign(new Error(`Item "${row.name}" is not available on the order taker`), { status: 400 });
        // Strict: an item without an event_taker_price cannot be sold on the POS.
        if (row.eventTakerPrice == null) {
          throw Object.assign(
            new Error(`Item "${row.name}" has no Order Taker price set`),
            { status: 400 }
          );
        }
        // Stock enforcement against the aggregated quantity.
        if (row.eventStock !== null) {
          if (row.eventStock < qty) {
            throw Object.assign(
              new Error(`Only ${row.eventStock} of "${row.name}" remaining`),
              { status: 409, remaining: row.eventStock, itemId: row.id }
            );
          }
          await tx
            .update(menuItemsTable)
            .set({ eventStock: sql`event_stock - ${qty}` })
            .where(eq(menuItemsTable.id, row.id));
          stockChanges.push({ itemId: row.id, name: row.name, newStock: row.eventStock - qty });
        }
        const unitPrice = parseFloat(row.eventTakerPrice);
        const lineTotal = round2(unitPrice * qty);
        subtotal += lineTotal;
        orderItems.push({
          itemId: row.id,
          name: row.name,
          quantity: qty,
          price: unitPrice,
          unitPrice,
          lineTotal,
        });
      }

      subtotal = round2(subtotal);
      const taxAmount = taxEnabled && taxRate > 0 ? round2(subtotal * (taxRate / 100)) : 0;
      const total = round2(subtotal + taxAmount);

      const activeEventSessionId = settings?.activeEventSessionId ?? null;

      // Validate plating against the just-priced items so the indexed errors
      // match what staff are looking at on screen. Throws status=400 on bad data.
      const cleanedPlateGroups = validateAndCleanPlateGroups(plateGroups, orderItems);

      const [created] = await tx
        .insert(eventOrdersTable)
        .values({
          guestName: guestName.trim(),
          phoneNumber: phoneNumber?.trim() || null,
          items: orderItems,
          plateGroups: cleanedPlateGroups,
          status: "pending",
          eventSessionId: activeEventSessionId,
          orderSource: "staff",
          subtotal: String(subtotal),
          taxRate: taxEnabled && taxRate > 0 ? String(taxRate) : null,
          taxAmount: String(taxAmount),
          total: String(total),
          // Staff orders start unpaid — kitchen feed filters these out until
          // payment is confirmed or staff explicitly overrides.
          paymentStatus: "unpaid",
        })
        .returning();

      // Atomically flag any items that just crossed the low-stock threshold
      // so concurrent orders don't double-fire the SMS. SMS is sent after
      // commit (rollback ⇒ no phantom alert).
      const threshold = s?.lowStockAlertThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
      const crossings = await detectAndMarkLowStockCrossings(tx, stockChanges, threshold);

      return {
        order: created,
        lowStockCrossings: crossings,
        lowStockSettings: { phones: s?.lowStockAlertPhones ?? [], eventName: s?.eventName ?? "", threshold },
      };
    });

    // Intentionally do NOT send the order confirmation SMS here — it fires
    // once payment is recorded (or override is invoked). The low-stock alert
    // does fire now, since the stock has actually been decremented.
    fireLowStockAlertIfAny(req, lowStockCrossings, lowStockSettings);

    res.status(201).json(serializeOrder(order));
  } catch (err: any) {
    if (err?.status === 409) {
      res.status(409).json({ error: err.message, remaining: err.remaining, itemId: err.itemId });
      return;
    }
    if (err?.status === 400 || err?.status === 404) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err?.status === 423 && err?.channelState) {
      res.status(423).json({
        error: err.message,
        state: err.channelState.state,
        pausedUntil: err.channelState.pausedUntil,
        remainingSec: err.channelState.remainingSec,
      });
      return;
    }
    req.log.error({ err }, "Error creating taker order");
    res.status(500).json({ error: "Failed to create order" });
  }
});

// ── Plate groups (plating layout) ──────────────────────────────────────
// Set/clear the optional plating layout while the order is still unpaid.
// Once payment is recorded (or override sent), the layout is locked — kitchen
// has already started reading it. PATCH with `plateGroups: null` (or omitted)
// to clear; otherwise the array is validated against the order's items.
router.patch("/event-taker/orders/:id/plate-groups", verifyTakerPassword, async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }
    const body = (req.body ?? {}) as { plateGroups?: unknown };
    const [existing] = await db.select().from(eventOrdersTable).where(eq(eventOrdersTable.id, id));
    if (!existing) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    if (existing.orderSource !== "staff") {
      res.status(400).json({ error: "Only staff (POS) orders accept plating" });
      return;
    }
    if (existing.paymentStatus !== "unpaid") {
      res.status(409).json({ error: "Plating is locked — order has already been sent to the kitchen" });
      return;
    }
    const settings = await getSettings();
    const activeId = settings?.activeEventSessionId ?? null;
    if (activeId != null && existing.eventSessionId !== activeId) {
      res.status(409).json({ error: "Order belongs to a different event session" });
      return;
    }
    const cartItems = (existing.items ?? []).map(i => ({
      itemId: i.itemId, name: i.name, quantity: i.quantity,
    }));
    const cleaned = validateAndCleanPlateGroups(body.plateGroups ?? null, cartItems);
    // Atomic guarded update: re-assert "staff" + "unpaid" in the WHERE clause so
    // a concurrent payment/override can't slip past our earlier read-check.
    const [updated] = await db
      .update(eventOrdersTable)
      .set({ plateGroups: cleaned })
      .where(and(
        eq(eventOrdersTable.id, id),
        eq(eventOrdersTable.orderSource, "staff"),
        eq(eventOrdersTable.paymentStatus, "unpaid"),
      ))
      .returning();
    if (!updated) {
      // Re-read to disambiguate: missing row vs lock fired between read and update.
      const [after] = await db.select().from(eventOrdersTable).where(eq(eventOrdersTable.id, id));
      if (!after) {
        res.status(404).json({ error: "Order not found" });
        return;
      }
      res.status(409).json({ error: "Plating is locked — order has already been sent to the kitchen" });
      return;
    }
    res.json(serializeOrder(updated));
  } catch (err: any) {
    if (err?.status === 400) {
      res.status(400).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "Error updating plate groups");
    res.status(500).json({ error: "Failed to update plating" });
  }
});

// ── Pending payments queue ─────────────────────────────────────────────
// Returns staff orders awaiting payment (held off the kitchen feed).
router.get("/event-taker/orders/pending", verifyTakerPassword, async (req, res) => {
  try {
    // Scope to the active event session so stale unpaid orders from prior
    // events don't leak into the current POS queue.
    const settings = await getSettings();
    const activeId = settings?.activeEventSessionId ?? null;
    // Include both 'unpaid' (parked off the kitchen) and 'override' (already
    // fired to the kitchen but still owed) so staff can come back later and
    // record real payment on either. Override rows are tagged in the UI so
    // they're visually distinct from parked tabs.
    const conditions = [
      eq(eventOrdersTable.orderSource, "staff"),
      inArray(eventOrdersTable.paymentStatus, ["unpaid", "override"]),
    ];
    if (activeId != null) conditions.push(eq(eventOrdersTable.eventSessionId, activeId));
    const rows = await db
      .select()
      .from(eventOrdersTable)
      .where(and(...conditions))
      .orderBy(desc(eventOrdersTable.createdAt));
    res.json(rows.map(serializeOrder));
  } catch (err) {
    req.log.error({ err }, "Error listing pending payments");
    res.status(500).json({ error: "Failed to load pending payments" });
  }
});

// Confirm payment for a previously-created unpaid order.
// On success: marks paid, fires SMS confirmation (if phone present),
// and returns the updated order so the POS can print/receipt it.
router.patch("/event-taker/orders/:id/payment", verifyTakerPassword, async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }
    const { method, cashReceived, statusUrlBase } = req.body as {
      method?: "cash" | "card" | "venmo";
      cashReceived?: number | string | null;
      statusUrlBase?: string;
    };
    if (method !== "cash" && method !== "card" && method !== "venmo") {
      res.status(400).json({ error: "Invalid payment method" });
      return;
    }

    const [existing] = await db.select().from(eventOrdersTable).where(eq(eventOrdersTable.id, id));
    if (!existing) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    // Refuse to mutate orders from a different (older) event session — keeps
    // POS actions consistent with the session-scoped pending queue.
    const settings = await getSettings();
    const activeId = settings?.activeEventSessionId ?? null;
    if (activeId != null && existing.eventSessionId !== activeId) {
      res.status(409).json({ error: "Order belongs to a different event session" });
      return;
    }
    if (existing.orderSource !== "staff") {
      res.status(400).json({ error: "Only staff (POS) orders accept payment recording" });
      return;
    }
    if (existing.paymentStatus === "paid") {
      // Idempotent — already recorded; just return current state. We
      // surface wasOverride: false here because any auto-print should
      // already have happened the first time payment was recorded; the
      // client shouldn't reprint from this idempotent reply.
      res.json({ ...serializeOrder(existing), wasOverride: false });
      return;
    }
    if (existing.paymentStatus !== "unpaid" && existing.paymentStatus !== "override") {
      res.status(409).json({ error: "Order is not awaiting payment" });
      return;
    }

    const total = existing.total != null ? parseFloat(existing.total) : 0;
    const updates: Record<string, unknown> = {
      paymentStatus: "paid",
      paymentMethod: method,
      paymentRecordedAt: new Date(),
      cashReceived: null,
      changeDue: null,
      // Preserve paymentOverrideReason when transitioning override→paid so the
      // audit trail of why the order was fired unpaid stays on the row.
    };

    if (method === "cash") {
      const received = Number(cashReceived);
      if (!Number.isFinite(received)) {
        res.status(400).json({ error: "cashReceived is required for cash payments" });
        return;
      }
      if (received < total) {
        res.status(400).json({ error: `Cash received ($${received.toFixed(2)}) is less than total ($${total.toFixed(2)})` });
        return;
      }
      const change = Math.round((received - total) * 100) / 100;
      updates.cashReceived = String(received.toFixed(2));
      updates.changeDue = String(change.toFixed(2));
    }

    // Race-safe two-phase atomic transition. We try 'unpaid' → 'paid' first,
    // and only if that fails fall back to 'override' → 'paid'. Whichever
    // WHERE clause actually matched tells us the *true* prior status at the
    // moment of the write, with no read-then-update window. We use this to
    // decide whether SMS should fire (override orders already SMS'd at
    // override time, so we must not double-text).
    let updated = (await db
      .update(eventOrdersTable)
      .set(updates)
      .where(and(
        eq(eventOrdersTable.id, id),
        eq(eventOrdersTable.orderSource, "staff"),
        eq(eventOrdersTable.paymentStatus, "unpaid"),
      ))
      .returning())[0];
    let wasOverride = false;
    if (!updated) {
      const overrideRows = await db
        .update(eventOrdersTable)
        .set(updates)
        .where(and(
          eq(eventOrdersTable.id, id),
          eq(eventOrdersTable.orderSource, "staff"),
          eq(eventOrdersTable.paymentStatus, "override"),
        ))
        .returning();
      updated = overrideRows[0];
      if (updated) wasOverride = true;
    }
    if (!updated) {
      // Lost the race. If the row still exists and is already finalized,
      // return it idempotently (no extra SMS). If it's gone (e.g. canceled
      // concurrently), surface a 409 so the client doesn't print a receipt.
      const [current] = await db.select().from(eventOrdersTable).where(eq(eventOrdersTable.id, id));
      if (!current) {
        res.status(409).json({ error: "Order no longer exists (was it canceled?)" });
        return;
      }
      res.json({ ...serializeOrder(current), wasOverride: false });
      return;
    }

    // Fire SMS confirmation now that payment is recorded — same shape as the
    // original POST flow, but only after the customer has actually paid. When
    // the order was already in override state the SMS already fired at the
    // time of override, so we don't re-send and double-text the customer.
    if (updated.phoneNumber && !wasOverride) {
      const settings = await getSettings();
      const orderStatusUrl = statusUrlBase
        ? `${statusUrlBase}/event/order/${updated.id}`
        : `${req.protocol}://${req.get("host")}/event/order/${updated.id}`;
      sendOrderConfirmation({
        guestName: updated.guestName,
        orderId: updated.id,
        phoneNumber: updated.phoneNumber,
        eventName: settings?.eventName ?? "",
        orderStatusUrl,
      }).catch(() => {});
    }

    // Surface wasOverride so the client can suppress kitchen-ticket
    // auto-print on override→paid transitions (kitchen already got the
    // ticket when the order was overridden).
    res.json({ ...serializeOrder(updated), wasOverride });
  } catch (err) {
    req.log.error({ err }, "Error recording payment");
    res.status(500).json({ error: "Failed to record payment" });
  }
});

// Override — send an unpaid order to the kitchen anyway.
router.patch("/event-taker/orders/:id/override", verifyTakerPassword, async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }
    const { reason, statusUrlBase } = req.body as { reason?: string; statusUrlBase?: string };

    const [existing] = await db.select().from(eventOrdersTable).where(eq(eventOrdersTable.id, id));
    if (!existing) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    const settings = await getSettings();
    const activeId = settings?.activeEventSessionId ?? null;
    if (activeId != null && existing.eventSessionId !== activeId) {
      res.status(409).json({ error: "Order belongs to a different event session" });
      return;
    }
    if (existing.orderSource !== "staff") {
      res.status(400).json({ error: "Only staff (POS) orders can be overridden" });
      return;
    }
    if (existing.paymentStatus !== "unpaid") {
      res.json(serializeOrder(existing));
      return;
    }

    // Atomic transition (see /payment for rationale): only flip 'unpaid' →
    // 'override'. If the row was already finalized by another device, return
    // the current state without re-sending SMS.
    const updatedRows = await db
      .update(eventOrdersTable)
      .set({
        paymentStatus: "override",
        paymentMethod: null,
        paymentRecordedAt: new Date(),
        paymentOverrideReason: reason?.trim() ? reason.trim().slice(0, 500) : null,
      })
      .where(and(
        eq(eventOrdersTable.id, id),
        eq(eventOrdersTable.orderSource, "staff"),
        eq(eventOrdersTable.paymentStatus, "unpaid"),
      ))
      .returning();
    if (updatedRows.length === 0) {
      const [current] = await db.select().from(eventOrdersTable).where(eq(eventOrdersTable.id, id));
      if (!current) {
        res.status(409).json({ error: "Order no longer exists (was it canceled?)" });
        return;
      }
      res.json(serializeOrder(current));
      return;
    }
    const updated = updatedRows[0];

    if (updated.phoneNumber) {
      const settings = await getSettings();
      const orderStatusUrl = statusUrlBase
        ? `${statusUrlBase}/event/order/${updated.id}`
        : `${req.protocol}://${req.get("host")}/event/order/${updated.id}`;
      sendOrderConfirmation({
        guestName: updated.guestName,
        orderId: updated.id,
        phoneNumber: updated.phoneNumber,
        eventName: settings?.eventName ?? "",
        orderStatusUrl,
      }).catch(() => {});
    }

    res.json(serializeOrder(updated));
  } catch (err) {
    req.log.error({ err }, "Error overriding payment gate");
    res.status(500).json({ error: "Failed to override payment" });
  }
});

// Cancel an unpaid order — restores stock and removes from queue.
// Refuses to cancel orders that are already paid or have been overridden
// to the kitchen, since those are no longer "pending".
router.delete("/event-taker/orders/:id", verifyTakerPassword, async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }

    const settings = await getSettings();
    const activeId = settings?.activeEventSessionId ?? null;
    await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(eventOrdersTable).where(eq(eventOrdersTable.id, id)).for("update");
      if (!existing) throw Object.assign(new Error("Order not found"), { status: 404 });
      if (activeId != null && existing.eventSessionId !== activeId) {
        throw Object.assign(new Error("Order belongs to a different event session"), { status: 409 });
      }
      if (existing.orderSource !== "staff") {
        throw Object.assign(new Error("Only staff orders can be cancelled here"), { status: 400 });
      }
      if (existing.paymentStatus !== "unpaid") {
        throw Object.assign(new Error("Order has already been sent to the kitchen and cannot be cancelled here"), { status: 409 });
      }

      // Restore stock for items that have a stock cap.
      const items = (existing.items ?? []) as { itemId: number; quantity: number }[];
      const itemIds = items.map(i => i.itemId);
      // Threshold for re-arming the low-stock SMS once stock climbs back up.
      const [s] = await tx.select({ t: eventSettingsTable.lowStockAlertThreshold }).from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
      const threshold = s?.t ?? DEFAULT_LOW_STOCK_THRESHOLD;
      if (itemIds.length > 0) {
        const rows = await tx
          .select({ id: menuItemsTable.id, eventStock: menuItemsTable.eventStock })
          .from(menuItemsTable)
          .where(inArray(menuItemsTable.id, itemIds))
          .for("update");
        const stockMap = new Map(rows.map(r => [r.id, r.eventStock]));
        for (const line of items) {
          const prev = stockMap.get(line.itemId);
          if (prev !== null && prev !== undefined) {
            await tx
              .update(menuItemsTable)
              .set({ eventStock: sql`event_stock + ${line.quantity}` })
              .where(eq(menuItemsTable.id, line.itemId));
            // Re-arm the low-stock alert if the restored stock now exceeds
            // the threshold (so a future dip will alert again).
            const restored = prev + line.quantity;
            if (restored > threshold) {
              await tx
                .update(menuItemsTable)
                .set({ lowStockAlertSent: false })
                .where(eq(menuItemsTable.id, line.itemId));
            }
          }
        }
      }

      await tx.delete(eventOrdersTable).where(eq(eventOrdersTable.id, id));
    });

    res.json({ ok: true });
  } catch (err: any) {
    if (err?.status === 404 || err?.status === 400 || err?.status === 409) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "Error cancelling unpaid order");
    res.status(500).json({ error: "Failed to cancel order" });
  }
});

export default router;
