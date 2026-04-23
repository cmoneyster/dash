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
  // Optional sizing/pricing detail captured from the source menu item.
  // All optional + nullable so legacy line items continue to validate.
  pricingTemplate?: "per_unit" | "pan_sizes" | null;
  // Pan-size selection (1..5). Null means per_unit.
  sizeSlot?: number | null;
  sizeLabel?: string | null;     // e.g. "Medium Pan"
  sizeServings?: number | null;  // e.g. 30
  // Per-unit info — used to render "tray of 12" / "12 per tray".
  unit?: string | null;          // e.g. "tray"
  servingSize?: number | null;   // e.g. 12
  // True when the unit price was auto-applied from a tier break (tier2/tier3).
  // Set to false (or omit) once staff manually overrides the price.
  tierApplied?: boolean | null;
  // Explicit pricing mode. "auto" allows the Quote Builder to (re)apply
  // tier-break pricing on quantity changes; "manual" locks the unit price
  // to whatever staff typed. Re-picking a menu item or pan size resets to
  // "auto". Legacy rows (null/undefined) are treated as "auto".
  priceMode?: "auto" | "manual" | null;
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
  // Square invoice mirror (Square is the system of record; we cache for display + lookup)
  squareInvoiceId: text("square_invoice_id"),
  squareInvoiceVersion: integer("square_invoice_version"),
  squareOrderId: text("square_order_id"),
  squareInvoiceStatus: text("square_invoice_status"), // DRAFT | UNPAID | SCHEDULED | PARTIALLY_PAID | PAID | CANCELED | FAILED | REFUNDED
  squareHostedUrl: text("square_hosted_url"),
  squareAmountPaid: numeric("square_amount_paid", { precision: 12, scale: 2 }),
  squareBalanceDue: numeric("square_balance_due", { precision: 12, scale: 2 }),
  squareDepositKind: text("square_deposit_kind"),    // 'percent' | 'fixed' | null
  squareDepositValue: numeric("square_deposit_value", { precision: 12, scale: 2 }),
  squareDueAt: timestamp("square_due_at"),
  squareDepositPaidAt: timestamp("square_deposit_paid_at"),
  squarePaidInFullAt: timestamp("square_paid_in_full_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type CateringInquiry = typeof cateringInquiriesTable.$inferSelect;
