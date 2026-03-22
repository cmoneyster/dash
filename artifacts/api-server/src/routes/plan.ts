import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { planItemsTable, menuItemsTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";

const router: IRouter = Router();

async function getPlanData(sessionId: string) {
  const items = await db
    .select()
    .from(planItemsTable)
    .innerJoin(menuItemsTable, eq(planItemsTable.menuItemId, menuItemsTable.id))
    .where(eq(planItemsTable.sessionId, sessionId));

  return {
    sessionId,
    items: items.map((row) => ({
      id: row.plan_items.id,
      menuItemId: row.plan_items.menuItemId,
      menuItem: {
        ...row.menu_items,
        price: parseFloat(row.menu_items.price),
        allergens: row.menu_items.allergens ?? [],
      },
    })),
  };
}

router.get("/plan", async (req, res) => {
  try {
    const { sessionId } = req.query as { sessionId: string };
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    res.json(await getPlanData(sessionId));
  } catch (err) {
    req.log.error({ err }, "Error getting plan");
    res.status(500).json({ error: "Failed to get plan" });
  }
});

router.post("/plan", async (req, res) => {
  try {
    const { sessionId, menuItemId } = req.body;
    if (!sessionId || !menuItemId) return res.status(400).json({ error: "sessionId and menuItemId required" });

    const [existing] = await db
      .select()
      .from(planItemsTable)
      .where(and(eq(planItemsTable.sessionId, sessionId), eq(planItemsTable.menuItemId, menuItemId)));

    if (!existing) {
      await db.insert(planItemsTable).values({ sessionId, menuItemId });
    }

    res.json(await getPlanData(sessionId));
  } catch (err) {
    req.log.error({ err }, "Error adding to plan");
    res.status(500).json({ error: "Failed to add to plan" });
  }
});

router.delete("/plan/:itemId", async (req, res) => {
  try {
    const itemId = parseInt(req.params.itemId);
    const sessionId = req.body?.sessionId || req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    await db.delete(planItemsTable).where(and(eq(planItemsTable.id, itemId), eq(planItemsTable.sessionId, sessionId as string)));

    res.json(await getPlanData(sessionId as string));
  } catch (err) {
    req.log.error({ err }, "Error removing from plan");
    res.status(500).json({ error: "Failed to remove from plan" });
  }
});

export default router;
