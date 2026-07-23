import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  ingredientsTable,
  ingredientCostHistoryTable,
  ingredientProcessStepsTable,
  preparationsTable,
  preparationLinesTable,
  preparationProcessStepsTable,
  recipesTable,
  recipeLinesTable,
  eventLaborTable,
  menuItemsTable,
  eventOrdersTable,
  cateringInquiriesTable,
  cateringTaskListsTable,
  eventSessionsTable,
} from "@workspace/db/schema";
import { eq, desc, and, lte, gte, isNotNull, isNull, inArray, sql, exists, asc } from "drizzle-orm";
import { conversionFactor, isIncompatibleConversion, groupedUnits } from "../lib/units";
import { openai } from "@workspace/integrations-openai-ai-server";

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
// When no entry exists at or before `asOf`, falls back to the latest available
// price and records the cache key in `fallbackKeys` so callers can signal that
// figures are approximate.
async function costAtDate(
  ingredientId: number,
  asOf: Date,
  cache?: Map<string, number>,
  fallbackKeys?: Set<string>,
): Promise<number | null> {
  const key = `${ingredientId}@${asOf.toISOString()}`;
  if (cache?.has(key)) {
    // Preserve fallback classification on cache hits
    if (fallbackKeys && fallbackKeyCache.has(key)) fallbackKeys.add(key);
    return cache.get(key)!;
  }
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
  if (row) {
    const val = parseFloat(row.costPerUnit);
    cache?.set(key, val);
    return val;
  }
  // No cost entry at or before asOf — fall back to the latest available price.
  const [latestRow] = await db
    .select({ costPerUnit: ingredientCostHistoryTable.costPerUnit })
    .from(ingredientCostHistoryTable)
    .where(eq(ingredientCostHistoryTable.ingredientId, ingredientId))
    .orderBy(desc(ingredientCostHistoryTable.effectiveAt))
    .limit(1);
  if (latestRow) {
    const val = parseFloat(latestRow.costPerUnit);
    cache?.set(key, val);
    fallbackKeyCache.add(key);
    fallbackKeys?.add(key);
    return val;
  }
  return null;
}

