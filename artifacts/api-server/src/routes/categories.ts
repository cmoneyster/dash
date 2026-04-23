import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { menuCategoriesTable } from "@workspace/db/schema";
import { asc, eq } from "drizzle-orm";

const router: IRouter = Router();

router.get("/categories", async (req, res) => {
  try {
    // Pass `?includeHidden=true` to include hidden categories. The Plan page
    // uses this so that items belonging to a category that is hidden from the
    // public menu are still classified into the correct planner_group (savory/
    // sweet/entrée/other) rather than collapsing into "Other items".
    const includeHidden = String(req.query.includeHidden ?? "") === "true";
    const baseQuery = db.select().from(menuCategoriesTable);
    const rows = await (includeHidden
      ? baseQuery
      : baseQuery.where(eq(menuCategoriesTable.visible, true))
    ).orderBy(asc(menuCategoriesTable.sortOrder), asc(menuCategoriesTable.id));
    res.json(rows.map((c) => ({
      id: c.id,
      name: c.name,
      sortOrder: c.sortOrder,
      visible: c.visible,
      plannerGroup: c.plannerGroup,
    })));
  } catch (err) {
    req.log.error({ err }, "Error listing categories");
    res.status(500).json({ error: "Failed to list categories" });
  }
});

export default router;
