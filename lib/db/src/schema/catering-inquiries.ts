import { pgTable, serial, text, integer, timestamp, jsonb, numeric, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export type CateringOrderItem = {
  name: string;
  quantity: number;
  price: number;
  // Optional sizing/unit snapshot captured from the cart at submission
  // time so the admin's read-only Cart Order Items table can show what
  // the guest actually picked (e.g. "Medium Pan · 30 servings", "tray
  // of 12"). All optional + nullable so legacy rows (pre-snapshot)
  // continue to validate and render with just the bare name.
  pricingTemplate?: "per_unit" | "pan_sizes" | null;
  sizeSlot?: number | null;
  sizeLabel?: string | null;
  sizeServings?: number | null;
  unit?: string | null;
  servingSize?: number | null;
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

export type QuoteReply = {
  id: string;
  channel: "email" | "sms";
  message: string;
  sentAt: string;
  sentTo: string;
};

export const cateringInquiriesTable = pgTable("catering_inquiries", {
  id: serial("id").primaryKey(),
  clientName: text("client_name").notNull(),
  clientEmail: text("client_email"),
  clientPhone: text("client_phone"),
  organization: text("organization"),
  eventDate: text("event_date"),
  eventTime: text("event_time"),
  guestCount: integer("guest_count"),
  venueAddress: text("venue_address"),
  menuNotes: text("menu_notes"),
  adminNotes: text("admin_notes"),
  status: text("status").notNull().default("inquiry"),
  source: text("source").notNull().default("form"),
  // Service mode the customer chose at checkout. 'drop_off' (default) is
  // standard catering drop-off; 'on_the_dash' is the food trailer cooking
  // on-site. The OTD fee config columns below are snapshots of the live
  // event_settings values at the time of submission so the historical
  // quote stays stable even after admins update the price list.
  serviceMode: text("service_mode").notNull().default("drop_off"),
  otdSetupFee: numeric("otd_setup_fee", { precision: 10, scale: 2 }),
  otdFeeWaiverThreshold: numeric("otd_fee_waiver_threshold", { precision: 10, scale: 2 }),
  otdIncludedHours: numeric("otd_included_hours", { precision: 5, scale: 2 }),
  otdAdditionalHourRate: numeric("otd_additional_hour_rate", { precision: 10, scale: 2 }),
  otdMaxAdditionalHours: integer("otd_max_additional_hours"),
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
  // Client responses captured from the public quote page (`/quote/:token`)
  quoteAcceptedAt: timestamp("quote_accepted_at"),
  quoteChangeRequestAt: timestamp("quote_change_request_at"),
  quoteChangeRequestMessage: text("quote_change_request_message"),
  quoteChangeRequestRespondedAt: timestamp("quote_change_request_responded_at"),
  quoteReplies: jsonb("quote_replies").$type<QuoteReply[]>(),
  // Square invoice mirror (Square is the system of record; we cache for display + lookup)
  squareInvoiceId: text("square_invoice_id"),
  squareInvoiceVersion: integer("square_invoice_version"),
  squareOrderId: text("square_order_id"),
  // Square customer id captured at primary publish. Supplemental
  // invoices MUST bind to this exact customer (not a re-resolution by
  // current email) so an admin editing `clientEmail` after the primary
  // is sent cannot accidentally route the supplemental to a different
  // Square customer than the one being billed for the primary.
  squareCustomerId: text("square_customer_id"),
  squareInvoiceStatus: text("square_invoice_status"), // DRAFT | UNPAID | SCHEDULED | PARTIALLY_PAID | PAID | CANCELED | FAILED | REFUNDED
  squareHostedUrl: text("square_hosted_url"),
  squareAmountPaid: numeric("square_amount_paid", { precision: 12, scale: 2 }),
  squareBalanceDue: numeric("square_balance_due", { precision: 12, scale: 2 }),
  squareDepositKind: text("square_deposit_kind"),    // 'percent' | 'fixed' | null
  squareDepositValue: numeric("square_deposit_value", { precision: 12, scale: 2 }),
  squareDueAt: timestamp("square_due_at"),
  squareDepositPaidAt: timestamp("square_deposit_paid_at"),
  squarePaidInFullAt: timestamp("square_paid_in_full_at"),
  // Frozen copy of the quote arrays at the moment the **primary** invoice
  // was published. Used as the baseline for the "uninvoiced delta"
  // computation in the supplemental-invoice flow (task #137). Re-issuing
  // the primary after a cancel re-snapshots; clearing the primary on
  // cancel also clears these. Inquiries whose primary was published
  // before this column existed have NULL here and the supplemental flow
  // stays disabled until/unless the primary is re-issued.
  primarySnapshotLineItems: jsonb("primary_snapshot_line_items").$type<QuoteLineItem[]>(),
  primarySnapshotFees: jsonb("primary_snapshot_fees").$type<QuoteAdjustment[]>(),
  primarySnapshotDiscounts: jsonb("primary_snapshot_discounts").$type<QuoteAdjustment[]>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type CateringInquiry = typeof cateringInquiriesTable.$inferSelect;
