import { Router, type IRouter, type Request } from "express";
import { db } from "@workspace/db";
import {
  cateringInquiriesTable,
  cateringSupplementalInvoicesTable,
  sharedPlansTable,
  planItemsTable,
  menuItemsTable,
  eventSettingsTable,
} from "@workspace/db/schema";
import type {
  CateringInquiry,
  CateringSupplementalInvoice,
  QuoteAdjustment,
  QuoteLineItem,
  QuoteReply,
  SupplementalLinesSnapshot,
} from "@workspace/db/schema";
import { and, eq, desc, ne, sql, inArray } from "drizzle-orm";
import {
  computeOtdSetupFeeRow,
  otdSetupFeeRowEquals,
  OTD_SETUP_FEE_ID,
  computeUninvoicedDelta,
} from "@workspace/pricing";
import { sendNewInquiryAlert } from "../lib/sms";
import { isEjoinConfigured, sendSmsViaEjoin } from "../lib/sms-ejoin";
import { sendMail } from "../lib/mail";
import { computeQuoteTotals, renderQuotePdf, fmtUSD } from "../lib/quote";
import { TAX_DISCLOSURE } from "../lib/tax";
import {
  PAYMENT_TERMS_TITLE,
  PAYMENT_TERMS_BULLETS,
} from "../lib/quote-copy";
import { objectStorageClient } from "../lib/objectStorage";
import {
  isSquareConfigured,
  createAndPublishInvoiceForInquiry,
  createAndPublishSupplementalInvoice,
  cancelInvoice,
  getInvoiceSnapshot,
  SquareApiError,
  type DepositSpec,
} from "../lib/square";
import { randomUUID } from "crypto";

// Supplemental statuses that block primary-invoice cancellation. Two
// groups:
//   1) Live Square statuses where the customer can still be charged:
//      DRAFT / UNPAID / SCHEDULED / PARTIALLY_PAID.
//   2) In-product transient/recovery states for the two-phase issuance:
//      - PENDING:             phase-1 reservation; phase-2 publish may
//                             still land a live Square invoice. Blocking
//                             primary cancel here closes the race where
//                             cancel slips between reservation and publish.
//      - AWAITING_RECONCILE:  phase-2 published to Square but the finalize
//                             txn failed mid-flight. The Square invoice
//                             is live; the row holds its IDs but the
//                             primary snapshot was not rolled forward.
//                             Admin must reconcile (refresh/cancel)
//                             before primary cancel is safe.
// Terminal statuses (PAID / REFUNDED / CANCELED / FAILED) do NOT block.
const OPEN_SUPP_STATUSES = new Set([
  "DRAFT", "UNPAID", "SCHEDULED", "PARTIALLY_PAID",
  "PENDING", "AWAITING_RECONCILE",
]);

function isOpenSupplemental(s: CateringSupplementalInvoice): boolean {
  return OPEN_SUPP_STATUSES.has((s.squareInvoiceStatus ?? "").toUpperCase());
}

// Embed supplementals on inquiry GET responses so the admin UI can render
// the supplemental sub-panel (delta preview, list, cancel guard) without
// an extra round-trip per inquiry.
async function loadSupplementalsByInquiryIds(
  inquiryIds: number[],
): Promise<Map<number, CateringSupplementalInvoice[]>> {
  const map = new Map<number, CateringSupplementalInvoice[]>();
  if (inquiryIds.length === 0) return map;
  const rows = await db
    .select()
    .from(cateringSupplementalInvoicesTable)
    .where(inArray(cateringSupplementalInvoicesTable.cateringInquiryId, inquiryIds))
    .orderBy(cateringSupplementalInvoicesTable.cateringInquiryId, cateringSupplementalInvoicesTable.seq);
  for (const r of rows) {
    const arr = map.get(r.cateringInquiryId) ?? [];
    arr.push(r);
    map.set(r.cateringInquiryId, arr);
  }
  return map;
}

const router: IRouter = Router();

const VALID_STATUSES = ["inquiry", "quoted", "confirmed", "completed", "cancelled"];

// Hard fallbacks if the event_settings row is somehow missing — keeps the
// admin OTD switch functional even on a fresh database. Mirror orders.ts
// and the schema defaults.
const OTD_DEFAULTS = {
  setupFee: 500,
  feeWaiverThreshold: 2000,
  includedHours: 2,
  additionalHourRate: 100,
  maxAdditionalHours: 3,
};

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
    .map((li) => {
      const tmpl = li.pricingTemplate;
      const pricingTemplate: "per_unit" | "pan_sizes" | null =
        tmpl === "pan_sizes" ? "pan_sizes" : tmpl === "per_unit" ? "per_unit" : null;
      const sizeSlotN = li.sizeSlot == null ? null : Number(li.sizeSlot);
      const sizeSlot = sizeSlotN != null && sizeSlotN >= 1 && sizeSlotN <= 5 ? Math.floor(sizeSlotN) : null;
      const sizeServingsN = li.sizeServings == null ? null : Number(li.sizeServings);
      const servingSizeN = li.servingSize == null ? null : Number(li.servingSize);
      const safeNum = (v: unknown, max: number) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) return 0;
        return Math.min(n, max);
      };
      const safeIntOrNull = (n: number | null, max: number) => {
        if (n == null || !Number.isFinite(n) || n < 0) return null;
        return Math.min(Math.floor(n), max);
      };
      return {
        id: String(li.id ?? randomUUID()),
        menuItemId: li.menuItemId == null ? null : Number(li.menuItemId) || null,
        name: String(li.name ?? "").slice(0, 200),
        quantity: safeNum(li.quantity, 1_000_000),
        unitPrice: safeNum(li.unitPrice, 1_000_000),
        notes: li.notes ? String(li.notes).slice(0, 500) : null,
        pricingTemplate,
        sizeSlot,
        sizeLabel: li.sizeLabel ? String(li.sizeLabel).slice(0, 60) : null,
        sizeServings: safeIntOrNull(sizeServingsN, 100_000),
        unit: li.unit ? String(li.unit).slice(0, 30) : null,
        servingSize: safeIntOrNull(servingSizeN, 100_000),
        tierApplied: li.tierApplied === true,
        priceMode: li.priceMode === "manual" ? "manual" : "auto",
      };
    });
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
    const suppMap = await loadSupplementalsByInquiryIds(inquiries.map(i => i.id));
    res.json(inquiries.map(i => ({ ...i, supplementals: suppMap.get(i.id) ?? [] })));
  } catch (err) {
    req.log.error({ err }, "Error listing catering inquiries");
    res.status(500).json({ error: "Failed to fetch inquiries" });
  }
});

