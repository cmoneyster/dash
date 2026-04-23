import { Router, type IRouter, type Request } from "express";
import { db } from "@workspace/db";
import {
  cateringInquiriesTable,
  sharedPlansTable,
  planItemsTable,
  menuItemsTable,
} from "@workspace/db/schema";
import type {
  CateringInquiry,
  QuoteAdjustment,
  QuoteLineItem,
} from "@workspace/db/schema";
import { eq, desc, sql } from "drizzle-orm";
import { sendNewInquiryAlert } from "../lib/sms";
import { isEjoinConfigured, sendSmsViaEjoin } from "../lib/sms-ejoin";
import { sendMail } from "../lib/mail";
import { computeQuoteTotals, renderQuotePdf, fmtUSD } from "../lib/quote";
import { objectStorageClient } from "../lib/objectStorage";
import { randomUUID } from "crypto";

const router: IRouter = Router();

const VALID_STATUSES = ["inquiry", "quoted", "confirmed", "completed", "cancelled"];

type Body = Record<string, unknown>;

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : v == null ? undefined : String(v);
}

function publicBaseUrl(req: Request): string {
  const env = process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "");
  if (env) return env;
  const fwd = req.headers["x-forwarded-proto"];
  const proto = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0] || req.protocol || "https";
  const host = req.get("host");
  return `${proto}://${host}`;
}

function quoteViewUrl(req: Request, token: string): string {
  return `${publicBaseUrl(req)}/quote/${token}`;
}

function normalizeAdjustments(raw: unknown): QuoteAdjustment[] | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return [];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
    .map((a) => ({
      id: String(a.id ?? randomUUID()),
      label: String(a.label ?? "").slice(0, 80),
      kind: a.kind === "percent" ? "percent" : "fixed",
      amount: Number(a.amount) || 0,
    }));
}

function normalizeLineItems(raw: unknown): QuoteLineItem[] | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return [];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((li): li is Record<string, unknown> => !!li && typeof li === "object")
    .map((li) => ({
      id: String(li.id ?? randomUUID()),
      menuItemId: li.menuItemId == null ? null : Number(li.menuItemId) || null,
      name: String(li.name ?? "").slice(0, 200),
      quantity: Number(li.quantity) || 0,
      unitPrice: Number(li.unitPrice) || 0,
      notes: li.notes ? String(li.notes).slice(0, 500) : null,
    }));
}

function applyTotalsToUpdates(updates: Record<string, unknown>) {
  const totals = computeQuoteTotals(
    (updates.lineItems as QuoteLineItem[] | null | undefined) ?? null,
    (updates.fees as QuoteAdjustment[] | null | undefined) ?? null,
    (updates.discounts as QuoteAdjustment[] | null | undefined) ?? null,
  );
  updates.subtotal = totals.subtotal.toFixed(2);
  updates.feesTotal = totals.feesTotal.toFixed(2);
  updates.discountsTotal = totals.discountsTotal.toFixed(2);
  updates.total = totals.total.toFixed(2);
}

// ── Object-storage persistence for generated PDFs ─────────────────────────────
//
// PDFs are written to PRIVATE_OBJECT_DIR/quotes/quote-<id>-<token>.pdf so that
// regenerating the quote (which rotates `quoteToken`) leaves a fresh, signed
// download URL and effectively orphans any prior PDFs as a side effect of the
// token rotation.

function quoteObjectName(privateObjectDir: string, inquiry: { id: number; quoteToken: string }) {
  const dir = privateObjectDir.endsWith("/") ? privateObjectDir : `${privateObjectDir}/`;
  return `${dir}quotes/quote-${inquiry.id}-${inquiry.quoteToken}.pdf`;
}

function parseGsPath(fullPath: string): { bucketName: string; objectName: string } | null {
  if (!fullPath.startsWith("/")) return null;
  const parts = fullPath.slice(1).split("/");
  if (parts.length < 2) return null;
  return { bucketName: parts[0], objectName: parts.slice(1).join("/") };
}

async function persistQuotePdf(
  inquiry: { id: number; quoteToken: string },
  bytes: Buffer,
): Promise<string | null> {
  const dir = process.env.PRIVATE_OBJECT_DIR?.trim();
  if (!dir) return null;
  const fullPath = quoteObjectName(dir, inquiry);
  const parsed = parseGsPath(fullPath);
  if (!parsed) return null;
  const file = objectStorageClient.bucket(parsed.bucketName).file(parsed.objectName);
  await file.save(bytes, {
    contentType: "application/pdf",
    resumable: false,
    metadata: { contentType: "application/pdf" },
  });
  return fullPath;
}

