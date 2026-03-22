import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { menuItemsTable } from "./menu-items";

export const planItemsTable = pgTable("plan_items", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  menuItemId: integer("menu_item_id").notNull().references(() => menuItemsTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertPlanItemSchema = createInsertSchema(planItemsTable).omit({ id: true, createdAt: true });
export type InsertPlanItem = z.infer<typeof insertPlanItemSchema>;
export type PlanItem = typeof planItemsTable.$inferSelect;