router.get("/admin/catering/:id", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    const [inquiry] = await db.select().from(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, id));
    if (!inquiry) {
      res.status(404).json({ error: "Inquiry not found" });
      return;
    }
    const suppMap = await loadSupplementalsByInquiryIds([id]);
    res.json({ ...inquiry, supplementals: suppMap.get(id) ?? [] });
  } catch (err) {
    req.log.error({ err }, "Error fetching catering inquiry");
    res.status(500).json({ error: "Failed to fetch inquiry" });
  }
});

// ── Create ────────────────────────────────────────────────────────────────────

router.post("/admin/catering", async (req, res): Promise<void> => {
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

    const [inquiry] = await db.insert(cateringInquiriesTable).values(insertVals as typeof cateringInquiriesTable.$inferInsert).returning();

    sendNewInquiryAlert({
      clientName,
      source: "form",
      eventDate: asString(body.eventDate)?.trim() || null,
      guestCount: typeof body.guestCount === "number" ? body.guestCount : null,
      total: inquiry.total ? `$${Number(inquiry.total).toFixed(2)}` : null,
      clientPhone: asString(body.clientPhone)?.trim() || null,
      // Use the persisted (normalized) value so the alert mirrors what the
      // admin will see on the inquiry record itself.
      venueAddress: inquiry.venueAddress,
      link: `${publicBaseUrl(req)}/admin/catering?inquiry=${inquiry.id}`,
    }).catch(() => {});

    res.status(201).json(inquiry);
  } catch (err) {
    req.log.error({ err }, "Error creating catering inquiry");
    res.status(500).json({ error: "Failed to create inquiry" });
  }
});

// ── Update ────────────────────────────────────────────────────────────────────

router.put("/admin/catering/:id", async (req, res): Promise<void> => {
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

    // Validate serviceMode up-front so we never partially apply OTD changes.
    let nextServiceMode: "drop_off" | "on_the_dash" | undefined;
    if (body.serviceMode !== undefined) {
      const sm = body.serviceMode;
      if (sm !== "drop_off" && sm !== "on_the_dash") {
        res.status(400).json({ error: "serviceMode must be 'drop_off' or 'on_the_dash'" });
        return;
      }
      nextServiceMode = sm;
    }

    const lineItems = normalizeLineItems(body.lineItems);
    const fees = normalizeAdjustments(body.fees);
    const discounts = normalizeAdjustments(body.discounts);

    // Fetch current row whenever we need to diff against it (totals
    // recompute, service-mode transition, or audit notes).
    let current: typeof cateringInquiriesTable.$inferSelect | undefined;
    if (
      lineItems !== undefined ||
      fees !== undefined ||
      discounts !== undefined ||
      nextServiceMode !== undefined
    ) {
      [current] = await db.select().from(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, id));
      if (!current) {
        res.status(404).json({ error: "Inquiry not found" });
        return;
      }
    }

    if (lineItems !== undefined || fees !== undefined || discounts !== undefined) {
      updates.lineItems = lineItems ?? current!.lineItems ?? [];
      updates.fees = fees ?? current!.fees ?? [];
      updates.discounts = discounts ?? current!.discounts ?? [];
      applyTotalsToUpdates(updates);
    }

    // Service-mode toggle: re-snapshot live OTD pricing config from
    // event_settings when switching to OTD; clear the snapshot when
    // switching back to Drop-Off. Mirrors the snapshot logic in
    // routes/orders.ts so admin-driven mode flips behave like a
    // re-submission for pricing-config purposes.
    if (nextServiceMode !== undefined && current && nextServiceMode !== current.serviceMode) {
      updates.serviceMode = nextServiceMode;
      if (nextServiceMode === "on_the_dash") {
        const [eventSettings] = await db
          .select()
          .from(eventSettingsTable)
          .where(eq(eventSettingsTable.id, 1));
        const cfg = {
          setupFee: eventSettings?.otdSetupFee != null
            ? parseFloat(eventSettings.otdSetupFee)
            : OTD_DEFAULTS.setupFee,
          feeWaiverThreshold: eventSettings?.otdFeeWaiverThreshold != null
            ? parseFloat(eventSettings.otdFeeWaiverThreshold)
            : OTD_DEFAULTS.feeWaiverThreshold,
          includedHours: eventSettings?.otdIncludedHours != null
            ? parseFloat(eventSettings.otdIncludedHours)
            : OTD_DEFAULTS.includedHours,
          additionalHourRate: eventSettings?.otdAdditionalHourRate != null
            ? parseFloat(eventSettings.otdAdditionalHourRate)
            : OTD_DEFAULTS.additionalHourRate,
          maxAdditionalHours: eventSettings?.otdMaxAdditionalHours ?? OTD_DEFAULTS.maxAdditionalHours,
        };
        updates.otdSetupFee = cfg.setupFee.toFixed(2);
        updates.otdFeeWaiverThreshold = cfg.feeWaiverThreshold.toFixed(2);
        updates.otdIncludedHours = cfg.includedHours.toFixed(2);
        updates.otdAdditionalHourRate = cfg.additionalHourRate.toFixed(2);
        updates.otdMaxAdditionalHours = cfg.maxAdditionalHours;

        // Synthesize the OTD setup-fee row so a programmatic mode flip
        // (without re-opening the editor — e.g. via API or a future
        // bulk action) still produces a fee array that bills the setup
        // fee. Delegates to the shared synthesizer in `@workspace/pricing`
        // so the stable id, label, and waiver logic stay aligned with
        // the admin Quote Builder UI and the cart-as-OTD seed path.
        const baseFees = (updates.fees as QuoteAdjustment[] | undefined) ?? current.fees ?? [];
        const baseSubtotalNum = updates.subtotal != null
          ? parseFloat(updates.subtotal as string)
          : (current.subtotal != null ? parseFloat(current.subtotal) : 0);
        const subtotalForWaiver = Number.isFinite(baseSubtotalNum) ? baseSubtotalNum : 0;
        const desiredRow = computeOtdSetupFeeRow(
          "on_the_dash",
          cfg.setupFee,
          cfg.feeWaiverThreshold,
          subtotalForWaiver,
        );
        const existingRowRaw = baseFees.find((f) => f.id === OTD_SETUP_FEE_ID) ?? null;
        const existingRow = existingRowRaw
          ? { ...existingRowRaw, amount: Number(existingRowRaw.amount) }
          : null;
        // Skip the write-back when the row is already in its desired
        // shape, to avoid pointless totals churn on no-op re-saves.
        if (!otdSetupFeeRowEquals(desiredRow, existingRow)) {
          const otherFees = baseFees.filter((f) => f.id !== OTD_SETUP_FEE_ID);
          updates.fees = desiredRow ? [...otherFees, desiredRow] : otherFees;
          applyTotalsToUpdates(updates);
        }
      } else {
        updates.otdSetupFee = null;
        updates.otdFeeWaiverThreshold = null;
        updates.otdIncludedHours = null;
        updates.otdAdditionalHourRate = null;
        updates.otdMaxAdditionalHours = null;
        // Strip both synthesized OTD fee rows (extra-hours upcharge +
        // on-site setup fee) so neither carries over as a hidden
        // upcharge after switching to Drop-Off. Mirrors the
        // QuoteEditor's stable ids so this stays in sync.
        const baseFees = (updates.fees as QuoteAdjustment[] | undefined) ?? current.fees ?? [];
        const cleanedFees = baseFees.filter(
          (f) => f.id !== "otd-extra-hours" && f.id !== "otd-setup-fee",
        );
        if (cleanedFees.length !== baseFees.length) {
          updates.fees = cleanedFees;
          applyTotalsToUpdates(updates);
        }
      }

      // Audit trail: append a single line to admin notes recording the
      // switch and when it happened. We use the version of admin notes
      // already queued in this request (if the client also edited them)
      // so we don't clobber a concurrent note edit.
      const ts = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
      const fromLabel = current.serviceMode === "on_the_dash" ? "On the Dash" : "Drop-Off";
      const toLabel = nextServiceMode === "on_the_dash" ? "On the Dash" : "Drop-Off";
      const auditLine = `[${ts}] Service mode switched: ${fromLabel} → ${toLabel}`;
      const baseNotes =
        updates.adminNotes !== undefined
          ? (updates.adminNotes as string | null)
          : current.adminNotes;
      updates.adminNotes = baseNotes ? `${baseNotes}\n${auditLine}` : auditLine;
    }

    const [updated] = await db
      .update(cateringInquiriesTable)
      .set(updates)
      .where(eq(cateringInquiriesTable.id, id))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Inquiry not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Error updating catering inquiry");
    res.status(500).json({ error: "Failed to update inquiry" });
  }
});

