import { pgTable, serial, integer, timestamp } from "drizzle-orm/pg-core";

// Admin-curated subset of the real menu shown on the public demo guest
// ordering page. Stores menu_items.id references so demo cards always
// reflect the current name/price/photo/description without copying.
// Items removed from the demo here disappear from /demo immediately.
export const demoMenuItemsTable = pgTable("demo_menu_items", {
  id: serial("id").primaryKey(),
  menuItemId: integer("menu_item_id").notNull().unique(),
  // Admin-controlled display order; ties break on category/name.
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type DemoMenuItem = typeof demoMenuItemsTable.$inferSelect;
