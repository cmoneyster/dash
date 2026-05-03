import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const printerStatusValues = ["online", "offline", "error", "disabled"] as const;
export type PrinterStatus = (typeof printerStatusValues)[number];

export const printersTable = pgTable("printers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  model: text("model").notNull().default("TSP143IV"),
  cloudprntToken: text("cloudprnt_token").notNull().unique(),
  lanIp: text("lan_ip"),
  location: text("location"),
  printsKitchenTicket: boolean("prints_kitchen_ticket").notNull().default(false),
  printsCustomerReceipt: boolean("prints_customer_receipt").notNull().default(false),
  printsItemLabels: boolean("prints_item_labels").notNull().default(false),
  autoPrintOnNewOrder: boolean("auto_print_on_new_order").notNull().default(true),
  allowLanFallback: boolean("allow_lan_fallback").notNull().default(true),
  suppressItemLabelsForPlateLines: boolean("suppress_item_labels_for_plate_lines").notNull().default(true),
  enabled: boolean("enabled").notNull().default(true),
  status: text("status").notNull().default("offline"),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertPrinterSchema = createInsertSchema(printersTable).omit({
  id: true,
  cloudprntToken: true,
  status: true,
  lastPolledAt: true,
  lastError: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertPrinter = z.infer<typeof insertPrinterSchema>;
export type Printer = typeof printersTable.$inferSelect;