// Tracks which costAtDate cache keys were resolved via latest-cost fallback,
// so that cache hits on the same key are also classified as fallback.
const fallbackKeyCache = new Set<string>();

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
// Handles both ingredient lines and preparation lines (single level).
async function computeRecipeCostPerServing(
  recipeId: number,
  yieldServings: number,
  asOf?: Date,
  cache?: Map<string, number>,
): Promise<{ costPerServing: number | null; missingCosts: number }> {
  const lines = await db
    .select({
      ingredientId: recipeLinesTable.ingredientId,
      preparationId: recipeLinesTable.preparationId,
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

    if (line.preparationId != null) {
      // Preparation line — resolve cost per yield unit from the preparations table
      const [prep] = await db
        .select({ yieldServings: preparationsTable.yieldServings, yieldUnit: preparationsTable.yieldUnit })
        .from(preparationsTable)
        .where(eq(preparationsTable.id, line.preparationId));
      if (!prep) { missing++; continue; }

      const prepLines = await db
        .select({
          ingredientId: preparationLinesTable.ingredientId,
          quantityPerYield: preparationLinesTable.quantityPerYield,
          recipeUnit: preparationLinesTable.recipeUnit,
          ingredientUnit: ingredientsTable.unit,
        })
        .from(preparationLinesTable)
        .leftJoin(ingredientsTable, eq(preparationLinesTable.ingredientId, ingredientsTable.id))
        .where(eq(preparationLinesTable.preparationId, line.preparationId));

      if (prepLines.length === 0) { missing++; continue; }
      let subTotal = 0;
      let subMissing = false;
      for (const sl of prepLines) {
        if (!sl.ingredientId) { subMissing = true; break; }
        const cost = asOf
          ? await costAtDate(sl.ingredientId, asOf, cache)
          : await latestCost(sl.ingredientId);
        if (cost == null) { subMissing = true; break; }
        const siu = sl.ingredientUnit ?? "";
        const sru = sl.recipeUnit ?? siu;
        const sfactor = conversionFactor(sru, siu);
        if (sfactor === null) {
          if (isIncompatibleConversion(sru, siu)) { subMissing = true; break; }
          subTotal += parseFloat(sl.quantityPerYield) * cost;
        } else {
          subTotal += parseFloat(sl.quantityPerYield) * sfactor * cost;
        }
      }
      if (subMissing) { missing++; continue; }

      const costPerYieldUnit = subTotal / prep.yieldServings;
      const ru = line.recipeUnit ?? prep.yieldUnit;
      const factor = conversionFactor(ru, prep.yieldUnit);
      if (factor === null) {
        if (isIncompatibleConversion(ru, prep.yieldUnit)) { missing++; continue; }
        total += qty * costPerYieldUnit;
      } else {
        total += qty * factor * costPerYieldUnit;
      }
    } else {
      if (!line.ingredientId) { missing++; continue; }
      const cost = asOf
        ? await costAtDate(line.ingredientId, asOf, cache)
        : await latestCost(line.ingredientId);
      if (cost == null) { missing++; continue; }
      const iu = line.ingredientUnit ?? "";
      const ru = line.recipeUnit ?? iu;
      const factor = conversionFactor(ru, iu);
      if (factor === null) {
        if (isIncompatibleConversion(ru, iu)) { missing++; continue; }
        total += qty * cost;
      } else {
        total += qty * factor * cost;
      }
    }
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

// ── Preparations CRUD ─────────────────────────────────────────────────────────

async function computePreparationCostPerYieldUnit(prepId: number, yieldServings: number): Promise<number | null> {
  const prepLines = await db
    .select({
      ingredientId: preparationLinesTable.ingredientId,
      quantityPerYield: preparationLinesTable.quantityPerYield,
      recipeUnit: preparationLinesTable.recipeUnit,
      ingredientUnit: ingredientsTable.unit,
    })
    .from(preparationLinesTable)
    .leftJoin(ingredientsTable, eq(preparationLinesTable.ingredientId, ingredientsTable.id))
    .where(eq(preparationLinesTable.preparationId, prepId));

  if (prepLines.length === 0) return null;
  let total = 0;
  for (const sl of prepLines) {
    if (!sl.ingredientId) return null;
    const cost = await latestCost(sl.ingredientId);
    if (cost == null) return null;
    const siu = sl.ingredientUnit ?? "";
    const sru = sl.recipeUnit ?? siu;
    const sfactor = conversionFactor(sru, siu);
    if (sfactor === null) {
      if (isIncompatibleConversion(sru, siu)) return null;
      total += parseFloat(sl.quantityPerYield) * cost;
    } else {
      total += parseFloat(sl.quantityPerYield) * sfactor * cost;
    }
  }
  return round4(total / yieldServings);
}

async function buildPreparationResponse(prep: typeof preparationsTable.$inferSelect) {
  const rawLines = await db
    .select({
      id: preparationLinesTable.id,
      ingredientId: preparationLinesTable.ingredientId,
      quantityPerYield: preparationLinesTable.quantityPerYield,
      recipeUnit: preparationLinesTable.recipeUnit,
      ingredientName: ingredientsTable.name,
      ingredientUnit: ingredientsTable.unit,
    })
    .from(preparationLinesTable)
    .leftJoin(ingredientsTable, eq(preparationLinesTable.ingredientId, ingredientsTable.id))
    .where(eq(preparationLinesTable.preparationId, prep.id));

  const ingredientIds = rawLines.filter(l => l.ingredientId != null).map(l => l.ingredientId!);
  const costMap = new Map<number, number>();
  if (ingredientIds.length > 0) {
    const costRows = await db
      .select({ ingredientId: ingredientCostHistoryTable.ingredientId, costPerUnit: ingredientCostHistoryTable.costPerUnit })
      .from(ingredientCostHistoryTable)
      .where(inArray(ingredientCostHistoryTable.ingredientId, [...new Set(ingredientIds)]))
      .orderBy(desc(ingredientCostHistoryTable.effectiveAt));
    for (const row of costRows) {
      if (!costMap.has(row.ingredientId)) costMap.set(row.ingredientId, parseFloat(row.costPerUnit));
    }
  }

  const lines = rawLines.map(l => {
    const qty = parseFloat(l.quantityPerYield);
    const iu = l.ingredientUnit ?? "";
    const ru = l.recipeUnit ?? null;
    const incompat = ru ? isIncompatibleConversion(ru, iu) : false;
    const unitCost = l.ingredientId != null ? (costMap.get(l.ingredientId) ?? null) : null;
    let costContrib: number | null = null;
    if (unitCost != null && !incompat) {
      const factor = ru ? (conversionFactor(ru, iu) ?? 1) : 1;
      costContrib = round4(qty * factor * unitCost);
    }
    return {
      id: l.id,
      ingredientId: l.ingredientId ?? 0,
      ingredientName: l.ingredientName ?? "",
      ingredientUnit: iu,
      quantityPerYield: qty,
      recipeUnit: ru,
      conversionError: incompat || undefined,
      costContribution: costContrib,
    };
  });

  const costPerYieldUnit = await computePreparationCostPerYieldUnit(prep.id, prep.yieldServings);

  return {
    id: prep.id,
    name: prep.name,
    yieldServings: prep.yieldServings,
    yieldUnit: prep.yieldUnit,
    notes: prep.notes,
    createdAt: prep.createdAt.toISOString(),
    updatedAt: prep.updatedAt.toISOString(),
    lines,
    costPerYieldUnit,
  };
}

router.get("/admin/costs/preparations", async (req, res): Promise<void> => {
  try {
    const preps = await db
      .select()
      .from(preparationsTable)
      .orderBy(asc(preparationsTable.name));

    const result = await Promise.all(preps.map(async (prep) => {
      const costPerYieldUnit = await computePreparationCostPerYieldUnit(prep.id, prep.yieldServings);
      return {
        id: prep.id,
        name: prep.name,
        yieldServings: prep.yieldServings,
        yieldUnit: prep.yieldUnit,
        notes: prep.notes,
        costPerYieldUnit,
      };
    }));

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Error listing preparations");
    res.status(500).json({ error: "Failed to list preparations" });
  }
});

router.post("/admin/costs/preparations", async (req, res): Promise<void> => {
  try {
    const { name, yieldServings, yieldUnit, notes, lines } = req.body as {
      name?: string;
      yieldServings?: number;
      yieldUnit?: string;
      notes?: string;
      lines?: Array<{ ingredientId?: number | null; quantityPerYield: number | string; recipeUnit?: string | null }>;
    };

    if (!name?.trim()) { res.status(400).json({ error: "name is required" }); return; }
    if (!yieldUnit?.trim()) { res.status(400).json({ error: "yieldUnit is required" }); return; }
    const yieldSrv = Math.max(1, parseInt(String(yieldServings ?? 1)));

    const prep = await db.transaction(async (tx) => {
      const [p] = await tx.insert(preparationsTable).values({
        name: name.trim(),
        yieldServings: yieldSrv,
        yieldUnit: yieldUnit.trim(),
        notes: notes?.trim() || null,
      }).returning();
      if (Array.isArray(lines) && lines.length > 0) {
        const validLines = lines.filter(l => l.ingredientId != null && l.ingredientId > 0 && l.quantityPerYield);
        if (validLines.length > 0) {
          await tx.insert(preparationLinesTable).values(validLines.map(l => ({
            preparationId: p.id,
            ingredientId: l.ingredientId!,
            quantityPerYield: String(round4(parseFloat(String(l.quantityPerYield)))),
            recipeUnit: l.recipeUnit?.trim() || null,
          })));
        }
      }
      return p;
    });

    res.status(201).json(await buildPreparationResponse(prep));
  } catch (err) {
    req.log.error({ err }, "Error creating preparation");
    res.status(500).json({ error: "Failed to create preparation" });
  }
});

router.get("/admin/costs/preparations/:id", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    const [prep] = await db.select().from(preparationsTable).where(eq(preparationsTable.id, id));
    if (!prep) { res.status(404).json({ error: "Preparation not found" }); return; }
    res.json(await buildPreparationResponse(prep));
  } catch (err) {
    req.log.error({ err }, "Error fetching preparation");
    res.status(500).json({ error: "Failed to fetch preparation" });
  }
});

router.put("/admin/costs/preparations/:id", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    const [existing] = await db.select().from(preparationsTable).where(eq(preparationsTable.id, id));
    if (!existing) { res.status(404).json({ error: "Preparation not found" }); return; }

    const { name, yieldServings, yieldUnit, notes, lines } = req.body as {
      name?: string;
      yieldServings?: number;
      yieldUnit?: string;
      notes?: string;
      lines?: Array<{ ingredientId?: number | null; quantityPerYield: number | string; recipeUnit?: string | null }>;
    };

    if (name !== undefined && !name.trim()) { res.status(400).json({ error: "name cannot be empty" }); return; }
    if (yieldUnit !== undefined && !yieldUnit.trim()) { res.status(400).json({ error: "yieldUnit cannot be empty" }); return; }

    const updates: Partial<typeof preparationsTable.$inferInsert> = { updatedAt: new Date() };
    if (name !== undefined) updates.name = name.trim();
    if (yieldServings !== undefined) updates.yieldServings = Math.max(1, parseInt(String(yieldServings)));
    if (yieldUnit !== undefined) updates.yieldUnit = yieldUnit.trim();
    if (notes !== undefined) updates.notes = notes?.trim() || null;

    const prep = await db.transaction(async (tx) => {
      const [p] = await tx.update(preparationsTable).set(updates).where(eq(preparationsTable.id, id)).returning();
      if (Array.isArray(lines)) {
        await tx.delete(preparationLinesTable).where(eq(preparationLinesTable.preparationId, id));
        const validLines = lines.filter(l => l.ingredientId != null && l.ingredientId > 0 && l.quantityPerYield);
        if (validLines.length > 0) {
          await tx.insert(preparationLinesTable).values(validLines.map(l => ({
            preparationId: id,
            ingredientId: l.ingredientId!,
            quantityPerYield: String(round4(parseFloat(String(l.quantityPerYield)))),
            recipeUnit: l.recipeUnit?.trim() || null,
          })));
        }
      }
      return p;
    });

    res.json(await buildPreparationResponse(prep));
  } catch (err) {
    req.log.error({ err }, "Error updating preparation");
    res.status(500).json({ error: "Failed to update preparation" });
  }
});

