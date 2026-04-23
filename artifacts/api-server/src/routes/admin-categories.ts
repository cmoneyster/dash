import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { menuCategoriesTable, menuItemsTable } from "@workspace/db/schema";
import { asc, eq, sql, and, ne } from "drizzle-orm";

const router: IRouter = Router();

const VALID_PLANNER_GROUPS = new Set(["savory", "sweet", "entree", "other"]);

function formatCategory(c: typeof menuCategoriesTable.$inferSelect) {
  return {
    id: c.id,
    name: c.name,
    sortOrder: c.sortOrder,
    visible: c.visible,
    plannerGroup: c.plannerGroup,
  };
}

router.get("/admin/categories", async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(menuCategoriesTable)
      .orderBy(asc(menuCategoriesTable.sortOrder), asc(menuCategoriesTable.id));
    const counts = await db
      .select({ category: menuItemsTable.category, count: sql<number>`count(*)::int` })
      .from(menuItemsTable)
      .groupBy(menuItemsTable.category);
    const countByName = new Map(counts.map((c) => [c.category, Number(c.count)]));
    res.json(rows.map((c) => ({ ...formatCategory(c), itemCount: countByName.get(c.name) ?? 0 })));
  } catch (err) {
    req.log.error({ err }, "Error listing admin categories");
    res.status(500).json({ error: "Failed to list categories" });
  }
});

router.post("/admin/categories", async (req, res): Promise<void> => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const plannerGroup = String(req.body?.plannerGroup ?? "other");
    const visible = req.body?.visible !== false;
    if (!name) {
      res.status(400).json({ error: "Name is required" });
      return;
    }
    if (!VALID_PLANNER_GROUPS.has(plannerGroup)) {
      res.status(400).json({ error: "Invalid plannerGroup" });
      return;
    }
    const [existing] = await db
      .select()
      .from(menuCategoriesTable)
      .where(eq(menuCategoriesTable.name, name));
    if (existing) {
      res.status(409).json({ error: "Category with that name already exists" });
      return;
    }

    const [maxRow] = await db
      .select({ max: sql<number>`COALESCE(MAX(${menuCategoriesTable.sortOrder}), -1)` })
      .from(menuCategoriesTable);
    const nextSort = Number(maxRow?.max ?? -1) + 1;

    const [created] = await db
      .insert(menuCategoriesTable)
      .values({ name, plannerGroup, visible, sortOrder: nextSort })
      .returning();
    res.status(201).json({ ...formatCategory(created), itemCount: 0 });
  } catch (err) {
    req.log.error({ err }, "Error creating category");
    res.status(500).json({ error: "Failed to create category" });
  }
});

router.patch("/admin/categories/:id", async (req, res): Promise<void> => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [current] = await db.select().from(menuCategoriesTable).where(eq(menuCategoriesTable.id, id));
    if (!current) {
      res.status(404).json({ error: "Category not found" });
      return;
    }

    const updates: Record<string, unknown> = {};
    let renameFrom: string | null = null;
    let renameTo: string | null = null;

    if (req.body?.name !== undefined) {
      const newName = String(req.body.name).trim();
      if (!newName) {
        res.status(400).json({ error: "Name cannot be empty" });
        return;
      }
      if (newName !== current.name) {
        const [conflict] = await db
          .select()
          .from(menuCategoriesTable)
          .where(and(eq(menuCategoriesTable.name, newName), ne(menuCategoriesTable.id, id)));
        if (conflict) {
          res.status(409).json({ error: "Another category already uses that name" });
          return;
        }
        renameFrom = current.name;
        renameTo = newName;
        updates.name = newName;
      }
    }
    if (req.body?.plannerGroup !== undefined) {
      const pg = String(req.body.plannerGroup);
      if (!VALID_PLANNER_GROUPS.has(pg)) {
        res.status(400).json({ error: "Invalid plannerGroup" });
        return;
      }
      updates.plannerGroup = pg;
    }
    if (req.body?.visible !== undefined) updates.visible = !!req.body.visible;
    if (req.body?.sortOrder !== undefined) {
      const so = parseInt(String(req.body.sortOrder), 10);
      if (isNaN(so)) {
        res.status(400).json({ error: "Invalid sortOrder" });
        return;
      }
      updates.sortOrder = so;
    }

    const result = await db.transaction(async (tx) => {
      const [row] = Object.keys(updates).length
        ? await tx.update(menuCategoriesTable).set(updates).where(eq(menuCategoriesTable.id, id)).returning()
        : await tx.select().from(menuCategoriesTable).where(eq(menuCategoriesTable.id, id));
      if (renameFrom && renameTo) {
        await tx
          .update(menuItemsTable)
          .set({ category: renameTo })
          .where(eq(menuItemsTable.category, renameFrom));
      }
      return row;
    });

    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(menuItemsTable)
      .where(eq(menuItemsTable.category, result.name));

    res.json({ ...formatCategory(result), itemCount: Number(countRow?.count ?? 0) });
  } catch (err) {
    req.log.error({ err }, "Error updating category");
    res.status(500).json({ error: "Failed to update category" });
  }
});

router.delete("/admin/categories/:id", async (req, res): Promise<void> => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [current] = await db.select().from(menuCategoriesTable).where(eq(menuCategoriesTable.id, id));
    if (!current) {
      res.status(404).json({ error: "Category not found" });
      return;
    }

    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(menuItemsTable)
      .where(eq(menuItemsTable.category, current.name));
    if (Number(countRow?.count ?? 0) > 0) {
      res.status(409).json({ error: "Category still has menu items. Remove or reassign them first." });
      return;
    }

    await db.delete(menuCategoriesTable).where(eq(menuCategoriesTable.id, id));
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Error deleting category");
    res.status(500).json({ error: "Failed to delete category" });
  }
});

router.post("/admin/categories/reorder", async (req, res): Promise<void> => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!items) {
      res.status(400).json({ error: "items array required" });
      return;
    }
    await db.transaction(async (tx) => {
      for (const it of items) {
        const id = parseInt(String(it.id), 10);
        const so = parseInt(String(it.sortOrder), 10);
        if (isNaN(id) || isNaN(so)) continue;
        await tx.update(menuCategoriesTable).set({ sortOrder: so }).where(eq(menuCategoriesTable.id, id));
      }
    });
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Error reordering categories");
    res.status(500).json({ error: "Failed to reorder categories" });
  }
});

export default router;
