import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";

// Audit ledger for every inbound message that was forwarded to the
// owner's phone. Used to enforce the "max forwards per inquiry per
// rolling 24h" cap configured in event_settings, and to provide a
// debug trail for the strict-tag owner-reply routing.
export const ownerForwardsTable = pgTable(
  "owner_forwards",
  {
    id: serial("id").primaryKey(),
    // The inquiry whose inbound triggered the forward. NULL is allowed
    // (forwards of unmatched inbounds aren't capped, but we still log
    // them for audit). Cap counting only counts non-null inquiry rows.
    inquiryId: integer("inquiry_id"),
    // The owner phone the forward was sent to (digits-only, no
    // leading 1) — captured at send time so changing the owner phone
    // later doesn't break the audit trail.
    ownerPhone: text("owner_phone").notNull(),
    forwardedAt: timestamp("forwarded_at", { withTimezone: true }).notNull().defaultNow(),
    // Originating inbound's gateway message id (so we can correlate
    // forwards back to the inbound that triggered them).
    sourceGatewayMessageId: text("source_gateway_message_id"),
  },
  (t) => ({
    byInquiryIdx: index("owner_forwards_by_inquiry_idx").on(t.inquiryId, t.forwardedAt),
  }),
);

export type OwnerForward = typeof ownerForwardsTable.$inferSelect;
