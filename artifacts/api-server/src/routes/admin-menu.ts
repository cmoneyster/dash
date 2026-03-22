import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { menuItemsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

router.get("/admin/menu", async (req, res) => {
  try {
    const items = await db.select().from(menuItemsTable).orderBy(menuItemsTable.createdAt);
    res.json(items.map((item) => ({ ...item, price: parseFloat(item.price), allergens: item.allergens ?? [] })));
  } catch (err) {
    req.log.error({ err }, "Error listing admin menu items");
    res.status(500).json({ error: "Failed to list menu items" });
  }
});

router.post("/admin/menu", async (req, res) => {
  try {
    const { name, description, category, price, servingSize, unit, imageUrl, allergens, available, prepTime } = req.body;
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
    }).returning();
    res.status(201).json({ ...item, price: parseFloat(item.price), allergens: item.allergens ?? [] });
  } catch (err) {
    req.log.error({ err }, "Error creating menu item");
    res.status(500).json({ error: "Failed to create menu item" });
  }
});

router.put("/admin/menu/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, description, category, price, servingSize, unit, imageUrl, allergens, available, prepTime } = req.body;
    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (category !== undefined) updates.category = category;
    if (price !== undefined) updates.price = String(price);
    if (servingSize !== undefined) updates.servingSize = servingSize;
    if (unit !== undefined) updates.unit = unit;
    if (imageUrl !== undefined) updates.imageUrl = imageUrl;
    if (allergens !== undefined) updates.allergens = allergens;
    if (available !== undefined) updates.available = available;
    if (prepTime !== undefined) updates.prepTime = prepTime;

    const [item] = await db.update(menuItemsTable).set(updates).where(eq(menuItemsTable.id, id)).returning();
    if (!item) return res.status(404).json({ error: "Menu item not found" });
    res.json({ ...item, price: parseFloat(item.price), allergens: item.allergens ?? [] });
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
