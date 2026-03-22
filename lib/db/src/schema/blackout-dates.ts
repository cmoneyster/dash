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
