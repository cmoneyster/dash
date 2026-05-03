import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";

export const contactRequestsTable = pgTable("contact_requests", {
  id: serial("id").primaryKey(),
  name: text("name"),
  channel: text("channel").notNull(),
  contactValue: text("contact_value").notNull(),
  summary: text("summary"),
  chatSessionId: text("chat_session_id"),
  inquiryId: integer("inquiry_id"),
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  handledAt: timestamp("handled_at"),
});

export type ContactRequest = typeof contactRequestsTable.$inferSelect;
