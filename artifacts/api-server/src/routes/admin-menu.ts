import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { menuItemsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

router.get("/admin/menu", async (req, res) => {
  try {
    const items = await db.select().from(menuItemsTable).orderBy(menuItemsTable.createdAt);
    res.json(items.map((item) => ({
      ...item,
      price: parseFloat(item.price),
      tier2Price: item.tier2Price != null ? parseFloat(item.tier2Price) : null,
      tier3Price: item.tier3Price != null ? parseFloat(item.tier3Price) : null,
      allergens: item.allergens ?? [],
    })));
  } catch (err) {
    req.log.error({ err }, "Error listing admin menu items");
    res.status(500).json({ error: "Failed to list menu items" });
  }
});

router.post("/admin/menu", async (req, res) => {
  try {
    const {
      name, description, category, price, servingSize, unit,
      imageUrl, allergens, available, prepTime,
      minimumOrderQty,
      tier2Qty, tier2Price, tier3Qty, tier3Price,
      eventActive, eventStock,
    } = req.body;
    const [item] = await db.insert(menuItemsTable).values({
      name,
      description,
      category,
      price: String(price),
      servingSize: servingSize ?? 1,
      unit: unit ?? "tray",
      imageUrl: imageUrl ?? null,
      allergens: allergens ?? [],
      available: available ?? true,
      prepTime: prepTime ?? null,
      minimumOrderQty: minimumOrderQty != null ? parseInt(String(minimumOrderQty)) : 1,
      tier2Qty: tier2Qty != null ? parseInt(String(tier2Qty)) : null,
      tier2Price: tier2Price != null ? String(tier2Price) : null,
      tier3Qty: tier3Qty != null ? parseInt(String(tier3Qty)) : null,
      tier3Price: tier3Price != null ? String(tier3Price) : null,
      eventActive: eventActive ?? false,
      eventStock: eventStock != null ? parseInt(String(eventStock)) : null,
    }).returning();
    res.status(201).json({
      ...item,
      price: parseFloat(item.price),
      tier2Price: item.tier2Price != null ? parseFloat(item.tier2Price) : null,
      tier3Price: item.tier3Price != null ? parseFloat(item.tier3Price) : null,
      allergens: item.allergens ?? [],
    });
  } catch (err) {
    req.log.error({ err }, "Error creating menu item");
    res.status(500).json({ error: "Failed to create menu item" });
  }
});

router.put("/admin/menu/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const {
      name, description, category, price, servingSize, unit,
      imageUrl, allergens, available, prepTime,
      minimumOrderQty,
      tier2Qty, tier2Price, tier3Qty, tier3Price,
      eventActive, eventStock,
    } = req.body;
    const updates: Record<string, unknown> = {};
    if (name !== undefined)             updates.name = name;
    if (description !== undefined)      updates.description = description;
    if (category !== undefined)         updates.category = category;
    if (price !== undefined)            updates.price = String(price);
    if (servingSize !== undefined)      updates.servingSize = servingSize;
    if (unit !== undefined)             updates.unit = unit;
    if (imageUrl !== undefined)         updates.imageUrl = imageUrl;
    if (allergens !== undefined)        updates.allergens = allergens;
    if (available !== undefined)        updates.available = available;
    if (prepTime !== undefined)         updates.prepTime = prepTime;
    if (minimumOrderQty !== undefined)  updates.minimumOrderQty = minimumOrderQty != null ? parseInt(String(minimumOrderQty)) : 1;
    if (tier2Qty !== undefined)         updates.tier2Qty = tier2Qty === null ? null : parseInt(String(tier2Qty));
    if (tier2Price !== undefined)       updates.tier2Price = tier2Price === null ? null : String(tier2Price);
    if (tier3Qty !== undefined)         updates.tier3Qty = tier3Qty === null ? null : parseInt(String(tier3Qty));
    if (tier3Price !== undefined)       updates.tier3Price = tier3Price === null ? null : String(tier3Price);
    if (eventActive !== undefined)      updates.eventActive = eventActive;
    if (eventStock !== undefined)       updates.eventStock = eventStock === null ? null : parseInt(String(eventStock));

    const [item] = await db.update(menuItemsTable).set(updates).where(eq(menuItemsTable.id, id)).returning();
    if (!item) return res.status(404).json({ error: "Menu item not found" });
    res.json({
      ...item,
      price: parseFloat(item.price),
      tier2Price: item.tier2Price != null ? parseFloat(item.tier2Price) : null,
      tier3Price: item.tier3Price != null ? parseFloat(item.tier3Price) : null,
      allergens: item.allergens ?? [],
    });
  } catch (err) {
    req.log.error({ err }, "Error updating menu item");
    res.status(500).json({ error: "Failed to update menu item" });
  }
});

router.delete("/admin/menu/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [deleted] = await db.delete(menuItemsTable).where(eq(menuItemsTable.id, id)).returning();
    if (!deleted) return res.status(404).json({ error: "Menu item not found" });
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Error deleting menu item");
    res.status(500).json({ error: "Failed to delete menu item" });
  }
});

export default router;
