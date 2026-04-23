import { pgTable, serial, text, integer, timestamp, jsonb, numeric, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export type CateringOrderItem = {
  name: string;
  quantity: number;
  price: number;
};

export type QuoteLineItem = {
  id: string;
  menuItemId: number | null;
  name: string;
  quantity: number;
  unitPrice: number;
  notes?: string | null;
};

export type QuoteAdjustment = {
  id: string;
  label: string;
  kind: "fixed" | "percent";
  amount: number;
};

export const cateringInquiriesTable = pgTable("catering_inquiries", {
  id: serial("id").primaryKey(),
  clientName: text("client_name").notNull(),
  clientEmail: text("client_email"),
  clientPhone: text("client_phone"),
  organization: text("organization"),
  eventDate: text("event_date"),
  guestCount: integer("guest_count"),
  venueAddress: text("venue_address"),
  menuNotes: text("menu_notes"),
  adminNotes: text("admin_notes"),
  status: text("status").notNull().default("inquiry"),
  source: text("source").notNull().default("form"),
  // Legacy cart-order snapshot (kept for backwards compatibility)
  orderItems: jsonb("order_items").$type<CateringOrderItem[]>(),
  orderTotal: text("order_total"),
  // Editable quote
  lineItems: jsonb("line_items").$type<QuoteLineItem[]>(),
  fees: jsonb("fees").$type<QuoteAdjustment[]>(),
  discounts: jsonb("discounts").$type<QuoteAdjustment[]>(),
  subtotal: numeric("subtotal", { precision: 12, scale: 2 }),
  feesTotal: numeric("fees_total", { precision: 12, scale: 2 }),
  discountsTotal: numeric("discounts_total", { precision: 12, scale: 2 }),
  total: numeric("total", { precision: 12, scale: 2 }),
  // Quote metadata
  quoteNumber: text("quote_number"),
  quoteToken: varchar("quote_token").default(sql`gen_random_uuid()`),
  quoteIssuedAt: timestamp("quote_issued_at"),
  quoteExpiresAt: timestamp("quote_expires_at"),
  quoteLastEmailedAt: timestamp("quote_last_emailed_at"),
  quoteLastTextedAt: timestamp("quote_last_texted_at"),
  quoteNotes: text("quote_notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type CateringInquiry = typeof cateringInquiriesTable.$inferSelect;
