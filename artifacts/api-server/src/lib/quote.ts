import PDFDocument from "pdfkit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type { CateringInquiry, QuoteAdjustment, QuoteLineItem } from "@workspace/db/schema";
import { computeOtdSetupFeeWaivedDisplay } from "@workspace/pricing";
import { TAX_DISCLOSURE } from "./tax";
import {
  PAYMENT_TERMS_TITLE,
  PAYMENT_TERMS_BULLETS,
  QUOTE_FOOTER_THANKS,
  NOT_PROVIDED,
} from "./quote-copy";

// Resolve the bundled CJK font path. In production (and `pnpm run dev`, which
// does `build && start`), the bundle runs from `dist/index.mjs` with the font
// at `dist/fonts/`. When the TS source is loaded directly (tests, tsx), we
// instead look in the repo's `assets/fonts/` directory. Falls back silently
// to Helvetica (Latin-only) if neither exists.
const FONT_PATH = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.join(here, "fonts", "NotoSansSC-Regular.otf"), // dist/fonts (built)
      path.join(here, "..", "..", "assets", "fonts", "NotoSansSC-Regular.otf"), // src/lib → assets/fonts (source)
    ];
    return candidates.find((p) => existsSync(p)) ?? null;
  } catch {
    return null;
  }
})();

export type ComputedAdjustment = QuoteAdjustment & { computed: number };

