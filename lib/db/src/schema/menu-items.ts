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
  eventActive: boolean("event_active").notNull().default(false),
  eventStock: integer("event_stock"),
  // Staff-only Event Order Taker (POS-style) flags
  eventTakerVisible: boolean("event_taker_visible").notNull().default(false),
  eventTakerPrice: numeric("event_taker_price", { precision: 10, scale: 2 }),
  // ── Pricing template ────────────────────────────────────────────────────────
  // "per_unit"  → uses price / servingSize / unit  (Small Bites and default)
  // "pan_sizes" → uses size1-5 fields              (Entrées)
  pricingTemplate: text("pricing_template").notNull().default("per_unit"),
  // Size slots 1–5 (1–3 pre-filled, 4–5 reserved for future use)
  size1Label: text("size1_label").default("Small Pan"),
  size1Servings: integer("size1_servings").default(15),
  size1Price: numeric("size1_price", { precision: 10, scale: 2 }),
  size2Label: text("size2_label").default("Medium Pan"),
  size2Servings: integer("size2_servings").default(30),
  size2Price: numeric("size2_price", { precision: 10, scale: 2 }),
  size3Label: text("size3_label").default("Large Pan"),
  size3Servings: integer("size3_servings").default(45),
  size3Price: numeric("size3_price", { precision: 10, scale: 2 }),
  size4Label: text("size4_label"),
  size4Servings: integer("size4_servings"),
  size4Price: numeric("size4_price", { precision: 10, scale: 2 }),
  size5Label: text("size5_label"),
  size5Servings: integer("size5_servings"),
  size5Price: numeric("size5_price", { precision: 10, scale: 2 }),
  internalNotes: text("internal_notes"),
  // ── On the Dash Experience eligibility ────────────────────────────────────
  // True when the food trailer can prepare this item fresh on-site at the
  // event. False (default) means the item is drop-off-only — selecting "On
  // the Dash" service mode while it's in the cart triggers a warning and
  // server-side validation rejects checkout.
  otdEligible: boolean("otd_eligible").notNull().default(false),
  // Tracks whether a low-stock SMS alert has already been fired for the
  // current crossing of the kitchen alert threshold. Reset to false when
  // stock is restocked above the threshold (or set to unlimited / 0) so
  // a future dip will re-fire. See artifacts/api-server/src/lib/lowStockAlerts.ts.
  lowStockAlertSent: boolean("low_stock_alert_sent").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertMenuItemSchema = createInsertSchema(menuItemsTable).omit({ id: true, createdAt: true });
export type InsertMenuItem = z.infer<typeof insertMenuItemSchema>;
export type MenuItem = typeof menuItemsTable.$inferSelect;
