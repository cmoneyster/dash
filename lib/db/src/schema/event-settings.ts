import { pgTable, integer, text, timestamp, boolean, numeric } from "drizzle-orm/pg-core";

export const eventSettingsTable = pgTable("event_settings", {
  id: integer("id").primaryKey(),
  eventName: text("event_name").notNull().default(""),
  eventPassword: text("event_password").notNull().default(""),
  kitchenPassword: text("kitchen_password"),
  twilioFromNumber: text("twilio_from_number"),
  activeEventSessionId: integer("active_event_session_id"),
  // Staff Order Taker (POS-style) settings
  eventTakerPassword: text("event_taker_password"),
  eventTakerTaxEnabled: boolean("event_taker_tax_enabled").notNull().default(false),
  eventTakerTaxRate: numeric("event_taker_tax_rate", { precision: 6, scale: 3 }),
  // Venmo display info shown on the POS payment screen
  venmoHandle: text("venmo_handle"),
  venmoQrImageUrl: text("venmo_qr_image_url"),
  // Kitchen-controlled ordering toggles. State is one of: 'accepting' | 'paused' | 'closed'.
  // When state='paused', pausedUntil holds the auto-resume timestamp.
  guestOrderingState: text("guest_ordering_state").notNull().default("accepting"),
  guestOrderingPausedUntil: timestamp("guest_ordering_paused_until"),
  guestOrderingPausedMessage: text("guest_ordering_paused_message"),
  takerOrderingState: text("taker_ordering_state").notNull().default("accepting"),
  takerOrderingPausedUntil: timestamp("taker_ordering_paused_until"),
  takerOrderingPausedMessage: text("taker_ordering_paused_message"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type EventSettings = typeof eventSettingsTable.$inferSelect;