router.delete("/admin/costs/preparations/:id", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    const inUse = await db
      .select({ id: recipeLinesTable.id })
      .from(recipeLinesTable)
      .where(eq(recipeLinesTable.preparationId, id))
      .limit(1);
    if (inUse.length > 0) {
      res.status(409).json({ error: "This preparation is referenced by one or more recipes and cannot be deleted." });
      return;
    }
    const [deleted] = await db.delete(preparationsTable).where(eq(preparationsTable.id, id)).returning();
    if (!deleted) { res.status(404).json({ error: "Preparation not found" }); return; }
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Error deleting preparation");
    res.status(500).json({ error: "Failed to delete preparation" });
  }
});

// Returns [{id, name}] of menu items that have their own recipe rows — used by
// the admin UI to populate the "inherit recipe from" picker.
router.get("/admin/menu/recipe-owners", async (req, res): Promise<void> => {
  try {
    const owners = await db
      .select({ id: menuItemsTable.id, name: menuItemsTable.name })
      .from(menuItemsTable)
      .where(and(
        eq(menuItemsTable.available, true),
        exists(
          db.select({ one: sql<number>`1` }).from(recipesTable).where(eq(recipesTable.menuItemId, menuItemsTable.id)),
        ),
      ))
      .orderBy(asc(menuItemsTable.name));
    res.json(owners);
  } catch (err) {
    req.log.error({ err }, "Error listing recipe owners");
    res.status(500).json({ error: "Failed to list recipe owners" });
  }
});

// ── Helper: build a recipe response object from a resolved recipe row + owning item ──
async function buildRecipeResponse(
  recipe: typeof recipesTable.$inferSelect,
  item: typeof menuItemsTable.$inferSelect,
  menuItemId: number,
  isInherited: boolean,
  inheritedFrom: { id: number; name: string } | null,
) {
  const rawLines = await db
    .select({
      id: recipeLinesTable.id,
      ingredientId: recipeLinesTable.ingredientId,
      preparationId: recipeLinesTable.preparationId,
      quantityPerYield: recipeLinesTable.quantityPerYield,
      recipeUnit: recipeLinesTable.recipeUnit,
      ingredientName: ingredientsTable.name,
      ingredientUnit: ingredientsTable.unit,
    })
    .from(recipeLinesTable)
    .leftJoin(ingredientsTable, eq(recipeLinesTable.ingredientId, ingredientsTable.id))
    .where(eq(recipeLinesTable.recipeId, recipe.id));

  // Fetch preparation details for preparation lines
  const prepIds = [...new Set(rawLines.filter(l => l.preparationId != null).map(l => l.preparationId!))];
  const prepInfoRows = prepIds.length > 0
    ? await db
        .select({
          id: preparationsTable.id,
          yieldServings: preparationsTable.yieldServings,
          yieldUnit: preparationsTable.yieldUnit,
          name: preparationsTable.name,
        })
        .from(preparationsTable)
        .where(inArray(preparationsTable.id, prepIds))
    : [];
  const prepInfoMap = new Map(prepInfoRows.map(r => [r.id, r]));

  // Batch-load latest ingredient costs for per-line costContribution
  const ingredientLineIds = [...new Set(rawLines.filter(l => l.ingredientId != null).map(l => l.ingredientId!))];
  const ingredientCostMap = new Map<number, number>();
  if (ingredientLineIds.length > 0) {
    const costRows = await db
      .select({ ingredientId: ingredientCostHistoryTable.ingredientId, costPerUnit: ingredientCostHistoryTable.costPerUnit })
      .from(ingredientCostHistoryTable)
      .where(inArray(ingredientCostHistoryTable.ingredientId, ingredientLineIds))
      .orderBy(desc(ingredientCostHistoryTable.effectiveAt));
    for (const row of costRows) {
      if (!ingredientCostMap.has(row.ingredientId)) {
        ingredientCostMap.set(row.ingredientId, parseFloat(row.costPerUnit));
      }
    }
  }

  // Compute cost-per-yield-unit for each referenced preparation
  const prepCostMap = new Map<number, number | null>();
  for (const id of prepIds) {
    const pi = prepInfoMap.get(id);
    if (pi) {
      const cost = await computePreparationCostPerYieldUnit(id, pi.yieldServings);
      prepCostMap.set(id, cost);
    }
  }

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

  const lines = rawLines.map(l => {
    const qty = parseFloat(l.quantityPerYield);
    if (l.preparationId != null) {
      const pi = prepInfoMap.get(l.preparationId);
      const yieldUnit = pi?.yieldUnit ?? "";
      const ru = l.recipeUnit ?? yieldUnit;
      const costPerYieldUnit = prepCostMap.get(l.preparationId) ?? null;
      let costContrib: number | null = null;
      if (costPerYieldUnit != null && yieldUnit) {
        const factor = conversionFactor(ru, yieldUnit);
        if (!isIncompatibleConversion(ru, yieldUnit)) {
          costContrib = round4(qty * (factor ?? 1) * costPerYieldUnit);
        }
      }
      return {
        id: l.id,
        kind: "preparation" as const,
        preparationId: l.preparationId,
        preparationName: pi?.name ?? "Unknown preparation",
        preparationYieldUnit: yieldUnit,
        quantityPerYield: qty,
        recipeUnit: l.recipeUnit ?? null,
        costContribution: costContrib,
      };
    }
    const iu = l.ingredientUnit ?? "";
    const ru = l.recipeUnit ?? null;
    const incompat = ru ? isIncompatibleConversion(ru, iu) : false;
    const latestCostVal = l.ingredientId != null ? (ingredientCostMap.get(l.ingredientId) ?? null) : null;
    let costContrib: number | null = null;
    if (latestCostVal != null && !incompat) {
      const factor = ru ? (conversionFactor(ru, iu) ?? 1) : 1;
      costContrib = round4(qty * factor * latestCostVal);
    }
    return {
      id: l.id,
      kind: "ingredient" as const,
      ingredientId: l.ingredientId ?? 0,
      ingredientName: l.ingredientName ?? "",
      ingredientUnit: iu,
      quantityPerYield: qty,
      recipeUnit: ru,
      conversionError: incompat,
      costContribution: costContrib,
    };
  });

  return {
    id: recipe.id,
    menuItemId,
    yieldServings: recipe.yieldServings,
    notes: recipe.notes,
    lines,
    costPerServing,
    costPerUnit,
    missingCosts,
    panSizeCosts,
    isInherited,
    inheritedFrom,
  };
}

