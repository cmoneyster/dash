// SMS sender — routes through ejointech gateway
// On failure: logs the error and sends an alert email to Corey@HollywoodEastCafe.com

import { isEjoinConfigured, sendSmsViaEjoin } from "./sms-ejoin";
import { sendSmsAlert } from "./mail";

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
  const body  = `Hi ${name}! Your order #${orderId} has been received at ${event}. Track your order: ${orderStatusUrl}`;
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
  const body  = `Hi ${name}! Your order #${orderId} is ready for pickup at ${event}! — dash by Hollywood East Cafe`;
  await sendSms(phoneNumber, body);
}

export async function sendNewInquiryAlert(opts: {
  clientName: string;
  source: "form" | "cart";
  eventDate?: string | null;
  guestCount?: number | null;
  total?: string | null;       // pre-formatted, e.g. "$123.45"
  clientPhone?: string | null;
  link?: string | null;        // deep link to admin inquiry editor
}): Promise<void> {
  const ownerPhone = process.env.OWNER_PHONE;
  if (!ownerPhone) {
    console.warn("[SMS] OWNER_PHONE not set — skipping inquiry alert");
    return;
  }
  const sourceLabel = opts.source === "cart" ? "cart order" : "form inquiry";
  const lines: string[] = [
    `New catering ${sourceLabel} from ${opts.clientName}`,
  ];
  const detail: string[] = [];
  if (opts.eventDate)   detail.push(`Event: ${opts.eventDate}`);
  if (opts.guestCount)  detail.push(`${opts.guestCount} guests`);
  if (detail.length)    lines.push(detail.join(" · "));
  if (opts.total)       lines.push(`Total: ${opts.total}`);
  if (opts.clientPhone) lines.push(`Phone: ${opts.clientPhone}`);
  if (opts.link)        lines.push(`View: ${opts.link}`);
  await sendSms(ownerPhone, lines.join("\n"));
}

export async function sendLowStockAlert(opts: {
  phoneNumber: string;
  eventName: string;
  items: Array<{ name: string; eventStock: number }>;
  threshold: number;
}): Promise<void> {
  const { phoneNumber, eventName, items, threshold } = opts;
  if (!phoneNumber || items.length === 0) return;
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
  await sendSms(phoneNumber, body);
}

export async function sendQuoteResponseSms(opts: {
  kind: "accepted" | "change_request";
  clientName: string;
  quoteNumber: string | null;
  message?: string | null;
  link?: string | null;
}): Promise<void> {
  const ownerPhone = process.env.OWNER_PHONE;
  if (!ownerPhone) {
    console.warn("[SMS] OWNER_PHONE not set — skipping quote response alert");
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