// ── Delete ────────────────────────────────────────────────────────────────────

router.delete("/admin/catering/:id", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    const [deleted] = await db.delete(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, id)).returning();
    if (!deleted) {
      res.status(404).json({ error: "Inquiry not found" });
      return;
    }
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

router.post("/admin/catering/:id/quote", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    const [current] = await db.select().from(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, id));
    if (!current) {
      res.status(404).json({ error: "Inquiry not found" });
      return;
    }

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

router.get("/admin/catering/:id/quote.pdf", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    const [inquiry] = await db.select().from(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, id));
    if (!inquiry) {
      res.status(404).json({ error: "Inquiry not found" });
      return;
    }
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

router.post("/admin/catering/:id/quote/email", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    const [inquiry] = await db.select().from(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, id));
    if (!inquiry) {
      res.status(404).json({ error: "Inquiry not found" });
      return;
    }

    const body = (req.body ?? {}) as Body;
    const to = asString(body.to)?.trim() || inquiry.clientEmail?.trim();
    if (!to) {
      res.status(400).json({ error: "No client email on file" });
      return;
    }
    if (!inquiry.quoteToken || !inquiry.quoteIssuedAt) {
      res.status(400).json({ error: "Generate the quote first" });
      return;
    }

    let pdf = await getPersistedQuotePdf(inquiry);
    if (!pdf) {
      pdf = await renderQuotePdf(inquiry);
      await persistQuotePdf({ id: inquiry.id, quoteToken: inquiry.quoteToken }, pdf).catch(() => {});
    }
    const link = quoteViewUrl(req, inquiry.quoteToken);
    const totals = computeQuoteTotals(inquiry.lineItems, inquiry.fees, inquiry.discounts);
    const payUrl = inquiry.squareHostedUrl ?? null;
    const payLabel = inquiry.squarePaidInFullAt
      ? null
      : inquiry.squareDepositPaidAt
        ? "Pay your remaining balance"
        : "Pay your invoice";
    const subject = `Your catering quote ${inquiry.quoteNumber ?? ""} from Hollywood East Cafe`.trim();
    // Event-detail line for the email body (the recipient already knows their
    // own email/phone, but they need the event date and venue to confirm).
    const eventDetailParts: string[] = [];
    if (inquiry.eventDate?.trim()) eventDetailParts.push(`Event date: ${inquiry.eventDate.trim()}`);
    if (inquiry.venueAddress?.trim()) eventDetailParts.push(`Venue: ${inquiry.venueAddress.trim()}`);
    if (inquiry.guestCount) eventDetailParts.push(`Guests: ${inquiry.guestCount}`);
    const text = [
      `Hi ${inquiry.clientName},`,
      ``,
      `Attached is your catering quote (${inquiry.quoteNumber ?? "draft"}) for a total of ${fmtUSD(totals.total)}.`,
      TAX_DISCLOSURE,
      ...(eventDetailParts.length ? [``, ...eventDetailParts] : []),
      ``,
      `You can also view it online: ${link}`,
      ...(payUrl && payLabel ? [``, `${payLabel} securely with Square: ${payUrl}`] : []),
      ``,
      PAYMENT_TERMS_TITLE,
      ...PAYMENT_TERMS_BULLETS.map((b) => `• ${b}`),
      ``,
      `Reply to this email with any questions or to confirm.`,
      ``,
      `— Hollywood East Cafe`,
    ].join("\n");
    const escapeHtml = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const eventDetailsHtml = eventDetailParts.length
      ? `<p style="margin:12px 0;color:#444;font-size:14px">${eventDetailParts
          .map((p) => escapeHtml(p))
          .join("<br/>")}</p>`
      : "";
    const html = `
      <p>Hi ${escapeHtml(inquiry.clientName)},</p>
      <p>Attached is your catering quote <strong>${escapeHtml(inquiry.quoteNumber ?? "(draft)")}</strong>
         for a total of <strong>${fmtUSD(totals.total)}</strong>.<br/>
         <span style="color:#888;font-size:12px">${TAX_DISCLOSURE}</span></p>
      ${eventDetailsHtml}
      <p><a href="${link}">View this quote online</a></p>
      ${payUrl && payLabel
        ? `<p><a href="${payUrl}" style="display:inline-block;padding:10px 18px;background:#7c3aed;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(payLabel)}</a></p>`
        : ""}
      <p style="margin-top:18px"><strong>${PAYMENT_TERMS_TITLE}</strong></p>
      <ul style="margin:6px 0 0 0;padding-left:20px;color:#222;font-size:14px;line-height:1.5">
        ${PAYMENT_TERMS_BULLETS.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}
      </ul>
      <p style="margin-top:18px">Reply to this email with any questions or to confirm.</p>
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
    if (!result.ok) {
      res.status(502).json({ error: result.error ?? "Failed to send email" });
      return;
    }

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

