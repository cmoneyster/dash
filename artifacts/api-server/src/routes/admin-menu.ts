import { Router, type IRouter } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";
import { db } from "@workspace/db";
import { menuItemsTable, menuCategoriesTable } from "@workspace/db/schema";
import { asc, eq, ne, sql } from "drizzle-orm";

const router: IRouter = Router();

// Returns the next sortOrder slot at the end of the given category
// (MAX(sortOrder) + 10, or 10 if the category is empty). Tx-aware so
// it can be reused inside a transaction.
async function nextSortOrderForCategory(
  tx: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0],
  category: string,
): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | null>`MAX(${menuItemsTable.sortOrder})` })
    .from(menuItemsTable)
    .where(eq(menuItemsTable.category, category));
  const max = row?.max == null ? null : Number(row.max);
  return (max ?? 0) + 10;
}

async function ensureCategoryExists(name: string | undefined | null) {
  if (!name) return;
  const trimmed = String(name).trim();
  if (!trimmed) return;
  const [existing] = await db
    .select()
    .from(menuCategoriesTable)
    .where(eq(menuCategoriesTable.name, trimmed));
  if (existing) return;
  const [maxRow] = await db
    .select({ max: sql<number>`COALESCE(MAX(${menuCategoriesTable.sortOrder}), -1)` })
    .from(menuCategoriesTable);
  const sortOrder = Number(maxRow?.max ?? -1) + 1;
  // Heuristic planner_group default for newly seen names.
  const lower = trimmed.toLowerCase();
  let plannerGroup = "other";
  if (lower.includes("savory")) plannerGroup = "savory";
  else if (lower.includes("sweet") || lower.includes("dessert")) plannerGroup = "sweet";
  else if (lower.startsWith("entrée") || lower.startsWith("entree") || lower.includes(" entrée") || lower.includes(" entree")) plannerGroup = "entree";
  await db
    .insert(menuCategoriesTable)
    .values({ name: trimmed, plannerGroup, visible: true, sortOrder })
    .onConflictDoNothing();
}

function formatItem(item: typeof menuItemsTable.$inferSelect) {
  return {
    ...item,
    price: parseFloat(item.price),
    tier2Price: item.tier2Price != null ? parseFloat(item.tier2Price) : null,
    tier3Price: item.tier3Price != null ? parseFloat(item.tier3Price) : null,
    size1Price: item.size1Price != null ? parseFloat(item.size1Price) : null,
    size2Price: item.size2Price != null ? parseFloat(item.size2Price) : null,
    size3Price: item.size3Price != null ? parseFloat(item.size3Price) : null,
    size4Price: item.size4Price != null ? parseFloat(item.size4Price) : null,
    size5Price: item.size5Price != null ? parseFloat(item.size5Price) : null,
    eventTakerPrice: item.eventTakerPrice != null ? parseFloat(item.eventTakerPrice) : null,
    allergens: item.allergens ?? [],
  };
}

router.get("/admin/menu", async (req, res) => {
  try {
    const items = await db
      .select()
      .from(menuItemsTable)
      .orderBy(asc(menuItemsTable.sortOrder), asc(menuItemsTable.id));
    res.json(items.map(formatItem));
  } catch (err) {
    req.log.error({ err }, "Error listing admin menu items");
    res.status(500).json({ error: "Failed to list menu items" });
  }
});