router.get("/admin/menu/:itemId/recipe", async (req, res): Promise<void> => {
  try {
    const itemId = parseInt(req.params.itemId);
    const [item] = await db.select().from(menuItemsTable).where(eq(menuItemsTable.id, itemId));
    if (!item) { res.status(404).json({ error: "Menu item not found" }); return; }

    // Check for own recipe first
    const [ownRecipe] = await db.select().from(recipesTable).where(eq(recipesTable.menuItemId, itemId));
    if (ownRecipe) {
      res.json(await buildRecipeResponse(ownRecipe, item, itemId, false, null));
      return;
    }

    // No own recipe — check for inherited recipe via sourceItemId (one level only)
    if (item.sourceItemId) {
      const [sourceItem] = await db.select().from(menuItemsTable).where(eq(menuItemsTable.id, item.sourceItemId));
      if (sourceItem) {
        const [sourceRecipe] = await db.select().from(recipesTable).where(eq(recipesTable.menuItemId, sourceItem.id));
        if (sourceRecipe) {
          res.json(await buildRecipeResponse(
            sourceRecipe,
            item,
            itemId,
            true,
            { id: sourceItem.id, name: sourceItem.name },
          ));
          return;
        }
      }
    }

    res.json(null);
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
      lines?: Array<{
        ingredientId?: number | null;
        preparationId?: number | null;
        quantityPerYield: number | string;
        recipeUnit?: string | null;
      }>;
    };

    const yield_ = Math.max(1, parseInt(String(yieldServings ?? 1)));
    if (!Array.isArray(lines)) { res.status(400).json({ error: "lines array is required" }); return; }

    // Validate lines: each must have exactly one of ingredientId or preparationId (XOR)
    for (const l of lines) {
      const hasIng = l.ingredientId != null && l.ingredientId > 0;
      const hasPrep = l.preparationId != null && l.preparationId > 0;
      if (!hasIng && !hasPrep) {
        res.status(400).json({ error: "Each recipe line must specify either ingredientId or preparationId" });
        return;
      }
      if (hasIng && hasPrep) {
        res.status(400).json({ error: "A recipe line cannot have both ingredientId and preparationId" });
        return;
      }
    }

    // Validate that all referenced preparationIds exist
    const prepIdRefs = [...new Set(lines.filter(l => l.preparationId != null && l.preparationId! > 0).map(l => l.preparationId!))];
    if (prepIdRefs.length > 0) {
      const existingPreps = await db
        .select({ id: preparationsTable.id })
        .from(preparationsTable)
        .where(inArray(preparationsTable.id, prepIdRefs));
      const existingIds = new Set(existingPreps.map(r => r.id));
      const missing = prepIdRefs.filter(id => !existingIds.has(id));
      if (missing.length > 0) {
        res.status(400).json({ error: `Preparation IDs not found: ${missing.join(", ")}` });
        return;
      }
    }

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

      const validLines = lines.filter(l => {
        const hasIng = l.ingredientId != null && l.ingredientId > 0;
        const hasPrep = l.preparationId != null && l.preparationId > 0;
        return (hasIng || hasPrep) && l.quantityPerYield;
      });

      if (validLines.length > 0) {
        await tx.insert(recipeLinesTable).values(
          validLines.map(l => ({
            recipeId: r.id,
            ingredientId: (l.ingredientId != null && l.ingredientId > 0) ? l.ingredientId : null,
            preparationId: (l.preparationId != null && l.preparationId > 0) ? l.preparationId : null,
            quantityPerYield: String(round4(parseFloat(String(l.quantityPerYield)))),
            recipeUnit: l.recipeUnit?.trim() || null,
          })),
        );
      }
      // Clear sourceItemId now that this item has its own recipe
      if (item.sourceItemId != null) {
        await tx.update(menuItemsTable).set({ sourceItemId: null }).where(eq(menuItemsTable.id, itemId));
      }
      return r;
    });

    // Re-fetch item in case sourceItemId was just cleared
    const [freshItem] = await db.select().from(menuItemsTable).where(eq(menuItemsTable.id, itemId));
    res.json(await buildRecipeResponse(recipe, freshItem ?? item, itemId, false, null));
  } catch (err) {
    if (err instanceof Error && err.message.includes("cannot reference itself")) {
      res.status(400).json({ error: err.message });
      return;
    }
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

    // Pre-load all menu items for serving size and sourceItemId
    const allMenuItems = await db.select({
      id: menuItemsTable.id,
      servingSize: menuItemsTable.servingSize,
      pricingTemplate: menuItemsTable.pricingTemplate,
      sourceItemId: menuItemsTable.sourceItemId,
    }).from(menuItemsTable);
    const menuItemMap = new Map(allMenuItems.map(m => [m.id, m]));

    // Resolve one-level recipe inheritance: for items with no own recipe but a
    // sourceItemId, point recipeByMenuItemId at the source's recipe so COGS
    // computation works transparently.
    for (const m of allMenuItems) {
      if (!recipeByMenuItemId.has(m.id) && m.sourceItemId != null) {
        const sourceRecipe = recipeByMenuItemId.get(m.sourceItemId);
        if (sourceRecipe) recipeByMenuItemId.set(m.id, sourceRecipe);
      }
    }

    // Pre-load ingredient units for conversion factor lookup
    const allIngredients = await db.select({ id: ingredientsTable.id, unit: ingredientsTable.unit }).from(ingredientsTable);
    const ingredientUnitMap = new Map(allIngredients.map(i => [i.id, i.unit]));

    // Pre-load preparation data for recipe lines that reference a preparation
    const prepIdSet = new Set<number>();
    for (const l of allLines) {
      if (l.preparationId != null) prepIdSet.add(l.preparationId);
    }
    const summaryPrepIds = [...prepIdSet];
    const prepInfoRows = summaryPrepIds.length > 0
      ? await db
          .select({ id: preparationsTable.id, yieldServings: preparationsTable.yieldServings, yieldUnit: preparationsTable.yieldUnit })
          .from(preparationsTable)
          .where(inArray(preparationsTable.id, summaryPrepIds))
      : [];
    const summaryPrepMap = new Map(prepInfoRows.map(r => [r.id, r]));

    // Load ingredient lines for each referenced preparation
    const prepLineRows = summaryPrepIds.length > 0
      ? await db
          .select()
          .from(preparationLinesTable)
          .where(inArray(preparationLinesTable.preparationId, summaryPrepIds))
      : [];
    const prepLinesByPrepId = new Map<number, typeof prepLineRows>();
    for (const sl of prepLineRows) {
      const arr = prepLinesByPrepId.get(sl.preparationId) ?? [];
      arr.push(sl);
      prepLinesByPrepId.set(sl.preparationId, arr);
    }

    const costCache = new Map<string, number>();

    // Compute the cost contribution for a single recipe line (ingredient or preparation).
    // Returns the numeric cost, or "missing" if costs are unavailable.
    async function resolveLineCost(
      line: { ingredientId: number | null; preparationId: number | null; quantityPerYield: string; recipeUnit: string | null },
      atDate: Date,
      fallbackKeys?: Set<string>,
    ): Promise<number | "missing"> {
      const qty = parseFloat(line.quantityPerYield);
      if (line.preparationId != null) {
        const prep = summaryPrepMap.get(line.preparationId);
        if (!prep) return "missing";
        const prepLines = prepLinesByPrepId.get(line.preparationId) ?? [];
        if (prepLines.length === 0) return "missing";
        let prepCost = 0;
        for (const sl of prepLines) {
          if (!sl.ingredientId) return "missing";
          const sCost = await costAtDate(sl.ingredientId, atDate, costCache, fallbackKeys);
          if (sCost == null) return "missing";
          const siu = ingredientUnitMap.get(sl.ingredientId) ?? "";
          const sru = sl.recipeUnit ?? siu;
          const sfactor = conversionFactor(sru, siu);
          if (sfactor === null) {
            if (isIncompatibleConversion(sru, siu)) return "missing";
            prepCost += parseFloat(sl.quantityPerYield) * sCost;
          } else {
            prepCost += parseFloat(sl.quantityPerYield) * sfactor * sCost;
          }
        }
        const costPerYieldUnit = prepCost / prep.yieldServings;
        const ru = line.recipeUnit ?? prep.yieldUnit;
        const factor = conversionFactor(ru, prep.yieldUnit);
        if (factor === null) {
          if (isIncompatibleConversion(ru, prep.yieldUnit)) return "missing";
          return qty * costPerYieldUnit;
        }
        return qty * factor * costPerYieldUnit;
      } else {
        if (!line.ingredientId) return "missing";
        const cost = await costAtDate(line.ingredientId, atDate, costCache, fallbackKeys);
        if (cost == null) return "missing";
        const iu = ingredientUnitMap.get(line.ingredientId) ?? "";
        const ru = line.recipeUnit ?? iu;
        const factor = conversionFactor(ru, iu);
        if (factor === null) {
          if (isIncompatibleConversion(ru, iu)) return "missing";
          return qty * cost;
        }
        return qty * factor * cost;
      }
    }

    // Compute COGS for an array of order items at a specific date
    async function computeOrderCogs(
      items: Array<{ itemId?: number; name: string; quantity: number }>,
      atDate: Date,
      fallbackKeys?: Set<string>,
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
          const result = await resolveLineCost(line, atDate, fallbackKeys);
          if (result === "missing") { hasAllCosts = false; continue; }
          recipeCost += result;
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

    type ItemBreakdownComponent = { name: string; quantity: number; cogs: number };
    type ItemBreakdownEntry = { name: string; quantity: number; cogs: number; revenue: number; components?: Map<string, ItemBreakdownComponent> };
    const itemBreakdown = new Map<string, ItemBreakdownEntry>();

    // Per-item COGS breakdown helper
    async function processItemsForBreakdown(
      items: Array<{ itemId?: number; name: string; quantity: number; unitPrice?: number; price?: number; lineTotal?: number; comboSelections?: Array<{ menuItemId: number; name: string; quantity: number }> }>,
      atDate: Date,
      fallbackKeys?: Set<string>,
    ) {
      for (const item of items) {
        const key = item.itemId ? `${item.itemId}::${item.name}` : `0::${item.name}`;
        const entry = itemBreakdown.get(key) ?? { name: item.name, quantity: 0, cogs: 0, revenue: 0 };
        let costContrib = 0;

        if (item.comboSelections && item.comboSelections.length > 0) {
          // Combo item: COGS is the sum of component costs
          for (const sel of item.comboSelections) {
            const compRecipe = recipeByMenuItemId.get(sel.menuItemId);
            if (!compRecipe) continue;
            const lines = linesByRecipeId.get(compRecipe.id) ?? [];
            let compCost = 0;
            let hasAll = true;
            for (const l of lines) {
              const result = await resolveLineCost(l, atDate, fallbackKeys);
              if (result === "missing") { hasAll = false; break; }
              compCost += result;
            }
            if (hasAll) {
              const servingSize = menuItemMap.get(sel.menuItemId)?.servingSize ?? 1;
              const compCogs = round2((compCost / compRecipe.yieldServings) * servingSize * sel.quantity * item.quantity);
              costContrib = round2(costContrib + compCogs);

              if (!entry.components) entry.components = new Map();
              const compKey = `${sel.menuItemId}::${sel.name}`;
              const compEntry = entry.components.get(compKey) ?? { name: sel.name, quantity: 0, cogs: 0 };
              compEntry.quantity += sel.quantity * item.quantity;
              compEntry.cogs = round2(compEntry.cogs + compCogs);
              entry.components.set(compKey, compEntry);
            }
          }
        } else if (item.itemId) {
          const recipe = recipeByMenuItemId.get(item.itemId);
          if (recipe) {
            const lines = linesByRecipeId.get(recipe.id) ?? [];
            let recipeCost = 0;
            let hasAll = true;
            for (const l of lines) {
              const result = await resolveLineCost(l, atDate, fallbackKeys);
              if (result === "missing") { hasAll = false; break; }
              recipeCost += result;
            }
            if (hasAll) {
              const servingSize = menuItemMap.get(item.itemId)?.servingSize ?? 1;
              costContrib = round2((recipeCost / recipe.yieldServings) * servingSize * item.quantity);
            }
          }
        }

        const unitPrice = item.unitPrice != null ? Number(item.unitPrice) : Number(item.price ?? 0);
        const lineRevenue = item.lineTotal != null ? Number(item.lineTotal) : round2(unitPrice * item.quantity);
        entry.quantity += item.quantity;
        entry.cogs = round2(entry.cogs + costContrib);
        entry.revenue = round2(entry.revenue + lineRevenue);
        itemBreakdown.set(key, entry);
      }
    }

    const fallbackKeys = new Set<string>();

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

        const items = (o.items ?? []) as Array<{ itemId?: number; name: string; quantity: number; price?: number; unitPrice?: number; lineTotal?: number; comboSelections?: Array<{ menuItemId: number; name: string; quantity: number }> }>;
        const r = await computeOrderCogs(items, o.createdAt, fallbackKeys);
        totalCogs = round2(totalCogs + r.cogs);
        itemsWithRecipe += r.itemsWithRecipe;
        itemsWithoutRecipe += r.itemsWithoutRecipe;
        await processItemsForBreakdown(items, o.createdAt, fallbackKeys);
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
        const r = await computeOrderCogs(items, inq.createdAt, fallbackKeys);
        totalCogs = round2(totalCogs + r.cogs);
        itemsWithRecipe += r.itemsWithRecipe;
        itemsWithoutRecipe += r.itemsWithoutRecipe;
        await processItemsForBreakdown(items, inq.createdAt, fallbackKeys);

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
      isEstimated: fallbackKeys.size > 0,
      itemBreakdown: Array.from(itemBreakdown.values())
        .sort((a, b) => b.cogs - a.cogs)
        .map(e => ({
          name: e.name,
          quantity: e.quantity,
          cogs: e.cogs,
          revenue: e.revenue,
          margin: e.revenue > 0 ? round2(((e.revenue - e.cogs) / e.revenue) * 100) : null,
          ...(e.components && e.components.size > 0
            ? { components: Array.from(e.components.values()).sort((a, b) => b.quantity - a.quantity) }
            : {}),
        })),
      laborBreakdown: sessionLaborTotals,
    });
  } catch (err) {
    req.log.error({ err }, "Error computing cost summary");
    res.status(500).json({ error: "Failed to compute cost summary" });
  }
});

