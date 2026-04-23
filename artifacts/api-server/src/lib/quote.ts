import PDFDocument from "pdfkit";
import type { CateringInquiry, QuoteAdjustment, QuoteLineItem } from "@workspace/db/schema";

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
  const chunks: Buffer[] = [];
  doc.on("data", (c) => chunks.push(c as Buffer));

  // Header
  doc
    .fontSize(20)
    .fillColor("#111111")
    .text("Hollywood East Cafe — Catering Quote", { align: "left" });
  doc
    .moveDown(0.2)
    .fontSize(10)
    .fillColor("#666666")
    .text("dash by Hollywood East Cafe");

  // Quote meta box (top right)
  const metaTop = 50;
  const metaX = 380;
  doc.fontSize(10).fillColor("#111111");
  doc.text(`Quote #: ${inquiry.quoteNumber ?? "DRAFT"}`, metaX, metaTop, { width: 165 });
  doc.text(`Issued: ${fmtDate(inquiry.quoteIssuedAt) || fmtDate(new Date())}`, metaX, metaTop + 14, { width: 165 });
  if (inquiry.quoteExpiresAt) {
    doc.text(`Valid until: ${fmtDate(inquiry.quoteExpiresAt)}`, metaX, metaTop + 28, { width: 165 });
  }

  doc.moveDown(2);

  // Client block
  doc.fontSize(11).fillColor("#666666").text("Prepared for");
  doc.fontSize(13).fillColor("#111111").text(inquiry.clientName);
  if (inquiry.organization) doc.fontSize(11).text(inquiry.organization);
  if (inquiry.clientEmail) doc.fontSize(10).fillColor("#444").text(inquiry.clientEmail);
  if (inquiry.clientPhone) doc.fontSize(10).fillColor("#444").text(inquiry.clientPhone);
  if (inquiry.eventDate || inquiry.guestCount || inquiry.venueAddress) {
    doc.moveDown(0.5);
    if (inquiry.eventDate) doc.fontSize(10).fillColor("#444").text(`Event date: ${inquiry.eventDate}`);
    if (inquiry.guestCount) doc.fontSize(10).fillColor("#444").text(`Guests: ${inquiry.guestCount}`);
    if (inquiry.venueAddress) doc.fontSize(10).fillColor("#444").text(`Venue: ${inquiry.venueAddress}`);
  }

  doc.moveDown(1);

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

  for (const li of totals.lineItems) {
    if (y > 680) {
      doc.addPage();
      y = 50;
    }
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
    doc.fillColor("#111").fontSize(10);
    const nameH = doc.heightOfString(li.name, { width: itemWidth });
    doc.text(li.name, colItem, y, { width: itemWidth });
    let yCursor = y + nameH;
    if (descriptor) {
      doc.fillColor("#666").fontSize(9);
      const h = doc.heightOfString(descriptor, { width: itemWidth });
      doc.text(descriptor, colItem, yCursor, { width: itemWidth });
      yCursor += h;
      doc.fontSize(10);
    }
    if (li.notes) {
      doc.fillColor("#888").fontSize(9);
      const h = doc.heightOfString(li.notes, { width: itemWidth });
      doc.text(li.notes, colItem, yCursor, { width: itemWidth });
      yCursor += h;
      doc.fontSize(10);
    }
    doc.fillColor("#111").fontSize(10);
    doc.text(String(li.quantity), colQty, y, { width: 50, align: "right" });
    doc.text(fmtUSD(li.unitPrice), colUnit, y, { width: 80, align: "right" });
    doc.text(fmtUSD(li.lineTotal), colTotal, y, { width: 80, align: "right" });
    const blockH = yCursor - y;
    y += Math.max(blockH, 14) + 6;
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
  for (const d of totals.discounts) {
    const lab = d.kind === "percent" ? `${d.label} (${d.amount}%)` : d.label;
    totalRow(lab, `-${fmtUSD(d.computed)}`, { color: "#15803d" });
  }
  y += 4;
  doc.moveTo(320, y).lineTo(560, y).strokeColor("#111").stroke();
  y += 6;
  totalRow("TOTAL", fmtUSD(totals.total), { bold: true });

  // Notes
  if (inquiry.quoteNotes?.trim()) {
    doc.moveDown(2);
    doc.fontSize(10).fillColor("#666").text("Notes", 50);
    doc.fontSize(10).fillColor("#222").text(inquiry.quoteNotes, 50, doc.y, { width: 510 });
  }

  // Footer
  doc.fontSize(8).fillColor("#888").text(
    "Thank you for considering Hollywood East Cafe for your event. Reply to this quote to confirm or request changes.",
    50,
    740,
    { width: 510, align: "center" },
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
  return {
    quoteNumber: inquiry.quoteNumber,
    quoteIssuedAt: inquiry.quoteIssuedAt,
    quoteExpiresAt: inquiry.quoteExpiresAt,
    quoteNotes: inquiry.quoteNotes,
    client: {
      name: inquiry.clientName,
      organization: inquiry.organization,
      email: inquiry.clientEmail,
      phone: inquiry.clientPhone,
      eventDate: inquiry.eventDate,
      guestCount: inquiry.guestCount,
      venueAddress: inquiry.venueAddress,
    },
    ...totals,
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
