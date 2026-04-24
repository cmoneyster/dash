import { Router, type IRouter } from "express";
import multer from "multer";
import JSZip from "jszip";
import { db } from "@workspace/db";
import { menuItemsTable, menuCategoriesTable } from "@workspace/db/schema";
import { eq, sql, inArray } from "drizzle-orm";
import {
  ITEMS_CSV_FILENAME,
  CATEGORIES_CSV_FILENAME,
  ITEM_COLUMNS,
  CATEGORY_COLUMNS,
  ITEM_FIELD_DOCS,
  CATEGORY_FIELD_DOCS,
  CLEAR_SENTINEL,
  itemToCsvRow,
  categoryToCsvRow,
  rowsToCsv,
  blankItemsCsv,
  blankCategoriesCsv,
  computeMenuDiff,
  type MenuDiff,
} from "../lib/menuCsv";

const router: IRouter = Router();

// In-memory upload — both CSVs combined are <1MB even with hundreds of items.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 4 },
});

async function loadDb() {
  const [items, categories] = await Promise.all([
    db.select().from(menuItemsTable).orderBy(menuItemsTable.id),
    db.select().from(menuCategoriesTable).orderBy(menuCategoriesTable.id),
  ]);
  return { items, categories };
}

function exportItemsCsv(items: Awaited<ReturnType<typeof loadDb>>["items"]): string {
  return rowsToCsv(ITEM_COLUMNS, items.map(itemToCsvRow));
}

function exportCategoriesCsv(cats: Awaited<ReturnType<typeof loadDb>>["categories"]): string {
  return rowsToCsv(CATEGORY_COLUMNS, cats.map(categoryToCsvRow));
}

// ─── GET /admin/menu/csv/export.zip ───────────────────────────────────────
router.get("/admin/menu/csv/export.zip", async (req, res) => {
  try {
    const { items, categories } = await loadDb();
    const zip = new JSZip();
    zip.file(ITEMS_CSV_FILENAME, exportItemsCsv(items));
    zip.file(CATEGORIES_CSV_FILENAME, exportCategoriesCsv(categories));
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="menu-export_${stamp}.zip"`);
    res.send(buf);
  } catch (err) {
    req.log.error({ err }, "Error exporting menu CSV");
    res.status(500).json({ error: "Failed to export menu CSV" });
  }
});

// ─── GET /admin/menu/csv/template.zip ─────────────────────────────────────
router.get("/admin/menu/csv/template.zip", async (req, res) => {
  try {
    const zip = new JSZip();
    zip.file(ITEMS_CSV_FILENAME, blankItemsCsv());
    zip.file(CATEGORIES_CSV_FILENAME, blankCategoriesCsv());
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="menu-template.zip"`);
    res.send(buf);
  } catch (err) {
    req.log.error({ err }, "Error generating menu template");
    res.status(500).json({ error: "Failed to generate template" });
  }
});

// ─── GET /admin/menu/csv/help ─────────────────────────────────────────────
router.get("/admin/menu/csv/help", (_req, res) => {
  res.json({
    clearSentinel: CLEAR_SENTINEL,
    listSeparator: "|",
    itemsFilename: ITEMS_CSV_FILENAME,
    categoriesFilename: CATEGORIES_CSV_FILENAME,
    itemsColumns: ITEM_FIELD_DOCS,
    categoriesColumns: CATEGORY_FIELD_DOCS,
  });
});

