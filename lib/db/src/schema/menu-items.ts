import { pgTable, serial, text, numeric, integer, boolean, timestamp, jsonb, type AnyPgColumn } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type ComboSlotOption = {
  menuItemId: number;
  name: string;
};

export type ComboSlot = {
  slotId: string;
  slotName: string;
  minQty: number;
  maxQty: number;
  options: ComboSlotOption[];
};

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
  // ── Item-label printing policy ────────────────────────────────────────────
  // Controls how many physical labels print for an ordered quantity:
  //   "per_unit"  → 1 label per unit (default; entrees, plates)
  //   "combined"  → 1 label total no matter the qty (small bites in 1 box)
  //   "per_box"   → 1 label per box of N (label_box_size); leftover gets its
  //                 own label (e.g. box of 6, qty 14 → 6,6,2)
  // See artifacts/api-server/src/lib/labelExpand.ts for the expansion.
  // When labelPrintingEnabled is false, no labels are enqueued regardless of
  // policy or box size — applies to both auto fan-out and manual reprints.
  labelPrintingEnabled: boolean("label_printing_enabled").notNull().default(true),
  labelPolicy: text("label_policy").notNull().default("per_unit"),
  labelBoxSize: integer("label_box_size"),
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
  // Manual display order within the item's category. New items are
  // inserted at the end of their category (MAX(sortOrder)+10). Used by
  // both the admin Menu Manager and the public /menu listing.
  sortOrder: integer("sort_order").notNull().default(0),
  // ── Combo item configuration ─────────────────────────────────────────────
  // When is_combo is true, this item acts as a combo — staff must select
  // components from each defined slot before adding the item to the order.
  // combo_slots is an ordered array of ComboSlot objects, each with a name,
  // min/max quantity rule, and a list of eligible menu-item options.
  // combo_component_labels controls whether individual labels are also
  // printed for each selected component (the combo itself always gets one
  // label driven by the combo item's own labelPolicy/labelBoxSize).
  isCombo: boolean("is_combo").notNull().default(false),
  comboSlots: jsonb("combo_slots").$type<ComboSlot[]>(),
  comboComponentLabels: boolean("combo_component_labels").notNull().default(false),
  // ── Recipe source link ────────────────────────────────────────────────────
  // When set, this item has no recipe of its own — it inherits the recipe
  // from the referenced item (one level only, no chaining). Useful for
  // event-specific variants (different name/price/stock) that share the
  // exact same ingredients as a catering menu item.
  // If an item later gets its own recipe rows, sourceItemId should be cleared
  // so the own recipe takes precedence unambiguously.
  sourceItemId: integer("source_item_id").references((): AnyPgColumn => menuItemsTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertMenuItemSchema = createInsertSchema(menuItemsTable).omit({ id: true, createdAt: true });
export type InsertMenuItem = z.infer<typeof insertMenuItemSchema>;
export type MenuItem = typeof menuItemsTable.$inferSelect;
