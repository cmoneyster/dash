import { pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// Numbers that the system refuses to send to and (for `admin-blocked`)
// refuses to surface in the Unmatched inbox.
//
//   - `customer-opt-out` — set when a customer texts STOP/UNSUBSCRIBE/etc.
//                          to the dedicated chat port. Affects all
//                          outbound app-wide. The customer's chat thread
//                          shows an "Opted out" badge and disables the
//                          composer.
//   - `admin-blocked`    — set when an admin clicks "Block sender" from
//                          the Unmatched inbox. Suppresses future
//                          inbounds from appearing in Unmatched and
//                          blocks any outbound to that number.
//
// Stored separately so a future blocklist UI can present them with
// different language and recovery flows.
export const phoneBlocklistTable = pgTable(
  "phone_blocklist",
  {
    id: serial("id").primaryKey(),
    // Normalized phone number (digits-only, no leading 1) — same shape
    // sms_messages.customerPhone uses so joins are direct.
    phone: text("phone").notNull(),
    // 'customer-opt-out' | 'admin-blocked'
    reason: text("reason").notNull(),
    // Optional free-form note (e.g. "spam wave 2026-01-12").
    note: text("note"),
    blockedAt: timestamp("blocked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Unique on phone — a number is either blocklisted or not. If a new
    // reason needs to override the existing one, the inserter does an
    // upsert.
    phoneUq: uniqueIndex("phone_blocklist_phone_uq").on(t.phone),
  }),
);

export type PhoneBlocklistEntry = typeof phoneBlocklistTable.$inferSelect;