// ─── Helper: pull CSVs out of an upload (zip or loose CSVs) ──────────────
async function extractCsvs(files: Express.Multer.File[]): Promise<{
  itemsCsv: string | null;
  categoriesCsv: string | null;
  warnings: string[];
}> {
  let itemsCsv: string | null = null;
  let categoriesCsv: string | null = null;
  const warnings: string[] = [];

  function classifyByName(name: string): "items" | "categories" | null {
    const lower = name.toLowerCase();
    if (lower.includes("menu_items") || lower.endsWith("/items.csv") || lower === "items.csv") return "items";
    if (lower.includes("menu_categories") || lower.endsWith("/categories.csv") || lower === "categories.csv") return "categories";
    if (lower.includes("item")) return "items";
    if (lower.includes("categor")) return "categories";
    return null;
  }
  function classifyByHeader(text: string): "items" | "categories" | null {
    const firstLine = text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0]?.toLowerCase() ?? "";
    if (firstLine.includes("planner_group")) return "categories";
    if (firstLine.includes("pricing_template") || firstLine.includes("size1_label")) return "items";
    return null;
  }

  for (const file of files) {
    const name = file.originalname || "upload";
    const lower = name.toLowerCase();
    if (lower.endsWith(".zip") || file.mimetype === "application/zip") {
      const zip = await JSZip.loadAsync(file.buffer);
      for (const [path, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        if (!path.toLowerCase().endsWith(".csv")) continue;
        const text = await entry.async("string");
        const kind = classifyByName(path) ?? classifyByHeader(text);
        if (kind === "items" && !itemsCsv) itemsCsv = text;
        else if (kind === "categories" && !categoriesCsv) categoriesCsv = text;
        else if (kind) warnings.push(`Ignored extra ${kind} file: ${path}`);
        else warnings.push(`Skipped unrecognized CSV: ${path}`);
      }
    } else if (lower.endsWith(".csv") || file.mimetype.includes("csv") || file.mimetype === "text/plain") {
      const text = file.buffer.toString("utf8");
      const kind = classifyByName(name) ?? classifyByHeader(text);
      if (kind === "items" && !itemsCsv) itemsCsv = text;
      else if (kind === "categories" && !categoriesCsv) categoriesCsv = text;
      else if (kind) warnings.push(`Ignored extra ${kind} file: ${name}`);
      else warnings.push(`Could not classify file: ${name} (rename to menu_items.csv or menu_categories.csv)`);
    } else {
      warnings.push(`Skipped unsupported file: ${name}`);
    }
  }
  return { itemsCsv, categoriesCsv, warnings };
}

// ─── POST /admin/menu/csv/diff ────────────────────────────────────────────
router.post("/admin/menu/csv/diff", upload.array("file", 4), async (req, res) => {
  try {
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (files.length === 0) {
      res.status(400).json({ error: "No files uploaded. Attach a zip or one/two CSV files." });
      return;
    }
    const { itemsCsv, categoriesCsv, warnings } = await extractCsvs(files);
    if (itemsCsv === null && categoriesCsv === null) {
      res.status(400).json({ error: "No menu CSV files found in the upload.", warnings });
      return;
    }
    const { items, categories } = await loadDb();
    const diff = computeMenuDiff({
      itemsCsv,
      categoriesCsv,
      dbItems: items,
      dbCategories: categories,
    });
    res.json({
      diff,
      warnings,
      hadItemsCsv: itemsCsv !== null,
      hadCategoriesCsv: categoriesCsv !== null,
      // Echo the source CSVs so the apply step re-parses the same content
      // (avoids client tampering with the row payload — we re-validate).
      sources: { itemsCsv, categoriesCsv },
    });
  } catch (err) {
    req.log.error({ err }, "Error computing menu CSV diff");
    res.status(500).json({ error: "Failed to compute diff" });
  }
});

