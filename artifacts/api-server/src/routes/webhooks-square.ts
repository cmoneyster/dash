import { Router, type IRouter, type Request } from "express";
import { db } from "@workspace/db";
import {
  cateringInquiriesTable,
  cateringSupplementalInvoicesTable,
} from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import {
  getSquareConfig,
  getInvoiceSnapshot,
  verifyWebhookSignature,
} from "../lib/square";

const router: IRouter = Router();

type SquareWebhookPayload = {
  type?: string;
  event_id?: string;
  data?: {
    type?: string;
    id?: string;
    object?: {
      invoice?: {
        id?: string;
        status?: string;
      };
    };
  };
};

function notificationUrl(req: Request): string {
  const fwdProto = req.headers["x-forwarded-proto"];
  const proto = (Array.isArray(fwdProto) ? fwdProto[0] : fwdProto)?.split(",")[0]
    || req.protocol
    || "https";
  const host = req.get("host");
  return `${proto}://${host}${req.originalUrl}`;
}

router.post("/webhooks/square", async (req, res): Promise<void> => {
  // app.ts mounts express.raw on this exact path so req.body is a Buffer.
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  const sigHeader = req.header("x-square-hmacsha256-signature") || "";

  const cfg = getSquareConfig();
  if (!cfg?.webhookSignatureKey) {
    req.log.warn("Square webhook received but signature key not configured");
    res.status(503).json({ error: "Square webhooks not configured" });
    return;
  }
  if (!sigHeader) {
    res.status(400).json({ error: "Missing signature header" });
    return;
  }
  const ok = verifyWebhookSignature({
    signatureKey: cfg.webhookSignatureKey,
    notificationUrl: notificationUrl(req),
    rawBody: raw,
    signatureHeader: sigHeader,
  });
  if (!ok) {
    req.log.warn("Square webhook signature mismatch");
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  let payload: SquareWebhookPayload;
  try {
    payload = JSON.parse(raw) as SquareWebhookPayload;
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  const eventType = payload.type ?? "";
  if (!eventType.startsWith("invoice.")) {
    // Acknowledge other event types so Square doesn't keep retrying.
    res.json({ ok: true, ignored: true });
    return;
  }

  const invoiceId = payload.data?.object?.invoice?.id ?? payload.data?.id ?? null;
  if (!invoiceId) {
    res.status(400).json({ error: "Missing invoice id" });
    return;
  }

  // Look up the matching row. The invoice id may belong to either the
  // primary invoice (mirror cols on `catering_inquiries`) or to a
  // supplemental invoice (`catering_supplemental_invoices`). We check
  // both; if neither matches, ack & ignore (could be stale or unrelated
  // to this app).
  const [inquiry] = await db
    .select()
    .from(cateringInquiriesTable)
    .where(eq(cateringInquiriesTable.squareInvoiceId, invoiceId));
  const [supplemental] = inquiry
    ? [null]
    : await db
        .select()
        .from(cateringSupplementalInvoicesTable)
        .where(eq(cateringSupplementalInvoicesTable.squareInvoiceId, invoiceId));

  if (!inquiry && !supplemental) {
    res.json({ ok: true, ignored: true });
    return;
  }

  // Re-fetch the canonical snapshot from Square (don't trust the webhook body
  // for amount/version) and apply.
  let snap;
  try {
    snap = await getInvoiceSnapshot(invoiceId);
  } catch (err) {
    req.log.error({ err, invoiceId }, "Failed to fetch invoice snapshot from Square");
    res.status(502).json({ error: "Failed to fetch invoice from Square" });
    return;
  }

  const now = new Date();

  if (inquiry) {
    const updates: Record<string, unknown> = {
      squareInvoiceVersion: snap.invoiceVersion,
      squareInvoiceStatus: snap.status,
      squareHostedUrl: snap.hostedUrl,
      squareAmountPaid: snap.amountPaidDollars.toFixed(2),
      squareBalanceDue: snap.balanceDueDollars.toFixed(2),
      updatedAt: new Date(),
    };
    if (snap.status === "PARTIALLY_PAID" && !inquiry.squareDepositPaidAt) {
      updates.squareDepositPaidAt = now;
      if (inquiry.status !== "confirmed") updates.status = "confirmed";
    }
    if (snap.status === "PAID") {
      if (!inquiry.squareDepositPaidAt) updates.squareDepositPaidAt = now;
      if (!inquiry.squarePaidInFullAt) updates.squarePaidInFullAt = now;
      if (inquiry.status !== "confirmed" && inquiry.status !== "completed") {
        updates.status = "confirmed";
      }
    }
    await db
      .update(cateringInquiriesTable)
      .set(updates)
      .where(eq(cateringInquiriesTable.id, inquiry.id));
  } else if (supplemental) {
    // Supplementals have no deposit / inquiry-status side effects — they
    // are pure additional charges. Just mirror the Square fields and
    // stamp paid-in-full when it lands.
    const updates: Record<string, unknown> = {
      squareInvoiceVersion: snap.invoiceVersion,
      squareInvoiceStatus: snap.status,
      squareHostedUrl: snap.hostedUrl,
      squareAmountPaid: snap.amountPaidDollars.toFixed(2),
      squareBalanceDue: snap.balanceDueDollars.toFixed(2),
      updatedAt: new Date(),
    };
    if (snap.status === "PAID" && !supplemental.squarePaidInFullAt) {
      updates.squarePaidInFullAt = now;
    }
    await db
      .update(cateringSupplementalInvoicesTable)
      .set(updates)
      .where(eq(cateringSupplementalInvoicesTable.id, supplemental.id));
  }

  res.json({ ok: true });
});

export default router;
