import { sql } from "drizzle-orm";
import { pgTable, integer, text, timestamp, boolean, numeric, jsonb } from "drizzle-orm/pg-core";
import type { PrintTemplate } from "./printers";

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
  // Catering invoice sales tax — applied to Square Orders API calls when enabled.
  // Unlike the POS tax (which is computed client-side on the receipt), this is
  // passed explicitly in the Square order body so the Square invoice shows a
  // separate tax line. Rate is a percentage (e.g. "8.875" for 8.875%).
  cateringTaxEnabled: boolean("catering_tax_enabled").notNull().default(false),
  cateringTaxRate: numeric("catering_tax_rate", { precision: 6, scale: 3 }),
  // Venmo display info shown on the POS payment screen
  venmoHandle: text("venmo_handle"),
  venmoQrImageUrl: text("venmo_qr_image_url"),
  // Order notes toggles. When enabled, a free-text "notes" textarea appears
  // on the respective ordering UI and the entered value is stored on the order
  // row and printed on the kitchen ticket notes section.
  guestNotesEnabled: boolean("guest_notes_enabled").notNull().default(false),
  staffNotesEnabled: boolean("staff_notes_enabled").notNull().default(false),
  // Square Terminal device ID for the Staff Order Taker card-present flow.
  // When set (and Square is configured), tapping Credit Card auto-fires a
  // Terminal checkout to this device instead of showing a manual prompt.
  squareTerminalDeviceId: text("square_terminal_device_id"),
  // Custom menu grid order for the Staff Order Taker. Stored as an ordered
  // array of menu item IDs. When set, items are returned in this order;
  // items not present in the list append at the end in default sort order.
  // An empty array (or null) means "use default alpha order".
  // Null entries within the array represent intentionally empty grid cells
  // (gaps the operator wants to leave blank between items).
  takerMenuOrder: jsonb("taker_menu_order").$type<(number | null)[]>(),
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
  // Owner email for non-SMS owner notifications (currently used as the
  // fallback recipient for chat human-handoff alert emails when no
  // chat-specific email is set). When blank, callers fall back to the
  // legacy hardcoded ALERT_TO address in lib/mail.ts. Stored as the
  // admin typed it; consumers should trim before use.
  ownerNotificationEmail: text("owner_notification_email"),
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
  // Optional email address that receives chat human-handoff alerts
  // (when a guest asks the website chat to be reached by phone, email,
  // or text). Lets the admin route chat alerts to a different inbox
  // than the regular ownerNotificationEmail. Resolution order at send
  // time: smsChatOwnerEmail → ownerNotificationEmail → legacy
  // hardcoded ALERT_TO. Stored as the admin typed it.
  smsChatOwnerEmail: text("sms_chat_owner_email"),
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
  // ── SMS gateway inbound polling controls (operator-tunable) ───────────────
  // When false, the boot-time loop skips the actual gateway HTTP fetch
  // (so the SIM stops bleeding ~7 KB every cycle), but admin "Run now"
  // still works. When true, polls happen every smsPollIntervalSeconds
  // in poll mode. Push-mode safety-net cadence is unaffected by these
  // two columns. Default true / 3s preserves prior behavior on first
  // deploy; the operator can dial it down to reduce data usage.
  smsPollEnabled: boolean("sms_poll_enabled").notNull().default(true),
  smsPollIntervalSeconds: integer("sms_poll_interval_seconds").notNull().default(3),
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
  // ── Daily booking capacity ────────────────────────────────────────────────
  // Per-day caps used by /events/day-load and the chat bot's check_event_date
  // tool. NULL on any column means "unlimited / no cap configured" for that
  // dimension. Slots count confirmed orders as hard load and pending orders as
  // soft load (still surfaced, but not blocking). Cancelled orders are
  // ignored. The five per-style slot columns mirror the service-style labels
  // the chat bot uses; only drop_off and on_the_dash are populated by the
  // current cart, but reserving columns for the others avoids a follow-up
  // migration when those modes ship to checkout.
  dailyGuestCap: integer("daily_guest_cap"),
  dailyDropOffSlots: integer("daily_drop_off_slots"),
  dailyOnTheDashSlots: integer("daily_on_the_dash_slots"),
  dailyBuffetSlots: integer("daily_buffet_slots"),
  dailyGrazingSlots: integer("daily_grazing_slots"),
  dailyMadeToOrderSlots: integer("daily_made_to_order_slots"),
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
  // ── Instagram hashtag polling controls (operator-tunable) ─────────────────
  // When false, the boot-time loop skips its scheduled cycle entirely
  // (so we don't burn the 30-call-per-7-day Meta quota while the
  // operator is iterating on hashtag config), but admin "Run now"
  // still works. When true, cycles run every instagramPollIntervalMinutes.
  // Cleanup pass cadence (daily) is unaffected by these two columns.
  // Default true / 30 min preserves prior behavior on first deploy.
  instagramPollEnabled: boolean("instagram_poll_enabled").notNull().default(true),
  instagramPollIntervalMinutes: integer("instagram_poll_interval_minutes").notNull().default(30),
  // Stats surfaced to the moderation sidebar; updated by the poller.
  instagramLastPolledAt: timestamp("instagram_last_polled_at"),
  // Stamped when the admin loads the moderation page; the sidebar nav badge
  // counts pending posts that arrived AFTER this timestamp.
  instagramAdminLastVisitedAt: timestamp("instagram_admin_last_visited_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  printTemplate: jsonb("print_template").$type<PrintTemplate>(),
});

export type EventSettings = typeof eventSettingsTable.$inferSelect;
