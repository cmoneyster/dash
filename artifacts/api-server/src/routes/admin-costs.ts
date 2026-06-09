import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  ingredientsTable,
  ingredientCostHistoryTable,
  recipesTable,
  recipeLinesTable,
  eventLaborTable,
  menuItemsTable,
  eventOrdersTable,
  cateringInquiriesTable,
  eventSessionsTable,
} from "@workspace/db/schema";
import { eq, desc, and, lte, gte, isNotNull, inArray, sql } from "drizzle-orm";
import { conversionFactor, groupedUnits } from "../lib/units";

const router: IRouter = Router();

// ── Units ─────────────────────────────────────────────────────────────────────

router.get("/admin/costs/units", (_req, res) => {
  res.json(groupedUnits());
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function round4(n: number) { return Math.round(n * 10000) / 10000; }
function round2(n: number) { return Math.round(n * 100) / 100; }

function parseDate(v: unknown, fallback: Date): Date {
  if (typeof v !== "string" || !v) return fallback;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

// Get the most recent cost per unit for an ingredient at or before `asOf`.
async function costAtDate(
  ingredientId: number,
  asOf: Date,
  cache?: Map<string, number>,
): Promise<number | null> {
  const key = `${ingredientId}@${asOf.toISOString()}`;
  if (cache?.has(key)) return cache.get(key)!;
  const [row] = await db
    .select({ costPerUnit: ingredientCostHistoryTable.costPerUnit })
    .from(ingredientCostHistoryTable)
    .where(
      and(
        eq(ingredientCostHistoryTable.ingredientId, ingredientId),
        lte(ingredientCostHistoryTable.effectiveAt, asOf),
      ),
    )
    .orderBy(desc(ingredientCostHistoryTable.effectiveAt))
    .limit(1);
  const val = row ? parseFloat(row.costPerUnit) : null;
  if (cache && val != null) cache.set(key, val);
  return val;
}

// Get the latest cost for an ingredient regardless of date.
async function latestCost(ingredientId: number): Promise<number | null> {
  const [row] = await db
    .select({ costPerUnit: ingredientCostHistoryTable.costPerUnit })
    .from(ingredientCostHistoryTable)
    .where(eq(ingredientCostHistoryTable.ingredientId, ingredientId))
    .orderBy(desc(ingredientCostHistoryTable.effectiveAt))
    .limit(1);
  return row ? parseFloat(row.costPerUnit) : null;
}

// Compute cost-per-serving for a recipe using either current or historical costs.
async function computeRecipeCostPerServing(
  recipeId: number,
  yieldServings: number,
  asOf?: Date,
  cache?: Map<string, number>,
): Promise<{ costPerServing: number | null; missingCosts: number }> {
  const lines = await db
    .select({
      ingredientId: recipeLinesTable.ingredientId,
      quantityPerYield: recipeLinesTable.quantityPerYield,
      recipeUnit: recipeLinesTable.recipeUnit,
      ingredientUnit: ingredientsTable.unit,
    })
    .from(recipeLinesTable)
    .leftJoin(ingredientsTable, eq(recipeLinesTable.ingredientId, ingredientsTable.id))
    .where(eq(recipeLinesTable.recipeId, recipeId));
  if (lines.length === 0) return { costPerServing: null, missingCosts: 0 };

  let total = 0;
  let missing = 0;
  for (const line of lines) {
    const qty = parseFloat(line.quantityPerYield);
    const cost = asOf
      ? await costAtDate(line.ingredientId, asOf, cache)
      : await latestCost(line.ingredientId);
    if (cost == null) { missing++; continue; }
    const iu = line.ingredientUnit ?? "";
    const ru = line.recipeUnit ?? iu;
    const factor = conversionFactor(ru, iu) ?? 1;
    total += qty * factor * cost;
  }
  if (missing === lines.length) return { costPerServing: null, missingCosts: missing };
  const cps = round4(total / yieldServings);
  return { costPerServing: cps, missingCosts: missing };
}

// ── Ingredients ───────────────────────────────────────────────────────────────

router.get("/admin/costs/ingredients", async (req, res) => {
  try {
    const ingredients = await db
      .select()
      .from(ingredientsTable)
      .orderBy(ingredientsTable.name);

    const result = await Promise.all(
      ingredients.map(async (ing) => {
        const history = await db
          .select()
          .from(ingredientCostHistoryTable)
          .where(eq(ingredientCostHistoryTable.ingredientId, ing.id))
          .orderBy(desc(ingredientCostHistoryTable.effectiveAt));

        return {
          ...ing,
          currentCost: history[0] ? parseFloat(history[0].costPerUnit) : null,
          history: history.map(h => ({
            id: h.id,
            costPerUnit: parseFloat(h.costPerUnit),
            effectiveAt: h.effectiveAt.toISOString(),
          })),
        };
      }),
    );

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Error listing ingredients");
    res.status(500).json({ error: "Failed to list ingredients" });
  }
});

router.post("/admin/costs/ingredients", async (req, res) => {
  try {
    const { name, unit, notes, initialCost } = req.body as {
      name?: string;
      unit?: string;
      notes?: string;
      initialCost?: number | string;
    };
    if (!name?.trim()) { res.status(400).json({ error: "name is required" }); return; }
    if (!unit?.trim()) { res.status(400).json({ error: "unit is required" }); return; }

    const [ing] = await db.insert(ingredientsTable).values({
      name: name.trim(),
      unit: unit.trim(),
      notes: notes?.trim() || null,
    }).returning();

    if (initialCost != null && initialCost !== "") {
      const cost = parseFloat(String(initialCost));
      if (Number.isFinite(cost) && cost >= 0) {
        await db.insert(ingredientCostHistoryTable).values({
          ingredientId: ing.id,
          costPerUnit: String(round4(cost)),
        });
      }
    }

    const history = await db
      .select()
      .from(ingredientCostHistoryTable)
      .where(eq(ingredientCostHistoryTable.ingredientId, ing.id))
      .orderBy(desc(ingredientCostHistoryTable.effectiveAt));

    res.status(201).json({
      ...ing,
      currentCost: history[0] ? parseFloat(history[0].costPerUnit) : null,
      history: history.map(h => ({
        id: h.id,
        costPerUnit: parseFloat(h.costPerUnit),
        effectiveAt: h.effectiveAt.toISOString(),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "Error creating ingredient");
    res.status(500).json({ error: "Failed to create ingredient" });
  }
});

router.put("/admin/costs/ingredients/:id", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    const { name, unit, notes } = req.body as { name?: string; unit?: string; notes?: string };
    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name.trim();
    if (unit !== undefined) updates.unit = unit.trim();
    if (notes !== undefined) updates.notes = notes?.trim() || null;

    const [ing] = await db
      .update(ingredientsTable)
      .set(updates)
      .where(eq(ingredientsTable.id, id))
      .returning();

    if (!ing) { res.status(404).json({ error: "Ingredient not found" }); return; }

    const history = await db
      .select()
      .from(ingredientCostHistoryTable)
      .where(eq(ingredientCostHistoryTable.ingredientId, id))
      .orderBy(desc(ingredientCostHistoryTable.effectiveAt));

    res.json({
      ...ing,
      currentCost: history[0] ? parseFloat(history[0].costPerUnit) : null,
      history: history.map(h => ({
        id: h.id,
        costPerUnit: parseFloat(h.costPerUnit),
        effectiveAt: h.effectiveAt.toISOString(),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "Error updating ingredient");
    res.status(500).json({ error: "Failed to update ingredient" });
  }
});

router.delete("/admin/costs/ingredients/:id", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    const usages = await db
      .select({ id: recipeLinesTable.id })
      .from(recipeLinesTable)
      .where(eq(recipeLinesTable.ingredientId, id))
      .limit(1);
    if (usages.length > 0) {
      res.status(409).json({ error: "Ingredient is used in one or more recipes and cannot be deleted. Remove it from all recipes first." });
      return;
    }
    await db.delete(ingredientCostHistoryTable).where(eq(ingredientCostHistoryTable.ingredientId, id));
    const [deleted] = await db.delete(ingredientsTable).where(eq(ingredientsTable.id, id)).returning();
    if (!deleted) { res.status(404).json({ error: "Ingredient not found" }); return; }
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Error deleting ingredient");
    res.status(500).json({ error: "Failed to delete ingredient" });
  }
});

router.post("/admin/costs/ingredients/:id/costs", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    const [ing] = await db.select().from(ingredientsTable).where(eq(ingredientsTable.id, id));
    if (!ing) { res.status(404).json({ error: "Ingredient not found" }); return; }

    const { costPerUnit, effectiveAt } = req.body as { costPerUnit?: number | string; effectiveAt?: string };
    if (costPerUnit == null || costPerUnit === "") {
      res.status(400).json({ error: "costPerUnit is required" });
      return;
    }
    const cost = parseFloat(String(costPerUnit));
    if (!Number.isFinite(cost) || cost < 0) {
      res.status(400).json({ error: "costPerUnit must be a non-negative number" });
      return;
    }

    const [entry] = await db.insert(ingredientCostHistoryTable).values({
      ingredientId: id,
      costPerUnit: String(round4(cost)),
      effectiveAt: effectiveAt ? new Date(effectiveAt) : new Date(),
    }).returning();

    res.status(201).json({
      id: entry.id,
      costPerUnit: parseFloat(entry.costPerUnit),
      effectiveAt: entry.effectiveAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Error adding cost entry");
    res.status(500).json({ error: "Failed to add cost entry" });
  }
});

// ── Recipes ───────────────────────────────────────────────────────────────────

router.get("/admin/menu/:itemId/recipe", async (req, res): Promise<void> => {
  try {
    const itemId = parseInt(req.params.itemId);
    const [item] = await db.select().from(menuItemsTable).where(eq(menuItemsTable.id, itemId));
    if (!item) { res.status(404).json({ error: "Menu item not found" }); return; }

    const [recipe] = await db.select().from(recipesTable).where(eq(recipesTable.menuItemId, itemId));
    if (!recipe) { res.json(null); return; }

    const lines = await db
      .select({
        id: recipeLinesTable.id,
        ingredientId: recipeLinesTable.ingredientId,
        quantityPerYield: recipeLinesTable.quantityPerYield,
        recipeUnit: recipeLinesTable.recipeUnit,
        ingredientName: ingredientsTable.name,
        ingredientUnit: ingredientsTable.unit,
      })
      .from(recipeLinesTable)
      .leftJoin(ingredientsTable, eq(recipeLinesTable.ingredientId, ingredientsTable.id))
      .where(eq(recipeLinesTable.recipeId, recipe.id));

    const { costPerServing, missingCosts } = await computeRecipeCostPerServing(
      recipe.id,
      recipe.yieldServings,
    );

    const servingSize = item.servingSize ?? 1;
    const costPerUnit = costPerServing != null ? round4(costPerServing * servingSize) : null;

    // Derive pan-size costs for pan_sizes template items
    let panSizeCosts: Array<{ label: string; servings: number; costPerPan: number }> | null = null;
    if (item.pricingTemplate === "pan_sizes" && costPerServing != null) {
      panSizeCosts = [];
      const sizes = [
        { label: item.size1Label, servings: item.size1Servings },
        { label: item.size2Label, servings: item.size2Servings },
        { label: item.size3Label, servings: item.size3Servings },
        { label: item.size4Label, servings: item.size4Servings },
        { label: item.size5Label, servings: item.size5Servings },
      ];
      for (const s of sizes) {
        if (s.label && s.servings) {
          panSizeCosts.push({
            label: s.label,
            servings: s.servings,
            costPerPan: round2(costPerServing * s.servings),
          });
        }
      }
    }

    res.json({
      id: recipe.id,
      menuItemId: itemId,
      yieldServings: recipe.yieldServings,
      notes: recipe.notes,
      lines: lines.map(l => ({
        id: l.id,
        ingredientId: l.ingredientId,
        ingredientName: l.ingredientName ?? "",
        ingredientUnit: l.ingredientUnit ?? "",
        quantityPerYield: parseFloat(l.quantityPerYield),
        recipeUnit: l.recipeUnit ?? null,
      })),
      costPerServing,
      costPerUnit,
      missingCosts,
      panSizeCosts,
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching recipe");
    res.status(500).json({ error: "Failed to fetch recipe" });
  }
});

router.put("/admin/menu/:itemId/recipe", async (req, res): Promise<void> => {
  try {
    const itemId = parseInt(req.params.itemId);
    const [item] = await db.select().from(menuItemsTable).where(eq(menuItemsTable.id, itemId));
    if (!item) { res.status(404).json({ error: "Menu item not found" }); return; }

    const { yieldServings, notes, lines } = req.body as {
      yieldServings?: number;
      notes?: string;
      lines?: Array<{ ingredientId: number; quantityPerYield: number | string; recipeUnit?: string | null }>;
    };

    const yield_ = Math.max(1, parseInt(String(yieldServings ?? 1)));
    if (!Array.isArray(lines)) { res.status(400).json({ error: "lines array is required" }); return; }

    let recipe = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(recipesTable).where(eq(recipesTable.menuItemId, itemId));
      let r;
      if (existing) {
        [r] = await tx
          .update(recipesTable)
          .set({ yieldServings: yield_, notes: notes?.trim() || null, updatedAt: new Date() })
          .where(eq(recipesTable.id, existing.id))
          .returning();
        await tx.delete(recipeLinesTable).where(eq(recipeLinesTable.recipeId, existing.id));
      } else {
        [r] = await tx
          .insert(recipesTable)
          .values({ menuItemId: itemId, yieldServings: yield_, notes: notes?.trim() || null })
          .returning();
      }
      if (lines.length > 0) {
        await tx.insert(recipeLinesTable).values(
          lines.map(l => ({
            recipeId: r.id,
            ingredientId: l.ingredientId,
            quantityPerYield: String(round4(parseFloat(String(l.quantityPerYield)))),
            recipeUnit: l.recipeUnit?.trim() || null,
          })),
        );
      }
      return r;
    });

    const linesData = await db
      .select({
        id: recipeLinesTable.id,
        ingredientId: recipeLinesTable.ingredientId,
        quantityPerYield: recipeLinesTable.quantityPerYield,
        recipeUnit: recipeLinesTable.recipeUnit,
        ingredientName: ingredientsTable.name,
        ingredientUnit: ingredientsTable.unit,
      })
      .from(recipeLinesTable)
      .leftJoin(ingredientsTable, eq(recipeLinesTable.ingredientId, ingredientsTable.id))
      .where(eq(recipeLinesTable.recipeId, recipe.id));

    const { costPerServing, missingCosts } = await computeRecipeCostPerServing(
      recipe.id,
      recipe.yieldServings,
    );

    const servingSize = item.servingSize ?? 1;
    const costPerUnit = costPerServing != null ? round4(costPerServing * servingSize) : null;

    let panSizeCosts: Array<{ label: string; servings: number; costPerPan: number }> | null = null;
    if (item.pricingTemplate === "pan_sizes" && costPerServing != null) {
      panSizeCosts = [];
      const sizes = [
        { label: item.size1Label, servings: item.size1Servings },
        { label: item.size2Label, servings: item.size2Servings },
        { label: item.size3Label, servings: item.size3Servings },
        { label: item.size4Label, servings: item.size4Servings },
        { label: item.size5Label, servings: item.size5Servings },
      ];
      for (const s of sizes) {
        if (s.label && s.servings) {
          panSizeCosts.push({
            label: s.label,
            servings: s.servings,
            costPerPan: round2(costPerServing * s.servings),
          });
        }
      }
    }

    res.json({
      id: recipe.id,
      menuItemId: itemId,
      yieldServings: recipe.yieldServings,
      notes: recipe.notes,
      lines: linesData.map(l => ({
        id: l.id,
        ingredientId: l.ingredientId,
        ingredientName: l.ingredientName ?? "",
        ingredientUnit: l.ingredientUnit ?? "",
        quantityPerYield: parseFloat(l.quantityPerYield),
        recipeUnit: l.recipeUnit ?? null,
      })),
      costPerServing,
      costPerUnit,
      missingCosts,
      panSizeCosts,
    });
  } catch (err) {
    req.log.error({ err }, "Error saving recipe");
    res.status(500).json({ error: "Failed to save recipe" });
  }
});

router.delete("/admin/menu/:itemId/recipe", async (req, res): Promise<void> => {
  try {
    const itemId = parseInt(req.params.itemId);
    const [recipe] = await db.select().from(recipesTable).where(eq(recipesTable.menuItemId, itemId));
    if (!recipe) { res.status(404).json({ error: "Recipe not found" }); return; }
    await db.delete(recipeLinesTable).where(eq(recipeLinesTable.recipeId, recipe.id));
    await db.delete(recipesTable).where(eq(recipesTable.id, recipe.id));
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Error deleting recipe");
    res.status(500).json({ error: "Failed to delete recipe" });
  }
});

// ── Labor ─────────────────────────────────────────────────────────────────────

router.get("/admin/costs/labor", async (req, res) => {
  try {
    const { referenceType, referenceId } = req.query as { referenceType?: string; referenceId?: string };
    if (!referenceType || !referenceId) {
      res.status(400).json({ error: "referenceType and referenceId are required" });
      return;
    }
    const id = parseInt(referenceId);
    const entries = await db
      .select()
      .from(eventLaborTable)
      .where(
        and(
          eq(eventLaborTable.referenceType, referenceType),
          eq(eventLaborTable.referenceId, id),
        ),
      )
      .orderBy(eventLaborTable.createdAt);

    res.json(entries.map(formatLabor));
  } catch (err) {
    req.log.error({ err }, "Error listing labor entries");
    res.status(500).json({ error: "Failed to list labor entries" });
  }
});

function formatLabor(e: typeof eventLaborTable.$inferSelect) {
  const hours = e.hours != null ? parseFloat(e.hours) : null;
  const hourlyRate = e.hourlyRate != null ? parseFloat(e.hourlyRate) : null;
  const flatCost = e.flatCost != null ? parseFloat(e.flatCost) : null;
  const subtotal = flatCost != null
    ? flatCost
    : (hours != null && hourlyRate != null ? round2(hours * hourlyRate) : null);
  return {
    id: e.id,
    referenceType: e.referenceType,
    referenceId: e.referenceId,
    employeeName: e.employeeName,
    hours,
    hourlyRate,
    flatCost,
    subtotal,
    notes: e.notes,
    createdAt: e.createdAt.toISOString(),
  };
}

router.post("/admin/costs/labor", async (req, res) => {
  try {
    const { referenceType, referenceId, employeeName, hours, hourlyRate, flatCost, notes } =
      req.body as {
        referenceType?: string;
        referenceId?: number;
        employeeName?: string;
        hours?: number | string | null;
        hourlyRate?: number | string | null;
        flatCost?: number | string | null;
        notes?: string;
      };

    if (!referenceType || !referenceId) {
      res.status(400).json({ error: "referenceType and referenceId are required" });
      return;
    }
    if (!employeeName?.trim()) {
      res.status(400).json({ error: "employeeName is required" });
      return;
    }
    const hoursN = hours != null && hours !== "" ? parseFloat(String(hours)) : null;
    const rateN = hourlyRate != null && hourlyRate !== "" ? parseFloat(String(hourlyRate)) : null;
    const flatN = flatCost != null && flatCost !== "" ? parseFloat(String(flatCost)) : null;

    if (flatN == null && (hoursN == null || rateN == null)) {
      res.status(400).json({ error: "Either flatCost or both hours and hourlyRate are required" });
      return;
    }

    const [entry] = await db.insert(eventLaborTable).values({
      referenceType,
      referenceId,
      employeeName: employeeName.trim(),
      hours: hoursN != null ? String(hoursN) : null,
      hourlyRate: rateN != null ? String(rateN) : null,
      flatCost: flatN != null ? String(flatN) : null,
      notes: notes?.trim() || null,
    }).returning();

    res.status(201).json(formatLabor(entry));
  } catch (err) {
    req.log.error({ err }, "Error creating labor entry");
    res.status(500).json({ error: "Failed to create labor entry" });
  }
});

router.patch("/admin/costs/labor/:id", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    const { employeeName, hours, hourlyRate, flatCost, notes } = req.body as {
      employeeName?: string;
      hours?: number | string | null;
      hourlyRate?: number | string | null;
      flatCost?: number | string | null;
      notes?: string;
    };
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (employeeName !== undefined) updates.employeeName = employeeName.trim();
    if (hours !== undefined) updates.hours = (hours != null && hours !== "") ? String(parseFloat(String(hours))) : null;
    if (hourlyRate !== undefined) updates.hourlyRate = (hourlyRate != null && hourlyRate !== "") ? String(parseFloat(String(hourlyRate))) : null;
    if (flatCost !== undefined) updates.flatCost = (flatCost != null && flatCost !== "") ? String(parseFloat(String(flatCost))) : null;
    if (notes !== undefined) updates.notes = notes?.trim() || null;

    const [entry] = await db
      .update(eventLaborTable)
      .set(updates)
      .where(eq(eventLaborTable.id, id))
      .returning();

    if (!entry) { res.status(404).json({ error: "Labor entry not found" }); return; }
    res.json(formatLabor(entry));
  } catch (err) {
    req.log.error({ err }, "Error updating labor entry");
    res.status(500).json({ error: "Failed to update labor entry" });
  }
});

router.delete("/admin/costs/labor/:id", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    const [deleted] = await db.delete(eventLaborTable).where(eq(eventLaborTable.id, id)).returning();
    if (!deleted) { res.status(404).json({ error: "Labor entry not found" }); return; }
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Error deleting labor entry");
    res.status(500).json({ error: "Failed to delete labor entry" });
  }
});

// ── Cost Summary ──────────────────────────────────────────────────────────────

router.get("/admin/costs/summary", async (req, res) => {
  try {
    const { from: fromStr, to: toStr, scope = "events" } = req.query as {
      from?: string;
      to?: string;
      scope?: string;
    };

    const today = new Date();
    const fromDate = parseDate(fromStr, new Date(today.getFullYear(), today.getMonth(), today.getDate()));
    const toDate = parseDate(toStr, today);
    const from = new Date(fromDate);
    from.setHours(0, 0, 0, 0);
    const to = new Date(toDate);
    to.setHours(23, 59, 59, 999);

    // Pre-load all recipes and lines to avoid N+1 for summary
    const allRecipes = await db.select().from(recipesTable);
    const recipeByMenuItemId = new Map(allRecipes.map(r => [r.menuItemId, r]));

    const allLines = allRecipes.length > 0
      ? await db
          .select()
          .from(recipeLinesTable)
          .where(inArray(recipeLinesTable.recipeId, allRecipes.map(r => r.id)))
      : [];
    const linesByRecipeId = new Map<number, typeof allLines>();
    for (const l of allLines) {
      const arr = linesByRecipeId.get(l.recipeId) ?? [];
      arr.push(l);
      linesByRecipeId.set(l.recipeId, arr);
    }

    // Pre-load all menu items for serving size
    const allMenuItems = await db.select({
      id: menuItemsTable.id,
      servingSize: menuItemsTable.servingSize,
      pricingTemplate: menuItemsTable.pricingTemplate,
    }).from(menuItemsTable);
    const menuItemMap = new Map(allMenuItems.map(m => [m.id, m]));

    // Pre-load ingredient units for conversion factor lookup
    const allIngredients = await db.select({ id: ingredientsTable.id, unit: ingredientsTable.unit }).from(ingredientsTable);
    const ingredientUnitMap = new Map(allIngredients.map(i => [i.id, i.unit]));

    const costCache = new Map<string, number>();

    // Compute COGS for an array of order items at a specific date
    async function computeOrderCogs(
      items: Array<{ itemId?: number; name: string; quantity: number }>,
      atDate: Date,
    ): Promise<{ cogs: number; itemsWithRecipe: number; itemsWithoutRecipe: number }> {
      let cogs = 0;
      let withRecipe = 0;
      let withoutRecipe = 0;

      for (const item of items) {
        if (!item.itemId) { withoutRecipe++; continue; }
        const recipe = recipeByMenuItemId.get(item.itemId);
        if (!recipe) { withoutRecipe++; continue; }

        const lines = linesByRecipeId.get(recipe.id) ?? [];
        let recipeCost = 0;
        let hasAllCosts = true;
        for (const line of lines) {
          const cost = await costAtDate(line.ingredientId, atDate, costCache);
          if (cost == null) { hasAllCosts = false; continue; }
          const iu = ingredientUnitMap.get(line.ingredientId) ?? "";
          const ru = line.recipeUnit ?? iu;
          const factor = conversionFactor(ru, iu) ?? 1;
          recipeCost += parseFloat(line.quantityPerYield) * factor * cost;
        }
        if (!hasAllCosts) { withoutRecipe++; continue; }

        const costPerServing = recipeCost / recipe.yieldServings;
        const menuItem = menuItemMap.get(item.itemId);
        const servingSize = menuItem?.servingSize ?? 1;
        const servingsOrdered = item.quantity * servingSize;
        cogs += costPerServing * servingsOrdered;
        withRecipe++;
      }

      return { cogs: round2(cogs), itemsWithRecipe: withRecipe, itemsWithoutRecipe: withoutRecipe };
    }

    type ItemBreakdownEntry = { name: string; quantity: number; cogs: number; revenue: number };
    const itemBreakdown = new Map<string, ItemBreakdownEntry>();

    // Per-item COGS breakdown helper
    async function processItemsForBreakdown(
      items: Array<{ itemId?: number; name: string; quantity: number; unitPrice?: number; price?: number; lineTotal?: number }>,
      atDate: Date,
    ) {
      for (const item of items) {
        const key = item.itemId ? `${item.itemId}::${item.name}` : `0::${item.name}`;
        let costContrib = 0;
        if (item.itemId) {
          const recipe = recipeByMenuItemId.get(item.itemId);
          if (recipe) {
            const lines = linesByRecipeId.get(recipe.id) ?? [];
            let recipeCost = 0;
            let hasAll = true;
            for (const l of lines) {
              const cost = await costAtDate(l.ingredientId, atDate, costCache);
              if (cost == null) { hasAll = false; break; }
              const iu = ingredientUnitMap.get(l.ingredientId) ?? "";
              const ru = l.recipeUnit ?? iu;
              const factor = conversionFactor(ru, iu) ?? 1;
              recipeCost += parseFloat(l.quantityPerYield) * factor * cost;
            }
            if (hasAll) {
              const servingSize = menuItemMap.get(item.itemId)?.servingSize ?? 1;
              costContrib = round2((recipeCost / recipe.yieldServings) * servingSize * item.quantity);
            }
          }
        }
        const unitPrice = item.unitPrice != null ? Number(item.unitPrice) : Number(item.price ?? 0);
        const lineRevenue = item.lineTotal != null ? Number(item.lineTotal) : round2(unitPrice * item.quantity);
        const entry = itemBreakdown.get(key) ?? { name: item.name, quantity: 0, cogs: 0, revenue: 0 };
        entry.quantity += item.quantity;
        entry.cogs = round2(entry.cogs + costContrib);
        entry.revenue = round2(entry.revenue + lineRevenue);
        itemBreakdown.set(key, entry);
      }
    }

    let totalRevenue = 0;
    let totalCogs = 0;
    let totalLaborCost = 0;
    let itemsWithoutRecipe = 0;
    let itemsWithRecipe = 0;

    const sessionLaborTotals: Array<{ referenceType: string; referenceId: number; name: string; laborCost: number }> = [];

    // ── Event orders ──────────────────────────────────────────────────────────
    if (scope === "events" || scope === "all") {
      const { gte, lt } = await import("drizzle-orm");
      const orders = await db
        .select()
        .from(eventOrdersTable)
        .where(
          and(
            gte(eventOrdersTable.createdAt, from),
            lt(eventOrdersTable.createdAt, to),
          ),
        );

      const activeOrders = orders.filter(o => o.voidedAt == null);

      for (const o of activeOrders) {
        const orderRevenue = o.total != null ? parseFloat(o.total) : 0;
        totalRevenue = round2(totalRevenue + orderRevenue);

        const items = (o.items ?? []) as Array<{ itemId?: number; name: string; quantity: number; price?: number; unitPrice?: number; lineTotal?: number }>;
        const r = await computeOrderCogs(items, o.createdAt);
        totalCogs = round2(totalCogs + r.cogs);
        itemsWithRecipe += r.itemsWithRecipe;
        itemsWithoutRecipe += r.itemsWithoutRecipe;
        await processItemsForBreakdown(items, o.createdAt);
      }

      // Labor for event sessions in range — only sessions whose date falls within the requested range
      const fromDateStr = from.toISOString().slice(0, 10);
      const toDateStr = to.toISOString().slice(0, 10);
      const sessions = await db
        .select()
        .from(eventSessionsTable)
        .where(
          and(
            isNotNull(eventSessionsTable.date),
            gte(eventSessionsTable.date, fromDateStr),
            lte(eventSessionsTable.date, toDateStr),
          ),
        );
      for (const session of sessions) {
        const laborEntries = await db
          .select()
          .from(eventLaborTable)
          .where(
            and(
              eq(eventLaborTable.referenceType, "event_session"),
              eq(eventLaborTable.referenceId, session.id),
            ),
          );
        const sessionLabor = laborEntries.reduce((sum, e) => {
          const f = formatLabor(e);
          return round2(sum + (f.subtotal ?? 0));
        }, 0);
        if (sessionLabor > 0) {
          sessionLaborTotals.push({
            referenceType: "event_session",
            referenceId: session.id,
            name: session.name,
            laborCost: sessionLabor,
          });
          totalLaborCost = round2(totalLaborCost + sessionLabor);
        }
      }
    }

    // ── Catering inquiries ────────────────────────────────────────────────────
    if (scope === "catering" || scope === "all") {
      const { gte, lt } = await import("drizzle-orm");
      const inquiries = await db
        .select()
        .from(cateringInquiriesTable)
        .where(
          and(
            gte(cateringInquiriesTable.createdAt, from),
            lt(cateringInquiriesTable.createdAt, to),
            sql`${cateringInquiriesTable.squareAmountPaid} > 0`,
          ),
        );

      for (const inq of inquiries) {
        const inqRevenue = inq.squareAmountPaid != null ? parseFloat(inq.squareAmountPaid) : 0;
        totalRevenue = round2(totalRevenue + inqRevenue);

        const lineItems = (inq.lineItems ?? []) as Array<{ menuItemId?: number | null; name: string; quantity: number; unitPrice?: number }>;
        const items = lineItems.map(l => ({
          itemId: l.menuItemId ?? undefined,
          name: l.name,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
        }));
        const r = await computeOrderCogs(items, inq.createdAt);
        totalCogs = round2(totalCogs + r.cogs);
        itemsWithRecipe += r.itemsWithRecipe;
        itemsWithoutRecipe += r.itemsWithoutRecipe;
        await processItemsForBreakdown(items, inq.createdAt);

        // Labor for this catering inquiry
        const laborEntries = await db
          .select()
          .from(eventLaborTable)
          .where(
            and(
              eq(eventLaborTable.referenceType, "catering_inquiry"),
              eq(eventLaborTable.referenceId, inq.id),
            ),
          );
        const inqLabor = laborEntries.reduce((sum, e) => {
          const f = formatLabor(e);
          return round2(sum + (f.subtotal ?? 0));
        }, 0);
        if (inqLabor > 0) {
          sessionLaborTotals.push({
            referenceType: "catering_inquiry",
            referenceId: inq.id,
            name: inq.clientName,
            laborCost: inqLabor,
          });
          totalLaborCost = round2(totalLaborCost + inqLabor);
        }
      }
    }

    const grossProfit = round2(totalRevenue - totalCogs - totalLaborCost);
    const grossMargin = totalRevenue > 0 ? round2((grossProfit / totalRevenue) * 100) : null;

    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      scope,
      revenue: totalRevenue,
      cogs: totalCogs,
      laborCost: totalLaborCost,
      grossProfit,
      grossMargin,
      itemsWithRecipe,
      itemsWithoutRecipe,
      itemBreakdown: Array.from(itemBreakdown.values())
        .sort((a, b) => b.cogs - a.cogs)
        .map(e => ({
          ...e,
          margin: e.revenue > 0 ? round2(((e.revenue - e.cogs) / e.revenue) * 100) : null,
        })),
      laborBreakdown: sessionLaborTotals,
    });
  } catch (err) {
    req.log.error({ err }, "Error computing cost summary");
    res.status(500).json({ error: "Failed to compute cost summary" });
  }
});

export default router;