async function getPersistedQuotePdf(
  inquiry: { id: number; quoteToken: string | null },
): Promise<Buffer | null> {
  const dir = process.env.PRIVATE_OBJECT_DIR?.trim();
  if (!dir || !inquiry.quoteToken) return null;
  const fullPath = quoteObjectName(dir, inquiry as { id: number; quoteToken: string });
  const parsed = parseGsPath(fullPath);
  if (!parsed) return null;
  try {
    const file = objectStorageClient.bucket(parsed.bucketName).file(parsed.objectName);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [buf] = await file.download();
    return buf;
  } catch {
    return null;
  }
}

async function signQuotePdfDownloadUrl(
  inquiry: { id: number; quoteToken: string },
): Promise<string | null> {
  const dir = process.env.PRIVATE_OBJECT_DIR?.trim();
  if (!dir) return null;
  const fullPath = quoteObjectName(dir, inquiry);
  const parsed = parseGsPath(fullPath);
  if (!parsed) return null;
  try {
    const file = objectStorageClient.bucket(parsed.bucketName).file(parsed.objectName);
    const [url] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + 1000 * 60 * 60, // 1h
      responseDisposition: `attachment; filename="quote-${inquiry.id}.pdf"`,
    });
    return url;
  } catch {
    return null;
  }
}

// ── List + read ───────────────────────────────────────────────────────────────

router.get("/admin/catering", async (req, res) => {
  try {
    const inquiries = await db
      .select()
      .from(cateringInquiriesTable)
      .orderBy(desc(cateringInquiriesTable.createdAt));
    res.json(inquiries);
  } catch (err) {
    req.log.error({ err }, "Error listing catering inquiries");
    res.status(500).json({ error: "Failed to fetch inquiries" });
  }
});

router.get("/admin/catering/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [inquiry] = await db.select().from(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, id));
    if (!inquiry) return res.status(404).json({ error: "Inquiry not found" });
    res.json(inquiry);
  } catch (err) {
    req.log.error({ err }, "Error fetching catering inquiry");
    res.status(500).json({ error: "Failed to fetch inquiry" });
  }
});

// ── Create ────────────────────────────────────────────────────────────────────

router.post("/admin/catering", async (req, res) => {
  try {
    const body = req.body as Body;
    const clientName = asString(body.clientName)?.trim();
    if (!clientName) {
      res.status(400).json({ error: "Client name is required" });
      return;
    }

    const insertVals: Record<string, unknown> = {
      clientName,
      clientEmail: asString(body.clientEmail)?.trim() || null,
      clientPhone: asString(body.clientPhone)?.trim() || null,
      organization: asString(body.organization)?.trim() || null,
      eventDate: asString(body.eventDate)?.trim() || null,
      guestCount: body.guestCount ?? null,
      venueAddress: asString(body.venueAddress)?.trim() || null,
      menuNotes: asString(body.menuNotes)?.trim() || null,
      adminNotes: asString(body.adminNotes)?.trim() || null,
      status: VALID_STATUSES.includes(asString(body.status) ?? "") ? asString(body.status)! : "inquiry",
      source: "form",
      lineItems: normalizeLineItems(body.lineItems) ?? [],
      fees: normalizeAdjustments(body.fees) ?? [],
      discounts: normalizeAdjustments(body.discounts) ?? [],
      quoteNotes: asString(body.quoteNotes)?.trim() || null,
      quoteExpiresAt: body.quoteExpiresAt ? new Date(asString(body.quoteExpiresAt)!) : null,
    };
    applyTotalsToUpdates(insertVals);

    const [inquiry] = await db.insert(cateringInquiriesTable).values(insertVals).returning();

    sendNewInquiryAlert({
      clientName,
      source: "form",
      eventDate: asString(body.eventDate)?.trim() || null,
      guestCount: typeof body.guestCount === "number" ? body.guestCount : null,
      total: inquiry.quoteTotal ? `$${Number(inquiry.quoteTotal).toFixed(2)}` : null,
      clientPhone: asString(body.clientPhone)?.trim() || null,
      link: `${publicBaseUrl(req)}/admin/catering?inquiry=${inquiry.id}`,
    }).catch(() => {});

    res.status(201).json(inquiry);
  } catch (err) {
    req.log.error({ err }, "Error creating catering inquiry");
    res.status(500).json({ error: "Failed to create inquiry" });
  }
});

