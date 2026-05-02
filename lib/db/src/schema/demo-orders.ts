import { pgTable, serial, text, jsonb, timestamp, boolean } from "drizzle-orm/pg-core";

export type DemoOrderItem = {
  itemId: number;
  name: string;
  quantity: number;
  price: number;
};

// Submissions from the public demo guest ordering page. Kept entirely
// separate from event_orders so demo activity can never appear in the
// kitchen feed, sales reports, or any operational queue.
export const demoOrdersTable = pgTable("demo_orders", {
  id: serial("id").primaryKey(),
  guestName: text("guest_name").notNull(),
  phoneNumber: text("phone_number").notNull(),
  // Captured for the per-IP rate limit and abuse forensics. Best-effort —
  // proxy / private-network requests may yield "unknown".
  ipAddress: text("ip_address"),
  items: jsonb("items").notNull().$type<DemoOrderItem[]>(),
  smsSent: boolean("sms_sent").notNull().default(false),
  smsError: text("sms_error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type DemoOrder = typeof demoOrdersTable.$inferSelect;
