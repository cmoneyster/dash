import { pgTable, serial, text, date, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const blackoutDatesTable = pgTable("blackout_dates", {
  id: serial("id").primaryKey(),
  date: date("date").notNull().unique(),
  reason: text("reason"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertBlackoutDateSchema = createInsertSchema(blackoutDatesTable).omit({ id: true, createdAt: true });
export type InsertBlackoutDate = z.infer<typeof insertBlackoutDateSchema>;
export type BlackoutDate = typeof blackoutDatesTable.$inferSelect;

export const blackoutTimeWindowsTable = pgTable("blackout_time_windows", {
  id: serial("id").primaryKey(),
  date: date("date").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertBlackoutTimeWindowSchema = createInsertSchema(blackoutTimeWindowsTable).omit({ id: true, createdAt: true });
export type InsertBlackoutTimeWindow = z.infer<typeof insertBlackoutTimeWindowSchema>;
export type BlackoutTimeWindow = typeof blackoutTimeWindowsTable.$inferSelect;
