import { pgTable, serial, text, jsonb, timestamp, integer } from "drizzle-orm/pg-core";

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
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type EventOrder = typeof eventOrdersTable.$inferSelect;
