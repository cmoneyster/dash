// Twilio integration via Replit connector
import twilio from "twilio";

async function getCredentials() {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
    ? "depl " + process.env.WEB_REPL_RENEWAL
    : null;

  if (!hostname || !xReplitToken) return null;

  try {
    const data = await fetch(
      "https://" + hostname + "/api/v2/connection?include_secrets=true&connector_names=twilio",
      {
        headers: {
          Accept: "application/json",
          "X-Replit-Token": xReplitToken,
        },
      }
    ).then(r => r.json()).then((d: any) => d.items?.[0]);

    if (!data?.settings?.account_sid || !data?.settings?.api_key || !data?.settings?.api_key_secret) {
      return null;
    }

    return {
      accountSid: data.settings.account_sid as string,
      apiKey: data.settings.api_key as string,
      apiKeySecret: data.settings.api_key_secret as string,
      defaultFromNumber: (data.settings.phone_number as string) ?? null,
    };
  } catch {
    return null;
  }
}

async function getClient() {
  const creds = await getCredentials();
  if (!creds) return null;
  return {
    client: twilio(creds.apiKey, creds.apiKeySecret, { accountSid: creds.accountSid }),
    defaultFromNumber: creds.defaultFromNumber,
  };
}

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

export async function sendSms(to: string, body: string, fromOverride?: string | null): Promise<void> {
  const conn = await getClient();
  if (!conn) {
    console.warn("[SMS] Twilio not configured, skipping message to", to);
    return;
  }
  const from = fromOverride || conn.defaultFromNumber;
  if (!from) {
    console.warn("[SMS] No Twilio from number configured, skipping message");
    return;
  }
  try {
    await conn.client.messages.create({ to: normalizePhone(to), from, body });
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
  const body = `Hi ${name}! Your order #${orderId} has been received at ${event}. Track your order: ${orderStatusUrl}`;
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
