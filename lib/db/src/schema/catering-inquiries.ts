import { pgTable, serial, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";

export type CateringOrderItem = {
  name: string;
  quantity: number;
  price: number;
};

export const cateringInquiriesTable = pgTable("catering_inquiries", {
  id: serial("id").primaryKey(),
  clientName: text("client_name").notNull(),
  clientEmail: text("client_email"),
  clientPhone: text("client_phone"),
  organization: text("organization"),
  eventDate: text("event_date"),
  guestCount: integer("guest_count"),
  venueAddress: text("venue_address"),
  menuNotes: text("menu_notes"),
  adminNotes: text("admin_notes"),
  status: text("status").notNull().default("inquiry"),
  source: text("source").notNull().default("form"),
  orderItems: jsonb("order_items").$type<CateringOrderItem[]>(),
  orderTotal: text("order_total"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type CateringInquiry = typeof cateringInquiriesTable.$inferSelect;