// ── Ingredient Process Steps ──────────────────────────────────────────────────

router.get("/admin/costs/ingredients/:id/steps", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    const steps = await db
      .select()
      .from(ingredientProcessStepsTable)
      .where(eq(ingredientProcessStepsTable.ingredientId, id))
      .orderBy(asc(ingredientProcessStepsTable.stepOrder), asc(ingredientProcessStepsTable.id));
    res.json(steps);
  } catch (err) {
    req.log.error({ err }, "Error fetching ingredient steps");
    res.status(500).json({ error: "Failed to fetch steps" });
  }
});

router.put("/admin/costs/ingredients/:id/steps", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    const [ing] = await db.select().from(ingredientsTable).where(eq(ingredientsTable.id, id));
    if (!ing) { res.status(404).json({ error: "Ingredient not found" }); return; }
    const { steps } = req.body as { steps: Array<{ description: string; stepOrder?: number }> };
    if (!Array.isArray(steps)) { res.status(400).json({ error: "steps array is required" }); return; }
    await db.transaction(async (tx) => {
      await tx.delete(ingredientProcessStepsTable).where(eq(ingredientProcessStepsTable.ingredientId, id));
      if (steps.length > 0) {
        const valid = steps.filter(s => s.description?.trim());
        if (valid.length > 0) {
          await tx.insert(ingredientProcessStepsTable).values(valid.map((s, i) => ({
            ingredientId: id,
            description: s.description.trim(),
            stepOrder: s.stepOrder ?? i,
          })));
        }
      }
    });
    const saved = await db
      .select()
      .from(ingredientProcessStepsTable)
      .where(eq(ingredientProcessStepsTable.ingredientId, id))
      .orderBy(asc(ingredientProcessStepsTable.stepOrder), asc(ingredientProcessStepsTable.id));
    res.json(saved);
  } catch (err) {
    req.log.error({ err }, "Error saving ingredient steps");
    res.status(500).json({ error: "Failed to save steps" });
  }
});

