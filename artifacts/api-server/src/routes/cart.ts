import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { cartItemsTable, menuItemsTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";

const router: IRouter = Router();

async function getCartData(sessionId: string) {
  const items = await db
    .select()
    .from(cartItemsTable)
    .innerJoin(menuItemsTable, eq(cartItemsTable.menuItemId, menuItemsTable.id))
    .where(eq(cartItemsTable.sessionId, sessionId));

  const cartItems = items.map((row) => ({
    id: row.cart_items.id,
    menuItemId: row.cart_items.menuItemId,
    quantity: row.cart_items.quantity,
    menuItem: {
      ...row.menu_items,
      price: parseFloat(row.menu_items.price),
      allergens: row.menu_items.allergens ?? [],
    },
  }));

  const total = cartItems.reduce((sum, item) => sum + item.menuItem.price * item.quantity, 0);
  return { sessionId, items: cartItems, total };
}

router.get("/cart", async (req, res) => {
  try {
    const { sessionId } = req.query as { sessionId: string };
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    const cart = await getCartData(sessionId);
    res.json(cart);
  } catch (err) {
    req.log.error({ err }, "Error getting cart");
    res.status(500).json({ error: "Failed to get cart" });
  }
});

router.post("/cart", async (req, res) => {
  try {
    const { sessionId, menuItemId, quantity } = req.body;
    if (!sessionId || !menuItemId) return res.status(400).json({ error: "sessionId and menuItemId required" });

    // Check if item already in cart
    const [existing] = await db
      .select()
      .from(cartItemsTable)
      .where(and(eq(cartItemsTable.sessionId, sessionId), eq(cartItemsTable.menuItemId, menuItemId)));

    if (existing) {
      await db
        .update(cartItemsTable)
        .set({ quantity: existing.quantity + (quantity ?? 1) })
        .where(eq(cartItemsTable.id, existing.id));
    } else {
      await db.insert(cartItemsTable).values({ sessionId, menuItemId, quantity: quantity ?? 1 });
    }

    const cart = await getCartData(sessionId);
    res.json(cart);
  } catch (err) {
    req.log.error({ err }, "Error adding to cart");
    res.status(500).json({ error: "Failed to add to cart" });
  }
});

router.put("/cart/:itemId", async (req, res) => {
  try {
    const itemId = parseInt(req.params.itemId);
    const { sessionId, quantity } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    await db.update(cartItemsTable).set({ quantity }).where(and(eq(cartItemsTable.id, itemId), eq(cartItemsTable.sessionId, sessionId)));

    const cart = await getCartData(sessionId);
    res.json(cart);
  } catch (err) {
    req.log.error({ err }, "Error updating cart item");
    res.status(500).json({ error: "Failed to update cart item" });
  }
});

router.delete("/cart/:itemId", async (req, res) => {
  try {
    const itemId = parseInt(req.params.itemId);
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    await db.delete(cartItemsTable).where(and(eq(cartItemsTable.id, itemId), eq(cartItemsTable.sessionId, sessionId)));

    const cart = await getCartData(sessionId);
    res.json(cart);
  } catch (err) {
    req.log.error({ err }, "Error removing from cart");
    res.status(500).json({ error: "Failed to remove from cart" });
  }
});

export default router;
