// SMS sender — routes through ejointech gateway
// On failure: logs the error and sends an alert email to Corey@HollywoodEastCafe.com

import { db } from "@workspace/db";
import { eventSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { isEjoinConfigured, sendSmsViaEjoin } from "./sms-ejoin";
import { sendSmsAlert } from "./mail";

// Resolve the owner notification phone with the documented fallback chain:
// admin-managed event_settings.owner_notification_phone wins, then the legacy
// OWNER_PHONE env var. Returns null when neither is present so callers can
// log/skip without sending to a stale number.
async function resolveOwnerPhone(): Promise<string | null> {
  try {
    const [row] = await db
      .select({ ownerNotificationPhone: eventSettingsTable.ownerNotificationPhone })
      .from(eventSettingsTable)
      .where(eq(eventSettingsTable.id, 1));
    const dbPhone = row?.ownerNotificationPhone?.trim();
    if (dbPhone) return dbPhone;
  } catch (err) {
    // DB hiccup shouldn't block alerts entirely — fall through to env.
    console.warn("[SMS] failed to read owner notification phone from DB", err);
  }
  const envPhone = process.env.OWNER_PHONE?.trim();
  return envPhone || null;
}

// Auto-reply disclaimer appended to guest-facing transactional sends
// (order received, order ready). Both go through the round-robin gateway
// pool, so any inbound reply lands on a random SIM and is effectively
// dropped — this sets correct expectations.
//
// Wording uses ASCII punctuation only (no em-dash) so the suffix stays
// inside the GSM-7 character set; an em-dash would force the entire
// message to UCS-2 encoding (70 chars/segment instead of 160) and roughly
// triple per-message gateway cost.
const NO_REPLY_NOTE = "Auto msg. Replies not read.";

// ── Public API ────────────────────────────────────────────────────────────────

export async function sendSms(to: string, body: string): Promise<void> {
  if (!isEjoinConfigured()) {
    console.error("[SMS] ejointech gateway not configured — SMS not sent to", to);
    return;
  }

  try {
    await sendSmsViaEjoin(to, body);
  } catch (err) {
    console.error("[SMS] ejointech failed:", err);
    // Fire-and-forget alert email — don't let it block the request
    sendSmsAlert({ to, error: err, message: body }).catch(() => {});
  }
}

export async function sendOrderConfirmation(opts: {
  guestName: string;
  orderId: number;
  phoneNumber: string;
  eventName: string;
  orderStatusUrl: string;
}): Promise<void> {
  const { guestName, orderId, phoneNumber, eventName, orderStatusUrl } = opts;
  const name  = guestName.split(" ")[0];
  const event = eventName || "dash by Hollywood East Cafe";
  const body  = `Hi ${name}! Your order #${orderId} has been received at ${event}. Track your order: ${orderStatusUrl} ${NO_REPLY_NOTE}`;
  await sendSms(phoneNumber, body);
}

export async function sendOrderReady(opts: {
  guestName: string;
  orderId: number;
  phoneNumber: string;
  eventName: string;
}): Promise<void> {
  const { guestName, orderId, eventName, phoneNumber } = opts;
  const name  = guestName.split(" ")[0];
  const event = eventName || "dash by Hollywood East Cafe";
  const body  = `Hi ${name}! Your order #${orderId} is ready for pickup at ${event}! — dash by Hollywood East Cafe ${NO_REPLY_NOTE}`;
  await sendSms(phoneNumber, body);
}

// Returns true when an SMS was actually dispatched (owner phone resolved and
// sendSms called), false when no owner phone is configured (no attempt made).
// Callers that don't need the status can safely ignore the return value;
// existing void-returning call sites are unaffected.
export async function sendNewInquiryAlert(opts: {
  clientName: string;
  source: "form" | "cart" | "chat" | "plan";
  eventDate?: string | null;
  guestCount?: number | null;
  total?: string | null;       // pre-formatted, e.g. "$123.45"
  clientPhone?: string | null;
  venueAddress?: string | null;
  link?: string | null;        // deep link to admin inquiry editor
}): Promise<boolean> {
  const ownerPhone = await resolveOwnerPhone();
  if (!ownerPhone) {
    console.warn("[SMS] no owner notification phone configured — skipping inquiry alert");
    return false;
  }
  const sourceLabel =
    opts.source === "cart"
      ? "cart order"
      : opts.source === "chat"
        ? "chat handoff"
        : opts.source === "plan"
          ? "plan inquiry"
          : "form inquiry";
  const lines: string[] = [
    `New catering ${sourceLabel} from ${opts.clientName}`,
  ];
  const detail: string[] = [];
  if (opts.eventDate)   detail.push(`Event: ${opts.eventDate}`);
  if (opts.guestCount)  detail.push(`${opts.guestCount} guests`);
  if (detail.length)    lines.push(detail.join(" · "));
  if (opts.total)       lines.push(`Total: ${opts.total} (excl. tax)`);
  // Venue gets its own line — addresses are long and would blow out the
  // compact "Event · Guests" detail row. Omitted entirely when blank so
  // the alert stays clean for older inquiries without a venue on file.
  if (opts.venueAddress?.trim()) lines.push(`Venue: ${opts.venueAddress.trim()}`);
  if (opts.clientPhone) lines.push(`Phone: ${opts.clientPhone}`);
  if (opts.link)        lines.push(`View: ${opts.link}`);
  await sendSms(ownerPhone, lines.join("\n"));
  return true;
}

export async function sendLowStockAlert(opts: {
  phoneNumbers: string[];
  eventName: string;
  items: Array<{ name: string; eventStock: number }>;
  threshold: number;
}): Promise<void> {
  const { phoneNumbers, eventName, items, threshold } = opts;
  if (phoneNumbers.length === 0 || items.length === 0) return;
  const event = eventName?.trim() || "dash by Hollywood East Cafe";
  // Cap the number of itemized lines so a sudden batch of crossings doesn't
  // produce a multi-segment SMS that gets truncated by the gateway.
  const MAX_LINES = 8;
  const lines = items.slice(0, MAX_LINES).map(i => `• ${i.name}: ${i.eventStock} left`);
  const overflow = items.length - MAX_LINES;
  if (overflow > 0) lines.push(`…and ${overflow} more`);
  const head = items.length === 1
    ? `Low stock at ${event}: "${items[0].name}" is down to ${items[0].eventStock} (threshold ${threshold}).`
    : `Low stock at ${event} (threshold ${threshold}):`;
  const body = items.length === 1 ? head : `${head}\n${lines.join("\n")}`;
  // Send sequentially so a slow gateway doesn't fan out parallel SMS bursts;
  // wrap each in try/catch so one bad recipient can't take down the others.
  // sendSms() already swallows gateway failures and emits an alert email,
  // but we add a defensive catch in case future implementations throw.
  for (const phone of phoneNumbers) {
    try {
      await sendSms(phone, body);
    } catch (err) {
      console.error("[SMS] low-stock alert failed for", phone, err);
    }
  }
}

export async function sendQuoteResponseSms(opts: {
  kind: "accepted" | "change_request";
  clientName: string;
  quoteNumber: string | null;
  message?: string | null;
  link?: string | null;
}): Promise<void> {
  const ownerPhone = await resolveOwnerPhone();
  if (!ownerPhone) {
    console.warn("[SMS] no owner notification phone configured — skipping quote response alert");
    return;
  }
  const isAccept = opts.kind === "accepted";
  const head = isAccept
    ? `${opts.clientName} accepted quote ${opts.quoteNumber ?? ""}`.trim()
    : `${opts.clientName} requested changes on quote ${opts.quoteNumber ?? ""}`.trim();
  const lines = [head];
  if (!isAccept && opts.message?.trim()) {
    const note = opts.message.trim();
    lines.push(note.length > 240 ? `${note.slice(0, 237)}…` : note);
  }
  if (opts.link) lines.push(opts.link);
  await sendSms(ownerPhone, lines.join("\n"));
}
