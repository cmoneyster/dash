import { pgTable, serial, text, integer, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";

// Persistent log of every SMS that flows through the dedicated customer
// chat port — both inbound (from the SIM) and outbound (admin-typed
// replies, owner-relayed replies, system-sent quotes/invoices that route
// through the chat port). Staff-facing sends (owner alerts, low-stock
// alerts, admin test sends) intentionally bypass this log because they
// do not flow through the chat port.
//
// Named `sms_messages` to avoid colliding with the existing `messages`
// table that powers the AI chat / conversations feature.
export const smsMessagesTable = pgTable(
  "sms_messages",
  {
    id: serial("id").primaryKey(),
    // 'inbound' | 'outbound'
    direction: text("direction").notNull(),
    // Normalized phone number (digits-only, no leading 1). For outbound
    // this is the customer; for inbound this is the sender.
    customerPhone: text("customer_phone").notNull(),
    body: text("body").notNull(),
    // ISO timestamp of the message itself. For outbound this is the
    // moment we dispatched; for inbound this is gateway-reported send
    // time when available, otherwise our ingest time.
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    // Always the dedicated customer chat port — recorded so historical
    // rows survive a future port reassignment.
    port: integer("port"),
    // Inquiry the message belongs to. NULL means it landed in the
    // Unmatched inbox at ingest time.
    inquiryId: integer("inquiry_id"),
    // Has the admin viewed this message in the chat UI? Only meaningful
    // for inbound messages — outbound rows are seen at send time.
    seenByAdmin: boolean("seen_by_admin").notNull().default(false),
    // Gateway-supplied unique id when available (for dedupe across
    // poller runs and webhook deliveries). For outbound we synthesize
    // a UUID so the column is always populated.
    gatewayMessageId: text("gateway_message_id").notNull(),
    // 'admin' | 'owner_relay' | 'system' — distinguishes admin-typed
    // outbound from owner-relayed-via-tag and from system sends
    // (quote text, invoice text). Inbound rows use 'inbound'.
    source: text("source").notNull(),
    // Optional gateway response summary for outbound (mirrors
    // sendSmsViaEjoin's gatewayResponse field).
    gatewayResponse: text("gateway_response"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Dedupe guard for inbound webhook+poller race. Outbound rows use a
    // synthesized UUID so they never collide.
    gatewayIdUq: uniqueIndex("sms_messages_gateway_id_uq").on(t.gatewayMessageId),
    // Hot lookups: messages for one inquiry in chronological order.
    byInquiryIdx: index("sms_messages_by_inquiry_idx").on(t.inquiryId, t.occurredAt),
    // Plain occurredAt index used for the Unmatched inbox listing
    // (filtered at query time on inquiry_id IS NULL).
    byOccurredIdx: index("sms_messages_by_occurred_idx").on(t.occurredAt),
    byPhoneIdx: index("sms_messages_by_phone_idx").on(t.customerPhone, t.occurredAt),
  }),
);

export type SmsMessage = typeof smsMessagesTable.$inferSelect;
export type SmsMessageInsert = typeof smsMessagesTable.$inferInsert;
