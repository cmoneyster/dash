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

// Font names registered on the doc. Helvetica is built-in to pdfkit; "CJK" is
// our bundled Noto Sans SC, only registered when the font file is present.
const FONT_LATIN = "Helvetica";
const FONT_CJK = "CJK";
const NON_ASCII_RE = /[^\x00-\x7F]/;
// Pick the right font for a given string. CJK font is heavier and renders
// Latin glyphs less crisply, so only use it when the string actually contains
// non-ASCII characters (typically Chinese in item names / notes / addresses).
// If the CJK font isn't bundled, always fall back to Helvetica.
function pickFont(text: string | null | undefined): string {
  if (!FONT_PATH) return FONT_LATIN;
  return text && NON_ASCII_RE.test(text) ? FONT_CJK : FONT_LATIN;
}

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
  return dt.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

/**
 * Render the quote PDF and resolve to a Buffer.
 */
export async function renderQuotePdf(inquiry: CateringInquiry): Promise<Buffer> {
  const totals = computeQuoteTotals(inquiry.lineItems, inquiry.fees, inquiry.discounts);
  const doc = new PDFDocument({ size: "LETTER", margin: 50 });
  // Default everything to Helvetica (built-in, crisp Latin glyphs). Register
  // the bundled Noto Sans SC under the name "CJK" so we can swap to it
  // per-string only when the text contains non-ASCII characters. Falls back
  // silently to Helvetica everywhere if the font file wasn't bundled.
  if (FONT_PATH) {
    doc.registerFont(FONT_CJK, FONT_PATH);
  }
  doc.font(FONT_LATIN);
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
  doc.font(FONT_LATIN).fontSize(9).fillColor("#666666").text("Prepared for", 50, clientTop);
  doc.font(pickFont(inquiry.clientName)).fontSize(12).fillColor("#111111")
    .text(inquiry.clientName, 50, doc.y);
  if (inquiry.organization) {
    doc.font(pickFont(inquiry.organization)).fontSize(10)
      .text(inquiry.organization, 50, doc.y);
  }
  // Render label + value as two runs so the static "Email: " / "Phone: " /
  // "Date: " / "Venue: " prefixes always stay in Helvetica and only the
  // user-controlled value swaps to the CJK font when needed. `continued: true`
  // keeps both runs on the same baseline.
  const emailValue = inquiry.clientEmail?.trim() || NOT_PROVIDED;
  doc
    .font(FONT_LATIN)
    .fontSize(9)
    .fillColor("#444")
    .text("Email: ", 50, doc.y, { width: 260, continued: true })
    .font(pickFont(emailValue))
    .text(emailValue);
  const phoneValue = inquiry.clientPhone?.trim() || NOT_PROVIDED;
  doc
    .font(FONT_LATIN)
    .fontSize(9)
    .fillColor("#444")
    .text("Phone: ", 50, doc.y, { width: 260, continued: true })
    .font(pickFont(phoneValue))
    .text(phoneValue);
  const leftBottom = doc.y;

  // Event details on the right — always render with placeholders so the
  // venue line is consistently visible and prominent. Same label/value split
  // as the client block above so static prefixes stay Helvetica.
  let rightY = clientTop;
  doc.font(FONT_LATIN).fontSize(9).fillColor("#666666").text("Event details", 320, rightY);
  rightY = doc.y;
  const dateValue = inquiry.eventDate?.trim() || NOT_PROVIDED;
  doc
    .font(FONT_LATIN)
    .fontSize(10)
    .fillColor("#222")
    .text("Date: ", 320, rightY, { width: 240, continued: true })
    .font(pickFont(dateValue))
    .text(dateValue);
  rightY = doc.y;
  if (inquiry.eventTime) {
    const windowStr = fmtDeliveryWindow(inquiry.eventTime);
    doc
      .font(FONT_LATIN)
      .fontSize(10)
      .fillColor("#222")
      .text("Delivery: ", 320, rightY, { width: 240, continued: true })
      .font(FONT_LATIN)
      .text(windowStr);
    rightY = doc.y;
  }
  doc
    .font(FONT_LATIN)
    .fontSize(10)
    .fillColor("#222")
    .text(`Guests: ${inquiry.guestCount ?? NOT_PROVIDED}`, 320, rightY, { width: 240 });
  rightY = doc.y;
  const venueValue = inquiry.venueAddress?.trim() || NOT_PROVIDED;
  doc
    .font(FONT_LATIN)
    .fontSize(10)
    .fillColor("#222")
    .text("Venue: ", 320, rightY, { width: 240, continued: true })
    .font(pickFont(venueValue))
    .text(venueValue);
  rightY = doc.y;
  doc.y = Math.max(leftBottom, rightY);
  doc.moveDown(0.6);

  // Line items table
  const tableTop = doc.y;
  const colItem = 50;
  const colQty = 320;
  const colUnit = 380;
  const colTotal = 470;

  doc.font(FONT_LATIN).fontSize(10).fillColor("#666");
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
  doc.font(FONT_LATIN).fillColor("#111").fontSize(10);

  if (totals.lineItems.length === 0) {
    doc.font(FONT_LATIN).fillColor("#999").text("(no items)", colItem, y);
    y += 16;
  }

  // Reserve space for totals + payment terms + notes + footer so we only break
  // to page 2 when truly full. Totals block is ~22pt header gap + ~16pt per
  // row (subtotal + fees + discounts + 1 divider + TOTAL); payment terms is
  // a heading + measured bullet height + padding; notes is optional and
  // measured at the actual render fontSize/width; footer sits just inside the
  // bottom margin. Heights are then re-checked after the line items loop and
  // the totals block is broken to a fresh page if it can't fit.
  const otdWaivedDisplay = computeOtdSetupFeeWaivedDisplay(
    inquiry.serviceMode,
    inquiry.otdSetupFee != null ? Number(inquiry.otdSetupFee) : null,
    inquiry.otdFeeWaiverThreshold != null ? Number(inquiry.otdFeeWaiverThreshold) : null,
    totals.subtotal,
  );
  // The waived ghost row is taller than a normal totals row: it renders the
  // label + strike-through amount on the strike line, then a 10pt caption +
  // 4pt padding below. The strike line itself is the max of (12pt, the
  // measured label height at the 140pt label-column width) so a long label
  // that wraps to two lines (the live label "On the Dash — on-site setup
  // fee" wraps at fontSize 10 / width 140) doesn't collide with the caption.
  // The render block below uses the same `waivedRowHeight` so reservation
  // and render stay in sync.
  let waivedRowHeight = 0;
  let waivedLabelHeight = 0;
  if (otdWaivedDisplay) {
    doc.font(FONT_LATIN).fontSize(10);
    waivedLabelHeight = doc.heightOfString(otdWaivedDisplay.label, { width: 140 });
    waivedRowHeight = Math.max(12, waivedLabelHeight) + 10 + 4; // strike + caption + padding
  }
  // Derive `totalsHeight` from the same constants the render block below uses
  // (NORMAL_ROW = 14pt advance per non-bold totalRow, TOTAL_ROW = 18pt for the
  // bold TOTAL row, fixed +12 above the totals divider, +4 +6 around the
  // pre-TOTAL divider, +12 for the tax disclosure, +8 post-totals padding) so
  // reservation and paint stay in sync. Over-reserving here would cause the
  // page-break safety net below to break to a fresh page even when the totals
  // block would have fit; under-reserving would clip into the footer.
  const NORMAL_TOTAL_ROW = 14;
  const BOLD_TOTAL_ROW = 18;
  const numNormalRows = 1 + totals.fees.length + totals.discounts.length; // subtotal + fees + discounts
  const totalsHeight = 12 // y += 12 after the divider above the totals block
    + numNormalRows * NORMAL_TOTAL_ROW
    + waivedRowHeight
    + 4 + 6 // y += 4 padding then y += 6 after the pre-TOTAL divider
    + BOLD_TOTAL_ROW
    + 12 // tax disclosure line
    + 8; // doc.y = Math.max(doc.y, y + 8) padding before payment terms
  // Measure each payment-terms bullet at the real render width so a future
  // copy edit that wraps a bullet to two lines doesn't silently overflow.
  doc.font(FONT_LATIN).fontSize(10);
  const paymentBulletsHeight = PAYMENT_TERMS_BULLETS.reduce(
    (sum, b) => sum + doc.heightOfString(`• ${b}`, { width: 510 }),
    0,
  );
  const paymentTermsHeight = 16 + paymentBulletsHeight + 12;
  // Measure notes at the real render fontSize/width with the right font for
  // the text so multi-line / CJK notes don't get under-reserved.
  const trimmedNotes = inquiry.quoteNotes?.trim() ?? "";
  let notesHeight = 0;
  if (trimmedNotes) {
    doc.font(pickFont(trimmedNotes)).fontSize(10);
    const notesBodyHeight = doc.heightOfString(trimmedNotes, { width: 510 });
    notesHeight = 16 + notesBodyHeight + 12; // heading + body + padding
  }
  // Clamp the notes contribution to whatever space is actually available on
  // page 1 once the table-header position, totals block, payment terms, and
  // a one-row item floor are accounted for. This way a pathologically long
  // notes field can't drive `lineItemMaxY` below the items start (which would
  // force every item onto page 2 unnecessarily). The SAFE_BOTTOM safety net
  // after the items loop still uses the unclamped `notesHeight` so the
  // actual fit is validated against full notes before drawing the totals
  // block; this cap only affects when the items loop chooses to break.
  const itemsStartY = y; // y at the top of the first item row, computed above
  const MIN_ITEMS_AREA = 30; // floor of one item row so page 1 never starves
  const availableForNotesOnPage1 = Math.max(
    0,
    740 - itemsStartY - totalsHeight - paymentTermsHeight - 8 - MIN_ITEMS_AREA,
  );
  const notesHeightForReservation = Math.min(notesHeight, availableForNotesOnPage1);
  const lineItemMaxY = 740 - totalsHeight - paymentTermsHeight - notesHeightForReservation - 8;

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
    // Measure each text block with the same font we'll render it with so the
    // measured heights line up with the painted output (CJK glyphs are taller
    // than Latin, so picking the wrong font here would mis-size the row).
    doc.font(pickFont(li.name)).fillColor("#111").fontSize(9.5);
    const nameH = doc.heightOfString(li.name, { width: itemWidth });
    let descH = 0;
    let notesH = 0;
    if (descriptor) {
      doc.font(pickFont(descriptor)).fontSize(8.5);
      descH = doc.heightOfString(descriptor, { width: itemWidth });
    }
    if (li.notes) {
      doc.font(pickFont(li.notes)).fontSize(8.5);
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

    doc.font(pickFont(li.name)).fillColor("#111").fontSize(9.5);
    doc.text(li.name, colItem, y, { width: itemWidth });
    let yCursor = y + nameH;
    if (descriptor) {
      doc.font(pickFont(descriptor)).fillColor("#666").fontSize(8.5)
        .text(descriptor, colItem, yCursor, { width: itemWidth });
      yCursor += descH;
    }
    if (li.notes) {
      doc.font(pickFont(li.notes)).fillColor("#888").fontSize(8.5)
        .text(li.notes, colItem, yCursor, { width: itemWidth });
      yCursor += notesH;
    }
    doc.font(FONT_LATIN).fillColor("#111").fontSize(9.5);
    doc.text(String(li.quantity), colQty, y, { width: 50, align: "right" });
    doc.text(fmtUSD(li.unitPrice), colUnit, y, { width: 80, align: "right" });
    doc.text(fmtUSD(li.lineTotal), colTotal, y, { width: 80, align: "right" });
    y += rowH;
  }

  // Safety net: even though `lineItemMaxY` reserves space on page 1 and the
  // overflow `pageCap` reserves space on subsequent pages, the totals +
  // payment terms + notes blocks can still butt up against the bottom margin
  // when the last few items barely fit. If the remaining vertical space on
  // the current page can't hold all three blocks plus the divider/padding,
  // break to a fresh page now and reset the cursor.
  const SAFE_BOTTOM = 720; // leave room for footer at 728
  const remainingNeeded = totalsHeight + paymentTermsHeight + notesHeight + 8;
  if (y + remainingNeeded > SAFE_BOTTOM) {
    doc.addPage();
    y = 50;
  }

  // Totals block
  doc.moveTo(320, y + 6).lineTo(560, y + 6).strokeColor("#dddddd").stroke();
  y += 12;

  function totalRow(label: string, amount: string, opts: { bold?: boolean; color?: string } = {}) {
    doc
      .font(pickFont(label))
      .fillColor(opts.color ?? "#111")
      .fontSize(opts.bold ? 12 : 10)
      .text(label, 320, y, { width: 140, align: "right" });
    doc.font(FONT_LATIN).text(amount, 470, y, { width: 80, align: "right" });
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
    doc.font(FONT_LATIN).fillColor("#888").fontSize(10);
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
    // Advance past the (possibly wrapped) label rather than a fixed 12pt so
    // the caption never collides with a wrapped label tail. The live label
    // "On the Dash — on-site setup fee" wraps to 2 lines at fontSize 10 in
    // the 140pt column, so without this guard the wrapped "fee" tail sits
    // exactly where the caption would render.
    y += Math.max(12, waivedLabelHeight);
    doc
      .font(FONT_LATIN)
      .fillColor("#888")
      .fontSize(8)
      .text(
        `Waived — order met ${fmtUSD(otdWaivedDisplay.waiverThreshold)} minimum`,
        320,
        y,
        { width: 230, align: "right" },
      );
    // 10pt caption + 4pt padding. Combined with the strike line above this
    // matches `waivedRowHeight` reserved in the page-break math.
    y += 10 + 4;
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
    .font(FONT_LATIN)
    .fillColor("#888")
    .fontSize(8.5)
    .text(TAX_DISCLOSURE, 320, y, { width: 230, align: "right" });
  y += 12;

  // Move the doc cursor below both the line-items area on the left and the
  // totals block on the right so the Payment Terms / Notes blocks below can
  // never overlap either.
  doc.y = Math.max(doc.y, y + 8);

  // Payment Terms — always present, renders below totals on the left.
  doc.font(FONT_LATIN).fontSize(10).fillColor("#666").text(PAYMENT_TERMS_TITLE, 50, doc.y);
  doc
    .font(FONT_LATIN)
    .fontSize(10)
    .fillColor("#222")
    .text(PAYMENT_TERMS_BULLETS.map((b) => `• ${b}`).join("\n"), 50, doc.y, { width: 510 });

  // Notes
  if (trimmedNotes) {
    doc.moveDown(0.8);
    doc.font(FONT_LATIN).fontSize(10).fillColor("#666").text("Notes", 50, doc.y);
    doc.font(pickFont(trimmedNotes)).fontSize(10).fillColor("#222")
      .text(trimmedNotes, 50, doc.y, { width: 510 });
  }

  // Footer — pin clearly inside the bottom margin so pdfkit doesn't auto-paginate.
  // Letter is 792pt tall with 50pt margins → maxY ≈ 742. Place footer at 728.
  const footerY = doc.page.height - doc.page.margins.bottom - 14;
  doc.font(FONT_LATIN).fontSize(8).fillColor("#888").text(
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
 * Format a 24-hour "HH:MM" time as a 30-minute delivery window string,
 * e.g. "14:00" → "2:00–2:30 PM", "11:45" → "11:45 AM–12:15 PM".
 * Returns an empty string when `time` is null/undefined/blank.
 */
export function fmtDeliveryWindow(time: string | null | undefined): string {
  if (!time) return "";
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return time;
  const startH = parseInt(match[1], 10);
  const startM = parseInt(match[2], 10);
  if (startH > 23 || startM > 59) return time;
  const endTotalMin = startH * 60 + startM + 30;
  const endH = Math.floor(endTotalMin / 60) % 24;
  const endM = endTotalMin % 60;
  const fmt12 = (h: number, m: number) => {
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, "0")}`;
  };
  const startPeriod = startH < 12 ? "AM" : "PM";
  const endPeriod = endH < 12 ? "AM" : "PM";
  const startFmt = fmt12(startH, startM);
  const endFmt = fmt12(endH, endM);
  if (startPeriod === endPeriod) return `${startFmt}–${endFmt} ${startPeriod}`;
  return `${startFmt} ${startPeriod}–${endFmt} ${endPeriod}`;
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
      eventTime: inquiry.eventTime,
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
