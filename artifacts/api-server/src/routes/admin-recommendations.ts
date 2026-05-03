import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  recommendedMenuItemsTable,
  menuItemsTable,
  menuCategoriesTable,
  ordersTable,
  orderItemsTable,
  eventOrdersTable,
  type EventOrderItem,
} from "@workspace/db/schema";
import { asc, eq, sql, isNull, ne } from "drizzle-orm";
import {
  AdminAddRecommendationBody,
  AdminReorderRecommendationsBody,
  AdminListTopSellersQueryParams,
  AdminSyncRecommendationsBody,
  AdminRemoveRecommendationParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

const TOP_SELLERS_DEFAULT_LIMIT = 12;
const TOP_SELLERS_MAX_LIMIT = 50;

type ListRow = {
  menuItemId: number;
  name: string;
  category: string;
  available: boolean;
  sortOrder: number;
  source: string;
};

async function listRecommendations(): Promise<ListRow[]> {
  const rows = await db
    .select({
      menuItemId: recommendedMenuItemsTable.menuItemId,
      sortOrder: recommendedMenuItemsTable.sortOrder,
      source: recommendedMenuItemsTable.source,
      name: menuItemsTable.name,
      category: menuItemsTable.category,
      available: menuItemsTable.available,
    })
    .from(recommendedMenuItemsTable)
    .innerJoin(menuItemsTable, eq(menuItemsTable.id, recommendedMenuItemsTable.menuItemId))
    .orderBy(asc(recommendedMenuItemsTable.sortOrder), asc(recommendedMenuItemsTable.menuItemId));
  return rows.map((r) => ({
    menuItemId: r.menuItemId,
    name: r.name,
    category: r.category,
    available: r.available,
    sortOrder: r.sortOrder,
    source: r.source,
  }));
}

// Aggregate quantities sold across real catering orders and real event
// (POS / on-site) orders. Demo orders are deliberately excluded — they're
// public sandbox submissions, not sales.
async function computeTopSellers(limit: number): Promise<
  { menuItemId: number; name: string; category: string; totalQuantity: number }[]
> {
  const safeLimit = Math.max(1, Math.min(limit, TOP_SELLERS_MAX_LIMIT));

  // Catering orders (drop-off / OTD) — flat order_items joined to orders
  // so we can drop cancelled orders.
  const cateringRows = await db
    .select({
      menuItemId: orderItemsTable.menuItemId,
      qty: sql<string>`COALESCE(SUM(${orderItemsTable.quantity}), 0)`,
    })
    .from(orderItemsTable)
    .innerJoin(ordersTable, eq(ordersTable.id, orderItemsTable.orderId))
    .where(ne(ordersTable.status, "cancelled"))
    .groupBy(orderItemsTable.menuItemId);

  const totals = new Map<number, number>();
  for (const r of cateringRows) {
    totals.set(r.menuItemId, (totals.get(r.menuItemId) ?? 0) + Number(r.qty ?? 0));
  }

  // Event orders — items live in a jsonb column; voidedAt rows are
  // excluded since they were pulled back by staff.
  const eventOrders = await db
    .select({ items: eventOrdersTable.items })
    .from(eventOrdersTable)
    .where(isNull(eventOrdersTable.voidedAt));
  for (const row of eventOrders) {
    const items = (row.items as EventOrderItem[] | null) ?? [];
    for (const it of items) {
      if (typeof it?.itemId !== "number" || typeof it?.quantity !== "number") continue;
      totals.set(it.itemId, (totals.get(it.itemId) ?? 0) + it.quantity);
    }
  }

  if (totals.size === 0) return [];

  // Resolve to live menu items (only available + visible category).
  const ids = Array.from(totals.keys());
  const items = await db
    .select({
      id: menuItemsTable.id,
      name: menuItemsTable.name,
      category: menuItemsTable.category,
      available: menuItemsTable.available,
    })
    .from(menuItemsTable)
    .where(sql`${menuItemsTable.id} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
  const cats = await db.select().from(menuCategoriesTable);
  const hidden = new Set(cats.filter((c) => !c.visible).map((c) => c.name));

  return items
    .filter((i) => i.available && !hidden.has(i.category))
    .map((i) => ({
      menuItemId: i.id,
      name: i.name,
      category: i.category,
      totalQuantity: totals.get(i.id) ?? 0,
    }))
    .sort((a, b) => b.totalQuantity - a.totalQuantity || a.name.localeCompare(b.name))
    .slice(0, safeLimit);
}

router.get("/admin/recommendations", async (req, res) => {
  try {
    const list = await listRecommendations();
    res.json(list);
  } catch (err) {
    req.log.error({ err }, "Error listing recommendations");
    res.status(500).json({ error: "Failed to list recommendations" });
  }
});

router.post("/admin/recommendations", async (req, res): Promise<void> => {
  const parsed = AdminAddRecommendationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "menuItemId is required" });
    return;
  }
  const { menuItemId } = parsed.data;
  try {
    const [item] = await db.select().from(menuItemsTable).where(eq(menuItemsTable.id, menuItemId));
    if (!item) {
      res.status(404).json({ error: "Menu item not found" });
      return;
    }
    const [maxRow] = await db
      .select({ max: sql<number>`COALESCE(MAX(${recommendedMenuItemsTable.sortOrder}), -10)` })
      .from(recommendedMenuItemsTable);
    const nextSort = Number(maxRow?.max ?? -10) + 10;
    const inserted = await db
      .insert(recommendedMenuItemsTable)
      .values({
        menuItemId,
        sortOrder: nextSort,
        source: "manual",
      })
      .onConflictDoNothing({ target: recommendedMenuItemsTable.menuItemId })
      .returning({ menuItemId: recommendedMenuItemsTable.menuItemId });
    if (inserted.length === 0) {
      res.status(409).json({ error: "Item is already in the recommendations list" });
      return;
    }
    const list = await listRecommendations();
    res.status(201).json(list);
  } catch (err) {
    req.log.error({ err }, "Error adding recommendation");
    res.status(500).json({ error: "Failed to add recommendation" });
  }
});

router.delete("/admin/recommendations/:menuItemId", async (req, res): Promise<void> => {
  const parsed = AdminRemoveRecommendationParams.safeParse(req.params);
  if (!parsed.success || parsed.data.menuItemId <= 0) {
    res.status(400).json({ error: "Invalid menuItemId" });
    return;
  }
  try {
    await db
      .delete(recommendedMenuItemsTable)
      .where(eq(recommendedMenuItemsTable.menuItemId, parsed.data.menuItemId));
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Error removing recommendation");
    res.status(500).json({ error: "Failed to remove recommendation" });
  }
});

router.patch("/admin/recommendations/reorder", async (req, res): Promise<void> => {
  const parsed = AdminReorderRecommendationsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "menuItemIds (positive integer array) is required" });
    return;
  }
  const idList = parsed.data.menuItemIds;
  const newSet = new Set<number>(idList);
  if (newSet.size !== idList.length) {
    res.status(400).json({ error: "menuItemIds must not contain duplicates" });
    return;
  }
  try {
    const current = await db
      .select({ menuItemId: recommendedMenuItemsTable.menuItemId })
      .from(recommendedMenuItemsTable);
    const currentSet = new Set(current.map((c) => c.menuItemId));
    if (
      currentSet.size !== newSet.size ||
      ![...currentSet].every((id) => newSet.has(id))
    ) {
      res.status(400).json({
        error: "menuItemIds must contain exactly the current set of recommended items",
      });
      return;
    }
    await db.transaction(async (tx) => {
      for (let i = 0; i < idList.length; i++) {
        const id = idList[i]!;
        await tx
          .update(recommendedMenuItemsTable)
          .set({ sortOrder: i * 10 })
          .where(eq(recommendedMenuItemsTable.menuItemId, id));
      }
    });
    const list = await listRecommendations();
    res.json(list);
  } catch (err) {
    req.log.error({ err }, "Error reordering recommendations");
    res.status(500).json({ error: "Failed to reorder recommendations" });
  }
});

router.get("/admin/recommendations/top-sellers", async (req, res): Promise<void> => {
  const parsed = AdminListTopSellersQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid limit" });
    return;
  }
  const limit = parsed.data.limit ?? TOP_SELLERS_DEFAULT_LIMIT;
  try {
    const top = await computeTopSellers(limit);
    const current = new Set(
      (await db
        .select({ id: recommendedMenuItemsTable.menuItemId })
        .from(recommendedMenuItemsTable)).map((r) => r.id),
    );
    res.json(
      top.map((t) => ({
        ...t,
        isCurrentlyRecommended: current.has(t.menuItemId),
      })),
    );
  } catch (err) {
    req.log.error({ err }, "Error computing top sellers");
    res.status(500).json({ error: "Failed to compute top sellers" });
  }
});

router.post("/admin/recommendations/sync", async (req, res): Promise<void> => {
  const parsed = AdminSyncRecommendationsBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Invalid body. mode must be 'replace' or 'merge', limit 1–50." });
    return;
  }
  const { mode } = parsed.data;
  const limit = parsed.data.limit ?? TOP_SELLERS_DEFAULT_LIMIT;
  const selected = parsed.data.menuItemIds ? new Set(parsed.data.menuItemIds) : null;
  if (selected && new Set(parsed.data.menuItemIds!).size !== parsed.data.menuItemIds!.length) {
    res.status(400).json({ error: "menuItemIds must not contain duplicates" });
    return;
  }
  try {
    const topAll = await computeTopSellers(limit);
    // When the admin deselected rows in the UI, only apply the chosen subset.
    const top = selected ? topAll.filter((t) => selected.has(t.menuItemId)) : topAll;

    await db.transaction(async (tx) => {
      if (mode === "replace") {
        await tx.delete(recommendedMenuItemsTable);
        for (let i = 0; i < top.length; i++) {
          await tx.insert(recommendedMenuItemsTable).values({
            menuItemId: top[i]!.menuItemId,
            sortOrder: i * 10,
            source: "sync",
          });
        }
      } else {
        const existingIds = new Set(
          (await tx
            .select({ id: recommendedMenuItemsTable.menuItemId })
            .from(recommendedMenuItemsTable)).map((r) => r.id),
        );
        const [maxRow] = await tx
          .select({ max: sql<number>`COALESCE(MAX(${recommendedMenuItemsTable.sortOrder}), -10)` })
          .from(recommendedMenuItemsTable);
        let nextSort = Number(maxRow?.max ?? -10) + 10;
        for (const t of top) {
          if (existingIds.has(t.menuItemId)) continue;
          await tx.insert(recommendedMenuItemsTable).values({
            menuItemId: t.menuItemId,
            sortOrder: nextSort,
            source: "sync",
          });
          nextSort += 10;
        }
      }
    });

    const list = await listRecommendations();
    res.json({ mode, applied: top.length, list });
  } catch (err) {
    req.log.error({ err }, "Error syncing recommendations");
    res.status(500).json({ error: "Failed to sync recommendations" });
  }
});

export default router;
