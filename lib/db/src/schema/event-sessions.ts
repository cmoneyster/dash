import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const eventSessionsTable = pgTable("event_sessions", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  date: text("date"),
  status: text("status").notNull().default("active"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  archivedAt: timestamp("archived_at"),
});

export type EventSession = typeof eventSessionsTable.$inferSelect;