// ── Update ────────────────────────────────────────────────────────────────────

router.put("/admin/catering/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const body = req.body as Body;

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.clientName !== undefined) updates.clientName = String(body.clientName).trim();
    if (body.clientEmail !== undefined) updates.clientEmail = String(body.clientEmail ?? "").trim() || null;
    if (body.clientPhone !== undefined) updates.clientPhone = String(body.clientPhone ?? "").trim() || null;
    if (body.organization !== undefined) updates.organization = String(body.organization ?? "").trim() || null;
    if (body.eventDate !== undefined) updates.eventDate = String(body.eventDate ?? "").trim() || null;
    if (body.guestCount !== undefined)
      updates.guestCount = body.guestCount === "" || body.guestCount === null ? null : parseInt(String(body.guestCount));
    if (body.venueAddress !== undefined) updates.venueAddress = String(body.venueAddress ?? "").trim() || null;
    if (body.menuNotes !== undefined) updates.menuNotes = String(body.menuNotes ?? "").trim() || null;
    if (body.adminNotes !== undefined) updates.adminNotes = String(body.adminNotes ?? "").trim() || null;
    if (body.status !== undefined && VALID_STATUSES.includes(String(body.status))) updates.status = body.status;
    if (body.quoteNotes !== undefined) updates.quoteNotes = String(body.quoteNotes ?? "").trim() || null;
    if (body.quoteExpiresAt !== undefined)
      updates.quoteExpiresAt = body.quoteExpiresAt ? new Date(String(body.quoteExpiresAt)) : null;

    const lineItems = normalizeLineItems(body.lineItems);
    const fees = normalizeAdjustments(body.fees);
    const discounts = normalizeAdjustments(body.discounts);
    if (lineItems !== undefined || fees !== undefined || discounts !== undefined) {
      const [current] = await db.select().from(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, id));
      if (!current) return res.status(404).json({ error: "Inquiry not found" });
      updates.lineItems = lineItems ?? current.lineItems ?? [];
      updates.fees = fees ?? current.fees ?? [];
      updates.discounts = discounts ?? current.discounts ?? [];
      applyTotalsToUpdates(updates);
    }

    const [updated] = await db
      .update(cateringInquiriesTable)
      .set(updates)
      .where(eq(cateringInquiriesTable.id, id))
      .returning();

    if (!updated) return res.status(404).json({ error: "Inquiry not found" });
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Error updating catering inquiry");
    res.status(500).json({ error: "Failed to update inquiry" });
  }
});

// ── Delete ────────────────────────────────────────────────────────────────────

router.delete("/admin/catering/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [deleted] = await db.delete(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, id)).returning();
    if (!deleted) return res.status(404).json({ error: "Inquiry not found" });
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Error deleting catering inquiry");
    res.status(500).json({ error: "Failed to delete inquiry" });
  }
});

// ── Quote: generate ───────────────────────────────────────────────────────────

async function generateQuoteNumber(): Promise<string> {
  const now = new Date();
  const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [{ n }] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(cateringInquiriesTable)
    .where(sql`${cateringInquiriesTable.quoteNumber} LIKE ${`Q-${yyyymm}-%`}`);
  const seq = (Number(n) || 0) + 1;
  return `Q-${yyyymm}-${String(seq).padStart(4, "0")}`;
}

router.post("/admin/catering/:id/quote", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [current] = await db.select().from(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, id));
    if (!current) return res.status(404).json({ error: "Inquiry not found" });

    // Always rotate the public token on (re)generation so any previously-shared
    // links are invalidated.
    const newToken = randomUUID();
    const updates: Record<string, unknown> = {
      updatedAt: new Date(),
      quoteIssuedAt: new Date(),
      quoteToken: newToken,
    };
    if (!current.quoteNumber) updates.quoteNumber = await generateQuoteNumber();
    if (current.status === "inquiry") updates.status = "quoted";

    const [updated] = await db
      .update(cateringInquiriesTable)
      .set(updates)
      .where(eq(cateringInquiriesTable.id, id))
      .returning();

    // Render and persist a PDF copy keyed by the rotated token.
    let downloadUrl: string | null = null;
    try {
      const pdf = await renderQuotePdf(updated as CateringInquiry);
      await persistQuotePdf({ id: updated.id, quoteToken: newToken }, pdf);
      downloadUrl = await signQuotePdfDownloadUrl({ id: updated.id, quoteToken: newToken });
    } catch (storageErr) {
      req.log.warn({ err: storageErr }, "Quote PDF persistence failed; live render still available");
    }

    res.json({
      inquiry: updated,
      viewUrl: quoteViewUrl(req, newToken),
      downloadUrl,
    });
  } catch (err) {
    req.log.error({ err }, "Error generating quote");
    res.status(500).json({ error: "Failed to generate quote" });
  }
});