// ── Preparation Process Steps ─────────────────────────────────────────────────

router.get("/admin/costs/preparations/:id/steps", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    const steps = await db
      .select()
      .from(preparationProcessStepsTable)
      .where(eq(preparationProcessStepsTable.preparationId, id))
      .orderBy(asc(preparationProcessStepsTable.stepOrder), asc(preparationProcessStepsTable.id));
    res.json(steps);
  } catch (err) {
    req.log.error({ err }, "Error fetching preparation steps");
    res.status(500).json({ error: "Failed to fetch steps" });
  }
});

router.put("/admin/costs/preparations/:id/steps", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    const [prep] = await db.select().from(preparationsTable).where(eq(preparationsTable.id, id));
    if (!prep) { res.status(404).json({ error: "Preparation not found" }); return; }
    const { steps } = req.body as { steps: Array<{ description: string; stepOrder?: number }> };
    if (!Array.isArray(steps)) { res.status(400).json({ error: "steps array is required" }); return; }
    await db.transaction(async (tx) => {
      await tx.delete(preparationProcessStepsTable).where(eq(preparationProcessStepsTable.preparationId, id));
      if (steps.length > 0) {
        const valid = steps.filter(s => s.description?.trim());
        if (valid.length > 0) {
          await tx.insert(preparationProcessStepsTable).values(valid.map((s, i) => ({
            preparationId: id,
            description: s.description.trim(),
            stepOrder: s.stepOrder ?? i,
          })));
        }
      }
    });
    const saved = await db
      .select()
      .from(preparationProcessStepsTable)
      .where(eq(preparationProcessStepsTable.preparationId, id))
      .orderBy(asc(preparationProcessStepsTable.stepOrder), asc(preparationProcessStepsTable.id));
    res.json(saved);
  } catch (err) {
    req.log.error({ err }, "Error saving preparation steps");
    res.status(500).json({ error: "Failed to save steps" });
  }
});

// ── Task List for Catering Inquiry ────────────────────────────────────────────