export type ComputedTotals = {
  lineItems: Array<QuoteLineItem & { lineTotal: number }>;
  subtotal: number;
  fees: ComputedAdjustment[];
  feesTotal: number;
  discounts: ComputedAdjustment[];
  discountsTotal: number;
  total: number;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeQuoteTotals(
  rawLineItems: QuoteLineItem[] | null | undefined,
  rawFees: QuoteAdjustment[] | null | undefined,
  rawDiscounts: QuoteAdjustment[] | null | undefined,
): ComputedTotals {
  const lineItems = (rawLineItems ?? []).map((li) => ({
    ...li,
    quantity: Number(li.quantity) || 0,
    unitPrice: Number(li.unitPrice) || 0,
    lineTotal: round2((Number(li.quantity) || 0) * (Number(li.unitPrice) || 0)),
  }));
  const subtotal = round2(lineItems.reduce((s, li) => s + li.lineTotal, 0));

  const fees: ComputedAdjustment[] = (rawFees ?? []).map((a) => ({
    ...a,
    amount: Number(a.amount) || 0,
    computed:
      a.kind === "percent"
        ? round2(subtotal * ((Number(a.amount) || 0) / 100))
        : round2(Number(a.amount) || 0),
  }));
  const feesTotal = round2(fees.reduce((s, f) => s + f.computed, 0));

  // Discounts apply against (subtotal + fees) so a percent discount feels right.
  const baseAfterFees = subtotal + feesTotal;
  const discounts: ComputedAdjustment[] = (rawDiscounts ?? []).map((a) => ({
    ...a,
    amount: Number(a.amount) || 0,
    computed:
      a.kind === "percent"
        ? round2(baseAfterFees * ((Number(a.amount) || 0) / 100))
        : round2(Number(a.amount) || 0),
  }));
  const discountsTotal = round2(discounts.reduce((s, d) => s + d.computed, 0));

  const total = round2(Math.max(0, subtotal + feesTotal - discountsTotal));
  return { lineItems, subtotal, fees, feesTotal, discounts, discountsTotal, total };
}

export function fmtUSD(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/**
 * Render the quote PDF and resolve to a Buffer.
 */
export async function renderQuotePdf(inquiry: CateringInquiry): Promise<Buffer> {
  const totals = computeQuoteTotals(inquiry.lineItems, inquiry.fees, inquiry.discounts);
  const doc = new PDFDocument({ size: "LETTER", margin: 50 });
  // Register a Unicode font with CJK coverage so menu items / notes containing
  // Chinese characters render correctly. Falls back silently to Helvetica
  // (Latin-only) if the font wasn't bundled, to avoid breaking PDF generation.
  if (FONT_PATH) {
    doc.registerFont("Default", FONT_PATH);
    doc.font("Default");
  }
  const chunks: Buffer[] = [];
  doc.on("data", (c) => chunks.push(c as Buffer));

  // Header
  doc
    .fontSize(20)
    .fillColor("#111111")
    .text("dash Catering", { align: "left" });
  doc
    .moveDown(0.2)
    .fontSize(10)
    .fillColor("#666666")
    .text("by Hollywood East Cafe");

  // Quote meta box (top right)
  const metaTop = 50;
  const metaX = 380;
  doc.fontSize(10).fillColor("#111111");
  doc.text(`Quote #: ${inquiry.quoteNumber ?? "DRAFT"}`, metaX, metaTop, { width: 165 });
  doc.text(`Issued: ${fmtDate(inquiry.quoteIssuedAt) || fmtDate(new Date())}`, metaX, metaTop + 14, { width: 165 });
  if (inquiry.quoteExpiresAt) {
    doc.text(`Valid until: ${fmtDate(inquiry.quoteExpiresAt)}`, metaX, metaTop + 28, { width: 165 });
  }

  doc.moveDown(1.2);

  // Client block — two columns to save vertical space. Always renders email
  // and phone rows (with a placeholder when missing) so the layout stays
  // stable and the contact info is easy to find.
  const clientTop = doc.y;
  doc.fontSize(9).fillColor("#666666").text("Prepared for", 50, clientTop);
  doc.fontSize(12).fillColor("#111111").text(inquiry.clientName, 50, doc.y);
  if (inquiry.organization) doc.fontSize(10).text(inquiry.organization, 50, doc.y);
  doc
    .fontSize(9)
    .fillColor("#444")
    .text(`Email: ${inquiry.clientEmail?.trim() || NOT_PROVIDED}`, 50, doc.y, { width: 260 });
  doc
    .fontSize(9)
    .fillColor("#444")
    .text(`Phone: ${inquiry.clientPhone?.trim() || NOT_PROVIDED}`, 50, doc.y, { width: 260 });
  const leftBottom = doc.y;

  // Event details on the right — always render with placeholders so the
  // venue line is consistently visible and prominent.
  let rightY = clientTop;
  doc.fontSize(9).fillColor("#666666").text("Event details", 320, rightY);
  rightY = doc.y;
  doc
    .fontSize(10)
    .fillColor("#222")
    .text(`Date: ${inquiry.eventDate?.trim() || NOT_PROVIDED}`, 320, rightY, { width: 240 });
  rightY = doc.y;
  doc
    .fontSize(10)
    .fillColor("#222")
    .text(`Guests: ${inquiry.guestCount ?? NOT_PROVIDED}`, 320, rightY, { width: 240 });
  rightY = doc.y;
  doc
    .fontSize(10)
    .fillColor("#222")
    .text(`Venue: ${inquiry.venueAddress?.trim() || NOT_PROVIDED}`, 320, rightY, { width: 240 });
  rightY = doc.y;
  doc.y = Math.max(leftBottom, rightY);
  doc.moveDown(0.6);

  // Line items table
  const tableTop = doc.y;
  const colItem = 50;
  const colQty = 320;
  const colUnit = 380;
  const colTotal = 470;

  doc.fontSize(10).fillColor("#666");
  doc.text("Item", colItem, tableTop);
  doc.text("Qty", colQty, tableTop, { width: 50, align: "right" });
  doc.text("Unit", colUnit, tableTop, { width: 80, align: "right" });
  doc.text("Total", colTotal, tableTop, { width: 80, align: "right" });
  doc
    .moveTo(50, tableTop + 14)
    .lineTo(560, tableTop + 14)
    .strokeColor("#dddddd")
    .stroke();

  let y = tableTop + 22;
  doc.fillColor("#111").fontSize(10);

  if (totals.lineItems.length === 0) {
    doc.fillColor("#999").text("(no items)", colItem, y);
    y += 16;
  }

  // Reserve space for totals + payment terms + notes + footer so we only break
  // to page 2 when truly full. Totals block is ~22pt header gap + ~16pt per
  // row (subtotal + fees + discounts + 1 divider + TOTAL); payment terms is
  // a heading + 3 bullets that always renders; notes is optional; footer sits
  // just inside the bottom margin.
  const otdWaivedDisplay = computeOtdSetupFeeWaivedDisplay(
    inquiry.serviceMode,
    inquiry.otdSetupFee != null ? Number(inquiry.otdSetupFee) : null,
    inquiry.otdFeeWaiverThreshold != null ? Number(inquiry.otdFeeWaiverThreshold) : null,
    totals.subtotal,
  );
  // +1 for the ghost waived row (struck-through original amount + caption).
  // The caption renders inline under the row, so reserve a touch of extra
  // height by counting it as a row in the totals block height calc.
  const totalsRows = 1 + totals.fees.length + totals.discounts.length + 1
    + (otdWaivedDisplay ? 1 : 0); // subtotal + adj + waived ghost? + TOTAL
  // 12pt extra reserves room for the tax-disclosure line below TOTAL.
  const totalsHeight = 22 + totalsRows * 16 + 12 + 12;
  // Payment terms: ~16pt heading + ~16pt per bullet line + 12pt padding.
  // Bullets are short enough to render as one line each at width 510.
  const paymentTermsHeight = 16 + PAYMENT_TERMS_BULLETS.length * 16 + 12;
  const notesHeight = inquiry.quoteNotes?.trim() ? 36 : 0;
  const lineItemMaxY = 740 - totalsHeight - paymentTermsHeight - notesHeight - 8;

  for (const li of totals.lineItems) {
    // Build a small descriptor below the name from sizing/per-unit info.
    const descriptorParts: string[] = [];
    if (li.pricingTemplate === "pan_sizes" && li.sizeLabel) {
      descriptorParts.push(li.sizeServings != null
        ? `${li.sizeLabel} · ${li.sizeServings} servings`
        : li.sizeLabel);
    } else if (li.unit) {
      descriptorParts.push(li.servingSize && li.servingSize > 1
        ? `${li.unit} of ${li.servingSize}`
        : `per ${li.unit}`);
    }
    const descriptor = descriptorParts.join(" · ");

    const itemWidth = 260;
    doc.fillColor("#111").fontSize(9.5);
    const nameH = doc.heightOfString(li.name, { width: itemWidth });
    let descH = 0;
    let notesH = 0;
    if (descriptor) {
      doc.fontSize(8.5);
      descH = doc.heightOfString(descriptor, { width: itemWidth });
    }
    if (li.notes) {
      doc.fontSize(8.5);
      notesH = doc.heightOfString(li.notes, { width: itemWidth });
    }
    const blockH = nameH + descH + notesH;
    const rowH = Math.max(blockH, 13) + 3;

    // Page break only when this row would push us past the area reserved for totals
    // on page 1, or past usable space on subsequent pages.
    const onOverflowPage = doc.bufferedPageRange().count > 1;
    const pageCap = onOverflowPage ? 720 : lineItemMaxY;
    if (y + rowH > pageCap) {
      doc.addPage();
      y = 50;
    }

    doc.fillColor("#111").fontSize(9.5);
    doc.text(li.name, colItem, y, { width: itemWidth });
    let yCursor = y + nameH;
    if (descriptor) {
      doc.fillColor("#666").fontSize(8.5)
        .text(descriptor, colItem, yCursor, { width: itemWidth });
      yCursor += descH;
    }
    if (li.notes) {
      doc.fillColor("#888").fontSize(8.5)
        .text(li.notes, colItem, yCursor, { width: itemWidth });
      yCursor += notesH;
    }
    doc.fillColor("#111").fontSize(9.5);
    doc.text(String(li.quantity), colQty, y, { width: 50, align: "right" });
    doc.text(fmtUSD(li.unitPrice), colUnit, y, { width: 80, align: "right" });
    doc.text(fmtUSD(li.lineTotal), colTotal, y, { width: 80, align: "right" });
    y += rowH;
  }

  // Totals block
  doc.moveTo(320, y + 6).lineTo(560, y + 6).strokeColor("#dddddd").stroke();
  y += 12;

  function totalRow(label: string, amount: string, opts: { bold?: boolean; color?: string } = {}) {
    doc
      .fillColor(opts.color ?? "#111")
      .fontSize(opts.bold ? 12 : 10)
      .text(label, 320, y, { width: 140, align: "right" });
    doc.text(amount, 470, y, { width: 80, align: "right" });
    y += opts.bold ? 18 : 14;
  }

  totalRow("Subtotal", fmtUSD(totals.subtotal));
  for (const f of totals.fees) {
    const lab = f.kind === "percent" ? `${f.label} (${f.amount}%)` : f.label;
    totalRow(lab, fmtUSD(f.computed));
  }
  // Ghost row: when the OTD setup fee was waived because the food subtotal
  // crossed the per-inquiry threshold, render the original fee with a
  // strikethrough so the customer can see what they saved. The waived fee
  // does NOT count toward the total — only the strikethrough text + a small
  // grey "Waived (minimum met)" caption render here.
  if (otdWaivedDisplay) {
    const amountXStart = 470; // left edge of amount column (470..550, width 80)
    const amountText = fmtUSD(otdWaivedDisplay.originalAmount);
    doc.fillColor("#888").fontSize(10);
    doc.text(otdWaivedDisplay.label, 320, y, { width: 140, align: "right" });
    doc.text(amountText, amountXStart, y, { width: 80, align: "right" });
    // Manual strike-through over the amount text so we don't pull in any
    // pdfkit text-decoration deps. Amount is right-aligned in an 80pt
    // column, so the right edge is fixed and we draw leftward by the
    // measured glyph width.
    const amountWidth = doc.widthOfString(amountText);
    const amountRight = amountXStart + 80;
    const strikeY = y + 5; // mid-height of a 10pt line
    doc
      .moveTo(amountRight - amountWidth, strikeY)
      .lineTo(amountRight, strikeY)
      .lineWidth(0.7)
      .strokeColor("#888")
      .stroke();
    y += 12;
    doc
      .fillColor("#888")
      .fontSize(8)
      .text(
        `Waived — order met ${fmtUSD(otdWaivedDisplay.waiverThreshold)} minimum`,
        320,
        y,
        { width: 230, align: "right" },
      );
    y += 10;
    // Restore default font size for any subsequent rows.
    doc.fontSize(10);
  }
  for (const d of totals.discounts) {
    const lab = d.kind === "percent" ? `${d.label} (${d.amount}%)` : d.label;
    totalRow(lab, `-${fmtUSD(d.computed)}`, { color: "#15803d" });
  }
  y += 4;
  doc.moveTo(320, y).lineTo(560, y).strokeColor("#111").stroke();
  y += 6;
  totalRow("TOTAL", fmtUSD(totals.total), { bold: true });

  // Tax disclosure — Square adds sales tax on the invoice itself.
  doc
    .fillColor("#888")
    .fontSize(8.5)
    .text(TAX_DISCLOSURE, 320, y, { width: 230, align: "right" });
  y += 12;

  // Move the doc cursor below both the line-items area on the left and the
  // totals block on the right so the Payment Terms / Notes blocks below can
  // never overlap either.
  doc.y = Math.max(doc.y, y + 8);

  // Payment Terms — always present, renders below totals on the left.
  doc.fontSize(10).fillColor("#666").text(PAYMENT_TERMS_TITLE, 50, doc.y);
  doc
    .fontSize(10)
    .fillColor("#222")
    .text(PAYMENT_TERMS_BULLETS.map((b) => `• ${b}`).join("\n"), 50, doc.y, { width: 510 });

  // Notes
  if (inquiry.quoteNotes?.trim()) {
    doc.moveDown(0.8);
    doc.fontSize(10).fillColor("#666").text("Notes", 50, doc.y);
    doc.fontSize(10).fillColor("#222").text(inquiry.quoteNotes, 50, doc.y, { width: 510 });
  }

  // Footer — pin clearly inside the bottom margin so pdfkit doesn't auto-paginate.
  // Letter is 792pt tall with 50pt margins → maxY ≈ 742. Place footer at 728.
  const footerY = doc.page.height - doc.page.margins.bottom - 14;
  doc.fontSize(8).fillColor("#888").text(
    QUOTE_FOOTER_THANKS,
    50,
    footerY,
    { width: 510, align: "center", lineBreak: false },
  );

  doc.end();
  return await new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * Build a public-facing JSON payload that does not leak internal fields.
 */
export function publicQuoteFromInquiry(inquiry: CateringInquiry) {
  const totals = computeQuoteTotals(inquiry.lineItems, inquiry.fees, inquiry.discounts);
  // Strip internal-only fields (tierApplied, priceMode, sizeSlot, menuItemId)
  // so they never leak to clients via the public JSON payload.
  const publicLineItems = totals.lineItems.map((li) => ({
    id: li.id,
    name: li.name,
    quantity: li.quantity,
    unitPrice: li.unitPrice,
    notes: li.notes ?? null,
    pricingTemplate: li.pricingTemplate ?? null,
    sizeLabel: li.sizeLabel ?? null,
    sizeServings: li.sizeServings ?? null,
    unit: li.unit ?? null,
    servingSize: li.servingSize ?? null,
    lineTotal: li.lineTotal,
  }));
  return {
    quoteNumber: inquiry.quoteNumber,
    quoteIssuedAt: inquiry.quoteIssuedAt,
    quoteExpiresAt: inquiry.quoteExpiresAt,
    quoteNotes: inquiry.quoteNotes,
    acceptedAt: inquiry.quoteAcceptedAt ? inquiry.quoteAcceptedAt.toISOString() : null,
    changeRequestAt: inquiry.quoteChangeRequestAt ? inquiry.quoteChangeRequestAt.toISOString() : null,
    changeRequestMessage: inquiry.quoteChangeRequestMessage ?? null,
    client: {
      name: inquiry.clientName,
      organization: inquiry.organization,
      email: inquiry.clientEmail,
      phone: inquiry.clientPhone,
      eventDate: inquiry.eventDate,
      guestCount: inquiry.guestCount,
      venueAddress: inquiry.venueAddress,
    },
    lineItems: publicLineItems,
    subtotal: totals.subtotal,
    fees: totals.fees,
    feesTotal: totals.feesTotal,
    discounts: totals.discounts,
    discountsTotal: totals.discountsTotal,
    total: totals.total,
    // OTD snapshot fields — exposed so the public quote page can render a
    // crossed-out "On the Dash setup fee — waived (minimum met)" ghost row
    // when the food subtotal cleared the per-inquiry waiver threshold. The
    // shared `computeOtdSetupFeeWaivedDisplay` helper in @workspace/pricing
    // is the source of truth for whether to render and what amount to show.
    serviceMode: inquiry.serviceMode ?? null,
    otdSetupFee: inquiry.otdSetupFee != null ? Number(inquiry.otdSetupFee) : null,
    otdFeeWaiverThreshold: inquiry.otdFeeWaiverThreshold != null
      ? Number(inquiry.otdFeeWaiverThreshold)
      : null,
    // Square — exposed only when an invoice has been issued, so the public
    // quote page can render a "Pay deposit / Pay balance" CTA.
    square: inquiry.squareInvoiceId
      ? {
          status: inquiry.squareInvoiceStatus ?? null,
          hostedUrl: inquiry.squareHostedUrl ?? null,
          amountPaid: inquiry.squareAmountPaid != null ? Number(inquiry.squareAmountPaid) : 0,
          balanceDue: inquiry.squareBalanceDue != null ? Number(inquiry.squareBalanceDue) : 0,
          depositPaidAt: inquiry.squareDepositPaidAt ? inquiry.squareDepositPaidAt.toISOString() : null,
          paidInFullAt: inquiry.squarePaidInFullAt ? inquiry.squarePaidInFullAt.toISOString() : null,
        }
      : null,
  };
}
