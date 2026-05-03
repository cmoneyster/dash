import { pgTable, integer, text, timestamp } from "drizzle-orm/pg-core";
import { menuItemsTable } from "./menu-items";

// Curated list of menu items the chat bot prefers when guests ask
// open-ended things like "what do you recommend?" or "what's popular?".
// Admin-managed via /admin/ai-recommendations: entries can be added by
// hand (source='manual') or seeded from real order history via the
// "Sync from order data" button (source='sync'). Order is admin-set
// through sortOrder; the bot returns items in ascending sortOrder.
export const recommendedMenuItemsTable = pgTable("recommended_menu_items", {
  menuItemId: integer("menu_item_id")
    .primaryKey()
    .references(() => menuItemsTable.id, { onDelete: "cascade" }),
  sortOrder: integer("sort_order").notNull().default(0),
  source: text("source").notNull().default("manual"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type RecommendedMenuItem = typeof recommendedMenuItemsTable.$inferSelect;
