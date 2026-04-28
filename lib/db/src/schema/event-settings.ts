import { sql } from "drizzle-orm";
import { pgTable, integer, text, timestamp, boolean, numeric } from "drizzle-orm/pg-core";

export const eventSettingsTable = pgTable("event_settings", {
  id: integer("id").primaryKey(),
  eventName: text("event_name").notNull().default(""),
  eventPassword: text("event_password").notNull().default(""),
  kitchenPassword: text("kitchen_password"),
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
  // ── Communications: SMS gateway port pool ─────────────────────────────────
  // Set of ejointech gateway ports the sender rotates through (round-robin)
  // to spread load across SIMs. Each entry must be 1–32 (gateway hardware
  // limit). Defaults to a single port (7) so existing deployments behave
  // identically until an admin opts into multi-port. Empty array is treated
  // as "fall back to port 7" by the sender, but the API rejects empty saves.
  smsActivePorts: integer("sms_active_ports").array().notNull().default(sql`ARRAY[7]::integer[]`),
  // Owner phone for inquiry-arrival and quote-response alerts. When set,
  // takes precedence over the OWNER_PHONE env var. Stored as the admin
  // typed it (E.164-ish) — sender normalizes before dispatch.
  ownerNotificationPhone: text("owner_notification_phone"),
  // ── Customer chat port ────────────────────────────────────────────────────
  // Single physical SIM port on the gateway dedicated to two-way customer
  // SMS chat (quote sends, change-request replies, the inquiry composer,
  // owner-relayed replies, and the inbound chat capture). MUST NOT
  // overlap with smsActivePorts (the round-robin pool used for staff-
  // facing sends). Validation enforces non-overlap on save.
  smsChatPort: integer("sms_chat_port"),
  // Optional phone number that receives the owner-forward leg of a
  // customer chat (and is recognized as "the owner" when replying via
  // the chat port). Lets the admin route chat traffic to a different
  // person than the regular ownerNotificationPhone (which keeps
  // handling low-stock alerts, inquiry-arrival/quote-response alerts,
  // and the test-owner-alert button via the round-robin pool).
  // Resolution order at send time: smsChatOwnerPhone → ownerNotificationPhone
  // → OWNER_PHONE env var → null. Stored as the admin typed it; sender
  // normalizes before dispatch.
  smsChatOwnerPhone: text("sms_chat_owner_phone"),
  // Toggle: forward inbound customer messages to the owner phone.
  // This controls forwards for messages tied to a real catering inquiry
  // (e.g. "[Catering #123 · Jane] ..."). Unmatched-sender forwards
  // (random texts from numbers we can't tie to an inquiry — usually
  // spam) are gated separately by smsOwnerForwardUnmatchedEnabled
  // below so admins can mute the spam without losing real customer
  // forwards.
  smsOwnerForwardEnabled: boolean("sms_owner_forward_enabled").notNull().default(false),
  // Cap for owner forwards per inquiry per rolling 24h. NULL means
  // unlimited. UI exposes 1/3/5/10/unlimited; default 1.
  smsOwnerForwardCapPer24h: integer("sms_owner_forward_cap_per_24h").default(1),
  // Sub-toggle on top of smsOwnerForwardEnabled: when ON, also forward
  // inbound texts whose sender doesn't match any catering inquiry
  // (the "[Unmatched · <phone>]" forwards). Defaults to FALSE because
  // these are usually spam (Google verification codes, retailer promos,
  // wrong numbers) and admins almost never want them texted to the
  // owner phone. When OFF, unmatched messages still land in the
  // Unmatched inbox — just no owner SMS is fired. Has no effect when
  // smsOwnerForwardEnabled itself is OFF.
  smsOwnerForwardUnmatchedEnabled: boolean("sms_owner_forward_unmatched_enabled").notNull().default(false),
  // Toggle: allow the owner to reply from their phone with `#<id> ...`
  // tag and have the message routed back to the customer through the
  // chat port.
  smsOwnerReplyEnabled: boolean("sms_owner_reply_enabled").notNull().default(false),
  // How many days of historical SIM messages to pull on first deploy
  // (and on a manual "Run backfill now"). Default 90.
  smsBackfillDays: integer("sms_backfill_days").notNull().default(90),
  // Stamped after the first successful historical backfill so it
  // doesn't re-run on every server restart. Manual re-trigger via
  // the settings card always runs regardless.
  smsBackfillCompletedAt: timestamp("sms_backfill_completed_at"),
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
  // ── Site & Social ──────────────────────────────────────────────────────────
  // Brand Instagram handle (no leading @). Empty string = not configured.
  // Used by the public footer link AND by the hashtag-wall auto-approve rule
  // (caption mentions the brand handle → auto-approve).
  instagramHandle: text("instagram_handle").notNull().default(""),
  // ── Instagram hashtag-wall config ──────────────────────────────────────────
  // Up to 5 watched hashtags (lowercased, no leading #). Polled every 30 min;
  // matches drop into instagram_hashtag_candidates as `pending` until an admin
  // approves them. Hard cap of 5 enforced server-side because Meta's quota is
  // 30 hashtag-searches per IG user per rolling 7 days.
  instagramHashtags: text("instagram_hashtags").array().notNull().default(sql`ARRAY[]::text[]`),
  instagramWallEnabled: boolean("instagram_wall_enabled").notNull().default(false),
  instagramWallMaxItems: integer("instagram_wall_max_items").notNull().default(12),
  instagramWallShowOnHome: boolean("instagram_wall_show_on_home").notNull().default(false),
  instagramWallShowOnGallery: boolean("instagram_wall_show_on_gallery").notNull().default(false),
  // Auto-approve when the post caption mentions @{instagramHandle}.
  // Disabled in the UI when handle is empty.
  instagramAutoApproveMention: boolean("instagram_auto_approve_mention").notNull().default(false),
  // Auto-deny posts older than N days. Default 90; admin can blank it to disable.
  instagramAutoDenyOlderThanDays: integer("instagram_auto_deny_older_than_days").default(90),
  // Stats surfaced to the moderation sidebar; updated by the poller.
  instagramLastPolledAt: timestamp("instagram_last_polled_at"),
  // Stamped when the admin loads the moderation page; the sidebar nav badge
  // counts pending posts that arrived AFTER this timestamp.
  instagramAdminLastVisitedAt: timestamp("instagram_admin_last_visited_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type EventSettings = typeof eventSettingsTable.$inferSelect;
