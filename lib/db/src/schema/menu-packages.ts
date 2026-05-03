import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { menuItemsTable } from "./menu-items";

export const menuPackagesTable = pgTable("menu_packages", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  imageUrl: text("image_url"),
  servesGuests: integer("serves_guests").notNull().default(20),
  hidden: boolean("hidden").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type MenuPackage = typeof menuPackagesTable.$inferSelect;

export const menuPackageItemsTable = pgTable("menu_package_items", {
  id: serial("id").primaryKey(),
  packageId: integer("package_id")
    .notNull()
    .references(() => menuPackagesTable.id, { onDelete: "cascade" }),
  menuItemId: integer("menu_item_id")
    .notNull()
    .references(() => menuItemsTable.id, { onDelete: "cascade" }),
  quantity: integer("quantity").notNull().default(1),
  sizeKey: integer("size_key"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type MenuPackageItem = typeof menuPackageItemsTable.$inferSelect;
