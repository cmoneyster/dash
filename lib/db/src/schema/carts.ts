import { pgTable, serial, text, integer, timestamp, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { menuItemsTable } from "./menu-items";

export const cartItemsTable = pgTable("cart_items", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  menuItemId: integer("menu_item_id").notNull().references(() => menuItemsTable.id, { onDelete: "cascade" }),
  quantity: integer("quantity").notNull().default(1),
  sizeSlot: integer("size_slot"),
  sizeLabel: text("size_label"),
  sizePrice: numeric("size_price", { precision: 10, scale: 2 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertCartItemSchema = createInsertSchema(cartItemsTable).omit({ id: true, createdAt: true });
export type InsertCartItem = z.infer<typeof insertCartItemSchema>;
export type CartItem = typeof cartItemsTable.$inferSelect;