type TaskStep = { id: number; stepOrder: number; description: string; descriptionEs: string | null };
type TaskIngredient = {
  ingredientId: number; name: string; nameEs: string | null;
  scaledQuantity: number; unit: string; processSteps: TaskStep[];
};
type TaskPrep = {
  preparationId: number; name: string; nameEs: string | null;
  scaledQuantity: number; unit: string;
  processSteps: TaskStep[];
  ingredientLines: TaskIngredient[];
};
type TaskItem = {
  lineItemId: string; menuItemId: number | null; name: string; nameEs: string | null;
  quantity: number; sizeLabel: string | null; sizeServings: number | null;
  hasRecipe: boolean;
  customText: string | null;
  recipeIngredients: TaskIngredient[];
  recipePreparations: TaskPrep[];
};

type SelectionInput = {
  lineItemId: string;
  include?: boolean;
  ingredientIds?: number[];
  preparationIds?: number[];
  customText?: string;
};

router.get("/admin/catering/:id/task-list/saved", async (req, res): Promise<void> => {
  try {
    const inqId = parseInt(req.params.id);
    const [row] = await db.select().from(cateringTaskListsTable).where(eq(cateringTaskListsTable.inquiryId, inqId));
    if (!row) { res.status(404).json({ error: "No saved task list" }); return; }
    res.json({ data: row.data, selections: row.selections, generatedAt: row.generatedAt });
  } catch (err) {
    req.log.error({ err }, "Error fetching saved task list");
    res.status(500).json({ error: "Failed to fetch saved task list" });
  }
});

