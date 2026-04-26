import { pgTable, serial, integer, text, timestamp, jsonb, numeric, uniqueIndex } from "drizzle-orm/pg-core";
import { cateringInquiriesTable, type QuoteAdjustment, type QuoteLineItem } from "./catering-inquiries";

// Snapshot of the exact rows that were billed on a specific supplemental
// invoice. We need this so the admin UI can show an audit trail ("Supp #2:
// 2 extra OTD hours +$300") even after the live quote has been edited
// further. Discounts are kept separate from line items / fees because the
// pricing engine treats them differently downstream.
export type SupplementalLinesSnapshot = {
  lineItems: QuoteLineItem[];
  fees: QuoteAdjustment[];
  discounts: QuoteAdjustment[];
};

// Child table: every row is one published Square supplemental invoice for
// a specific catering inquiry. The same Square mirror columns the primary
// uses live here so the UI can render status / hosted URL / paid balance
// per supplemental without an extra Square round-trip.
//
// Cancellation never deletes rows: we flip `squareInvoiceStatus` to
// "CANCELED" and keep the audit trail intact so the cancel-primary guard
// can still see historical supplementals.
export const cateringSupplementalInvoicesTable = pgTable("catering_supplemental_invoices", {
  id: serial("id").primaryKey(),
  cateringInquiryId: integer("catering_inquiry_id")
    .notNull()
    .references(() => cateringInquiriesTable.id, { onDelete: "cascade" }),
  // Monotonic per-inquiry sequence ("Supplemental #1", "#2", …). Set
  // server-side at insert time as `(max(seq for inquiry) ?? 0) + 1`.
  seq: integer("seq").notNull(),
  // squareInvoiceId is null for the brief "PENDING" window during
  // two-phase issuance: we INSERT the row inside the FOR UPDATE txn to
  // claim the (inquiryId, seq) slot, then call Square, then UPDATE the
  // row with the real Square ids. If Square fails we flip the row to
  // status="FAILED" instead of deleting, both for the audit trail and
  // so the next issuance picks the *next* seq cleanly.
  squareInvoiceId: text("square_invoice_id"),
  squareInvoiceVersion: integer("square_invoice_version"),
  squareOrderId: text("square_order_id"),
  // Lifecycle: PENDING (reservation) -> Square statuses (DRAFT/UNPAID/
  // SCHEDULED/PARTIALLY_PAID/PAID/CANCELED/REFUNDED) or FAILED if the
  // Square publish itself errored.
  squareInvoiceStatus: text("square_invoice_status"),
  squareHostedUrl: text("square_hosted_url"),
  squareAmountPaid: numeric("square_amount_paid", { precision: 12, scale: 2 }),
  squareBalanceDue: numeric("square_balance_due", { precision: 12, scale: 2 }),
  squareDueAt: timestamp("square_due_at"),
  squarePaidInFullAt: timestamp("square_paid_in_full_at"),
  // Frozen copy of the delta rows billed on THIS supplemental, so the UI
  // can render the per-supplemental breakdown without depending on the
  // live (and possibly further-edited) quote arrays.
  linesSnapshot: jsonb("lines_snapshot").$type<SupplementalLinesSnapshot>().notNull(),
  // Cached delta total in dollars at the time of issue (matches the sum
  // of `linesSnapshot`). Lets the list view sort/sum without re-running
  // the delta computation.
  amountTotal: numeric("amount_total", { precision: 12, scale: 2 }).notNull(),
  // Frozen copy of the inquiry's `primarySnapshot*` cols at the moment
  // BEFORE this supplemental rolled them forward to "current". Used to
  // restore the inquiry's snapshot when this supplemental is canceled,
  // so the same extras become re-billable. We only support rolling back
  // the *most recent* non-canceled supplemental's effect — earlier ones
  // would require unwinding intervening edits we no longer have.
  priorSnapshotLineItems: jsonb("prior_snapshot_line_items").$type<QuoteLineItem[]>(),
  priorSnapshotFees: jsonb("prior_snapshot_fees").$type<QuoteAdjustment[]>(),
  priorSnapshotDiscounts: jsonb("prior_snapshot_discounts").$type<QuoteAdjustment[]>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  // Prevents two concurrent supplement requests from claiming the same
  // seq number for one inquiry. The issuance handler still races on the
  // Square side; the unique constraint just guarantees we never persist
  // duplicate "#N" labels.
  inquirySeqUnique: uniqueIndex("catering_supp_inv_inquiry_seq_uniq").on(
    t.cateringInquiryId, t.seq,
  ),
}));

export type CateringSupplementalInvoice = typeof cateringSupplementalInvoicesTable.$inferSelect;