// ─── POST /admin/menu/csv/apply ───────────────────────────────────────────
//
// Body (JSON):
//   {
//     itemsCsv: string | null,
//     categoriesCsv: string | null,
//     selectedCategoryRowIndexes: number[],   // 1-based positions in CSV
//     selectedItemRowIndexes:     number[],
//     deleteMissingCategoryIds:   number[],   // ids selected for deletion
//     deleteMissingItemIds:       number[],
//   }
//
// Re-parses the supplied CSVs against the current DB and applies only the
// selected rows in a single transaction (categories first).
//
// The apply payload echoes the parsed CSVs back as JSON strings so the
// server can re-parse them under the same diff rules. Real exports can
// approach a few hundred KB; the global express.json limit in app.ts is
// raised to 2MB specifically to accommodate this round-trip.
router.post("/admin/menu/csv/apply", async (req, res) => {
  try {
    const body = req.body ?? {};
    const itemsCsv: string | null = typeof body.itemsCsv === "string" ? body.itemsCsv : null;
    const categoriesCsv: string | null = typeof body.categoriesCsv === "string" ? body.categoriesCsv : null;
    const selCatIdx = new Set<number>(Array.isArray(body.selectedCategoryRowIndexes) ? body.selectedCategoryRowIndexes.map(Number) : []);
    const selItemIdx = new Set<number>(Array.isArray(body.selectedItemRowIndexes) ? body.selectedItemRowIndexes.map(Number) : []);
    const delCatIds = new Set<number>(Array.isArray(body.deleteMissingCategoryIds) ? body.deleteMissingCategoryIds.map(Number) : []);
    const delItemIds = new Set<number>(Array.isArray(body.deleteMissingItemIds) ? body.deleteMissingItemIds.map(Number) : []);

    const { items: dbItems, categories: dbCategories } = await loadDb();
    const diff: MenuDiff = computeMenuDiff({
      itemsCsv, categoriesCsv,
      dbItems, dbCategories,
    });

    // Bail out if any *selected* row has errors.
    const selectedCatRows = diff.categories.rows.filter((r) => selCatIdx.has(r.rowIndex));
    const selectedItemRows = diff.items.rows.filter((r) => selItemIdx.has(r.rowIndex));
    const blockingErrors: string[] = [];
    for (const r of selectedCatRows) {
      if (r.errors.length) blockingErrors.push(`Category row ${r.rowIndex} (${r.displayName}): ${r.errors.join("; ")}`);
    }
    for (const r of selectedItemRows) {
      if (r.errors.length) blockingErrors.push(`Item row ${r.rowIndex} (${r.displayName}): ${r.errors.join("; ")}`);
    }

    // Selection-aware re-validation: an item may reference a category that
    // *would* exist after the selected categories are applied. The diff
    // step optimistically allows any category that appears in the CSV, but
    // if the user deselects that category row we must reject the item.
    //
    // Compute the post-selection category-name set:
    //   = (DB category names)
    //     − (names of DB categories scheduled for deletion)
    //     − (names of DB categories being renamed away from)
    //     ∪ (names of DB categories being renamed to)
    //     ∪ (names of newly inserted categories)
    const postCategoryNames = new Set(dbCategories.map((c) => c.name));
    for (const id of delCatIds) {
      const c = dbCategories.find((x) => x.id === id);
      if (c) postCategoryNames.delete(c.name);
    }
    for (const r of selectedCatRows) {
      if (r.status === "new" && r.newValues) {
        const n = (r.newValues as Record<string, unknown>).name;
        if (typeof n === "string") postCategoryNames.add(n);
      } else if (r.status === "updated" && r.id != null && r.updates) {
        const newName = (r.updates as Record<string, unknown>).name;
        const before = dbCategories.find((c) => c.id === r.id);
        if (typeof newName === "string" && before && newName !== before.name) {
          postCategoryNames.delete(before.name);
          postCategoryNames.add(newName);
        }
      }
    }
    for (const r of selectedItemRows) {
      // Only check rows that are actually changing the category, plus all
      // new rows. Updates that don't touch category are unaffected.
      let categoryToCheck: string | null = null;
      if (r.status === "new" && r.newValues) {
        const c = (r.newValues as Record<string, unknown>).category;
        if (typeof c === "string") categoryToCheck = c;
      } else if (r.status === "updated" && r.updates) {
        const c = (r.updates as Record<string, unknown>).category;
        if (typeof c === "string") categoryToCheck = c;
      }
      if (categoryToCheck && !postCategoryNames.has(categoryToCheck)) {
        blockingErrors.push(
          `Item row ${r.rowIndex} (${r.displayName}): category "${categoryToCheck}" will not exist after this import — also select that category row, or change the item's category.`,
        );
      }
    }

    // Block category deletions that would orphan menu items. Mirrors the
    // existing /admin/categories DELETE business rule (admin-categories.ts).
    // Names of items that will exist after item inserts/updates/deletes:
    const postItemCategoryUsage = new Map<string, number>();
    const itemRowIdsBeingDeleted = new Set<number>(
      diff.items.missing.filter((m) => delItemIds.has(m.id)).map((m) => m.id),
    );
    const itemRowIdsBeingUpdated = new Map<number, string>();
    for (const r of selectedItemRows) {
      if (r.status === "updated" && r.id != null && r.updates) {
        const c = (r.updates as Record<string, unknown>).category;
        if (typeof c === "string") itemRowIdsBeingUpdated.set(r.id, c);
      }
    }
    for (const it of dbItems) {
      if (itemRowIdsBeingDeleted.has(it.id)) continue;
      const cat = itemRowIdsBeingUpdated.get(it.id) ?? it.category;
      postItemCategoryUsage.set(cat, (postItemCategoryUsage.get(cat) ?? 0) + 1);
    }
    for (const r of selectedItemRows) {
      if (r.status === "new" && r.newValues) {
        const c = (r.newValues as Record<string, unknown>).category;
        if (typeof c === "string") postItemCategoryUsage.set(c, (postItemCategoryUsage.get(c) ?? 0) + 1);
      }
    }
    for (const id of delCatIds) {
      const c = dbCategories.find((x) => x.id === id);
      if (!c) continue;
      const usage = postItemCategoryUsage.get(c.name) ?? 0;
      if (usage > 0) {
        blockingErrors.push(
          `Cannot delete category "${c.name}": ${usage} menu item${usage === 1 ? "" : "s"} would still reference it. Reassign or delete those items first.`,
        );
      }
    }

    if (blockingErrors.length) {
      res.status(400).json({ error: "Cannot apply rows that still have validation errors", details: blockingErrors });
      return;
    }

    const result = await db.transaction(async (tx) => {
      let categoriesCreated = 0;
      let categoriesUpdated = 0;
      let categoriesDeleted = 0;
      let itemsCreated = 0;
      let itemsUpdated = 0;
      let itemsDeleted = 0;
      // ── Categories first ──────────────────────────────────────────────
      // Track rename pairs so we can cascade item.category to the new name.
      const renamePairs: Array<{ from: string; to: string }> = [];

      for (const r of selectedCatRows) {
        if (r.status === "new" && r.newValues) {
          // For new rows: pick a sortOrder if not specified
          const values: Record<string, unknown> = { ...r.newValues };
          if (values.sortOrder === undefined || values.sortOrder === null) {
            const [maxRow] = await tx
              .select({ max: sql<number>`COALESCE(MAX(${menuCategoriesTable.sortOrder}), -1)` })
              .from(menuCategoriesTable);
            values.sortOrder = Number(maxRow?.max ?? -1) + 1;
          }
          await tx.insert(menuCategoriesTable).values(values as typeof menuCategoriesTable.$inferInsert);
          categoriesCreated++;
        } else if (r.status === "updated" && r.id != null && r.updates) {
          const before = dbCategories.find((c) => c.id === r.id);
          if (before && r.updates.name !== undefined && before.name !== r.updates.name) {
            renamePairs.push({ from: before.name, to: String(r.updates.name) });
          }
          await tx.update(menuCategoriesTable).set(r.updates).where(eq(menuCategoriesTable.id, r.id));
          categoriesUpdated++;
        }
      }

      // Cascade category renames into menu_items.category
      for (const { from, to } of renamePairs) {
        await tx
          .update(menuItemsTable)
          .set({ category: to })
          .where(eq(menuItemsTable.category, from));
      }

      // ── Delete missing categories (only those explicitly selected) ────
      const catsToDelete = diff.categories.missing
        .filter((m) => delCatIds.has(m.id))
        .map((m) => m.id);
      if (catsToDelete.length) {
        await tx.delete(menuCategoriesTable).where(inArray(menuCategoriesTable.id, catsToDelete));
        categoriesDeleted = catsToDelete.length;
      }

      // ── Items ─────────────────────────────────────────────────────────
      for (const r of selectedItemRows) {
        if (r.status === "new" && r.newValues) {
          await tx.insert(menuItemsTable).values(r.newValues as typeof menuItemsTable.$inferInsert);
          itemsCreated++;
        } else if (r.status === "updated" && r.id != null && r.updates) {
          await tx.update(menuItemsTable).set(r.updates).where(eq(menuItemsTable.id, r.id));
          itemsUpdated++;
        }
      }

      const itemsToDelete = diff.items.missing
        .filter((m) => delItemIds.has(m.id))
        .map((m) => m.id);
      if (itemsToDelete.length) {
        await tx.delete(menuItemsTable).where(inArray(menuItemsTable.id, itemsToDelete));
        itemsDeleted = itemsToDelete.length;
      }

      return { categoriesCreated, categoriesUpdated, categoriesDeleted, itemsCreated, itemsUpdated, itemsDeleted };
    });

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Error applying menu CSV import");
    res.status(500).json({ error: "Failed to apply CSV import" });
  }
});

export default router;
