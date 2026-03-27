import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { menuItemsTable, eventOrdersTable, eventSettingsTable, eventSessionsTable } from "@workspace/db/schema";
import { eq, desc, and, sql } from "drizzle-orm";
import { sendOrderConfirmation, sendOrderReady } from "../lib/sms";

const router: IRouter = Router();

async function getEventSettings() {
  const [settings] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
  return settings ?? null;
}

// Guest ordering password — stored as eventPassword in DB
async function resolveOrderPassword(): Promise<string | null> {
  const settings = await getEventSettings();
  if (settings?.eventPassword) return settings.eventPassword;
  return process.env.EVENT_PASSWORD ?? null;
}

// Kitchen display password — uses kitchenPassword if set, falls back to order password
async function resolveKitchenPassword(): Promise<string | null> {
  const settings = await getEventSettings();
  if (settings?.kitchenPassword) return settings.kitchenPassword;
  if (settings?.eventPassword) return settings.eventPassword;
  return process.env.EVENT_PASSWORD ?? null;
}

function makeAuthMiddleware(resolvePwd: () => Promise<string | null>) {
  return async function (req: Request, res: Response, next: NextFunction) {
    const password = await resolvePwd();
    if (!password) {
      res.status(503).json({ error: "Event ordering is not configured" });
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
}

const verifyOrderPassword = makeAuthMiddleware(resolveOrderPassword);
const verifyKitchenPassword = makeAuthMiddleware(resolveKitchenPassword);

router.get("/event-ordering/settings", async (req, res) => {
  try {
    const settings = await getEventSettings();
    let activeSessionName: string | null = null;
    if (settings?.activeEventSessionId) {
      const [session] = await db
        .select({ name: eventSessionsTable.name })
        .from(eventSessionsTable)
        .where(eq(eventSessionsTable.id, settings.activeEventSessionId));
      activeSessionName = session?.name ?? null;
    }
    res.json({
      eventName: settings?.eventName ?? "",
      activeSessionId: settings?.activeEventSessionId ?? null,
      activeSessionName,
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching event settings");
    res.status(500).json({ error: "Failed to fetch event settings" });
  }
});

// Kitchen can create a new session (uses kitchen password, not admin token)
router.post("/event-ordering/create-session", verifyKitchenPassword, async (req, res) => {
  try {
    const settings = await getEventSettings();
    const name = settings?.eventName?.trim() || "Unnamed Event";
    const today = new Date().toISOString().split("T")[0];

    const [session] = await db
      .insert(eventSessionsTable)
      .values({ name, date: today })
      .returning();

    if (settings) {
      await db
        .update(eventSettingsTable)
        .set({ activeEventSessionId: session.id, updatedAt: new Date() })
        .where(eq(eventSettingsTable.id, 1));
    } else {
      await db.insert(eventSettingsTable).values({ id: 1, eventName: name, activeEventSessionId: session.id });
    }

    res.status(201).json(session);
  } catch (err) {
    req.log.error({ err }, "Error creating session from kitchen");
    res.status(500).json({ error: "Failed to create session" });
  }
});

router.post("/event-ordering/verify", async (req, res) => {
  const { password, role } = req.body as { password?: string; role?: string };
  const resolve = role === "kitchen" ? resolveKitchenPassword : resolveOrderPassword;
  const expected = await resolve();
  if (!expected) {
    res.status(503).json({ error: "Event ordering is not configured" });
    return;
  }
  if (!password || password !== expected) {
    res.status(401).json({ error: "Invalid password" });
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

router.post("/event-ordering/orders", verifyOrderPassword, async (req, res) => {
  try {
    const { guestName, phoneNumber, items, statusUrlBase } = req.body;
    if (!guestName || !items?.length) {
      res.status(400).json({ error: "guestName and items are required" });
      return;
    }

    type OrderItem = { itemId: number; name: string; quantity: number; price: number };

    const order = await db.transaction(async (tx) => {
      for (const item of items as OrderItem[]) {
        const [row] = await tx
          .select({ id: menuItemsTable.id, name: menuItemsTable.name, eventStock: menuItemsTable.eventStock })
          .from(menuItemsTable)
          .where(eq(menuItemsTable.id, item.itemId))
          .for("update");
        if (!row) throw Object.assign(new Error(`Item ${item.itemId} not found`), { status: 404 });
        if (row.eventStock !== null) {
          if (row.eventStock < item.quantity) {
            throw Object.assign(
              new Error(`Only ${row.eventStock} of "${row.name}" remaining`),
              { status: 409, remaining: row.eventStock, itemId: item.itemId }
            );
          }
          await tx
            .update(menuItemsTable)
            .set({ eventStock: sql`event_stock - ${item.quantity}` })
            .where(eq(menuItemsTable.id, item.itemId));
        }
      }

      const activeSettings = await tx.select({ activeEventSessionId: eventSettingsTable.activeEventSessionId }).from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
      const activeEventSessionId = activeSettings[0]?.activeEventSessionId ?? null;

      const [created] = await tx
        .insert(eventOrdersTable)
        .values({
          guestName,
          phoneNumber: phoneNumber?.trim() || null,
          items,
          status: "pending",
          eventSessionId: activeEventSessionId,
        })
        .returning();
      return created;
    });

    if (order.phoneNumber) {
      const settings = await getEventSettings();
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

    res.status(201).json(order);
  } catch (err: any) {
    if (err?.status === 409) {
      res.status(409).json({ error: err.message, remaining: err.remaining, itemId: err.itemId });
      return;
    }
    req.log.error({ err }, "Error creating event order");
    res.status(500).json({ error: "Failed to create event order" });
  }
});

router.get("/event-ordering/orders", verifyKitchenPassword, async (req, res) => {
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

router.patch("/event-ordering/orders/:id/status", verifyKitchenPassword, async (req, res) => {
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

    if (status === "ready" && updated.phoneNumber) {
      const settings = await getEventSettings();
      sendOrderReady({
        guestName: updated.guestName,
        orderId: updated.id,
        phoneNumber: updated.phoneNumber,
        eventName: settings?.eventName ?? "",
      }).catch(() => {});
    }

    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Error updating event order status");
    res.status(500).json({ error: "Failed to update order status" });
  }
});

// Stock management — kitchen password required
router.get("/event-ordering/stock", verifyKitchenPassword, async (req, res) => {
  try {
    const items = await db
      .select({
        id: menuItemsTable.id,
        name: menuItemsTable.name,
        category: menuItemsTable.category,
        eventStock: menuItemsTable.eventStock,
        imageUrl: menuItemsTable.imageUrl,
      })
      .from(menuItemsTable)
      .where(eq(menuItemsTable.eventActive, true))
      .orderBy(menuItemsTable.category, menuItemsTable.name);
    res.json(items);
  } catch (err) {
    req.log.error({ err }, "Error fetching event stock");
    res.status(500).json({ error: "Failed to fetch stock" });
  }
});

router.patch("/event-ordering/stock/:itemId", verifyKitchenPassword, async (req, res) => {
  try {
    const itemId = parseInt(req.params.itemId);
    const { eventStock } = req.body as { eventStock: number | null };
    const stock = eventStock === null ? null : Math.max(0, parseInt(String(eventStock)));
    const [item] = await db
      .update(menuItemsTable)
      .set({ eventStock: stock })
      .where(and(eq(menuItemsTable.id, itemId), eq(menuItemsTable.eventActive, true)))
      .returning({ id: menuItemsTable.id, name: menuItemsTable.name, eventStock: menuItemsTable.eventStock });
    if (!item) return res.status(404).json({ error: "Item not found or not event-active" });
    res.json(item);
  } catch (err) {
    req.log.error({ err }, "Error updating event stock");
    res.status(500).json({ error: "Failed to update stock" });
  }
});

export default router;
