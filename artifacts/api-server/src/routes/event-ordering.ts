import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { menuItemsTable, eventOrdersTable, eventSettingsTable } from "@workspace/db/schema";
import { eq, desc } from "drizzle-orm";
import { sendOrderConfirmation, sendOrderReady } from "../lib/sms";

const router: IRouter = Router();

async function getEventSettings() {
  const [settings] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
  return settings ?? null;
}

async function resolveEventPassword(): Promise<string | null> {
  const settings = await getEventSettings();
  if (settings?.eventPassword) return settings.eventPassword;
  return process.env.EVENT_PASSWORD ?? null;
}

async function verifyEventPassword(req: Request, res: Response, next: NextFunction) {
  const eventPassword = await resolveEventPassword();
  if (!eventPassword) {
    res.status(503).json({ error: "Event ordering is not configured" });
    return;
  }
  const authHeader = req.headers["authorization"];
  const supplied = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!supplied || supplied !== eventPassword) {
    res.status(401).json({ error: "Invalid event password" });
    return;
  }
  next();
}

router.get("/event-ordering/settings", async (req, res) => {
  try {
    const settings = await getEventSettings();
    res.json({ eventName: settings?.eventName ?? "" });
  } catch (err) {
    req.log.error({ err }, "Error fetching event settings");
    res.status(500).json({ error: "Failed to fetch event settings" });
  }
});

router.post("/event-ordering/verify", async (req, res) => {
  const { password } = req.body as { password?: string };
  const eventPassword = await resolveEventPassword();
  if (!eventPassword) {
    res.status(503).json({ error: "Event ordering is not configured" });
    return;
  }
  if (!password || password !== eventPassword) {
    res.status(401).json({ error: "Invalid event password" });
    return;
  }
  res.json({ ok: true });
});

router.get("/event-ordering/menu", async (req, res) => {
  try {
    const items = await db
      .select()
      .from(menuItemsTable)
      .where(eq(menuItemsTable.eventActive, true));
    res.json(items);
  } catch (err) {
    req.log.error({ err }, "Error fetching event menu");
    res.status(500).json({ error: "Failed to fetch event menu" });
  }
});

router.post("/event-ordering/orders", verifyEventPassword, async (req, res) => {
  try {
    const { guestName, tableNumber, phoneNumber, items, statusUrlBase } = req.body;
    if (!guestName || !items?.length) {
      res.status(400).json({ error: "guestName and items are required" });
      return;
    }
    const [order] = await db
      .insert(eventOrdersTable)
      .values({
        guestName,
        tableNumber: tableNumber || null,
        phoneNumber: phoneNumber?.trim() || null,
        items,
        status: "pending",
      })
      .returning();

    // Fire-and-forget SMS confirmation
    if (order.phoneNumber) {
      const settings = await getEventSettings();
      const eventName = settings?.eventName ?? "";
      const fromNumber = settings?.twilioFromNumber || null;
      const orderStatusUrl = statusUrlBase
        ? `${statusUrlBase}/event/order/${order.id}`
        : `${req.protocol}://${req.get("host")}/event/order/${order.id}`;
      sendOrderConfirmation({
        guestName: order.guestName,
        orderId: order.id,
        phoneNumber: order.phoneNumber,
        eventName,
        orderStatusUrl,
        fromNumber,
      }).catch(() => {});
    }

    res.status(201).json(order);
  } catch (err) {
    req.log.error({ err }, "Error creating event order");
    res.status(500).json({ error: "Failed to create event order" });
  }
});

router.get("/event-ordering/orders", verifyEventPassword, async (req, res) => {
  try {
    const orders = await db
      .select()
      .from(eventOrdersTable)
      .orderBy(desc(eventOrdersTable.createdAt));
    res.json(orders);
  } catch (err) {
    req.log.error({ err }, "Error fetching event orders");
    res.status(500).json({ error: "Failed to fetch event orders" });
  }
});

// Public endpoint — no auth required — to check a single order's status
router.get("/event-ordering/orders/:id/public", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [order] = await db
      .select({
        id: eventOrdersTable.id,
        guestName: eventOrdersTable.guestName,
        status: eventOrdersTable.status,
        items: eventOrdersTable.items,
        createdAt: eventOrdersTable.createdAt,
      })
      .from(eventOrdersTable)
      .where(eq(eventOrdersTable.id, id));
    if (!order) return res.status(404).json({ error: "Order not found" });
    const settings = await getEventSettings();
    res.json({ ...order, eventName: settings?.eventName ?? "" });
  } catch (err) {
    req.log.error({ err }, "Error fetching public order");
    res.status(500).json({ error: "Failed to fetch order" });
  }
});

router.patch("/event-ordering/orders/:id/status", verifyEventPassword, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { status } = req.body as { status: string };
    const valid = ["pending", "preparing", "ready", "done"];
    if (!valid.includes(status)) {
      res.status(400).json({ error: "Invalid status" });
      return;
    }
    const [updated] = await db
      .update(eventOrdersTable)
      .set({ status })
      .where(eq(eventOrdersTable.id, id))
      .returning();

    // Fire-and-forget SMS when order becomes "ready"
    if (status === "ready" && updated.phoneNumber) {
      const settings = await getEventSettings();
      sendOrderReady({
        guestName: updated.guestName,
        orderId: updated.id,
        phoneNumber: updated.phoneNumber,
        eventName: settings?.eventName ?? "",
        fromNumber: settings?.twilioFromNumber || null,
      }).catch(() => {});
    }

    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Error updating event order status");
    res.status(500).json({ error: "Failed to update order status" });
  }
});

export default router;
