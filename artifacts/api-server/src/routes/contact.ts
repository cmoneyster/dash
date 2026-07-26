import { Router } from "express";
import { z } from "zod/v4";
import { db } from "@workspace/db";
import { cateringInquiriesTable, contactRequestsTable, eventSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { sendToCustomerGuarded, normalizePhoneDigits } from "../lib/sms-inbox";
import { getChatPort } from "../lib/sms-ejoin";
import { sendNewInquiryAlert } from "../lib/sms";
import { sendMail, ALERT_TO } from "../lib/mail";

const router = Router();

const ContactBody = z.object({
  channel: z.enum(["email", "sms"]),
  name: z.string().min(1).max(120),
  contact: z.string().min(3).max(254),
  message: z.string().min(1).max(2000),
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function resolveOwnerEmail(): Promise<string> {
  try {
    const [settings] = await db
      .select({
        chatOwner: eventSettingsTable.smsChatOwnerEmail,
        owner: eventSettingsTable.ownerNotificationEmail,
      })
      .from(eventSettingsTable)
      .where(eq(eventSettingsTable.id, 1));
    return settings?.chatOwner?.trim() || settings?.owner?.trim() || ALERT_TO;
  } catch {
    return ALERT_TO;
  }
}

router.post("/contact/message", async (req, res) => {
  const parsed = ContactBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "Invalid request body" });
    return;
  }
  const { channel, name, contact, message } = parsed.data;

  if (channel === "email") {
    if (!EMAIL_RE.test(contact) || contact.length > 254) {
      res.status(400).json({ ok: false, error: "Email address looks invalid." });
      return;
    }
    const to = await resolveOwnerEmail();
    const safeName = escapeHtml(name);
    const safeContact = escapeHtml(contact);
    const safeMessage = escapeHtml(message).replace(/\n/g, "<br/>");
    const html = [
      `<p><strong>${safeName}</strong> sent a message via the dash website.</p>`,
      `<p><strong>Reply to:</strong> ${safeContact}</p>`,
      `<p><strong>Message:</strong><br/>${safeMessage}</p>`,
    ].join("\n");
    const text = [
      `${name} sent a message via the dash website.`,
      `Reply to: ${contact}`,
      "",
      `Message:`,
      message,
    ].join("\n");
    const mailResult = await sendMail({
      to,
      replyTo: contact,
      subject: `New message from ${name} — dash website`,
      text,
      html,
    });
    if (!mailResult.ok) {
      req.log.warn({ error: mailResult.error }, "[contact] email send failed");
      res.status(500).json({ ok: false, error: "Failed to send your message. Please try again." });
      return;
    }
    res.json({ ok: true, channel: "email" });
    return;
  }

  // ── SMS path ──────────────────────────────────────────────────────────────
  const normalizedPhone = normalizePhoneDigits(contact);
  if (normalizedPhone.length < 10) {
    res.status(400).json({
      ok: false,
      error: "Phone number looks incomplete — please use a 10-digit US number.",
    });
    return;
  }

  let inquiryId: number | null = null;
  try {
    const adminNote = `Initiated via website contact form (SMS).\nSummary: ${message}`;
    const [row] = await db
      .insert(cateringInquiriesTable)
      .values({
        clientName: name,
        clientPhone: normalizedPhone,
        adminNotes: adminNote,
        source: "chat",
        status: "inquiry",
      } as typeof cateringInquiriesTable.$inferInsert)
      .returning({ id: cateringInquiriesTable.id });
    inquiryId = row?.id ?? null;
  } catch (err) {
    req.log.warn({ err }, "[contact] failed to create inquiry row");
  }

  try {
    await db.insert(contactRequestsTable).values({
      name,
      channel: "sms",
      contactValue: normalizedPhone,
      summary: message,
      inquiryId,
    });
  } catch (err) {
    req.log.warn({ err }, "[contact] failed to insert contact_requests row");
  }

  // smsBridge is the contract-specified enum: "sent" | "no-chat-port" | "failed"
  // ("blocked" collapses to "failed" so the response shape matches the spec)
  let smsBridgeStatus: "sent" | "no-chat-port" | "failed" = "no-chat-port";
  let welcomeSmsSent = false;
  try {
    const port = await getChatPort();
    if (port == null) {
      smsBridgeStatus = "no-chat-port";
      req.log.warn("[contact] SMS welcome skipped — no chat port configured");
    } else {
      const firstName = name.split(/\s+/)[0] || "there";
      const welcome =
        `Hi ${firstName}, this is dash by Hollywood East Cafe. Thanks for reaching out! ` +
        `Reply here and a team member will be in touch. Reply STOP to opt out.`;
      const result = await sendToCustomerGuarded({
        to: normalizedPhone,
        body: welcome,
        inquiryId,
        source: "system",
      });
      if (result.status === "sent") {
        smsBridgeStatus = "sent";
        welcomeSmsSent = true;
      } else {
        smsBridgeStatus = "failed";
        req.log.warn({ status: result.status }, "[contact] SMS welcome blocked or rejected");
      }
    }
  } catch (err) {
    smsBridgeStatus = "failed";
    req.log.error({ err }, "[contact] failed to send SMS welcome");
  }

  let ownerAlertSent = false;
  try {
    ownerAlertSent = await sendNewInquiryAlert({
      clientName: name,
      source: "chat",
      clientPhone: normalizedPhone,
    });
  } catch (err) {
    req.log.warn({ err }, "[contact] owner SMS alert failed");
  }

  // Email audit trail to owner regardless of SMS status
  let ownerEmailSent = false;
  try {
    const to = await resolveOwnerEmail();
    const safeName = escapeHtml(name);
    const safePhone = escapeHtml(normalizedPhone);
    const safeMessage = escapeHtml(message).replace(/\n/g, "<br/>");
    const inquiryNote =
      inquiryId != null
        ? `<p>Inquiry created: <strong>#${inquiryId}</strong>. Reply to the guest by texting <code>#${inquiryId} your message</code> to the catering chat number.</p>`
        : "";
    const auditResult = await sendMail({
      to,
      subject: `New contact form message (SMS) — ${name}`,
      text: [
        `${name} submitted the contact form via the dash website (SMS path).`,
        `Phone: ${normalizedPhone}`,
        `Message:\n${message}`,
        inquiryId != null
          ? `Inquiry #${inquiryId} created (reply with #${inquiryId} <msg>).`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
      html: [
        `<p><strong>${safeName}</strong> submitted the contact form via the dash website (SMS path).</p>`,
        `<p><strong>Phone:</strong> ${safePhone}</p>`,
        `<p><strong>Message:</strong><br/>${safeMessage}</p>`,
        inquiryNote,
      ]
        .filter(Boolean)
        .join("\n"),
    });
    if (auditResult.ok) {
      ownerEmailSent = true;
    } else {
      req.log.warn({ error: auditResult.error }, "[contact] owner email audit trail failed");
    }
  } catch (err) {
    req.log.warn({ err }, "[contact] owner email audit trail threw unexpectedly");
  }

  // Return 500 only when every delivery attempt failed — the guest got no
  // welcome text AND the owner received no alert via any channel.
  const anyDeliverySucceeded = welcomeSmsSent || ownerAlertSent || ownerEmailSent;
  if (!anyDeliverySucceeded) {
    req.log.error(
      { smsBridgeStatus, ownerAlertSent, ownerEmailSent },
      "[contact] all SMS-path delivery attempts failed",
    );
    res.status(500).json({ ok: false, error: "Failed to send your message. Please try again." });
    return;
  }

  res.json({ ok: true, channel: "sms", smsBridge: smsBridgeStatus });
});

export default router;
