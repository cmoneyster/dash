import { sql } from "drizzle-orm";
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
  // Server-side low-stock SMS alerts. When an item with limited event_stock
  // crosses the threshold (greater-than → less-than-or-equal), an SMS is sent
  // to every recipient in lowStockAlertPhones so the kitchen lead, owner,
  // runner, etc. are all notified even if the Kitchen Display tablet is
  // asleep / locked. Threshold defaults to 5 if null. Empty array = alerts
  // disabled.
  lowStockAlertPhones: text("low_stock_alert_phones").array().notNull().default(sql`ARRAY[]::text[]`),
  lowStockAlertThreshold: integer("low_stock_alert_threshold"),
  // ── On the Dash Experience pricing config ──────────────────────────────────
  // Controls the on-site food trailer service mode. Defaults match the
  // launch pricing: $500 setup fee, waived once subtotal is $2,000+,
  // includes 2 hours of on-site service, then $100/hour up to 3 additional
  // hours. Admins edit these in /admin/event-settings; the cart route
  // snapshots the live values onto every catering inquiry so historic
  // quotes stay stable even after price changes.
  otdSetupFee: numeric("otd_setup_fee", { precision: 10, scale: 2 }).notNull().default("500"),
  otdFeeWaiverThreshold: numeric("otd_fee_waiver_threshold", { precision: 10, scale: 2 }).notNull().default("2000"),
  otdIncludedHours: numeric("otd_included_hours", { precision: 5, scale: 2 }).notNull().default("2"),
  otdAdditionalHourRate: numeric("otd_additional_hour_rate", { precision: 10, scale: 2 }).notNull().default("100"),
  otdMaxAdditionalHours: integer("otd_max_additional_hours").notNull().default(3),
  // ── Site & Social: link-preview customization ──────────────────────────────
  // When the public site URL is shared on iMessage / Facebook / Slack / etc.,
  // these values drive the og: + twitter: meta tags injected at the edge by
  // the catering-web vite middleware. All fields are optional with sensible
  // server-side fallbacks (event name as title, generic description, the
  // bundled opengraph.jpg image), so a fresh install never serves a broken
  // preview card. socialLogoPosition is one of:
  //   'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'none'.
  // socialHeroImageUrl / socialLogoImageUrl reference the existing image
  // library serving URLs (e.g. /api/storage/objects/<id>) so we reuse a
  // single upload pipeline for every visual asset on the site.
  // instagramHandle is reused later by Instagram-specific features (footer
  // icon link today, hashtag wall in a follow-up task).
  socialShareTitle: text("social_share_title").notNull().default(""),
  socialShareDescription: text("social_share_description").notNull().default(""),
  socialShareTagline: text("social_share_tagline").notNull().default(""),
  socialHeroImageUrl: text("social_hero_image_url"),
  socialLogoImageUrl: text("social_logo_image_url"),
  socialLogoPosition: text("social_logo_position").notNull().default("bottom-right"),
  instagramHandle: text("instagram_handle"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type EventSettings = typeof eventSettingsTable.$inferSelect;
