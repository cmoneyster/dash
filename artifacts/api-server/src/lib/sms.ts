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