router.post("/admin/catering/:id/quote/sms", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    const [inquiry] = await db.select().from(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, id));
    if (!inquiry) {
      res.status(404).json({ error: "Inquiry not found" });
      return;
    }

    const body = (req.body ?? {}) as Body;
    const to = asString(body.to)?.trim() || inquiry.clientPhone?.trim();
    if (!to) {
      res.status(400).json({ error: "No client phone on file" });
      return;
    }
    if (!inquiry.quoteToken || !inquiry.quoteIssuedAt) {
      res.status(400).json({ error: "Generate the quote first" });
      return;
    }

    const link = quoteViewUrl(req, inquiry.quoteToken);
    const totals = computeQuoteTotals(inquiry.lineItems, inquiry.fees, inquiry.discounts);
    const payUrl = inquiry.squareHostedUrl ?? null;
    const smsBody =
      `Hi ${inquiry.clientName.split(" ")[0]}! Your catering quote ${inquiry.quoteNumber ?? ""} ` +
      `(${fmtUSD(totals.total)}) from Hollywood East Cafe is ready: ${link}` +
      (payUrl && !inquiry.squarePaidInFullAt ? `\nPay: ${payUrl}` : "");

    if (!isEjoinConfigured()) {
      res.status(502).json({ error: "SMS gateway not configured" });
      return;
    }
    try {
      // Bypass the fire-and-forget sendSms wrapper so we only stamp the
      // last-texted timestamp on a confirmed gateway success.
      await sendSmsViaEjoin(to, smsBody);
    } catch (sendErr) {
      req.log.error({ err: sendErr }, "Quote SMS gateway send failed");
      res.status(502).json({ error: "Failed to send SMS via gateway" });
      return;
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

// ── Change-request: reply (email or SMS) ──────────────────────────────────────

router.post("/admin/catering/:id/change-request/reply", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    const [inquiry] = await db.select().from(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, id));
    if (!inquiry) {
      res.status(404).json({ error: "Inquiry not found" });
      return;
    }

    const body = (req.body ?? {}) as Body;
    const channel = asString(body.channel);
    if (channel !== "email" && channel !== "sms") {
      res.status(400).json({ error: "channel must be 'email' or 'sms'" });
      return;
    }
    const message = asString(body.message)?.trim();
    if (!message) {
      res.status(400).json({ error: "Message cannot be empty" });
      return;
    }
    if (message.length > 2000) {
      res.status(400).json({ error: "Message is too long (max 2000 characters)" });
      return;
    }

    const sentAt = new Date();
    let sentTo: string;

    if (channel === "email") {
      const to = inquiry.clientEmail?.trim();
      if (!to) {
        res.status(400).json({ error: "No client email on file" });
        return;
      }
      const subject = `Re: Your catering quote ${inquiry.quoteNumber ?? ""}`.trim();
      const link = inquiry.quoteToken ? quoteViewUrl(req, inquiry.quoteToken) : null;
      const text = [
        `Hi ${inquiry.clientName},`,
        ``,
        message,
        ...(link ? [``, `View your quote: ${link}`] : []),
        ``,
        `— Hollywood East Cafe`,
      ].join("\n");
      const escapedMessage = message
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n/g, "<br>");
      const html = `
        <p>Hi ${inquiry.clientName},</p>
        <p>${escapedMessage}</p>
        ${link ? `<p><a href="${link}">View your quote</a></p>` : ""}
        <p>— Hollywood East Cafe</p>
      `;
      const result = await sendMail({ to, subject, text, html });
      if (!result.ok) {
        res.status(502).json({ error: result.error ?? "Failed to send email" });
        return;
      }
      sentTo = to;
    } else {
      const to = inquiry.clientPhone?.trim();
      if (!to) {
        res.status(400).json({ error: "No client phone on file" });
        return;
      }
      if (!isEjoinConfigured()) {
        res.status(502).json({ error: "SMS gateway not configured" });
        return;
      }
      try {
        await sendSmsViaEjoin(to, message);
      } catch (sendErr) {
        req.log.error({ err: sendErr }, "Change-request reply SMS failed");
        res.status(502).json({ error: "Failed to send SMS via gateway" });
        return;
      }
      sentTo = to;
    }

    const reply: QuoteReply = {
      id: randomUUID(),
      channel,
      message,
      sentAt: sentAt.toISOString(),
      sentTo,
    };
    const replies: QuoteReply[] = [...(inquiry.quoteReplies ?? []), reply];

    const [updated] = await db
      .update(cateringInquiriesTable)
      .set({
        quoteReplies: replies,
        quoteChangeRequestRespondedAt: inquiry.quoteChangeRequestRespondedAt ?? sentAt,
        updatedAt: sentAt,
      })
      .where(eq(cateringInquiriesTable.id, id))
      .returning();

    res.json({ ok: true, inquiry: updated, sentTo });
  } catch (err) {
    req.log.error({ err }, "Error sending change-request reply");
    res.status(500).json({ error: "Failed to send reply" });
  }
});

// ── Change-request: dismiss / mark responded ──────────────────────────────────

router.post("/admin/catering/:id/change-request/dismiss", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    const [inquiry] = await db.select().from(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, id));
    if (!inquiry) {
      res.status(404).json({ error: "Inquiry not found" });
      return;
    }
    if (!inquiry.quoteChangeRequestAt) {
      res.status(400).json({ error: "No change request to dismiss" });
      return;
    }

    const now = new Date();
    const [updated] = await db
      .update(cateringInquiriesTable)
      .set({
        quoteChangeRequestRespondedAt: inquiry.quoteChangeRequestRespondedAt ?? now,
        updatedAt: now,
      })
      .where(eq(cateringInquiriesTable.id, id))
      .returning();
    res.json({ ok: true, inquiry: updated });
  } catch (err) {
    req.log.error({ err }, "Error dismissing change request");
    res.status(500).json({ error: "Failed to dismiss" });
  }
});

// ── Square: send invoice ──────────────────────────────────────────────────────

function parseDepositSpec(raw: unknown): DepositSpec {
  if (!raw || typeof raw !== "object") return { kind: "none" };
  const r = raw as { kind?: unknown; value?: unknown };
  if (r.kind === "percent") {
    const v = Math.max(0, Math.min(100, Number(r.value) || 0));
    return v > 0 ? { kind: "percent", value: v } : { kind: "none" };
  }
  if (r.kind === "fixed") {
    const v = Math.max(0, Number(r.value) || 0);
    return v > 0 ? { kind: "fixed", value: v } : { kind: "none" };
  }
  return { kind: "none" };
}

