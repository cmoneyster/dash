import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { cartItemsTable, menuItemsTable } from "@workspace/db/schema";
import { eq, and, isNull } from "drizzle-orm";

const router: IRouter = Router();

function getEffectivePrice(
  item: {
    price: string;
    tier2Qty: number | null;
    tier2Price: string | null;
    tier3Qty: number | null;
    tier3Price: string | null;
  },
  qty: number,
  sizePrice?: number | null,
): number {
  if (sizePrice != null) return sizePrice;
  const base = parseFloat(item.price);
  const t2q = item.tier2Qty;
  const t2p = item.tier2Price ? parseFloat(item.tier2Price) : null;
  const t3q = item.tier3Qty;
  const t3p = item.tier3Price ? parseFloat(item.tier3Price) : null;
  if (t3q && t3p && qty >= t3q) return t3p;
  if (t2q && t2p && qty >= t2q) return t2p;
  return base;
}

async function getCartData(sessionId: string) {
  const rows = await db
    .select()
    .from(cartItemsTable)
    .innerJoin(menuItemsTable, eq(cartItemsTable.menuItemId, menuItemsTable.id))
    .where(eq(cartItemsTable.sessionId, sessionId));

  const cartItems = rows.map((row) => {
    const qty = row.cart_items.quantity;
    const sizePrice = row.cart_items.sizePrice ? parseFloat(row.cart_items.sizePrice) : null;
    const effectivePrice = getEffectivePrice(row.menu_items, qty, sizePrice);
    return {
      id: row.cart_items.id,
      menuItemId: row.cart_items.menuItemId,
      quantity: qty,
      effectivePrice,
      sizeSlot: row.cart_items.sizeSlot ?? null,
      sizeLabel: row.cart_items.sizeLabel ?? null,
      sizePrice,
      menuItem: {
        ...row.menu_items,
        price: parseFloat(row.menu_items.price),
        tier2Price: row.menu_items.tier2Price ? parseFloat(row.menu_items.tier2Price) : null,
        tier3Price: row.menu_items.tier3Price ? parseFloat(row.menu_items.tier3Price) : null,
        allergens: row.menu_items.allergens ?? [],
      },
    };
  });

  const total = cartItems.reduce((sum, item) => sum + item.effectivePrice * item.quantity, 0);
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
    const { sessionId, menuItemId, quantity, sizeSlot } = req.body;
    if (!sessionId || !menuItemId) return res.status(400).json({ error: "sessionId and menuItemId required" });

    const [menuItem] = await db.select().from(menuItemsTable).where(eq(menuItemsTable.id, menuItemId));
    if (!menuItem) return res.status(404).json({ error: "Menu item not found" });

    const requestedQty = quantity ?? 1;
    const minQty = menuItem.minimumOrderQty ?? 1;

    const slotNum: number | null = sizeSlot != null ? Number(sizeSlot) : null;

    // Derive sizePrice server-side from menu item — never trust client-supplied price
    let slotPriceNum: string | null = null;
    if (slotNum != null && slotNum >= 1 && slotNum <= 5) {
      const slotPriceField = `size${slotNum}Price` as keyof typeof menuItem;
      const rawPrice = menuItem[slotPriceField];
      if (rawPrice != null) slotPriceNum = String(rawPrice);
    }

    // Validate that slotNum refers to a defined size slot for pan_sizes items
    if (slotNum != null && slotPriceNum == null) {
      return res.status(400).json({ error: `Size slot ${slotNum} is not defined for this item` });
    }

    // Derive sizeLabel server-side as well
    let derivedLabel: string | null = null;
    if (slotNum != null && slotNum >= 1 && slotNum <= 5) {
      const slotLabelField = `size${slotNum}Label` as keyof typeof menuItem;
      derivedLabel = (menuItem[slotLabelField] as string | null) ?? null;
    }

    let existing;
    if (slotNum != null) {
      [existing] = await db
        .select()
        .from(cartItemsTable)
        .where(and(
          eq(cartItemsTable.sessionId, sessionId),
          eq(cartItemsTable.menuItemId, menuItemId),
          eq(cartItemsTable.sizeSlot, slotNum),
        ));
    } else {
      [existing] = await db
        .select()
        .from(cartItemsTable)
        .where(and(
          eq(cartItemsTable.sessionId, sessionId),
          eq(cartItemsTable.menuItemId, menuItemId),
          isNull(cartItemsTable.sizeSlot),
        ));
    }

    if (existing) {
      const newQty = existing.quantity + requestedQty;
      if (newQty < minQty) return res.status(400).json({ error: `Minimum order quantity is ${minQty}` });
      await db.update(cartItemsTable).set({ quantity: newQty }).where(eq(cartItemsTable.id, existing.id));
    } else {
      const addQty = Math.max(requestedQty, minQty);
      await db.insert(cartItemsTable).values({
        sessionId,
        menuItemId,
        quantity: addQty,
        sizeSlot: slotNum,
        sizeLabel: derivedLabel,
        sizePrice: slotPriceNum,
      });
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

    const [cartItem] = await db.select().from(cartItemsTable).where(eq(cartItemsTable.id, itemId));
    if (cartItem) {
      const [menuItem] = await db.select().from(menuItemsTable).where(eq(menuItemsTable.id, cartItem.menuItemId));
      const minQty = menuItem?.minimumOrderQty ?? 1;
      if (quantity < minQty) return res.status(400).json({ error: `Minimum order quantity is ${minQty}` });
    }

    await db.update(cartItemsTable).set({ quantity }).where(and(eq(cartItemsTable.id, itemId), eq(cartItemsTable.sessionId, sessionId)));
    const cart = await getCartData(sessionId);
    res.json(cart);
  } catch (err) {
    req.log.error({ err }, "Error updating cart item");
    res.status(500).json({ error: "Failed to update cart item" });
  }
});

router.delete("/cart", async (req, res) => {
  try {
    const sessionId: string | undefined = req.body?.sessionId || (req.query.sessionId as string | undefined);
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    await db.delete(cartItemsTable).where(eq(cartItemsTable.sessionId, sessionId));
    res.json({ sessionId, items: [], total: 0 });
  } catch (err) {
    req.log.error({ err }, "Error clearing cart");
    res.status(500).json({ error: "Failed to clear cart" });
  }
});

router.delete("/cart/:itemId", async (req, res) => {
  try {
    const itemId = parseInt(req.params.itemId);
    const sessionId: string | undefined = req.body?.sessionId || (req.query.sessionId as string | undefined);

    const [cartItem] = await db.select().from(cartItemsTable).where(eq(cartItemsTable.id, itemId));
    if (!cartItem) return res.status(404).json({ error: "Cart item not found" });

    const effectiveSessionId = sessionId ?? cartItem.sessionId;
    await db.delete(cartItemsTable).where(eq(cartItemsTable.id, itemId));
    const cart = await getCartData(effectiveSessionId);
    res.json(cart);
  } catch (err) {
    req.log.error({ err }, "Error removing from cart");
    res.status(500).json({ error: "Failed to remove from cart" });
  }
});

export default router;
