import { pgTable, serial, text, numeric, integer, timestamp } from "drizzle-orm/pg-core";
import { menuItemsTable } from "./menu-items";

export const ingredientsTable = pgTable("ingredients", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  unit: text("unit").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const ingredientCostHistoryTable = pgTable("ingredient_cost_history", {
  id: serial("id").primaryKey(),
  ingredientId: integer("ingredient_id").notNull().references(() => ingredientsTable.id),
  costPerUnit: numeric("cost_per_unit", { precision: 12, scale: 4 }).notNull(),
  effectiveAt: timestamp("effective_at").notNull().defaultNow(),
});

export const recipesTable = pgTable("recipes", {
  id: serial("id").primaryKey(),
  menuItemId: integer("menu_item_id").notNull().unique().references(() => menuItemsTable.id),
  yieldServings: integer("yield_servings").notNull().default(1),
  yieldUnit: text("yield_unit"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const recipeLinesTable = pgTable("recipe_lines", {
  id: serial("id").primaryKey(),
  recipeId: integer("recipe_id").notNull().references(() => recipesTable.id, { onDelete: "cascade" }),
  ingredientId: integer("ingredient_id").references(() => ingredientsTable.id),
  subRecipeId: integer("sub_recipe_id").references(() => recipesTable.id, { onDelete: "set null" }),
  quantityPerYield: numeric("quantity_per_yield", { precision: 12, scale: 4 }).notNull(),
  recipeUnit: text("recipe_unit"),
});

export const eventLaborTable = pgTable("event_labor", {
  id: serial("id").primaryKey(),
  referenceType: text("reference_type").notNull(),
  referenceId: integer("reference_id").notNull(),
  employeeName: text("employee_name").notNull(),
  hours: numeric("hours", { precision: 8, scale: 2 }),
  hourlyRate: numeric("hourly_rate", { precision: 10, scale: 2 }),
  flatCost: numeric("flat_cost", { precision: 10, scale: 2 }),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type Ingredient = typeof ingredientsTable.$inferSelect;
export type IngredientCostHistory = typeof ingredientCostHistoryTable.$inferSelect;
export type Recipe = typeof recipesTable.$inferSelect;
export type RecipeLine = typeof recipeLinesTable.$inferSelect;
export type EventLabor = typeof eventLaborTable.$inferSelect;
