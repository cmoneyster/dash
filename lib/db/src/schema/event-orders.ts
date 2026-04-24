import { pgTable, serial, text, jsonb, timestamp, integer, numeric } from "drizzle-orm/pg-core";

export type EventOrderItem = {
  itemId: number;
  name: string;
  quantity: number;
  price: number;
};

// Optional staff-set plating layout. Each plate carries whole-number
// quantities of items pulled from the parent `items` cart. Sum per itemId
// across plates must be <= cart line quantity. Unassigned units (cart - sum)
// are rendered as a separate "Unassigned" group on the kitchen ticket.
export type EventOrderPlate = {
  label: string;
  items: { itemId: number; quantity: number }[];
};

export const eventOrdersTable = pgTable("event_orders", {
  id: serial("id").primaryKey(),
  guestName: text("guest_name").notNull(),
  tableNumber: text("table_number"),
  phoneNumber: text("phone_number"),
  items: jsonb("items").notNull().$type<EventOrderItem[]>(),
  // Null when staff did not configure plating (kitchen renders the standard
  // single-list ticket). Locked once the order leaves the unpaid queue.
  plateGroups: jsonb("plate_groups").$type<EventOrderPlate[]>(),
  status: text("status").notNull().default("pending"),
  eventSessionId: integer("event_session_id"),
  // 'guest' = self-service /event page; 'staff' = /event-taker POS
  orderSource: text("order_source").notNull().default("guest"),
  // Snapshotted totals (staff orders only — guest orders leave these null)
  subtotal: numeric("subtotal", { precision: 10, scale: 2 }),
  taxRate: numeric("tax_rate", { precision: 6, scale: 3 }),
  taxAmount: numeric("tax_amount", { precision: 10, scale: 2 }),
  total: numeric("total", { precision: 10, scale: 2 }),
  // Payment gating for staff (POS) orders. Guest orders default to 'paid'.
  // 'unpaid'   = staff order awaiting payment, hidden from kitchen
  // 'paid'     = payment recorded (cash/card/venmo)
  // 'override' = staff sent unpaid order to kitchen anyway
  paymentStatus: text("payment_status").notNull().default("paid"),
  // 'cash' | 'card' | 'venmo' | null
  paymentMethod: text("payment_method"),
  cashReceived: numeric("cash_received", { precision: 10, scale: 2 }),
  changeDue: numeric("change_due", { precision: 10, scale: 2 }),
  paymentRecordedAt: timestamp("payment_recorded_at"),
  paymentOverrideReason: text("payment_override_reason"),
  // Service-time milestones — set once when status first reaches that step.
  // Used by Sales Reports to compute time-to-pickup metrics.
  readyAt: timestamp("ready_at"),
  pickedUpAt: timestamp("picked_up_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type EventOrder = typeof eventOrdersTable.$inferSelect;
