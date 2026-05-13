import { Router, type IRouter, type Request } from "express";
import { db } from "@workspace/db";
import { cateringInquiriesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { renderQuotePdf, publicQuoteFromInquiry } from "../lib/quote";
import { sendQuoteResponseAlert } from "../lib/mail";
import { sendQuoteResponseSms } from "../lib/sms";

const router: IRouter = Router();

function publicBaseUrl(req: Request): string {
  const env = process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "");
  if (env) return env;
  const fwd = req.headers["x-forwarded-proto"];
  const proto = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0] || req.protocol || "https";
  const host = req.get("host");
  return `${proto}://${host}`;
}

// JSON snapshot for the public read-only quote page
router.get("/quote/:token", async (req, res): Promise<void> => {
  try {
    const token = req.params.token;
    if (!token) { res.status(404).json({ error: "Quote not found" }); return; }
    const [inquiry] = await db
      .select()
      .from(cateringInquiriesTable)
      .where(eq(cateringInquiriesTable.quoteToken, token));
    if (!inquiry || !inquiry.quoteIssuedAt) { res.status(404).json({ error: "Quote not found" }); return; }
    if (inquiry.quoteExpiresAt && new Date(inquiry.quoteExpiresAt) < new Date()) {
      res.status(410).json({ error: "Quote has expired", expired: true });
      return;
    }
    res.json(publicQuoteFromInquiry(inquiry));
  } catch (err) {
    req.log.error({ err }, "Error fetching public quote");
    res.status(500).json({ error: "Failed to fetch quote" });
  }
});

router.get("/quote/:token/pdf", async (req, res): Promise<void> => {
  try {
    const token = req.params.token;
    if (!token) { res.status(404).json({ error: "Quote not found" }); return; }
    const [inquiry] = await db
      .select()
      .from(cateringInquiriesTable)
      .where(eq(cateringInquiriesTable.quoteToken, token));
    if (!inquiry || !inquiry.quoteIssuedAt) { res.status(404).json({ error: "Quote not found" }); return; }
    if (inquiry.quoteExpiresAt && new Date(inquiry.quoteExpiresAt) < new Date()) {
      res.status(410).json({ error: "Quote has expired" });
      return;
    }
    const pdf = await renderQuotePdf(inquiry);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${inquiry.quoteNumber ?? `quote-${inquiry.id}`}.pdf"`,
    );
    res.send(pdf);
  } catch (err) {
    req.log.error({ err }, "Error rendering public quote PDF");
    res.status(500).json({ error: "Failed to render PDF" });
  }
});

// ── Client actions: accept / request changes ─────────────────────────────────

type LoadedInquiry =
  | { ok: true; inquiry: typeof cateringInquiriesTable.$inferSelect }
  | { ok: false; status: number; body: { error: string; expired?: boolean } };

async function loadActionableInquiry(token: string | undefined): Promise<LoadedInquiry> {
  if (!token) return { ok: false, status: 404, body: { error: "Quote not found" } };
  const [inquiry] = await db
    .select()
    .from(cateringInquiriesTable)
    .where(eq(cateringInquiriesTable.quoteToken, token));
  if (!inquiry || !inquiry.quoteIssuedAt) {
    return { ok: false, status: 404, body: { error: "Quote not found" } };
  }
  if (inquiry.quoteExpiresAt && new Date(inquiry.quoteExpiresAt) < new Date()) {
    return { ok: false, status: 410, body: { error: "Quote has expired", expired: true } };
  }
  return { ok: true, inquiry };
}

