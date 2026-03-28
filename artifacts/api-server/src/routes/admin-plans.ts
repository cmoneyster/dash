import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sharedPlansTable, planItemsTable, menuItemsTable } from "@workspace/db/schema";
import { eq, and, desc, asc, count } from "drizzle-orm";

const router: IRouter = Router();

async function getPlanItems(sessionId: string) {
  const rows = await db
    .select()
    .from(planItemsTable)
    .innerJoin(menuItemsTable, eq(planItemsTable.menuItemId, menuItemsTable.id))
    .where(eq(planItemsTable.sessionId, sessionId));

  return rows.map((row) => ({
    id: row.plan_items.id,
    menuItemId: row.plan_items.menuItemId,
    createdAt: row.plan_items.createdAt,
    menuItem: {
      id: row.menu_items.id,
      name: row.menu_items.name,
      category: row.menu_items.category,
      price: parseFloat(row.menu_items.price),
      unit: row.menu_items.unit,
      servingSize: row.menu_items.servingSize,
      pricingTemplate: row.menu_items.pricingTemplate,
    },
  }));
}

// List all shared plans
router.get("/admin/plans", async (req, res) => {
  try {
    const plans = await db
      .select()
      .from(sharedPlansTable)
      .orderBy(desc(sharedPlansTable.lastModifiedAt));

    // Enrich each plan with item count
    const enriched = await Promise.all(
      plans.map(async (plan) => {
        const [row] = await db
          .select({ count: count() })
          .from(planItemsTable)
          .where(eq(planItemsTable.sessionId, plan.sessionId));
        return {
          shareToken: plan.shareToken,
          planNumber: plan.planNumber,
          planName: plan.planName,
          adminNotes: plan.adminNotes,
          createdAt: plan.createdAt,
          lastModifiedAt: plan.lastModifiedAt,
          expiresAt: plan.expiresAt,
          itemCount: row?.count ?? 0,
          guestCount: extractGuestCount(plan.plannerState),
        };
      })
    );

    res.json(enriched);
  } catch (err) {
    req.log.error({ err }, "Error listing admin plans");
    res.status(500).json({ error: "Failed to list plans" });
  }
});

// Get full plan detail
router.get("/admin/plans/:token", async (req, res) => {
  try {
    const [plan] = await db
      .select()
      .from(sharedPlansTable)
      .where(eq(sharedPlansTable.shareToken, req.params.token));

    if (!plan) return res.status(404).json({ error: "Plan not found" });

    const items = await getPlanItems(plan.sessionId);

    res.json({
      shareToken: plan.shareToken,
      planNumber: plan.planNumber,
      planName: plan.planName,
      adminNotes: plan.adminNotes,
      plannerState: plan.plannerState,
      createdAt: plan.createdAt,
      lastModifiedAt: plan.lastModifiedAt,
      expiresAt: plan.expiresAt,
      items,
    });
  } catch (err) {
    req.log.error({ err }, "Error getting admin plan");
    res.status(500).json({ error: "Failed to get plan" });
  }
});

// Update plan name or admin notes
router.patch("/admin/plans/:token", async (req, res) => {
  try {
    const { planName, adminNotes } = req.body as { planName?: string; adminNotes?: string };
    const updates: Record<string, unknown> = { lastModifiedAt: new Date() };
    if (planName !== undefined) updates.planName = planName || null;
    if (adminNotes !== undefined) updates.adminNotes = adminNotes || null;

    const [updated] = await db
      .update(sharedPlansTable)
      .set(updates)
      .where(eq(sharedPlansTable.shareToken, req.params.token))
      .returning();

    if (!updated) return res.status(404).json({ error: "Plan not found" });
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Error updating admin plan");
    res.status(500).json({ error: "Failed to update plan" });
  }
});

// Remove an item from a plan
router.delete("/admin/plans/:token/items/:itemId", async (req, res) => {
  try {
    const [plan] = await db
      .select({ sessionId: sharedPlansTable.sessionId })
      .from(sharedPlansTable)
      .where(eq(sharedPlansTable.shareToken, req.params.token));
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    const itemId = parseInt(req.params.itemId);
    await db
      .delete(planItemsTable)
      .where(and(eq(planItemsTable.id, itemId), eq(planItemsTable.sessionId, plan.sessionId)));

    await db
      .update(sharedPlansTable)
      .set({ lastModifiedAt: new Date() })
      .where(eq(sharedPlansTable.shareToken, req.params.token));

    const items = await getPlanItems(plan.sessionId);
    res.json({ items });
  } catch (err) {
    req.log.error({ err }, "Error removing item from plan");
    res.status(500).json({ error: "Failed to remove item" });
  }
});

// Delete an entire plan
router.delete("/admin/plans/:token", async (req, res) => {
  try {
    const [plan] = await db
      .select({ sessionId: sharedPlansTable.sessionId })
      .from(sharedPlansTable)
      .where(eq(sharedPlansTable.shareToken, req.params.token));
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    await db.delete(planItemsTable).where(eq(planItemsTable.sessionId, plan.sessionId));
    await db.delete(sharedPlansTable).where(eq(sharedPlansTable.shareToken, req.params.token));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Error deleting plan");
    res.status(500).json({ error: "Failed to delete plan" });
  }
});

function extractGuestCount(plannerState: unknown): number | null {
  if (!plannerState || typeof plannerState !== "object") return null;
  const s = plannerState as Record<string, unknown>;
  if (typeof s.guests === "number") return s.guests;
  if (typeof s.guests === "string") {
    const n = parseInt(s.guests);
    return isNaN(n) ? null : n;
  }
  return null;
}

export default router;
