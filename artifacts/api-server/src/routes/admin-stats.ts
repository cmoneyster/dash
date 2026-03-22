import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { ordersTable, menuItemsTable } from "@workspace/db/schema";
import { eq, count, sum } from "drizzle-orm";

const router: IRouter = Router();

router.get("/admin/stats", async (req, res) => {
  try {
    const [{ totalOrders }] = await db.select({ totalOrders: count() }).from(ordersTable);
    const [{ pendingOrders }] = await db
      .select({ pendingOrders: count() })
      .from(ordersTable)
      .where(eq(ordersTable.status, "pending"));
    const [{ totalRevenue }] = await db.select({ totalRevenue: sum(ordersTable.total) }).from(ordersTable);
    const [{ totalMenuItems }] = await db.select({ totalMenuItems: count() }).from(menuItemsTable);

    res.json({
      totalOrders,
      pendingOrders,
      totalRevenue: parseFloat(totalRevenue ?? "0"),
      totalMenuItems,
    });
  } catch (err) {
    req.log.error({ err }, "Error getting admin stats");
    res.status(500).json({ error: "Failed to get admin stats" });
  }
});

export default router;