router.post("/admin/catering/:id/task-list", async (req, res): Promise<void> => {
  try {
    const inqId = parseInt(req.params.id);
    const [inq] = await db.select().from(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, inqId));
    if (!inq) { res.status(404).json({ error: "Inquiry not found" }); return; }

    const { selections: selectionsBody } = req.body as { selections?: SelectionInput[] };
    const selMap = new Map<string, SelectionInput>();
    if (Array.isArray(selectionsBody)) {
      for (const s of selectionsBody) selMap.set(s.lineItemId, s);
    }

    const lineItems = (inq.lineItems as Array<{
      id: string; menuItemId: number | null; name: string; quantity: number;
      sizeLabel?: string | null; sizeServings?: number | null;
    }>) ?? [];

    const taskItems: TaskItem[] = [];
    // buy list: key = `${ingredientId}::${unit}`
    const buyAgg = new Map<string, { ingredientId: number; name: string; qty: number; unit: string }>();

    function addToBuy(ingredientId: number, name: string, scaledQty: number, unit: string) {
      const k = `${ingredientId}::${unit}`;
      const ex = buyAgg.get(k);
      if (ex) { ex.qty = round4(ex.qty + scaledQty); }
      else { buyAgg.set(k, { ingredientId, name, qty: scaledQty, unit }); }
    }

    async function loadIngSteps(ingId: number): Promise<TaskStep[]> {
      const rows = await db
        .select({ id: ingredientProcessStepsTable.id, stepOrder: ingredientProcessStepsTable.stepOrder, description: ingredientProcessStepsTable.description, descriptionEs: ingredientProcessStepsTable.descriptionEs })
        .from(ingredientProcessStepsTable)
        .where(eq(ingredientProcessStepsTable.ingredientId, ingId))
        .orderBy(asc(ingredientProcessStepsTable.stepOrder), asc(ingredientProcessStepsTable.id));
      return rows;
    }

    async function loadPrepSteps(prepId: number): Promise<TaskStep[]> {
      const rows = await db
        .select({ id: preparationProcessStepsTable.id, stepOrder: preparationProcessStepsTable.stepOrder, description: preparationProcessStepsTable.description, descriptionEs: preparationProcessStepsTable.descriptionEs })
        .from(preparationProcessStepsTable)
        .where(eq(preparationProcessStepsTable.preparationId, prepId))
        .orderBy(asc(preparationProcessStepsTable.stepOrder), asc(preparationProcessStepsTable.id));
      return rows;
    }

    for (const li of lineItems) {
      const sel = selMap.get(li.id);
      if (sel?.include === false) continue;

      const menuItemId = li.menuItemId ?? null;
      const lineQty = Number(li.quantity) || 1;
      const sizeServings = Number(li.sizeServings) || 1;

      if (!menuItemId) {
        taskItems.push({ lineItemId: li.id, menuItemId: null, name: li.name, nameEs: null, quantity: lineQty, sizeLabel: li.sizeLabel ?? null, sizeServings: li.sizeServings ?? null, hasRecipe: false, customText: sel?.customText ?? null, recipeIngredients: [], recipePreparations: [] });
        continue;
      }

      // Resolve recipe: own first, then inherited via sourceItemId
      let recipe: typeof recipesTable.$inferSelect | null = null;
      const [ownRecipe] = await db.select().from(recipesTable).where(eq(recipesTable.menuItemId, menuItemId));
      if (ownRecipe) {
        recipe = ownRecipe;
      } else {
        const [item] = await db.select({ sourceItemId: menuItemsTable.sourceItemId }).from(menuItemsTable).where(eq(menuItemsTable.id, menuItemId));
        if (item?.sourceItemId) {
          const [sourceRecipe] = await db.select().from(recipesTable).where(eq(recipesTable.menuItemId, item.sourceItemId));
          if (sourceRecipe) recipe = sourceRecipe;
        }
      }

      if (!recipe) {
        taskItems.push({ lineItemId: li.id, menuItemId, name: li.name, nameEs: null, quantity: lineQty, sizeLabel: li.sizeLabel ?? null, sizeServings: li.sizeServings ?? null, hasRecipe: false, customText: sel?.customText ?? null, recipeIngredients: [], recipePreparations: [] });
        continue;
      }

      // Scale factor: total servings / recipe yield
      const totalServings = lineQty * sizeServings;
      const scaleFactor = recipe.yieldServings > 0 ? totalServings / recipe.yieldServings : 1;

      // Get recipe lines
      const recipeLines = await db
        .select({
          id: recipeLinesTable.id,
          ingredientId: recipeLinesTable.ingredientId,
          preparationId: recipeLinesTable.preparationId,
          quantityPerYield: recipeLinesTable.quantityPerYield,
          recipeUnit: recipeLinesTable.recipeUnit,
          ingredientName: ingredientsTable.name,
          ingredientUnit: ingredientsTable.unit,
        })
        .from(recipeLinesTable)
        .leftJoin(ingredientsTable, eq(recipeLinesTable.ingredientId, ingredientsTable.id))
        .where(eq(recipeLinesTable.recipeId, recipe.id));

      const recipeIngredients: TaskIngredient[] = [];
      const recipePreparations: TaskPrep[] = [];

      for (const rl of recipeLines) {
        const scaledQty = round4(parseFloat(rl.quantityPerYield) * scaleFactor);

        if (rl.ingredientId != null) {
          if (sel?.ingredientIds && !sel.ingredientIds.includes(rl.ingredientId)) continue;
          const unit = rl.recipeUnit ?? rl.ingredientUnit ?? "";
          const steps = await loadIngSteps(rl.ingredientId);
          recipeIngredients.push({ ingredientId: rl.ingredientId, name: rl.ingredientName ?? "", nameEs: null, scaledQuantity: scaledQty, unit, processSteps: steps });
          addToBuy(rl.ingredientId, rl.ingredientName ?? "", scaledQty, unit);
        } else if (rl.preparationId != null) {
          if (sel?.preparationIds && !sel.preparationIds.includes(rl.preparationId)) continue;
          const [prepRow] = await db.select().from(preparationsTable).where(eq(preparationsTable.id, rl.preparationId));
          if (!prepRow) continue;
          const prepUnit = rl.recipeUnit ?? prepRow.yieldUnit;
          const factor = conversionFactor(prepUnit, prepRow.yieldUnit) ?? 1;
          const scaledInPrepUnits = round4(scaledQty * factor);
          const prepScale = prepRow.yieldServings > 0 ? scaledInPrepUnits / prepRow.yieldServings : 1;

          const prepSteps = await loadPrepSteps(rl.preparationId);

          // Expand prep ingredient lines
          const prepLines = await db
            .select({
              ingredientId: preparationLinesTable.ingredientId,
              ingredientName: ingredientsTable.name,
              ingredientUnit: ingredientsTable.unit,
              quantityPerYield: preparationLinesTable.quantityPerYield,
              recipeUnit: preparationLinesTable.recipeUnit,
            })
            .from(preparationLinesTable)
            .leftJoin(ingredientsTable, eq(preparationLinesTable.ingredientId, ingredientsTable.id))
            .where(eq(preparationLinesTable.preparationId, rl.preparationId));

          const prepIngredients: TaskIngredient[] = [];
          for (const pl of prepLines) {
            if (!pl.ingredientId) continue;
            const plUnit = pl.recipeUnit ?? pl.ingredientUnit ?? "";
            const plQty = round4(parseFloat(pl.quantityPerYield) * prepScale);
            const ingSteps = await loadIngSteps(pl.ingredientId);
            prepIngredients.push({ ingredientId: pl.ingredientId, name: pl.ingredientName ?? "", nameEs: null, scaledQuantity: plQty, unit: plUnit, processSteps: ingSteps });
            addToBuy(pl.ingredientId, pl.ingredientName ?? "", plQty, plUnit);
          }

          recipePreparations.push({ preparationId: rl.preparationId, name: prepRow.name, nameEs: null, scaledQuantity: scaledQty, unit: prepUnit, processSteps: prepSteps, ingredientLines: prepIngredients });
        }
      }

      taskItems.push({ lineItemId: li.id, menuItemId, name: li.name, nameEs: null, quantity: lineQty, sizeLabel: li.sizeLabel ?? null, sizeServings: li.sizeServings ?? null, hasRecipe: true, customText: null, recipeIngredients, recipePreparations });
    }

    const buyList = Array.from(buyAgg.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(b => ({ ingredientId: b.ingredientId, name: b.name, nameEs: null as string | null, totalQuantity: b.qty, unit: b.unit }));

    // Collect unique strings needing translation (not already translated by DB)
    const toTranslate = new Set<string>();
    for (const ti of taskItems) {
      toTranslate.add(ti.name);
      for (const ri of ti.recipeIngredients) {
        toTranslate.add(ri.name);
        for (const s of ri.processSteps) { if (!s.descriptionEs) toTranslate.add(s.description); }
      }
      for (const rp of ti.recipePreparations) {
        toTranslate.add(rp.name);
        for (const s of rp.processSteps) { if (!s.descriptionEs) toTranslate.add(s.description); }
        for (const ing of rp.ingredientLines) {
          toTranslate.add(ing.name);
          for (const s of ing.processSteps) { if (!s.descriptionEs) toTranslate.add(s.description); }
        }
      }
    }
    for (const b of buyList) toTranslate.add(b.name);

    // Batch translate via OpenAI
    const translations = new Map<string, string>();
    const toTranslateArr = Array.from(toTranslate).filter(s => s.trim());
    if (toTranslateArr.length > 0) {
      try {
        const response = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{
            role: "user",
            content: `Translate the following food/catering terms and instructions from English to Spanish. Return a valid JSON object where keys are the original English strings and values are accurate Spanish translations. Maintain culinary precision.\n\nStrings:\n${JSON.stringify(toTranslateArr)}`,
          }],
          response_format: { type: "json_object" },
          temperature: 0.1,
        });
        const raw = response.choices[0]?.message?.content ?? "{}";
        const parsed = JSON.parse(raw) as Record<string, string>;
        for (const [k, v] of Object.entries(parsed)) translations.set(k, String(v));
      } catch (err) {
        req.log.warn({ err }, "Task list translation failed — returning untranslated");
      }
    }

    const tr = (s: string) => translations.get(s) ?? null;

    // Apply translations
    const result = {
      inquiryId: inqId,
      clientName: inq.clientName,
      eventDate: (inq as any).eventDate ?? null,
      taskItems: taskItems.map(ti => ({
        ...ti,
        nameEs: tr(ti.name),
        recipeIngredients: ti.recipeIngredients.map(ri => ({
          ...ri, nameEs: tr(ri.name),
          processSteps: ri.processSteps.map(s => ({ ...s, descriptionEs: s.descriptionEs ?? tr(s.description) })),
        })),
        recipePreparations: ti.recipePreparations.map(rp => ({
          ...rp, nameEs: tr(rp.name),
          processSteps: rp.processSteps.map(s => ({ ...s, descriptionEs: s.descriptionEs ?? tr(s.description) })),
          ingredientLines: rp.ingredientLines.map(ing => ({
            ...ing, nameEs: tr(ing.name),
            processSteps: ing.processSteps.map(s => ({ ...s, descriptionEs: s.descriptionEs ?? tr(s.description) })),
          })),
        })),
      })),
      buyList: buyList.map(b => ({ ...b, nameEs: tr(b.name) })),
    };

    await db.insert(cateringTaskListsTable)
      .values({ inquiryId: inqId, data: result as any, selections: (selectionsBody ?? null) as any, generatedAt: new Date() })
      .onConflictDoUpdate({
        target: cateringTaskListsTable.inquiryId,
        set: { data: result as any, selections: (selectionsBody ?? null) as any, generatedAt: new Date() },
      });

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Error generating task list");
    res.status(500).json({ error: "Failed to generate task list" });
  }
});

export default router;