router.post("/admin/catering/:id/square/invoice", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    if (!isSquareConfigured()) {
      res.status(503).json({
        error: "Square is not configured. Add SQUARE_ACCESS_TOKEN and SQUARE_LOCATION_ID.",
      });
      return;
    }
    const [inquiry] = await db.select().from(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, id));
    if (!inquiry) {
      res.status(404).json({ error: "Inquiry not found" });
      return;
    }

    if (inquiry.squareInvoiceId) {
      res.status(409).json({
        error: "An invoice already exists. Cancel it first to issue a new one.",
      });
      return;
    }

    const body = (req.body ?? {}) as Body;
    const deposit = parseDepositSpec(body.deposit);
    const dueDate = asString(body.dueDate)?.trim() || null;

    const created = await createAndPublishInvoiceForInquiry({
      inquiry,
      deposit,
      dueDate,
    });

    // Deep-copy the live quote arrays into the primary snapshot columns so
    // the supplemental-invoice flow has a stable "what we already billed"
    // baseline. JSON round-trip is the simplest safe deep clone for the
    // jsonb shape (no Dates, no functions, only primitives + arrays).
    const snapshotLineItems = JSON.parse(JSON.stringify(inquiry.lineItems ?? [])) as QuoteLineItem[];
    const snapshotFees = JSON.parse(JSON.stringify(inquiry.fees ?? [])) as QuoteAdjustment[];
    const snapshotDiscounts = JSON.parse(JSON.stringify(inquiry.discounts ?? [])) as QuoteAdjustment[];

    const updates: Record<string, unknown> = {
      squareInvoiceId: created.invoiceId,
      squareInvoiceVersion: created.invoiceVersion,
      squareOrderId: created.orderId,
      squareInvoiceStatus: created.status,
      squareHostedUrl: created.hostedUrl,
      squareAmountPaid: "0.00",
      squareBalanceDue: (created.balanceDueCents / 100).toFixed(2),
      squareDepositKind: deposit.kind === "none" ? null : deposit.kind,
      squareDepositValue: deposit.kind === "none" ? null : String(deposit.value),
      squareDueAt: dueDate ? new Date(`${dueDate}T00:00:00`) : null,
      primarySnapshotLineItems: snapshotLineItems,
      primarySnapshotFees: snapshotFees,
      primarySnapshotDiscounts: snapshotDiscounts,
      updatedAt: new Date(),
    };

    const [updated] = await db
      .update(cateringInquiriesTable)
      .set(updates)
      .where(eq(cateringInquiriesTable.id, id))
      .returning();
    const suppMap = await loadSupplementalsByInquiryIds([id]);
    res.json({ ok: true, inquiry: { ...updated, supplementals: suppMap.get(id) ?? [] } });
  } catch (err) {
    if (err instanceof SquareApiError) {
      req.log.error({ status: err.status, errors: err.errors }, "Square invoice create failed");
      res.status(502).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "Error creating Square invoice");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to create invoice" });
  }
});

// ── Square: cancel ────────────────────────────────────────────────────────────

router.post("/admin/catering/:id/square/cancel", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    if (!isSquareConfigured()) {
      res.status(503).json({ error: "Square is not configured" });
      return;
    }
    // To close the cancel-vs-supplement race we hold the FOR UPDATE
    // inquiry-row lock across the entire critical section: validation,
    // the Square cancel call, AND the local clear UPDATE. That way a
    // concurrent supplement-phase-1 either:
    //   (a) blocks on FOR UPDATE until this txn commits, then reads
    //       the cleared primary (squareInvoiceId NULL) and bails on
    //       "no_primary"; or
    //   (b) committed its PENDING reservation row before us, in which
    //       case our open-supps check sees PENDING (now in
    //       OPEN_SUPP_STATUSES) and we 409 here.
    // We deliberately accept holding the row lock across Square's HTTP
    // call: cancel is admin-only, low-frequency, and the alternative
    // (a separate "cancel-in-flight" guard column) requires schema
    // churn for no real benefit. If Square cancel throws the txn rolls
    // back atomically and the inquiry stays exactly as it was.
    const result = await db.transaction(async (tx) => {
      const [inquiry] = await tx
        .select()
        .from(cateringInquiriesTable)
        .where(eq(cateringInquiriesTable.id, id))
        .for("update");
      if (!inquiry) return { kind: "not_found" as const };
      if (!inquiry.squareInvoiceId || inquiry.squareInvoiceVersion == null) {
        return { kind: "no_invoice" as const };
      }
      if (inquiry.squareInvoiceStatus === "PAID" || inquiry.squarePaidInFullAt) {
        return { kind: "paid" as const };
      }
      const existingSupps = await tx
        .select()
        .from(cateringSupplementalInvoicesTable)
        .where(eq(cateringSupplementalInvoicesTable.cateringInquiryId, id));
      const openSupps = existingSupps.filter(isOpenSupplemental);
      if (openSupps.length > 0) {
        return { kind: "open_supps" as const, count: openSupps.length };
      }

      await cancelInvoice(inquiry.squareInvoiceId, inquiry.squareInvoiceVersion);

      // Clear Square fields + the primary snapshot so a fresh invoice
      // can be issued cleanly. Re-issuing the primary will re-snapshot
      // from the (possibly further-edited) live arrays.
      const [updated] = await tx
        .update(cateringInquiriesTable)
        .set({
          squareInvoiceId: null,
          squareInvoiceVersion: null,
          squareOrderId: null,
          squareInvoiceStatus: "CANCELED",
          squareHostedUrl: null,
          squareAmountPaid: null,
          squareBalanceDue: null,
          squareDepositKind: null,
          squareDepositValue: null,
          squareDueAt: null,
          squareDepositPaidAt: null,
          squarePaidInFullAt: null,
          primarySnapshotLineItems: null,
          primarySnapshotFees: null,
          primarySnapshotDiscounts: null,
          updatedAt: new Date(),
        })
        .where(eq(cateringInquiriesTable.id, id))
        .returning();
      return { kind: "ok" as const, updated };
    });

    if (result.kind === "not_found") { res.status(404).json({ error: "Inquiry not found" }); return; }
    if (result.kind === "no_invoice") { res.status(400).json({ error: "No Square invoice to cancel" }); return; }
    if (result.kind === "paid") { res.status(400).json({ error: "Cannot cancel a paid invoice" }); return; }
    if (result.kind === "open_supps") {
      res.status(409).json({
        error: `Cancel the ${result.count} outstanding supplemental invoice${result.count === 1 ? "" : "s"} first.`,
      });
      return;
    }
    const updated = result.updated;
    const suppMap = await loadSupplementalsByInquiryIds([id]);
    res.json({ ok: true, inquiry: { ...updated, supplementals: suppMap.get(id) ?? [] } });
  } catch (err) {
    if (err instanceof SquareApiError) {
      req.log.error({ status: err.status, errors: err.errors }, "Square invoice cancel failed");
      res.status(502).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "Error cancelling Square invoice");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to cancel invoice" });
  }
});

// ── Square: supplemental invoice (post-event extras) ─────────────────────────
//
// Creates a *second* Square invoice for the uninvoiced delta since the
// primary was published. The primary invoice is never modified.

