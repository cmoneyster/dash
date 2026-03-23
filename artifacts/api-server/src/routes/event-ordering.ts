import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { menuItemsTable, eventOrdersTable } from "@workspace/db/schema";
import { eq, desc } from "drizzle-orm";

const router: IRouter = Router();

function verifyEventPassword(req: Request, res: Response, next: NextFunction) {
  const eventPassword = process.env.EVENT_PASSWORD;
  if (!eventPassword) {
    res.status(503).json({ error: "Event ordering is not configured (EVENT_PASSWORD not set)" });
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

router.post("/event-ordering/verify", (req, res) => {
  const { password } = req.body as { password?: string };
  const eventPassword = process.env.EVENT_PASSWORD;
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
    const { guestName, tableNumber, items } = req.body;
    if (!guestName || !items?.length) {
      res.status(400).json({ error: "guestName and items are required" });
      return;
    }
    const [order] = await db
      .insert(eventOrdersTable)
      .values({ guestName, tableNumber: tableNumber || null, items, status: "pending" })
      .returning();
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
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Error updating event order status");
    res.status(500).json({ error: "Failed to update order status" });
  }
});

export default router;