router.post("/admin/menu", async (req, res) => {
  try {
    const {
      name, description, category, price, servingSize, unit,
      imageUrl, allergens, available, prepTime,
      minimumOrderQty,
      tier2Qty, tier2Price, tier3Qty, tier3Price,
      eventActive, eventStock,
      eventTakerVisible, eventTakerPrice,
      pricingTemplate,
      size1Label, size1Servings, size1Price,
      size2Label, size2Servings, size2Price,
      size3Label, size3Servings, size3Price,
      size4Label, size4Servings, size4Price,
      size5Label, size5Servings, size5Price,
      internalNotes,
      otdEligible,
      labelPolicy,
      labelBoxSize,
    } = req.body;
    // New items always land at the bottom of their category.
    const sortOrder = await nextSortOrderForCategory(db, String(category ?? "").trim());
    const [item] = await db.insert(menuItemsTable).values({
      name,
      description,
      category,
      sortOrder,
      price: String(price),
      servingSize: servingSize ?? 1,
      unit: unit ?? "tray",
      imageUrl: imageUrl ?? null,
      allergens: allergens ?? [],
      available: available ?? true,
      prepTime: prepTime ?? null,
      minimumOrderQty: minimumOrderQty != null ? parseInt(String(minimumOrderQty)) : 1,
      tier2Qty: tier2Qty != null ? parseInt(String(tier2Qty)) : null,
      tier2Price: tier2Price != null ? String(tier2Price) : null,
      tier3Qty: tier3Qty != null ? parseInt(String(tier3Qty)) : null,
      tier3Price: tier3Price != null ? String(tier3Price) : null,
      eventActive: eventActive ?? false,
      eventStock: eventStock != null ? parseInt(String(eventStock)) : null,
      eventTakerVisible: eventTakerVisible ?? false,
      eventTakerPrice: eventTakerPrice != null && eventTakerPrice !== "" ? String(eventTakerPrice) : null,
      pricingTemplate: pricingTemplate ?? "per_unit",
      size1Label: size1Label ?? "Small Pan",
      size1Servings: size1Servings != null ? parseInt(String(size1Servings)) : 15,
      size1Price: size1Price != null ? String(size1Price) : null,
      size2Label: size2Label ?? "Medium Pan",
      size2Servings: size2Servings != null ? parseInt(String(size2Servings)) : 30,
      size2Price: size2Price != null ? String(size2Price) : null,
      size3Label: size3Label ?? "Large Pan",
      size3Servings: size3Servings != null ? parseInt(String(size3Servings)) : 45,
      size3Price: size3Price != null ? String(size3Price) : null,
      size4Label: size4Label ?? null,
      size4Servings: size4Servings != null ? parseInt(String(size4Servings)) : null,
      size4Price: size4Price != null ? String(size4Price) : null,
      size5Label: size5Label ?? null,
      size5Servings: size5Servings != null ? parseInt(String(size5Servings)) : null,
      size5Price: size5Price != null ? String(size5Price) : null,
      internalNotes: internalNotes ? String(internalNotes).trim() || null : null,
      otdEligible: otdEligible ?? false,
      labelPolicy: labelPolicy === "combined" || labelPolicy === "per_box" ? labelPolicy : "per_unit",
      labelBoxSize: labelBoxSize != null && labelBoxSize !== "" ? parseInt(String(labelBoxSize)) : null,
    }).returning();
    await ensureCategoryExists(category);
    res.status(201).json(formatItem(item));
  } catch (err) {
    req.log.error({ err }, "Error creating menu item");
    res.status(500).json({ error: "Failed to create menu item" });
  }
});

router.put("/admin/menu/:id", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    const {
      name, description, category, price, servingSize, unit,
      imageUrl, allergens, available, prepTime,
      minimumOrderQty,
      tier2Qty, tier2Price, tier3Qty, tier3Price,
      eventActive, eventStock,
      eventTakerVisible, eventTakerPrice,
      pricingTemplate,
      size1Label, size1Servings, size1Price,
      size2Label, size2Servings, size2Price,
      size3Label, size3Servings, size3Price,
      size4Label, size4Servings, size4Price,
      size5Label, size5Servings, size5Price,
      internalNotes,
      otdEligible,
      labelPolicy,
      labelBoxSize,
    } = req.body;
    const updates: Record<string, unknown> = {};
    if (name !== undefined)             updates.name = name;
    if (description !== undefined)      updates.description = description;
    if (category !== undefined)         updates.category = category;
    if (price !== undefined)            updates.price = String(price);
    if (servingSize !== undefined)      updates.servingSize = servingSize;
    if (unit !== undefined)             updates.unit = unit;
    if (imageUrl !== undefined)         updates.imageUrl = imageUrl;
    if (allergens !== undefined)        updates.allergens = allergens;
    if (available !== undefined)        updates.available = available;
    if (prepTime !== undefined)         updates.prepTime = prepTime;
    if (minimumOrderQty !== undefined)  updates.minimumOrderQty = minimumOrderQty != null ? parseInt(String(minimumOrderQty)) : 1;
    if (tier2Qty !== undefined)         updates.tier2Qty = tier2Qty === null ? null : parseInt(String(tier2Qty));
    if (tier2Price !== undefined)       updates.tier2Price = tier2Price === null ? null : String(tier2Price);
    if (tier3Qty !== undefined)         updates.tier3Qty = tier3Qty === null ? null : parseInt(String(tier3Qty));
    if (tier3Price !== undefined)       updates.tier3Price = tier3Price === null ? null : String(tier3Price);
    if (eventActive !== undefined)      updates.eventActive = eventActive;
    if (eventStock !== undefined)       updates.eventStock = eventStock === null ? null : parseInt(String(eventStock));
    if (eventTakerVisible !== undefined) updates.eventTakerVisible = eventTakerVisible;
    if (eventTakerPrice !== undefined)  updates.eventTakerPrice = eventTakerPrice === null || eventTakerPrice === "" ? null : String(eventTakerPrice);
    if (pricingTemplate !== undefined)  updates.pricingTemplate = pricingTemplate;
    if (size1Label !== undefined)       updates.size1Label = size1Label;
    if (size1Servings !== undefined)    updates.size1Servings = size1Servings != null ? parseInt(String(size1Servings)) : null;
    if (size1Price !== undefined)       updates.size1Price = size1Price === null ? null : String(size1Price);
    if (size2Label !== undefined)       updates.size2Label = size2Label;
    if (size2Servings !== undefined)    updates.size2Servings = size2Servings != null ? parseInt(String(size2Servings)) : null;
    if (size2Price !== undefined)       updates.size2Price = size2Price === null ? null : String(size2Price);
    if (size3Label !== undefined)       updates.size3Label = size3Label;
    if (size3Servings !== undefined)    updates.size3Servings = size3Servings != null ? parseInt(String(size3Servings)) : null;
    if (size3Price !== undefined)       updates.size3Price = size3Price === null ? null : String(size3Price);
    if (size4Label !== undefined)       updates.size4Label = size4Label;
    if (size4Servings !== undefined)    updates.size4Servings = size4Servings != null ? parseInt(String(size4Servings)) : null;
    if (size4Price !== undefined)       updates.size4Price = size4Price === null ? null : String(size4Price);
    if (size5Label !== undefined)       updates.size5Label = size5Label;
    if (size5Servings !== undefined)    updates.size5Servings = size5Servings != null ? parseInt(String(size5Servings)) : null;
    if (size5Price !== undefined)       updates.size5Price = size5Price === null ? null : String(size5Price);
    if (internalNotes !== undefined)    updates.internalNotes = internalNotes ? String(internalNotes).trim() || null : null;
    if (otdEligible !== undefined)      updates.otdEligible = otdEligible === true || otdEligible === "true";
    if (labelPolicy !== undefined)      updates.labelPolicy = labelPolicy === "combined" || labelPolicy === "per_box" ? labelPolicy : "per_unit";
    if (labelBoxSize !== undefined)     updates.labelBoxSize = labelBoxSize === null || labelBoxSize === "" ? null : parseInt(String(labelBoxSize));

    // If the category is being changed to a different value, drop the
    // item at the bottom of the destination category so it doesn't
    // inherit a stale sortOrder from its old neighbors.
    if (category !== undefined) {
      const [existing] = await db
        .select({ category: menuItemsTable.category })
        .from(menuItemsTable)
        .where(eq(menuItemsTable.id, id));
      if (existing && existing.category !== String(category).trim()) {
        updates.sortOrder = await nextSortOrderForCategory(db, String(category).trim());
      }
    }

    const [item] = await db.update(menuItemsTable).set(updates).where(eq(menuItemsTable.id, id)).returning();
    if (!item) {
      res.status(404).json({ error: "Menu item not found" });
      return;
    }
    if (category !== undefined) await ensureCategoryExists(category);
    res.json(formatItem(item));
  } catch (err) {
    req.log.error({ err }, "Error updating menu item");
    res.status(500).json({ error: "Failed to update menu item" });
  }
});

