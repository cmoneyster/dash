import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { menuItemsTable, menuCategoriesTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";

const router: IRouter = Router();

router.get("/menu", async (req, res) => {
  try {
    const { category, available } = req.query;
    let items = await db.select().from(menuItemsTable);

    // Exclude items whose category is hidden (or whose category row exists & is invisible).
    const cats = await db.select().from(menuCategoriesTable);
    const hidden = new Set(cats.filter((c) => !c.visible).map((c) => c.name));
    if (hidden.size > 0) items = items.filter((i) => !hidden.has(i.category));

    if (category && typeof category === "string") {
      items = items.filter((i) => i.category === category);
    }
    if (available !== undefined) {
      const avail = available === "true";
      items = items.filter((i) => i.available === avail);
    }

    const formatted = items.map(({ internalNotes: _notes, ...item }) => ({
      ...item,
      price: parseFloat(item.price),
      allergens: item.allergens ?? [],
    }));
    res.json(formatted);
  } catch (err) {
    req.log.error({ err }, "Error listing menu items");
    res.status(500).json({ error: "Failed to list menu items" });
  }
});

router.get("/menu/:id", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    const [item] = await db.select().from(menuItemsTable).where(eq(menuItemsTable.id, id));
    if (!item) {
      res.status(404).json({ error: "Menu item not found" });
      return;
    }
    const { internalNotes: _notes, ...pub } = item;
    res.json({ ...pub, price: parseFloat(pub.price), allergens: pub.allergens ?? [] });
  } catch (err) {
    req.log.error({ err }, "Error getting menu item");
    res.status(500).json({ error: "Failed to get menu item" });
  }
});

export default router;
