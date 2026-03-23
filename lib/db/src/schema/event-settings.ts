import { pgTable, integer, text, timestamp } from "drizzle-orm/pg-core";

export const eventSettingsTable = pgTable("event_settings", {
  id: integer("id").primaryKey(),
  eventName: text("event_name").notNull().default(""),
  eventPassword: text("event_password").notNull().default(""),
  kitchenPassword: text("kitchen_password"),
  twilioFromNumber: text("twilio_from_number"),
  activeEventSessionId: integer("active_event_session_id"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type EventSettings = typeof eventSettingsTable.$inferSelect;