router.delete("/admin/menu/:id", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    const [deleted] = await db.delete(menuItemsTable).where(eq(menuItemsTable.id, id)).returning();
    if (!deleted) {
      res.status(404).json({ error: "Menu item not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Error deleting menu item");
    res.status(500).json({ error: "Failed to delete menu item" });
  }
});

// Bulk reorder menu items inside a single transaction. Mirrors the
// shape of POST /admin/categories/reorder. Body: { items: [{id, sortOrder}] }
router.post("/admin/menu/reorder", async (req, res): Promise<void> => {
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
        await tx
          .update(menuItemsTable)
          .set({ sortOrder: so })
          .where(eq(menuItemsTable.id, id));
      }
    });
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Error reordering menu items");
    res.status(500).json({ error: "Failed to reorder menu items" });
  }
});

router.post("/admin/menu/generate-description", async (req, res): Promise<void> => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    // Pull a handful of existing descriptions to use as style examples
    const samples = await db
      .select({ name: menuItemsTable.name, description: menuItemsTable.description })
      .from(menuItemsTable)
      .where(ne(menuItemsTable.description, ""))
      .orderBy(asc(menuItemsTable.id))
      .limit(5);

    const sampleText = samples.length > 0
      ? samples.map(s => `"${s.name}": ${s.description}`).join("\n")
      : '"Orange Chicken": Crispy chicken tossed in a tangy, sweet orange glaze. A beloved classic — bold, bright, and satisfying.';

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      max_completion_tokens: 150,
      messages: [
        {
          role: "system",
          content: `You write short, appetizing menu item descriptions for a Chinese-American catering business called "dash by Hollywood East Cafe". Match the tone, length, and style of these real examples from our menu:\n\n${sampleText}\n\nRules: 1-3 sentences max. Warm, sensory, and inviting. No prices. No first-person "we". No markdown or bullet points. Focus on flavor, texture, and what makes the dish special.`,
        },
        {
          role: "user",
          content: `Write a menu description for: ${name.trim()}`,
        },
      ],
    });

    const description = response.choices[0]?.message?.content?.trim() ?? "";
    res.json({ description });
  } catch (err) {
    req.log.error({ err }, "Error generating menu item description");
    res.status(500).json({ error: "Failed to generate description" });
  }
});

export default router;
