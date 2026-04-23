import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { menuItemsTable, eventOrdersTable, eventSettingsTable } from "@workspace/db/schema";
import { eq, sql, inArray, and, desc } from "drizzle-orm";
import { sendOrderConfirmation } from "../lib/sms";

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
  };
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
    res.json({
      eventName: s?.eventName ?? "",
      taxEnabled: s?.eventTakerTaxEnabled ?? false,
      taxRate: s?.eventTakerTaxRate != null ? parseFloat(s.eventTakerTaxRate) : null,
      hasPassword: !!resolved,
      venmoHandle: s?.venmoHandle ?? null,
      venmoQrImageUrl: s?.venmoQrImageUrl ?? null,
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
    const { guestName, phoneNumber, items, statusUrlBase } = req.body as {
      guestName?: string;
      phoneNumber?: string | null;
      items?: { itemId: number; quantity: number }[];
      statusUrlBase?: string;
    };
    if (!guestName?.trim() || !items?.length) {
      res.status(400).json({ error: "guestName and items are required" });
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

    const order = await db.transaction(async (tx) => {
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

      const [created] = await tx
        .insert(eventOrdersTable)
        .values({
          guestName: guestName.trim(),
          phoneNumber: phoneNumber?.trim() || null,
          items: orderItems,
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
      return created;
    });

    // Intentionally do NOT send the SMS confirmation here — it fires once
    // payment is recorded (or override is invoked).

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
    req.log.error({ err }, "Error creating taker order");
    res.status(500).json({ error: "Failed to create order" });
  }
});

// ── Pending payments queue ─────────────────────────────────────────────
// Returns staff orders awaiting payment (held off the kitchen feed).
router.get("/event-taker/orders/pending", verifyTakerPassword, async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(eventOrdersTable)
      .where(and(
        eq(eventOrdersTable.orderSource, "staff"),
        eq(eventOrdersTable.paymentStatus, "unpaid"),
      ))
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
    const id = parseInt(req.params.id, 10);
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
    if (existing.orderSource !== "staff") {
      res.status(400).json({ error: "Only staff (POS) orders accept payment recording" });
      return;
    }
    if (existing.paymentStatus === "paid") {
      // Idempotent — already recorded; just return current state.
      res.json(serializeOrder(existing));
      return;
    }

    const total = existing.total != null ? parseFloat(existing.total) : 0;
    const updates: Record<string, unknown> = {
      paymentStatus: "paid",
      paymentMethod: method,
      paymentRecordedAt: new Date(),
      cashReceived: null,
      changeDue: null,
      paymentOverrideReason: null,
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

    const [updated] = await db
      .update(eventOrdersTable)
      .set(updates)
      .where(eq(eventOrdersTable.id, id))
      .returning();

    // Fire SMS confirmation now that payment is recorded — same shape as the
    // original POST flow, but only after the customer has actually paid.
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
    req.log.error({ err }, "Error recording payment");
    res.status(500).json({ error: "Failed to record payment" });
  }
});

// Override — send an unpaid order to the kitchen anyway.
router.patch("/event-taker/orders/:id/override", verifyTakerPassword, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
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
    if (existing.orderSource !== "staff") {
      res.status(400).json({ error: "Only staff (POS) orders can be overridden" });
      return;
    }
    if (existing.paymentStatus !== "unpaid") {
      res.json(serializeOrder(existing));
      return;
    }

    const [updated] = await db
      .update(eventOrdersTable)
      .set({
        paymentStatus: "override",
        paymentMethod: null,
        paymentRecordedAt: new Date(),
        paymentOverrideReason: reason?.trim() ? reason.trim().slice(0, 500) : null,
      })
      .where(eq(eventOrdersTable.id, id))
      .returning();

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
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }

    await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(eventOrdersTable).where(eq(eventOrdersTable.id, id)).for("update");
      if (!existing) throw Object.assign(new Error("Order not found"), { status: 404 });
      if (existing.orderSource !== "staff") {
        throw Object.assign(new Error("Only staff orders can be cancelled here"), { status: 400 });
      }
      if (existing.paymentStatus !== "unpaid") {
        throw Object.assign(new Error("Order has already been sent to the kitchen and cannot be cancelled here"), { status: 409 });
      }

      // Restore stock for items that have a stock cap.
      const items = (existing.items ?? []) as { itemId: number; quantity: number }[];
      const itemIds = items.map(i => i.itemId);
      if (itemIds.length > 0) {
        const rows = await tx
          .select({ id: menuItemsTable.id, eventStock: menuItemsTable.eventStock })
          .from(menuItemsTable)
          .where(inArray(menuItemsTable.id, itemIds))
          .for("update");
        const stockMap = new Map(rows.map(r => [r.id, r.eventStock]));
        for (const line of items) {
          if (stockMap.get(line.itemId) !== null && stockMap.get(line.itemId) !== undefined) {
            await tx
              .update(menuItemsTable)
              .set({ eventStock: sql`event_stock + ${line.quantity}` })
              .where(eq(menuItemsTable.id, line.itemId));
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
