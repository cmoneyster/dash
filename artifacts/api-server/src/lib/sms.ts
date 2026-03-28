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
}): Promise<void> {
  const ownerPhone = process.env.OWNER_PHONE;
  if (!ownerPhone) {
    console.warn("[SMS] OWNER_PHONE not set — skipping inquiry alert");
    return;
  }
  const sourceLabel = opts.source === "cart" ? "cart order" : "form inquiry";
  const datePart = opts.eventDate ? ` — Event: ${opts.eventDate}` : "";
  const body = `New catering inquiry from ${opts.clientName} (${sourceLabel})${datePart}. Check admin for details.`;
  await sendSms(ownerPhone, body);
}
