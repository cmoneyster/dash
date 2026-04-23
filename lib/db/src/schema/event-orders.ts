import { pgTable, serial, text, jsonb, timestamp, integer, numeric } from "drizzle-orm/pg-core";

export type EventOrderItem = {
  itemId: number;
  name: string;
  quantity: number;
  price: number;
};

export const eventOrdersTable = pgTable("event_orders", {
  id: serial("id").primaryKey(),
  guestName: text("guest_name").notNull(),
  tableNumber: text("table_number"),
  phoneNumber: text("phone_number"),
  items: jsonb("items").notNull().$type<EventOrderItem[]>(),
  status: text("status").notNull().default("pending"),
  eventSessionId: integer("event_session_id"),
  // 'guest' = self-service /event page; 'staff' = /event-taker POS
  orderSource: text("order_source").notNull().default("guest"),
  // Snapshotted totals (staff orders only — guest orders leave these null)
  subtotal: numeric("subtotal", { precision: 10, scale: 2 }),
  taxRate: numeric("tax_rate", { precision: 6, scale: 3 }),
  taxAmount: numeric("tax_amount", { precision: 10, scale: 2 }),
  total: numeric("total", { precision: 10, scale: 2 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type EventOrder = typeof eventOrdersTable.$inferSelect;
