import { pgTable, serial, text, numeric, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const menuItemsTable = pgTable("menu_items", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  category: text("category").notNull(),
  price: numeric("price", { precision: 10, scale: 2 }).notNull(),
  servingSize: integer("serving_size").notNull().default(1),
  unit: text("unit").notNull().default("tray"),
  imageUrl: text("image_url"),
  allergens: text("allergens").array().notNull().default([]),
  available: boolean("available").notNull().default(true),
  prepTime: text("prep_time"),
  minimumOrderQty: integer("minimum_order_qty").notNull().default(1),
  tier2Qty: integer("tier2_qty"),
  tier2Price: numeric("tier2_price", { precision: 10, scale: 2 }),
  tier3Qty: integer("tier3_qty"),
  tier3Price: numeric("tier3_price", { precision: 10, scale: 2 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertMenuItemSchema = createInsertSchema(menuItemsTable).omit({ id: true, createdAt: true });
export type InsertMenuItem = z.infer<typeof insertMenuItemSchema>;
export type MenuItem = typeof menuItemsTable.$inferSelect;
