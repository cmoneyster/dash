// Email alerting — sends admin notifications via SMTP (nodemailer)
// Configure via: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
// Alert recipient hardcoded to Corey@HollywoodEastCafe.com

import nodemailer from "nodemailer";

// Exported so chat-handoff callers can use it as the final link in the
// smsChatOwnerEmail → ownerNotificationEmail → ALERT_TO fallback chain
// (kept hardcoded so a fresh deploy with no DB-managed email still
// reaches a real human).
export const ALERT_TO   = "Corey@HollywoodEastCafe.com";
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

export async function sendQuoteResponseAlert(context: {
  kind: "accepted" | "change_request";
  clientName: string;
  quoteNumber: string | null;
  message?: string | null;
  link?: string | null;
}): Promise<void> {
  const transport = getTransport();
  if (!transport) {
    console.warn("[mail] SMTP not configured — skipping quote response alert");
    return;
  }
  const isAccept = context.kind === "accepted";
  const subject = isAccept
    ? `Quote ${context.quoteNumber ?? ""} accepted by ${context.clientName}`.trim()
    : `Changes requested on quote ${context.quoteNumber ?? ""} by ${context.clientName}`.trim();
  const lines = [
    `Client: ${context.clientName}`,
    `Quote: ${context.quoteNumber ?? "—"}`,
    `Action: ${isAccept ? "Accepted" : "Requested changes"}`,
  ];
  if (!isAccept && context.message?.trim()) {
    lines.push("", "Message:", context.message.trim());
  }
  if (context.link) lines.push("", `Open in admin: ${context.link}`);
  // Escape any client-provided text to avoid HTML/script injection in the
  // staff alert email. clientName/quoteNumber/message all originate from
  // user input, so we sanitize before interpolating into HTML.
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const safeName = esc(context.clientName);
  const safeQuote = esc(context.quoteNumber ?? "—");
  const safeMessage = context.message?.trim() ? esc(context.message.trim()).replace(/\n/g, "<br/>") : "";
  const safeLink = context.link ? esc(context.link) : "";
  const html = `
    <p><strong>Client:</strong> ${safeName}</p>
    <p><strong>Quote:</strong> ${safeQuote}</p>
    <p><strong>Action:</strong> ${isAccept ? "Accepted" : "Requested changes"}</p>
    ${!isAccept && safeMessage
      ? `<p><strong>Message:</strong></p><blockquote>${safeMessage}</blockquote>`
      : ""}
    ${safeLink ? `<p><a href="${safeLink}">Open in admin</a></p>` : ""}
  `;
  try {
    await transport.sendMail({
      from: `"dash by Hollywood East Cafe" <${ALERT_FROM}>`,
      to: ALERT_TO,
      subject,
      text: lines.join("\n"),
      html,
    });
  } catch (mailErr) {
    console.error("[mail] Failed to send quote response alert:", mailErr);
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
