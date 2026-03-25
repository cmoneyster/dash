import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { planItemsTable, menuItemsTable, sharedPlansTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
const router: IRouter = Router();

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

function expiresAt60Days() {
  return new Date(Date.now() + SIXTY_DAYS_MS);
}

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

async function resolveSharedPlan(token: string) {
  const [record] = await db
    .select()
    .from(sharedPlansTable)
    .where(eq(sharedPlansTable.shareToken, token));
  return record ?? null;
}

async function touchSharedPlan(token: string) {
  const now = new Date();
  const expires = expiresAt60Days();
  await db
    .update(sharedPlansTable)
    .set({ lastModifiedAt: now, expiresAt: expires })
    .where(eq(sharedPlansTable.shareToken, token));
}

// ── Regular plan CRUD ──────────────────────────────────────────────────────

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

// ── Shared plan ────────────────────────────────────────────────────────────

// Create or update a share token for a session
router.post("/plan/share", async (req, res) => {
  try {
    const { sessionId, planName, plannerState } = req.body as {
      sessionId: string; planName?: string; plannerState?: unknown;
    };
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    // Re-use an existing token for this session if one exists
    const [existing] = await db
      .select()
      .from(sharedPlansTable)
      .where(eq(sharedPlansTable.sessionId, sessionId));

    if (existing) {
      const expires = expiresAt60Days();
      await db
        .update(sharedPlansTable)
        .set({
          planName: planName ?? existing.planName,
          plannerState: plannerState !== undefined ? plannerState : existing.plannerState,
          lastModifiedAt: new Date(),
          expiresAt: expires,
        })
        .where(eq(sharedPlansTable.shareToken, existing.shareToken));

      return res.json({ shareToken: existing.shareToken, expiresAt: expires });
    }

    const expires = expiresAt60Days();
    const [created] = await db
      .insert(sharedPlansTable)
      .values({ sessionId, planName: planName ?? null, plannerState: plannerState ?? null, expiresAt: expires })
      .returning();

    res.json({ shareToken: created.shareToken, expiresAt: created.expiresAt });
  } catch (err) {
    req.log.error({ err }, "Error creating shared plan");
    res.status(500).json({ error: "Failed to create shared plan" });
  }
});

// Get shared plan
router.get("/plan/share/:token", async (req, res) => {
  try {
    const record = await resolveSharedPlan(req.params.token);
    if (!record) return res.status(404).json({ error: "Plan not found" });
    if (new Date() > record.expiresAt) return res.status(410).json({ error: "This plan link has expired" });

    await touchSharedPlan(req.params.token);
    const plan = await getPlanData(record.sessionId);
    res.json({
      ...plan,
      shareToken: record.shareToken,
      planName: record.planName,
      plannerState: record.plannerState ?? null,
      expiresAt: record.expiresAt,
    });
  } catch (err) {
    req.log.error({ err }, "Error getting shared plan");
    res.status(500).json({ error: "Failed to get shared plan" });
  }
});

// Update planner state on a shared plan
router.patch("/plan/share/:token/planner", async (req, res) => {
  try {
    const record = await resolveSharedPlan(req.params.token);
    if (!record) return res.status(404).json({ error: "Plan not found" });
    if (new Date() > record.expiresAt) return res.status(410).json({ error: "This plan link has expired" });

    const { plannerState } = req.body as { plannerState: unknown };
    if (plannerState === undefined) return res.status(400).json({ error: "plannerState required" });

    await db
      .update(sharedPlansTable)
      .set({ plannerState, lastModifiedAt: new Date(), expiresAt: expiresAt60Days() })
      .where(eq(sharedPlansTable.shareToken, req.params.token));

    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Error updating planner state");
    res.status(500).json({ error: "Failed to update planner state" });
  }
});

// Add item to shared plan
router.post("/plan/share/:token/items", async (req, res) => {
  try {
    const record = await resolveSharedPlan(req.params.token);
    if (!record) return res.status(404).json({ error: "Plan not found" });
    if (new Date() > record.expiresAt) return res.status(410).json({ error: "This plan link has expired" });

    const { menuItemId } = req.body as { menuItemId: number };
    if (!menuItemId) return res.status(400).json({ error: "menuItemId required" });

    const [existing] = await db
      .select()
      .from(planItemsTable)
      .where(and(eq(planItemsTable.sessionId, record.sessionId), eq(planItemsTable.menuItemId, menuItemId)));

    if (!existing) {
      await db.insert(planItemsTable).values({ sessionId: record.sessionId, menuItemId });
    }

    await touchSharedPlan(req.params.token);
    const plan = await getPlanData(record.sessionId);
    res.json({ ...plan, shareToken: record.shareToken, planName: record.planName, expiresAt: record.expiresAt });
  } catch (err) {
    req.log.error({ err }, "Error adding item to shared plan");
    res.status(500).json({ error: "Failed to add item" });
  }
});

// Remove item from shared plan
router.delete("/plan/share/:token/items/:itemId", async (req, res) => {
  try {
    const record = await resolveSharedPlan(req.params.token);
    if (!record) return res.status(404).json({ error: "Plan not found" });
    if (new Date() > record.expiresAt) return res.status(410).json({ error: "This plan link has expired" });

    const itemId = parseInt(req.params.itemId);
    await db
      .delete(planItemsTable)
      .where(and(eq(planItemsTable.id, itemId), eq(planItemsTable.sessionId, record.sessionId)));

    await touchSharedPlan(req.params.token);
    const plan = await getPlanData(record.sessionId);
    res.json({ ...plan, shareToken: record.shareToken, planName: record.planName, expiresAt: record.expiresAt });
  } catch (err) {
    req.log.error({ err }, "Error removing item from shared plan");
    res.status(500).json({ error: "Failed to remove item" });
  }
});

export default router;
