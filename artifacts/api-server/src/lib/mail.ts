// Email alerting — sends admin notifications via SMTP (nodemailer)
// Configure via: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
// Alert recipient hardcoded to Corey@HollywoodEastCafe.com

import nodemailer from "nodemailer";

const ALERT_TO   = "Corey@HollywoodEastCafe.com";
const ALERT_FROM = "dash@HollywoodEastCafe.com";

function getTransport() {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const port = parseInt(process.env.SMTP_PORT?.trim() || "587", 10);
  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

export type MailAttachment = {
  filename: string;
  content: Buffer;
  contentType?: string;
};

export async function sendMail(opts: {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: MailAttachment[];
  replyTo?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const transport = getTransport();
  if (!transport) return { ok: false, error: "SMTP not configured" };
  try {
    await transport.sendMail({
      from: `"dash by Hollywood East Cafe" <${ALERT_FROM}>`,
      to: opts.to,
      replyTo: opts.replyTo ?? ALERT_TO,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
      attachments: opts.attachments,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendSmsAlert(context: {
  to: string;
  error: unknown;
  message: string;
}): Promise<void> {
  const transport = getTransport();
  if (!transport) {
    console.warn("[mail] SMTP not configured — skipping alert email");
    return;
  }

  const err      = context.error instanceof Error ? context.error.message : String(context.error);
  const timestamp = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });

  try {
    await transport.sendMail({
      from:    `"dash by Hollywood East Cafe" <${ALERT_FROM}>`,
      to:      ALERT_TO,
      subject: "⚠️ dash SMS Gateway Issue",
      text: [
        `Time: ${timestamp}`,
        `Recipient: ${context.to}`,
        `Message: ${context.message}`,
        ``,
        `Error: ${err}`,
        ``,
        `The SMS was NOT delivered. Please check the ejointech gateway at:`,
        `http://yuhome.corkytech.com:1640`,
      ].join("\n"),
      html: `
        <p><strong>Time:</strong> ${timestamp}</p>
        <p><strong>Recipient:</strong> ${context.to}</p>
        <p><strong>Message:</strong> ${context.message}</p>
        <hr/>
        <p><strong>Error:</strong> <code>${err}</code></p>
        <p>The SMS was <strong>NOT delivered</strong>. Please check the ejointech gateway at:<br/>
        <a href="http://yuhome.corkytech.com:1640">yuhome.corkytech.com:1640</a></p>
      `,
    });
    console.info(`[mail] SMS failure alert sent to ${ALERT_TO}`);
  } catch (mailErr) {
    console.error("[mail] Failed to send alert email:", mailErr);
  }
}
