import { pgTable, serial, text, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const printerStatusValues = ["online", "offline", "error", "disabled"] as const;
export type PrinterStatus = (typeof printerStatusValues)[number];

export const printerModeValues = ["lan_browser"] as const;
export type PrinterMode = (typeof printerModeValues)[number];

export type SectionKey =
  | "header"
  | "orderNumber"
  | "guestName"
  | "tableNumber"
  | "timestamp"
  | "source"
  | "items"
  | "totals"
  | "notes"
  | "footer";

export type SectionAlign = "left" | "center" | "right";

export type SectionStyle = {
  visible?: boolean;
  bold?: boolean;
  align?: SectionAlign;
  size?: number;
  dividerBefore?: boolean;
  dividerAfter?: boolean;
};

export type TicketLayout = {
  sectionOrder?: SectionKey[];
  sections?: Partial<Record<SectionKey, SectionStyle>>;
};

export type PrintTemplate = {
  businessName?: string | null;
  footer?: string | null;
  dividerChar?: string | null;
  headerText?: string | null;
  logoUrl?: string | null;
  logoPosition?: "before_name" | "after_name" | null;
  reverseOrder?: boolean | null;
  kitchen_ticket?: TicketLayout;
  customer_receipt?: TicketLayout;
  item_label?: TicketLayout;
  plate_label?: TicketLayout;
};

export const printersTable = pgTable("printers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  model: text("model").notNull().default("TSP143IV"),
  lanIp: text("lan_ip"),
  printMode: text("print_mode").notNull().default("lan_browser"),
  location: text("location"),
  printsKitchenTicket: boolean("prints_kitchen_ticket").notNull().default(false),
  printsCustomerReceipt: boolean("prints_customer_receipt").notNull().default(false),
  printsItemLabels: boolean("prints_item_labels").notNull().default(false),
  autoPrintOnNewOrder: boolean("auto_print_on_new_order").notNull().default(true),
  suppressItemLabelsForPlateLines: boolean("suppress_item_labels_for_plate_lines").notNull().default(true),
  opensCashDrawer: boolean("opens_cash_drawer").notNull().default(false),
  enabled: boolean("enabled").notNull().default(true),
  status: text("status").notNull().default("offline"),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  lastError: text("last_error"),
  printTemplate: jsonb("print_template").$type<PrintTemplate>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertPrinterSchema = createInsertSchema(printersTable).omit({
  id: true,
  status: true,
  lastPolledAt: true,
  lastError: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertPrinter = z.infer<typeof insertPrinterSchema>;
export type Printer = typeof printersTable.$inferSelect;