// ── Quote: PDF (admin) — prefer persisted, fallback to live render ────────────

router.get("/admin/catering/:id/quote.pdf", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [inquiry] = await db.select().from(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, id));
    if (!inquiry) return res.status(404).json({ error: "Inquiry not found" });
    const persisted = await getPersistedQuotePdf(inquiry);
    const pdf = persisted ?? (await renderQuotePdf(inquiry));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${inquiry.quoteNumber ?? `quote-${id}`}.pdf"`);
    res.send(pdf);
  } catch (err) {
    req.log.error({ err }, "Error rendering quote PDF");
    res.status(500).json({ error: "Failed to render PDF" });
  }
});

// ── Quote: send by email ──────────────────────────────────────────────────────

router.post("/admin/catering/:id/quote/email", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [inquiry] = await db.select().from(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, id));
    if (!inquiry) return res.status(404).json({ error: "Inquiry not found" });

    const body = (req.body ?? {}) as Body;
    const to = asString(body.to)?.trim() || inquiry.clientEmail?.trim();
    if (!to) return res.status(400).json({ error: "No client email on file" });
    if (!inquiry.quoteToken || !inquiry.quoteIssuedAt) {
      return res.status(400).json({ error: "Generate the quote first" });
    }

    let pdf = await getPersistedQuotePdf(inquiry);
    if (!pdf) {
      pdf = await renderQuotePdf(inquiry);
      await persistQuotePdf({ id: inquiry.id, quoteToken: inquiry.quoteToken }, pdf).catch(() => {});
    }
    const link = quoteViewUrl(req, inquiry.quoteToken);
    const totals = computeQuoteTotals(inquiry.lineItems, inquiry.fees, inquiry.discounts);
    const subject = `Your catering quote ${inquiry.quoteNumber ?? ""} from Hollywood East Cafe`.trim();
    const text = [
      `Hi ${inquiry.clientName},`,
      ``,
      `Attached is your catering quote (${inquiry.quoteNumber ?? "draft"}) for a total of ${fmtUSD(totals.total)}.`,
      ``,
      `You can also view it online: ${link}`,
      ``,
      `Reply to this email with any questions or to confirm.`,
      ``,
      `— Hollywood East Cafe`,
    ].join("\n");
    const html = `
      <p>Hi ${inquiry.clientName},</p>
      <p>Attached is your catering quote <strong>${inquiry.quoteNumber ?? "(draft)"}</strong>
         for a total of <strong>${fmtUSD(totals.total)}</strong>.</p>
      <p><a href="${link}">View this quote online</a></p>
      <p>Reply to this email with any questions or to confirm.</p>
      <p>— Hollywood East Cafe</p>
    `;

    const result = await sendMail({
      to,
      subject,
      text,
      html,
      attachments: [{
        filename: `${inquiry.quoteNumber ?? `quote-${id}`}.pdf`,
        content: pdf,
        contentType: "application/pdf",
      }],
    });
    if (!result.ok) return res.status(502).json({ error: result.error ?? "Failed to send email" });

    const [updated] = await db
      .update(cateringInquiriesTable)
      .set({ quoteLastEmailedAt: new Date(), updatedAt: new Date() })
      .where(eq(cateringInquiriesTable.id, id))
      .returning();
    res.json({ ok: true, inquiry: updated, sentTo: to });
  } catch (err) {
    req.log.error({ err }, "Error emailing quote");
    res.status(500).json({ error: "Failed to email quote" });
  }
});

// ── Quote: send by SMS ────────────────────────────────────────────────────────

