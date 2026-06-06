import { pgTable, serial, text, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { printersTable } from "./printers";

export const printJobTypeValues = [
  "kitchen_ticket",
  "customer_receipt",
  "item_label",
  "plate_label",
  "cash_drawer",
  "test",
] as const;
export type PrintJobType = (typeof printJobTypeValues)[number];

export const printJobStatusValues = [
  "queued",
  "delivered",
  "printed",
  "failed",
  "canceled",
] as const;
export type PrintJobStatus = (typeof printJobStatusValues)[number];

export const printJobDeliveryValues = ["lan_browser"] as const;
export type PrintJobDelivery = (typeof printJobDeliveryValues)[number];

export type PrintJobPayload = {
  [key: string]: unknown;
};

export const printJobsTable = pgTable("print_jobs", {
  id: serial("id").primaryKey(),
  printerId: integer("printer_id").notNull().references(() => printersTable.id, { onDelete: "cascade" }),
  jobType: text("job_type").notNull(),
  orderSource: text("order_source"),
  orderId: integer("order_id"),
  payload: jsonb("payload").$type<PrintJobPayload>().notNull(),
  contentType: text("content_type").notNull().default("application/vnd.star.starprnt"),
  status: text("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  deliveredVia: text("delivered_via"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  printedAt: timestamp("printed_at", { withTimezone: true }),
});

export const insertPrintJobSchema = createInsertSchema(printJobsTable).omit({
  id: true,
  status: true,
  attempts: true,
  deliveredVia: true,
  error: true,
  createdAt: true,
  deliveredAt: true,
  printedAt: true,
});
export type InsertPrintJob = z.infer<typeof insertPrintJobSchema>;
export type PrintJob = typeof printJobsTable.$inferSelect;