router.post("/admin/catering/:id/square/supplement", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (!isSquareConfigured()) {
    res.status(503).json({
      error: "Square is not configured. Add SQUARE_ACCESS_TOKEN and SQUARE_LOCATION_ID.",
    });
    return;
  }

  // ── Phase 1: reserve a seq slot. Inside a single transaction we lock
  // the inquiry row, recompute the delta, decide nextSeq, and INSERT a
  // PENDING child row that claims (cateringInquiryId, seq) via the
  // unique index. Any concurrent request will then either wait on the
  // FOR UPDATE lock or fail at insert time on the unique index — we
  // can never publish two Square invoices for the same seq.
  let reservation: {
    suppRowId: number;
    nextSeq: number;
    inquiry: typeof cateringInquiriesTable.$inferSelect;
    delta: ReturnType<typeof computeUninvoicedDelta>;
    linesSnapshot: SupplementalLinesSnapshot;
    deltaLineItems: QuoteLineItem[];
    deltaFees: QuoteAdjustment[];
    deltaDiscounts: QuoteAdjustment[];
  };
  try {
    const prep = await db.transaction(async (tx) => {
      const [inq] = await tx
        .select()
        .from(cateringInquiriesTable)
        .where(eq(cateringInquiriesTable.id, id))
        .for("update");
      if (!inq) return { kind: "not_found" as const };
      if (!inq.squareInvoiceId || !inq.primarySnapshotLineItems) {
        return { kind: "no_primary" as const };
      }
      if (!inq.clientEmail?.trim()) return { kind: "no_email" as const };

      const delta = computeUninvoicedDelta({
        currentLineItems: (inq.lineItems ?? []) as QuoteLineItem[],
        currentFees: (inq.fees ?? []) as QuoteAdjustment[],
        currentDiscounts: (inq.discounts ?? []) as QuoteAdjustment[],
        snapshotLineItems: (inq.primarySnapshotLineItems ?? []) as QuoteLineItem[],
        snapshotFees: (inq.primarySnapshotFees ?? []) as QuoteAdjustment[],
        snapshotDiscounts: (inq.primarySnapshotDiscounts ?? []) as QuoteAdjustment[],
      });
      if (delta.deltaTotal <= 0) return { kind: "no_delta" as const };

      const existingSupps = await tx
        .select()
        .from(cateringSupplementalInvoicesTable)
        .where(eq(cateringSupplementalInvoicesTable.cateringInquiryId, id));
      const nextSeq = existingSupps.reduce((m, s) => Math.max(m, s.seq), 0) + 1;

      const priorSnapshotLineItems = JSON.parse(JSON.stringify(inq.primarySnapshotLineItems ?? [])) as QuoteLineItem[];
      const priorSnapshotFees = JSON.parse(JSON.stringify(inq.primarySnapshotFees ?? [])) as QuoteAdjustment[];
      const priorSnapshotDiscounts = JSON.parse(JSON.stringify(inq.primarySnapshotDiscounts ?? [])) as QuoteAdjustment[];

      const deltaLineItems = delta.deltaLineItems as unknown as QuoteLineItem[];
      const deltaFees = delta.deltaFees as unknown as QuoteAdjustment[];
      const deltaDiscounts = delta.deltaDiscounts as unknown as QuoteAdjustment[];
      const linesSnapshot: SupplementalLinesSnapshot = {
        lineItems: deltaLineItems,
        fees: deltaFees,
        discounts: deltaDiscounts,
      };

      // Reservation INSERT — claims the (inquiryId, seq) unique slot.
      // squareInvoiceId is null until phase 2 finalizes; status PENDING
      // is included in OPEN_SUPP_STATUSES so a concurrent primary
      // cancel that races in between this commit and phase 2 will see
      // the PENDING row and 409. The UI hides PENDING rows so this
      // brief reservation window does not flicker into the admin list.
      const [reserved] = await tx.insert(cateringSupplementalInvoicesTable).values({
        cateringInquiryId: id,
        seq: nextSeq,
        squareInvoiceId: null,
        squareInvoiceVersion: null,
        squareOrderId: null,
        squareInvoiceStatus: "PENDING",
        squareHostedUrl: null,
        squareAmountPaid: "0.00",
        squareBalanceDue: delta.deltaTotal.toFixed(2),
        squareDueAt: new Date(),
        linesSnapshot,
        amountTotal: delta.deltaTotal.toFixed(2),
        priorSnapshotLineItems,
        priorSnapshotFees,
        priorSnapshotDiscounts,
      }).returning();

      return {
        kind: "ok" as const,
        suppRowId: reserved.id,
        nextSeq,
        inquiry: inq,
        delta,
        linesSnapshot,
        deltaLineItems, deltaFees, deltaDiscounts,
      };
    });

    if (prep.kind === "not_found") { res.status(404).json({ error: "Inquiry not found" }); return; }
    if (prep.kind === "no_primary") { res.status(409).json({ error: "Issue the primary Square invoice before sending a supplemental." }); return; }
    if (prep.kind === "no_email") { res.status(400).json({ error: "Client must have an email on file" }); return; }
    if (prep.kind === "no_delta") { res.status(400).json({ error: "No new charges since the primary invoice — nothing to bill." }); return; }

    reservation = prep;
  } catch (err) {
    req.log.error({ err }, "Error reserving supplemental seq");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to reserve supplemental seq" });
    return;
  }

  // ── Phase 2a: publish to Square (no DB lock held). If this throws,
  // nothing was sent to the customer — mark the reservation row FAILED
  // and bail. The seq stays claimed; the next issuance picks seq+1.
  let created: Awaited<ReturnType<typeof createAndPublishSupplementalInvoice>>;
  try {
    created = await createAndPublishSupplementalInvoice({
      inquiry: reservation.inquiry,
      lineItems: reservation.deltaLineItems,
      fees: reservation.deltaFees,
      discounts: reservation.deltaDiscounts,
      supplementSeq: reservation.nextSeq,
    });
  } catch (err) {
    try {
      await db
        .update(cateringSupplementalInvoicesTable)
        .set({ squareInvoiceStatus: "FAILED", updatedAt: new Date() })
        .where(eq(cateringSupplementalInvoicesTable.id, reservation.suppRowId));
    } catch (cleanupErr) {
      req.log.error(
        { err: cleanupErr, suppRowId: reservation.suppRowId },
        "Failed to mark supplemental reservation FAILED after Square publish error",
      );
    }
    if (err instanceof SquareApiError) {
      req.log.error({ status: err.status, errors: err.errors, suppRowId: reservation.suppRowId },
        "Square supplemental invoice create failed");
      res.status(502).json({ error: err.message });
      return;
    }
    req.log.error({ err, suppRowId: reservation.suppRowId },
      "Error publishing Square supplemental invoice");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to create supplemental invoice" });
    return;
  }

  // Log the Square ids BEFORE any DB writes so a freak DB failure
  // between publish and the finalize step can still be reconciled
  // by hand from the pino logs.
  req.log.info(
    { suppRowId: reservation.suppRowId, invoiceId: created.invoiceId, orderId: created.orderId },
    "Square supplemental published; finalizing DB row",
  );

  // ── Phase 2b: finalize. Single txn that (1) UPDATEs the reservation
  // row with the live Square ids/status and (2) rolls the inquiry's
  // primary snapshot forward so the next computeUninvoicedDelta returns
  // zero until the admin makes further edits.
  //
  // If this txn fails the Square invoice is already live and chargeable.
  // Recovery: persist the Square ids on the row in a minimal UPDATE and
  // flip status to AWAITING_RECONCILE so:
  //   - the webhook can match the row by squareInvoiceId,
  //   - refresh / cancel handlers can address it,
  //   - it blocks primary cancel via OPEN_SUPP_STATUSES,
  //   - it surfaces in the admin UI for manual follow-up.
  // The snapshot is intentionally NOT rolled forward — the next
  // supplement issuance would otherwise re-bill the same delta.
  try {
    const updated = await db.transaction(async (tx) => {
      await tx
        .update(cateringSupplementalInvoicesTable)
        .set({
          squareInvoiceId: created.invoiceId,
          squareInvoiceVersion: created.invoiceVersion,
          squareOrderId: created.orderId,
          squareInvoiceStatus: created.status,
          squareHostedUrl: created.hostedUrl,
          squareBalanceDue: (created.balanceDueCents / 100).toFixed(2),
          updatedAt: new Date(),
        })
        .where(eq(cateringSupplementalInvoicesTable.id, reservation.suppRowId));

      const newSnapshotLineItems = JSON.parse(JSON.stringify(reservation.inquiry.lineItems ?? [])) as QuoteLineItem[];
      const newSnapshotFees = JSON.parse(JSON.stringify(reservation.inquiry.fees ?? [])) as QuoteAdjustment[];
      const newSnapshotDiscounts = JSON.parse(JSON.stringify(reservation.inquiry.discounts ?? [])) as QuoteAdjustment[];
      const [u] = await tx
        .update(cateringInquiriesTable)
        .set({
          primarySnapshotLineItems: newSnapshotLineItems,
          primarySnapshotFees: newSnapshotFees,
          primarySnapshotDiscounts: newSnapshotDiscounts,
          updatedAt: new Date(),
        })
        .where(eq(cateringInquiriesTable.id, id))
        .returning();
      return u;
    });

    const suppMap = await loadSupplementalsByInquiryIds([id]);
    const insertedSupp = (suppMap.get(id) ?? []).find(s => s.id === reservation.suppRowId);
    res.json({
      ok: true,
      inquiry: { ...updated, supplementals: suppMap.get(id) ?? [] },
      supplemental: insertedSupp,
    });
  } catch (err) {
    try {
      await db
        .update(cateringSupplementalInvoicesTable)
        .set({
          squareInvoiceId: created.invoiceId,
          squareInvoiceVersion: created.invoiceVersion,
          squareOrderId: created.orderId,
          squareInvoiceStatus: "AWAITING_RECONCILE",
          squareHostedUrl: created.hostedUrl,
          squareBalanceDue: (created.balanceDueCents / 100).toFixed(2),
          updatedAt: new Date(),
        })
        .where(eq(cateringSupplementalInvoicesTable.id, reservation.suppRowId));
    } catch (cleanupErr) {
      req.log.error(
        { err: cleanupErr, suppRowId: reservation.suppRowId,
          invoiceId: created.invoiceId, orderId: created.orderId },
        "AWAITING_RECONCILE persist failed; orphaned supplemental — see logged Square ids",
      );
    }
    req.log.error({ err, suppRowId: reservation.suppRowId, invoiceId: created.invoiceId },
      "Finalize txn failed after Square publish; row marked AWAITING_RECONCILE");
    res.status(500).json({
      error: "Supplemental invoice published to Square but local finalize failed. The row is marked AWAITING_RECONCILE — please refresh from the admin panel.",
    });
  }
});

