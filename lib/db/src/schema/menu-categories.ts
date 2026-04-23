import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const menuCategoriesTable = pgTable("menu_categories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  sortOrder: integer("sort_order").notNull().default(0),
  visible: boolean("visible").notNull().default(true),
  plannerGroup: text("planner_group").notNull().default("other"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type MenuCategory = typeof menuCategoriesTable.$inferSelect;
export type InsertMenuCategory = typeof menuCategoriesTable.$inferInsert;
