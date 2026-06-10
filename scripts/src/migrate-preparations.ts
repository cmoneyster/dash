/**
 * migrate-preparations.ts
 *
 * One-time data migration: move old "preparation" recipes (those that had
 * `yield_unit` set on the `recipes` table) into the new standalone
 * `preparations` / `preparation_lines` tables, rewire any parent recipe
 * lines that used `sub_recipe_id`, and hide the old preparation-only menu
 * items from the customer-facing menu.
 *
 * SAFE TO RUN MULTIPLE TIMES — it is fully idempotent.  If the old columns
 * have already been dropped (i.e. you ran the schema push first and there
 * was no data to migrate) the script exits cleanly.
 *
 * Run with:
 *   pnpm --filter @workspace/scripts run migrate:preparations
 */

import { pool } from "@workspace/db";
import type { PoolClient } from "pg";

async function columnExists(client: PoolClient, table: string, column: string): Promise<boolean> {
  const res = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_name = $1 AND column_name = $2
     ) AS exists`,
    [table, column],
  );
  return res.rows[0].exists;
}

async function main() {
  console.log("=== Preparations migration ===\n");

  const client = await pool.connect();
  try {
    // Check whether the old columns still exist
    const hasYieldUnit   = await columnExists(client, "recipes",      "yield_unit");
    const hasSubRecipeId = await columnExists(client, "recipe_lines", "sub_recipe_id");

    if (!hasYieldUnit && !hasSubRecipeId) {
      console.log(
        "Old columns (recipes.yield_unit / recipe_lines.sub_recipe_id) " +
        "no longer exist — schema was already migrated.\n" +
        "Migration complete (no-op).",
      );
      return;
    }

    await client.query("BEGIN");

    // ── Step 1: Create new tables if they don't exist yet ────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS preparations (
        id             SERIAL PRIMARY KEY,
        name           TEXT    NOT NULL,
        yield_servings INT     NOT NULL DEFAULT 1,
        yield_unit     TEXT    NOT NULL,
        notes          TEXT,
        created_at     TIMESTAMP NOT NULL DEFAULT now(),
        updated_at     TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS preparation_lines (
        id                 SERIAL PRIMARY KEY,
        preparation_id     INT NOT NULL REFERENCES preparations(id) ON DELETE CASCADE,
        ingredient_id      INT REFERENCES ingredients(id),
        quantity_per_yield NUMERIC(12,4) NOT NULL,
        recipe_unit        TEXT
      )
    `);
    await client.query(`
      ALTER TABLE recipe_lines ADD COLUMN IF NOT EXISTS preparation_id INT
        REFERENCES preparations(id) ON DELETE SET NULL
    `);

    // ── Step 2: Identify old preparation recipes (yield_unit IS NOT NULL) ─
    const recipeIdToPrepId = new Map<number, number>();

    if (hasYieldUnit) {
      const { rows: prepRecipes } = await client.query<{
        id: number;
        menuItemId: number;
        yieldServings: number;
        yieldUnit: string;
        notes: string | null;
        menuItemName: string;
      }>(`
        SELECT r.id,
               r.menu_item_id   AS "menuItemId",
               r.yield_servings AS "yieldServings",
               r.yield_unit     AS "yieldUnit",
               r.notes,
               mi.name          AS "menuItemName"
        FROM recipes r
        JOIN menu_items mi ON mi.id = r.menu_item_id
        WHERE r.yield_unit IS NOT NULL
      `);

      console.log(`Found ${prepRecipes.length} preparation recipe(s) to migrate.`);

      for (const pr of prepRecipes) {
        // Idempotency check: skip if name already in preparations
        const existRes = await client.query<{ id: number }>(
          `SELECT id FROM preparations WHERE name = $1 LIMIT 1`,
          [pr.menuItemName],
        );
        if (existRes.rows.length > 0) {
          console.log(`  Skipped (already exists): "${pr.menuItemName}" → preparations.id=${existRes.rows[0].id}`);
          recipeIdToPrepId.set(pr.id, existRes.rows[0].id);
          continue;
        }

        // Insert new preparation
        const insertRes = await client.query<{ id: number }>(
          `INSERT INTO preparations (name, yield_servings, yield_unit, notes)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [pr.menuItemName, pr.yieldServings, pr.yieldUnit, pr.notes],
        );
        const newPrepId = insertRes.rows[0].id;
        recipeIdToPrepId.set(pr.id, newPrepId);
        console.log(`  Migrated: "${pr.menuItemName}" → preparations.id=${newPrepId}`);

        // Copy ingredient lines
        const { rows: oldLines } = await client.query<{
          ingredientId: number;
          quantityPerYield: string;
          recipeUnit: string | null;
        }>(`
          SELECT ingredient_id      AS "ingredientId",
                 quantity_per_yield AS "quantityPerYield",
                 recipe_unit        AS "recipeUnit"
          FROM recipe_lines
          WHERE recipe_id = $1 AND ingredient_id IS NOT NULL
        `, [pr.id]);

        for (const line of oldLines) {
          await client.query(
            `INSERT INTO preparation_lines (preparation_id, ingredient_id, quantity_per_yield, recipe_unit)
             VALUES ($1, $2, $3, $4)`,
            [newPrepId, line.ingredientId, line.quantityPerYield, line.recipeUnit],
          );
        }
        console.log(`    → copied ${oldLines.length} ingredient line(s)`);
      }

      // ── Step 3: Rewire parent recipe_lines that used sub_recipe_id ───────
      if (hasSubRecipeId && recipeIdToPrepId.size > 0) {
        let rewiredCount = 0;
        for (const [oldRecipeId, newPrepId] of recipeIdToPrepId) {
          const res = await client.query(
            `UPDATE recipe_lines
             SET preparation_id = $1, ingredient_id = NULL
             WHERE sub_recipe_id = $2 AND preparation_id IS NULL`,
            [newPrepId, oldRecipeId],
          );
          rewiredCount += res.rowCount ?? 0;
        }
        console.log(`\nRewired ${rewiredCount} recipe line(s) from sub_recipe_id → preparation_id.`);
      }

      // ── Step 4: Hide old preparation-only menu items ─────────────────────
      if (prepRecipes.length > 0) {
        const prepMenuItemIds = prepRecipes.map(p => p.menuItemId);
        const idList = prepMenuItemIds.map((_, i) => `$${i + 1}`).join(", ");
        const hideRes = await client.query(
          `UPDATE menu_items SET visible = false WHERE id IN (${idList}) AND visible = true`,
          prepMenuItemIds,
        );
        console.log(`Hidden ${hideRes.rowCount ?? 0} legacy preparation menu item(s) from the customer menu.`);
      }

      // ── Step 5: Drop old columns ──────────────────────────────────────────
      await client.query(`ALTER TABLE recipes DROP COLUMN IF EXISTS yield_unit`);
      console.log("\nDropped recipes.yield_unit");
    }

    if (hasSubRecipeId) {
      await client.query(`ALTER TABLE recipe_lines DROP COLUMN IF EXISTS sub_recipe_id`);
      console.log("Dropped recipe_lines.sub_recipe_id");
    }

    await client.query("COMMIT");
    console.log("\n✓ Migration complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