router.post("/admin/catering/:id/quote/sms", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [inquiry] = await db.select().from(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, id));
    if (!inquiry) return res.status(404).json({ error: "Inquiry not found" });

    const body = (req.body ?? {}) as Body;
    const to = asString(body.to)?.trim() || inquiry.clientPhone?.trim();
    if (!to) return res.status(400).json({ error: "No client phone on file" });
    if (!inquiry.quoteToken || !inquiry.quoteIssuedAt) {
      return res.status(400).json({ error: "Generate the quote first" });
    }

    const link = quoteViewUrl(req, inquiry.quoteToken);
    const totals = computeQuoteTotals(inquiry.lineItems, inquiry.fees, inquiry.discounts);
    const smsBody =
      `Hi ${inquiry.clientName.split(" ")[0]}! Your catering quote ${inquiry.quoteNumber ?? ""} ` +
      `(${fmtUSD(totals.total)}) from Hollywood East Cafe is ready: ${link}`;

    if (!isEjoinConfigured()) {
      return res.status(502).json({ error: "SMS gateway not configured" });
    }
    try {
      // Bypass the fire-and-forget sendSms wrapper so we only stamp the
      // last-texted timestamp on a confirmed gateway success.
      await sendSmsViaEjoin(to, smsBody);
    } catch (sendErr) {
      req.log.error({ err: sendErr }, "Quote SMS gateway send failed");
      return res.status(502).json({ error: "Failed to send SMS via gateway" });
    }

    const [updated] = await db
      .update(cateringInquiriesTable)
      .set({ quoteLastTextedAt: new Date(), updatedAt: new Date() })
      .where(eq(cateringInquiriesTable.id, id))
      .returning();
    res.json({ ok: true, inquiry: updated, sentTo: to });
  } catch (err) {
    req.log.error({ err }, "Error texting quote");
    res.status(500).json({ error: "Failed to text quote" });
  }
});

// ── Convert a shared plan into an inquiry ─────────────────────────────────────

type PlannerStateShape = {
  guests?: number | string;
  piecesMap?: Record<string, number>;
  panQtys?: Record<string, Record<string, number>>;
};

router.post("/admin/catering/from-plan/:token", async (req, res) => {
  try {
    const token = req.params.token;
    const [plan] = await db
      .select()
      .from(sharedPlansTable)
      .where(eq(sharedPlansTable.shareToken, token));
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    const itemRows = await db
      .select()
      .from(planItemsTable)
      .innerJoin(menuItemsTable, eq(planItemsTable.menuItemId, menuItemsTable.id))
      .where(eq(planItemsTable.sessionId, plan.sessionId));

    const ps = (plan.plannerState ?? {}) as PlannerStateShape;
    const piecesMap: Record<string, number> = ps.piecesMap ?? {};
    const panQtys: Record<string, Record<string, number>> = ps.panQtys ?? {};
    const guestCount: number | null =
      typeof ps.guests === "number" ? ps.guests : ps.guests ? parseInt(String(ps.guests)) : null;

    const lineItems: QuoteLineItem[] = [];
    for (const row of itemRows) {
      const mi = row.menu_items;
      const planItemId = String(row.plan_items.id);
      if (mi.pricingTemplate === "pan_sizes") {
        const slots = panQtys[planItemId] ?? {};
        const sizeMeta = [
          { idx: 1, label: mi.size1Label, price: mi.size1Price },
          { idx: 2, label: mi.size2Label, price: mi.size2Price },
          { idx: 3, label: mi.size3Label, price: mi.size3Price },
          { idx: 4, label: mi.size4Label, price: mi.size4Price },
          { idx: 5, label: mi.size5Label, price: mi.size5Price },
        ];
        for (const s of sizeMeta) {
          const qty = Number(slots[String(s.idx)] ?? 0);
          if (qty > 0 && s.label && s.price != null) {
            lineItems.push({
              id: randomUUID(),
              menuItemId: mi.id,
              name: `${mi.name} — ${s.label}`,
              quantity: qty,
              unitPrice: parseFloat(s.price),
              notes: null,
            });
          }
        }
      } else {
        const qty = Number(piecesMap[planItemId] ?? 0);
        if (qty > 0) {
          lineItems.push({
            id: randomUUID(),
            menuItemId: mi.id,
            name: mi.name,
            quantity: qty,
            unitPrice: parseFloat(mi.price),
            notes: null,
          });
        }
      }
    }

    const insertVals: Record<string, unknown> = {
      clientName: plan.planName?.trim() || "Plan import",
      organization: null,
      guestCount,
      menuNotes: `Imported from shared plan${plan.planNumber ? ` #${plan.planNumber}` : ""}.`,
      status: "inquiry",
      source: "form",
      lineItems,
      fees: [],
      discounts: [],
    };
    applyTotalsToUpdates(insertVals);

    const [created] = await db.insert(cateringInquiriesTable).values(insertVals).returning();
    res.status(201).json(created);
  } catch (err) {
    req.log.error({ err }, "Error converting plan to inquiry");
    res.status(500).json({ error: "Failed to convert plan" });
  }
});

export default router;
