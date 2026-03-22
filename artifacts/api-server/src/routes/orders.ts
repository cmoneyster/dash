import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { ordersTable, orderItemsTable, cartItemsTable, menuItemsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

async function getOrderWithItems(orderId: number) {
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
  if (!order) return null;
  const items = await db.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, orderId));
  return {
    ...order,
    total: parseFloat(order.total),
    items: items.map((i) => ({ ...i, price: parseFloat(i.price) })),
  };
}

router.post("/orders", async (req, res) => {
  try {
    const {
      sessionId, customerName, customerEmail, customerPhone,
      eventDate, eventType, guestCount, serviceStyle, deliveryNotes
    } = req.body;

    if (!sessionId || !customerName || !customerEmail) {
      return res.status(400).json({ error: "sessionId, customerName, and customerEmail are required" });
    }

    // Get cart items
    const cartItems = await db
      .select()
      .from(cartItemsTable)
      .innerJoin(menuItemsTable, eq(cartItemsTable.menuItemId, menuItemsTable.id))
      .where(eq(cartItemsTable.sessionId, sessionId));

    if (cartItems.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    const total = cartItems.reduce(
      (sum, row) => sum + parseFloat(row.menu_items.price) * row.cart_items.quantity,
      0
    );

    const [order] = await db.insert(ordersTable).values({
      sessionId,
      customerName,
      customerEmail,
      customerPhone: customerPhone ?? null,
      eventDate: eventDate ?? null,
      eventType: eventType ?? null,
      guestCount: guestCount ?? null,
      serviceStyle: serviceStyle ?? null,
      deliveryNotes: deliveryNotes ?? null,
      status: "pending",
      total: String(total),
    }).returning();

    // Insert order items
    await db.insert(orderItemsTable).values(
      cartItems.map((row) => ({
        orderId: order.id,
        menuItemId: row.menu_items.id,
        menuItemName: row.menu_items.name,
        price: row.menu_items.price,
        quantity: row.cart_items.quantity,
      }))
    );

    // Clear the cart
    await db.delete(cartItemsTable).where(eq(cartItemsTable.sessionId, sessionId));

    const result = await getOrderWithItems(order.id);
    res.status(201).json(result);
  } catch (err) {
    req.log.error({ err }, "Error creating order");
    res.status(500).json({ error: "Failed to create order" });
  }
});

router.get("/admin/orders", async (req, res) => {
  try {
    const orders = await db.select().from(ordersTable).orderBy(ordersTable.createdAt);
    const result = await Promise.all(orders.map((o) => getOrderWithItems(o.id)));
    res.json(result.filter(Boolean));
  } catch (err) {
    req.log.error({ err }, "Error listing orders");
    res.status(500).json({ error: "Failed to list orders" });
  }
});

router.put("/admin/orders/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: "status required" });

    const [updated] = await db.update(ordersTable).set({ status }).where(eq(ordersTable.id, id)).returning();
    if (!updated) return res.status(404).json({ error: "Order not found" });

    const result = await getOrderWithItems(id);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Error updating order status");
    res.status(500).json({ error: "Failed to update order status" });
  }
});

export default router;