// ── Square: supplemental refresh ─────────────────────────────────────────────

router.post("/admin/catering/:id/square/supplement/:supplementId/refresh", async (req, res): Promise<void> => {
  try {
    const inquiryId = parseInt(req.params.id);
    const supplementId = parseInt(req.params.supplementId);
    if (!isSquareConfigured()) {
      res.status(503).json({ error: "Square is not configured" });
      return;
    }
    const [supp] = await db
      .select()
      .from(cateringSupplementalInvoicesTable)
      .where(eq(cateringSupplementalInvoicesTable.id, supplementId));
    if (!supp || supp.cateringInquiryId !== inquiryId) {
      res.status(404).json({ error: "Supplemental invoice not found" });
      return;
    }
    // PENDING reservations and FAILED publishes have no Square invoice
    // to refresh — there's no remote object to query.
    if (!supp.squareInvoiceId) {
      res.status(400).json({ error: "Supplemental was never published to Square" });
      return;
    }

    const snap = await getInvoiceSnapshot(supp.squareInvoiceId);
    const updates: Record<string, unknown> = {
      squareInvoiceVersion: snap.invoiceVersion,
      squareInvoiceStatus: snap.status,
      squareHostedUrl: snap.hostedUrl,
      squareAmountPaid: snap.amountPaidDollars.toFixed(2),
      squareBalanceDue: snap.balanceDueDollars.toFixed(2),
      updatedAt: new Date(),
    };
    if (snap.status === "PAID" && !supp.squarePaidInFullAt) {
      updates.squarePaidInFullAt = new Date();
    }

    await db
      .update(cateringSupplementalInvoicesTable)
      .set(updates)
      .where(eq(cateringSupplementalInvoicesTable.id, supplementId));

    const [inquiry] = await db.select().from(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, inquiryId));
    const suppMap = await loadSupplementalsByInquiryIds([inquiryId]);
    res.json({ ok: true, inquiry: { ...inquiry, supplementals: suppMap.get(inquiryId) ?? [] } });
  } catch (err) {
    if (err instanceof SquareApiError) {
      req.log.error({ status: err.status, errors: err.errors }, "Square supplemental refresh failed");
      res.status(502).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "Error refreshing Square supplemental invoice");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to refresh supplemental" });
  }
});

// ── Square: supplemental cancel ──────────────────────────────────────────────

