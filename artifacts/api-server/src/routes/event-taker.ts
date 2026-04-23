import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { menuItemsTable, eventOrdersTable, eventSettingsTable } from "@workspace/db/schema";
import { eq, sql, inArray } from "drizzle-orm";
import { sendOrderConfirmation } from "../lib/sms";

const router: IRouter = Router();

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
        })
        .returning();
      return created;
    });

    if (order.phoneNumber) {
      const eventName = settings?.eventName ?? "";
      const orderStatusUrl = statusUrlBase
        ? `${statusUrlBase}/event/order/${order.id}`
        : `${req.protocol}://${req.get("host")}/event/order/${order.id}`;
      sendOrderConfirmation({
        guestName: order.guestName,
        orderId: order.id,
        phoneNumber: order.phoneNumber,
        eventName,
        orderStatusUrl,
      }).catch(() => {});
    }

    res.status(201).json({
      ...order,
      subtotal: order.subtotal != null ? parseFloat(order.subtotal) : null,
      taxRate: order.taxRate != null ? parseFloat(order.taxRate) : null,
      taxAmount: order.taxAmount != null ? parseFloat(order.taxAmount) : null,
      total: order.total != null ? parseFloat(order.total) : null,
    });
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

export default router;