router.post("/quote/:token/accept", async (req, res): Promise<void> => {
  try {
    const loaded = await loadActionableInquiry(req.params.token);
    if (!loaded.ok) { res.status(loaded.status).json(loaded.body); return; }
    const inquiry = loaded.inquiry;

    if (inquiry.quoteAcceptedAt) {
      res.json(publicQuoteFromInquiry(inquiry));
      return;
    }

    // Collect eventDate / eventTime from the body — the client may supply
    // them when accepting if the inquiry was created without them.
    const body = (req.body ?? {}) as Record<string, unknown>;
    const bodyEventDate = typeof body.eventDate === "string" ? body.eventDate.trim() || null : null;
    const rawBodyTime = typeof body.eventTime === "string" ? body.eventTime.trim() : null;
    // Validate HH:MM 24-hour format to avoid storing malformed values.
    const HH_MM = /^([01]?\d|2[0-3]):[0-5]\d$/;
    if (rawBodyTime && !HH_MM.test(rawBodyTime)) {
      res.status(400).json({ error: "eventTime must be in HH:MM 24-hour format (e.g. 14:30)." });
      return;
    }
    const bodyEventTime = rawBodyTime || null;

    // Body values take precedence so clients can correct a previously-stored
    // date/time (e.g. "change delivery details" flow on the public quote page).
    const resolvedEventDate = bodyEventDate || inquiry.eventDate?.trim() || null;
    const resolvedEventTime = bodyEventTime || inquiry.eventTime?.trim() || null;

    if (!resolvedEventDate || !resolvedEventTime) {
      res.status(422).json({
        error: "Delivery date and time are required to accept this quote.",
        missingEventDate: !resolvedEventDate,
        missingEventTime: !resolvedEventTime,
      });
      return;
    }

    const now = new Date();
    const [updated] = await db
      .update(cateringInquiriesTable)
      .set({
        quoteAcceptedAt: now,
        eventDate: resolvedEventDate,
        eventTime: resolvedEventTime,
        // Confirming clears any prior change-request state.
        quoteChangeRequestAt: null,
        quoteChangeRequestMessage: null,
        // Move the inquiry forward in the workflow if it was still in early states.
        status: inquiry.status === "inquiry" || inquiry.status === "quoted" ? "confirmed" : inquiry.status,
        updatedAt: now,
      })
      .where(eq(cateringInquiriesTable.id, inquiry.id))
      .returning();

    const adminLink = `${publicBaseUrl(req)}/admin/catering?inquiry=${updated.id}`;
    // Fire-and-forget notifications — don't fail the client request if alerts fail.
    sendQuoteResponseAlert({
      kind: "accepted",
      clientName: updated.clientName,
      quoteNumber: updated.quoteNumber,
      link: adminLink,
    }).catch((err) => req.log.error({ err }, "Quote accept email alert failed"));
    sendQuoteResponseSms({
      kind: "accepted",
      clientName: updated.clientName,
      quoteNumber: updated.quoteNumber,
      link: adminLink,
    }).catch((err) => req.log.error({ err }, "Quote accept SMS alert failed"));

    res.json(publicQuoteFromInquiry(updated));
  } catch (err) {
    req.log.error({ err }, "Error accepting quote");
    res.status(500).json({ error: "Failed to accept quote" });
  }
});

router.post("/quote/:token/request-changes", async (req, res): Promise<void> => {
  try {
    const loaded = await loadActionableInquiry(req.params.token);
    if (!loaded.ok) { res.status(loaded.status).json(loaded.body); return; }
    const inquiry = loaded.inquiry;

    if (inquiry.quoteAcceptedAt) {
      res.status(409).json({ error: "Quote has already been accepted" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawMessage = typeof body.message === "string" ? body.message.trim() : "";
    if (!rawMessage) { res.status(400).json({ error: "Please describe the changes you'd like." }); return; }
    const message = rawMessage.slice(0, 2000);

    const now = new Date();
    const [updated] = await db
      .update(cateringInquiriesTable)
      .set({
        quoteChangeRequestAt: now,
        quoteChangeRequestMessage: message,
        updatedAt: now,
      })
      .where(eq(cateringInquiriesTable.id, inquiry.id))
      .returning();

    const adminLink = `${publicBaseUrl(req)}/admin/catering?inquiry=${updated.id}`;
    sendQuoteResponseAlert({
      kind: "change_request",
      clientName: updated.clientName,
      quoteNumber: updated.quoteNumber,
      message,
      link: adminLink,
    }).catch((err) => req.log.error({ err }, "Quote change-request email alert failed"));
    sendQuoteResponseSms({
      kind: "change_request",
      clientName: updated.clientName,
      quoteNumber: updated.quoteNumber,
      message,
      link: adminLink,
    }).catch((err) => req.log.error({ err }, "Quote change-request SMS alert failed"));

    res.json(publicQuoteFromInquiry(updated));
  } catch (err) {
    req.log.error({ err }, "Error submitting change request");
    res.status(500).json({ error: "Failed to submit change request" });
  }
});

export default router;
