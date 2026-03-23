import twilio from "twilio";

interface SmsConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

function getConfig(): SmsConfig | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  if (!accountSid || !authToken || !fromNumber) return null;
  return { accountSid, authToken, fromNumber };
}

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

export async function sendSms(to: string, body: string, fromOverride?: string | null): Promise<void> {
  const config = getConfig();
  if (!config) return;
  const from = fromOverride || config.fromNumber;
  try {
    const client = twilio(config.accountSid, config.authToken);
    await client.messages.create({ to: normalizePhone(to), from, body });
  } catch (err) {
    console.error("[SMS] Failed to send message:", err);
  }
}

export async function sendOrderConfirmation(opts: {
  guestName: string;
  orderId: number;
  phoneNumber: string;
  eventName: string;
  orderStatusUrl: string;
  fromNumber?: string | null;
}): Promise<void> {
  const { guestName, orderId, phoneNumber, eventName, orderStatusUrl, fromNumber } = opts;
  const name = guestName.split(" ")[0];
  const event = eventName || "dash by Hollywood East Cafe";
  const body = `Hi ${name}! Your order #${orderId} has been received at ${event}. Track your order: ${orderStatusUrl} — dash by Hollywood East Cafe`;
  await sendSms(phoneNumber, body, fromNumber);
}

export async function sendOrderReady(opts: {
  guestName: string;
  orderId: number;
  phoneNumber: string;
  eventName: string;
  fromNumber?: string | null;
}): Promise<void> {
  const { guestName, orderId, eventName, phoneNumber, fromNumber } = opts;
  const name = guestName.split(" ")[0];
  const event = eventName || "dash by Hollywood East Cafe";
  const body = `Hi ${name}! Your order #${orderId} is ready for pickup at ${event}! — dash by Hollywood East Cafe`;
  await sendSms(phoneNumber, body, fromNumber);
}