router.post("/admin/catering/:id/square/supplement/:supplementId/cancel", async (req, res): Promise<void> => {
  try {
    const inquiryId = parseInt(req.params.id);
    const supplementId = parseInt(req.params.supplementId);
    if (!isSquareConfigured()) {
      res.status(503).json({ error: "Square is not configured" });
      return;
    }
    // Mirror primary-cancel: hold FOR UPDATE on the inquiry row across
    // validation + Square cancel + rollback decision + snapshot restore.
    // This closes the race where a concurrent supplement-issue could slip
    // a newer non-canceled supp in between our laterNonCanceled check
    // and our snapshot rollback (which would otherwise silently undo the
    // newer supp's billed delta and let it be re-billed). The supplement
    // issuance handler also takes FOR UPDATE on the inquiry row in its
    // phase 1, so the two paths serialize cleanly.
    const result = await db.transaction(async (tx) => {
      // Lock the inquiry row first — this is the serialization point.
      const [inq] = await tx
        .select({ id: cateringInquiriesTable.id })
        .from(cateringInquiriesTable)
        .where(eq(cateringInquiriesTable.id, inquiryId))
        .for("update");
      if (!inq) return { kind: "not_found" as const };

      const [supp] = await tx
        .select()
        .from(cateringSupplementalInvoicesTable)
        .where(eq(cateringSupplementalInvoicesTable.id, supplementId));
      if (!supp || supp.cateringInquiryId !== inquiryId) {
        return { kind: "not_found" as const };
      }
      // PENDING reservations and FAILED publishes have no live Square
      // invoice — there's nothing to cancel on Square's side.
      if (!supp.squareInvoiceId || supp.squareInvoiceVersion == null) {
        return { kind: "not_published" as const };
      }
      if (supp.squareInvoiceStatus === "PAID" || supp.squarePaidInFullAt) {
        return { kind: "paid" as const };
      }
      if ((supp.squareInvoiceStatus ?? "").toUpperCase() === "CANCELED") {
        return { kind: "already_canceled" as const };
      }

      // Decide rollback eligibility under the same lock that protects
      // against concurrent issuance. We only roll back if this supp is
      // still the most-recent non-canceled one — restoring an older
      // supp's prior snapshot would silently undo the deltas that later
      // supps already billed.
      const allSupps = await tx
        .select()
        .from(cateringSupplementalInvoicesTable)
        .where(eq(cateringSupplementalInvoicesTable.cateringInquiryId, inquiryId));
      // FAILED rows never published to Square (publish error in phase 2a)
      // and never rolled the snapshot forward, so they don't block our
      // rollback. Only later non-canceled, non-FAILED supps mean a real
      // billed delta we'd be undoing.
      const laterNonCanceled = allSupps.some(s => {
        if (s.id === supplementId) return false;
        if (s.seq <= supp.seq) return false;
        const st = (s.squareInvoiceStatus ?? "").toUpperCase();
        return st !== "CANCELED" && st !== "FAILED";
      });
      const canRollback = !laterNonCanceled && supp.priorSnapshotLineItems != null;

      // Square cancel happens inside the txn so any failure rolls back
      // both the snapshot restore and the supp-row update atomically.
      await cancelInvoice(supp.squareInvoiceId, supp.squareInvoiceVersion);

      await tx
        .update(cateringSupplementalInvoicesTable)
        .set({
          squareInvoiceStatus: "CANCELED",
          squareHostedUrl: null,
          squareBalanceDue: "0.00",
          updatedAt: new Date(),
        })
        .where(eq(cateringSupplementalInvoicesTable.id, supplementId));

      if (canRollback) {
        await tx
          .update(cateringInquiriesTable)
          .set({
            primarySnapshotLineItems: supp.priorSnapshotLineItems,
            primarySnapshotFees: supp.priorSnapshotFees,
            primarySnapshotDiscounts: supp.priorSnapshotDiscounts,
            updatedAt: new Date(),
          })
          .where(eq(cateringInquiriesTable.id, inquiryId));
      }

      return { kind: "ok" as const };
    });

    if (result.kind === "not_found") { res.status(404).json({ error: "Supplemental invoice not found" }); return; }
    if (result.kind === "not_published") { res.status(400).json({ error: "Supplemental was never published to Square" }); return; }
    if (result.kind === "paid") { res.status(400).json({ error: "Cannot cancel a paid supplemental invoice" }); return; }
    if (result.kind === "already_canceled") { res.status(400).json({ error: "Supplemental is already canceled" }); return; }

    const [inquiry] = await db.select().from(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, inquiryId));
    const suppMap = await loadSupplementalsByInquiryIds([inquiryId]);
    res.json({ ok: true, inquiry: { ...inquiry, supplementals: suppMap.get(inquiryId) ?? [] } });
  } catch (err) {
    if (err instanceof SquareApiError) {
      req.log.error({ status: err.status, errors: err.errors }, "Square supplemental cancel failed");
      res.status(502).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "Error cancelling Square supplemental invoice");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to cancel supplemental" });
  }
});

// ── Square: refresh (manual re-pull) ──────────────────────────────────────────

router.post("/admin/catering/:id/square/refresh", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    if (!isSquareConfigured()) {
      res.status(503).json({ error: "Square is not configured" });
      return;
    }
    const [inquiry] = await db.select().from(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, id));
    if (!inquiry) {
      res.status(404).json({ error: "Inquiry not found" });
      return;
    }
    if (!inquiry.squareInvoiceId) {
      res.status(400).json({ error: "No Square invoice on file" });
      return;
    }

    const snap = await getInvoiceSnapshot(inquiry.squareInvoiceId);
    const updates: Record<string, unknown> = {
      squareInvoiceVersion: snap.invoiceVersion,
      squareInvoiceStatus: snap.status,
      squareHostedUrl: snap.hostedUrl,
      squareAmountPaid: snap.amountPaidDollars.toFixed(2),
      squareBalanceDue: snap.balanceDueDollars.toFixed(2),
      updatedAt: new Date(),
    };
    const now = new Date();
    if (snap.status === "PARTIALLY_PAID" && !inquiry.squareDepositPaidAt) {
      updates.squareDepositPaidAt = now;
    }
    if (snap.status === "PAID") {
      if (!inquiry.squareDepositPaidAt) updates.squareDepositPaidAt = now;
      if (!inquiry.squarePaidInFullAt) updates.squarePaidInFullAt = now;
    }

    const [updated] = await db
      .update(cateringInquiriesTable)
      .set(updates)
      .where(eq(cateringInquiriesTable.id, id))
      .returning();
    res.json({ ok: true, inquiry: updated });
  } catch (err) {
    if (err instanceof SquareApiError) {
      req.log.error({ status: err.status, errors: err.errors }, "Square invoice refresh failed");
      res.status(502).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "Error refreshing Square invoice");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to refresh invoice" });
  }
});

// ── Convert a shared plan into an inquiry ─────────────────────────────────────

type PlannerStateShape = {
  guests?: number | string;
  piecesMap?: Record<string, number>;
  panQtys?: Record<string, Record<string, number>>;
};

router.post("/admin/catering/from-plan/:token", async (req, res): Promise<void> => {
  try {
    const token = req.params.token;
    const [plan] = await db
      .select()
      .from(sharedPlansTable)
      .where(eq(sharedPlansTable.shareToken, token));
    if (!plan) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }

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

    const [created] = await db.insert(cateringInquiriesTable).values(insertVals as typeof cateringInquiriesTable.$inferInsert).returning();
    res.status(201).json(created);
  } catch (err) {
    req.log.error({ err }, "Error converting plan to inquiry");
    res.status(500).json({ error: "Failed to convert plan" });
  }
});

export default router;
