/**
 * Star TSP receipt renderer (80mm paper, ~48 chars/line at default font).
 *
 * Emits Star Line Mode / ESC-POS-compatible byte streams that work with the
 * TSP143IV (and other TSP-series printers in CloudPRNT mode) using the
 * `text/plain; charset=utf-8` content type. The printer's firmware applies
 * the embedded escape sequences (bold, double-size, cut) directly.
 *
 * Why text/plain rather than raster: it keeps the implementation
 * model-agnostic across the whole TSP family (TSP100IV/143IV/650/700/800),
 * makes debugging easier (you can `cat` a job's bytes), and is plenty for
 * kitchen tickets / receipts / labels. We can swap to raster later for
 * logos / fancy layout without touching the queue or routing.
 */

const ESC = 0x1b;
const GS  = 0x1d;
const LF  = 0x0a;

/**
 * StarPRNT Core command set — content type: application/vnd.star.starprntcore
 *
 * The TSP143IV (TSP100IV series) natively supports starprntcore, which is
 * explicitly designed to work with BOTH Star Line and StarPRNT emulation
 * modes, bypassing the printer's emulation-map setting entirely.
 *
 * starprntcore uses ESC/POS-compatible commands:
 *   Init:    ESC @  (1B 40)
 *   Bold:    ESC E n  (1B 45 n)  n=1 on, n=0 off
 *   Align:   ESC a n  (1B 61 n)  n=1 center, n=0 left
 *   DblSize: GS ! n   (1D 21 n)  n=0x11 double H+W, n=0 normal
 *   Cut:     ESC d n  (1B 64 n)  feed n lines then partial cut
 *
 * Reference: Star CloudPRNT Protocol Guide — Content Media Types
 * https://star-m.jp/products/s_print/sdk/StarCloudPRNT/manual/en/
 *   protocol-reference/common-spec-reference/content-mediatypes/index.html
 */

/** Initialize printer (clears formatting, resets char set). */
const INIT = Buffer.from([ESC, 0x40]);
/** Bold on / off. */
const BOLD_ON  = Buffer.from([ESC, 0x45, 0x01]);
const BOLD_OFF = Buffer.from([ESC, 0x45, 0x00]);
/** Center / left align. */
const ALIGN_CENTER = Buffer.from([ESC, 0x61, 0x01]);
const ALIGN_LEFT   = Buffer.from([ESC, 0x61, 0x00]);
/** Character size: 0x00 = normal, 0x11 = double-width + double-height. */
const SIZE_NORMAL = Buffer.from([GS, 0x21, 0x00]);
const SIZE_DOUBLE = Buffer.from([GS, 0x21, 0x11]);
/**
 * ESC d 3: feed 3 lines then partial cut (StarPRNT cut command).
 * In starprntcore ESC d n = "print buffer + feed n lines + partial cut".
 * This is different from ESC/POS where ESC d = line feed only and GS V = cut.
 */
const CUT = Buffer.from([ESC, 0x64, 0x03]);

const LINE_WIDTH = 48;

function divider(char = "-"): string {
  return char.repeat(LINE_WIDTH);
}

function pad(left: string, right: string): string {
  const space = LINE_WIDTH - left.length - right.length;
  if (space <= 1) return `${left} ${right}`.slice(0, LINE_WIDTH);
  return left + " ".repeat(space) + right;
}

function wrap(text: string, indent = 0): string[] {
  const max = LINE_WIDTH - indent;
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      if (line.length === 0) {
        line = word;
      } else if (line.length + 1 + word.length <= max) {
        line += " " + word;
      } else {
        out.push(" ".repeat(indent) + line);
        line = word;
      }
    }
    if (line) out.push(" ".repeat(indent) + line);
  }
  return out;
}

function fmtTime(d: Date): string {
  return d.toLocaleString("en-US", {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Builder that emits printable bytes one chunk at a time. */
class TicketBuilder {
  private chunks: Buffer[] = [INIT];

  raw(b: Buffer) { this.chunks.push(b); return this; }
  text(s: string) { this.chunks.push(Buffer.from(s, "utf-8")); return this; }
  line(s = "") { this.text(s); this.chunks.push(Buffer.from([LF])); return this; }
  bold(on: boolean) { this.chunks.push(on ? BOLD_ON : BOLD_OFF); return this; }
  double(on: boolean) { this.chunks.push(on ? SIZE_DOUBLE : SIZE_NORMAL); return this; }
  center() { this.chunks.push(ALIGN_CENTER); return this; }
  left() { this.chunks.push(ALIGN_LEFT); return this; }
  div(c = "-") { return this.line(divider(c)); }

  cut(): Buffer {
    this.chunks.push(Buffer.from([LF, LF, LF]));
    this.chunks.push(CUT);
    return Buffer.concat(this.chunks);
  }
}

// ─── Payload types ──────────────────────────────────────────────────────────

export type OrderHeader = {
  orderNumber: string | number;
  guestName: string;
  source: "event_taker" | "event_ordering" | "demo" | "online" | "manual";
  placedAt: string; // ISO
  tableNumber?: string | null;
  phoneNumber?: string | null;
  notes?: string | null;
};

export type OrderLine = {
  name: string;
  quantity: number;
  unitPrice?: number;
  modifiers?: string[];
  notes?: string | null;
};

export type KitchenTicketPayload = {
  type: "kitchen_ticket";
  header: OrderHeader;
  lines: OrderLine[];
  plates?: { label: string; lines: OrderLine[] }[];
};

export type CustomerReceiptPayload = {
  type: "customer_receipt";
  header: OrderHeader;
  lines: OrderLine[];
  subtotal?: number;
  tax?: number;
  tip?: number;
  total: number;
  paymentMethod?: string;
  businessName?: string;
  footer?: string;
};

export type ItemLabelPayload = {
  type: "item_label";
  orderNumber: string | number;
  guestName: string;
  itemName: string;
  quantity: number;
  modifiers?: string[];
  notes?: string | null;
  placedAt: string;
  isFullBox?: boolean;
};

export type PlateLabelPayload = {
  type: "plate_label";
  orderNumber: string | number;
  guestName: string;
  plateLabel: string;
  lines: { name: string; quantity: number; modifiers?: string[]; notes?: string | null }[];
  placedAt: string;
};

export type TestPayload = {
  type: "test";
  printerName: string;
  message?: string;
};

export type RenderablePayload =
  | KitchenTicketPayload
  | CustomerReceiptPayload
  | ItemLabelPayload
  | PlateLabelPayload
  | TestPayload;

// ─── Renderers ──────────────────────────────────────────────────────────────

function renderKitchenTicket(p: KitchenTicketPayload): Buffer {
  const t = new TicketBuilder();
  t.center().double(true).bold(true).line("KITCHEN").double(false).bold(false).left();
  t.div("=");
  t.bold(true).line(`ORDER #${p.header.orderNumber}`).bold(false);
  t.line(`Guest: ${p.header.guestName}`);
  if (p.header.tableNumber) t.line(`Table: ${p.header.tableNumber}`);
  t.line(`Time:  ${fmtTime(new Date(p.header.placedAt))}`);
  t.line(`Source: ${p.header.source}`);
  t.div();

  const renderLines = (lines: OrderLine[]) => {
    for (const l of lines) {
      t.bold(true).line(`${l.quantity}x ${l.name}`).bold(false);
      if (l.modifiers?.length) {
        for (const m of l.modifiers) wrap(`+ ${m}`, 4).forEach((w) => t.line(w));
      }
      if (l.notes) wrap(`* ${l.notes}`, 4).forEach((w) => t.line(w));
    }
  };

  if (p.plates?.length) {
    for (const plate of p.plates) {
      t.bold(true).line(`-- ${plate.label} --`).bold(false);
      renderLines(plate.lines);
      t.line();
    }
  }
  if (p.lines.length) {
    if (p.plates?.length) t.bold(true).line("-- Unassigned --").bold(false);
    renderLines(p.lines);
  }

  if (p.header.notes) {
    t.div();
    t.bold(true).line("NOTES:").bold(false);
    wrap(p.header.notes).forEach((w) => t.line(w));
  }
  return t.cut();
}

function renderCustomerReceipt(p: CustomerReceiptPayload): Buffer {
  const t = new TicketBuilder();
  if (p.businessName) t.center().bold(true).line(p.businessName).bold(false).left();
  t.center().line(fmtTime(new Date(p.header.placedAt))).left();
  t.div();
  t.line(`Order #${p.header.orderNumber}`);
  t.line(`Guest: ${p.header.guestName}`);
  if (p.header.tableNumber) t.line(`Table: ${p.header.tableNumber}`);
  t.div();
  for (const l of p.lines) {
    const right = l.unitPrice != null ? `$${(l.unitPrice * l.quantity).toFixed(2)}` : "";
    t.line(pad(`${l.quantity}x ${l.name}`, right));
    if (l.modifiers?.length) for (const m of l.modifiers) t.line(`   + ${m}`);
  }
  t.div();
  if (p.subtotal != null) t.line(pad("Subtotal", `$${p.subtotal.toFixed(2)}`));
  if (p.tax != null) t.line(pad("Tax", `$${p.tax.toFixed(2)}`));
  if (p.tip != null) t.line(pad("Tip", `$${p.tip.toFixed(2)}`));
  t.bold(true).line(pad("TOTAL", `$${p.total.toFixed(2)}`)).bold(false);
  if (p.paymentMethod) t.line(`Paid: ${p.paymentMethod}`);
  if (p.footer) {
    t.line();
    t.center();
    wrap(p.footer).forEach((w) => t.line(w));
    t.left();
  }
  return t.cut();
}

function renderItemLabel(p: ItemLabelPayload): Buffer {
  const t = new TicketBuilder();
  t.bold(true).double(true).line(`#${p.orderNumber}`).double(false).bold(false);
  t.line(`Guest: ${p.guestName}`);
  t.div();
  t.bold(true).double(true);
  wrap(`${p.quantity}x ${p.itemName}`).forEach((w) => t.line(w));
  t.double(false).bold(false);
  if (p.isFullBox) t.line("[FULL BOX]");
  if (p.modifiers?.length) {
    for (const m of p.modifiers) wrap(`+ ${m}`, 2).forEach((w) => t.line(w));
  }
  if (p.notes) {
    t.div();
    wrap(p.notes).forEach((w) => t.line(w));
  }
  t.div();
  t.line(fmtTime(new Date(p.placedAt)));
  return t.cut();
}

function renderPlateLabel(p: PlateLabelPayload): Buffer {
  const t = new TicketBuilder();
  t.bold(true).double(true).line(`#${p.orderNumber}`).double(false).bold(false);
  t.line(`Guest: ${p.guestName}`);
  t.div();
  t.bold(true).double(true).line(p.plateLabel).double(false).bold(false);
  t.div();
  for (const l of p.lines) {
    t.bold(true).line(`${l.quantity}x ${l.name}`).bold(false);
    if (l.modifiers?.length) for (const m of l.modifiers) t.line(`  + ${m}`);
    if (l.notes) wrap(`* ${l.notes}`, 2).forEach((w) => t.line(w));
  }
  t.div();
  t.line(fmtTime(new Date(p.placedAt)));
  return t.cut();
}

function renderTest(p: TestPayload): Buffer {
  const t = new TicketBuilder();
  t.center().bold(true).double(true).line("TEST PRINT").double(false).bold(false).left();
  t.div("=");
  t.line(`Printer: ${p.printerName}`);
  t.line(`Time:    ${fmtTime(new Date())}`);
  t.div();
  t.line(p.message ?? "If you can read this, CloudPRNT is working.");
  t.line();
  t.line("- Bold:");
  t.bold(true).line("    The quick brown fox").bold(false);
  t.line("- Double:");
  t.double(true).line(" 80mm test").double(false);
  return t.cut();
}

export function renderJob(payload: RenderablePayload): { bytes: Buffer; contentType: string } {
  let bytes: Buffer;
  switch (payload.type) {
    case "kitchen_ticket": bytes = renderKitchenTicket(payload); break;
    case "customer_receipt": bytes = renderCustomerReceipt(payload); break;
    case "item_label": bytes = renderItemLabel(payload); break;
    case "plate_label": bytes = renderPlateLabel(payload); break;
    case "test": bytes = renderTest(payload); break;
  }
  return { bytes, contentType: "application/vnd.star.starprntcore" };
}

// ─── StarWebPRNT XML renderer ────────────────────────────────────────────────
//
// Produces native StarWebPRNT high-level XML elements rather than raw ESC/POS
// bytes.  The printer's firmware interprets these commands regardless of its
// language-mode setting (Star Line Mode vs ESC/POS), making it more reliable
// for browser-based LAN delivery (WebPRNT) than the raw-byte path used by
// CloudPRNT.

function xmlEsc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

class WebPrntBuilder {
  private cmds: string[] = [];

  text(s: string) { if (s) this.cmds.push(`<Text>${xmlEsc(s)}</Text>`); return this; }
  line(s = "")   { this.cmds.push(`<Text>${xmlEsc(s)}\n</Text>`); return this; }
  bold(on: boolean) { this.cmds.push(`<Bold on="${on}"/>`); return this; }
  double(on: boolean) {
    this.cmds.push(on
      ? `<CharacterExpansion Method="DoubleWidthDoubleHeight"/>`
      : `<CharacterExpansion Method="Normal"/>`);
    return this;
  }
  center() { this.cmds.push(`<Alignment Method="Center"/>`); return this; }
  left()   { this.cmds.push(`<Alignment Method="Left"/>`); return this; }
  div(c = "-") { return this.line(c.repeat(LINE_WIDTH)); }

  build(): string {
    this.cmds.push(`<CutPaper Method="Partial"/>`);
    const inner = this.cmds.join("");
    return (
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<StarWebPRNT:Request Version="1.00" xmlns:StarWebPRNT="http://www.star-m.jp/StarWebPRNT/V1.00/">` +
      `<PrintData><Printer>${inner}</Printer></PrintData>` +
      `</StarWebPRNT:Request>`
    );
  }
}

function webPrntKitchenTicket(p: KitchenTicketPayload): string {
  const b = new WebPrntBuilder();
  b.center().double(true).bold(true).line("KITCHEN").double(false).bold(false).left();
  b.div("=");
  b.bold(true).line(`ORDER #${p.header.orderNumber}`).bold(false);
  b.line(`Guest: ${p.header.guestName}`);
  if (p.header.tableNumber) b.line(`Table: ${p.header.tableNumber}`);
  b.line(`Time:  ${fmtTime(new Date(p.header.placedAt))}`);
  b.line(`Source: ${p.header.source}`);
  b.div();

  const renderLines = (lines: OrderLine[]) => {
    for (const l of lines) {
      b.bold(true).line(`${l.quantity}x ${l.name}`).bold(false);
      if (l.modifiers?.length) for (const m of l.modifiers) wrap(`+ ${m}`, 4).forEach((w) => b.line(w));
      if (l.notes) wrap(`* ${l.notes}`, 4).forEach((w) => b.line(w));
    }
  };

  if (p.plates?.length) {
    for (const plate of p.plates) {
      b.bold(true).line(`-- ${plate.label} --`).bold(false);
      renderLines(plate.lines);
      b.line();
    }
  }
  if (p.lines.length) {
    if (p.plates?.length) b.bold(true).line("-- Unassigned --").bold(false);
    renderLines(p.lines);
  }
  if (p.header.notes) {
    b.div();
    b.bold(true).line("NOTES:").bold(false);
    wrap(p.header.notes).forEach((w) => b.line(w));
  }
  return b.build();
}

function webPrntCustomerReceipt(p: CustomerReceiptPayload): string {
  const b = new WebPrntBuilder();
  if (p.businessName) b.center().bold(true).line(p.businessName).bold(false).left();
  b.center().line(fmtTime(new Date(p.header.placedAt))).left();
  b.div();
  b.line(`Order #${p.header.orderNumber}`);
  b.line(`Guest: ${p.header.guestName}`);
  if (p.header.tableNumber) b.line(`Table: ${p.header.tableNumber}`);
  b.div();
  for (const l of p.lines) {
    const right = l.unitPrice != null ? `$${(l.unitPrice * l.quantity).toFixed(2)}` : "";
    b.line(pad(`${l.quantity}x ${l.name}`, right));
    if (l.modifiers?.length) for (const m of l.modifiers) b.line(`   + ${m}`);
  }
  b.div();
  if (p.subtotal != null) b.line(pad("Subtotal", `$${p.subtotal.toFixed(2)}`));
  if (p.tax != null) b.line(pad("Tax", `$${p.tax.toFixed(2)}`));
  if (p.tip != null) b.line(pad("Tip", `$${p.tip.toFixed(2)}`));
  b.bold(true).line(pad("TOTAL", `$${p.total.toFixed(2)}`)).bold(false);
  if (p.paymentMethod) b.line(`Paid: ${p.paymentMethod}`);
  if (p.footer) {
    b.line();
    b.center();
    wrap(p.footer).forEach((w) => b.line(w));
    b.left();
  }
  return b.build();
}

function webPrntItemLabel(p: ItemLabelPayload): string {
  const b = new WebPrntBuilder();
  b.bold(true).double(true).line(`#${p.orderNumber}`).double(false).bold(false);
  b.line(`Guest: ${p.guestName}`);
  b.div();
  b.bold(true).double(true);
  wrap(`${p.quantity}x ${p.itemName}`).forEach((w) => b.line(w));
  b.double(false).bold(false);
  if (p.isFullBox) b.line("[FULL BOX]");
  if (p.modifiers?.length) for (const m of p.modifiers) wrap(`+ ${m}`, 2).forEach((w) => b.line(w));
  if (p.notes) {
    b.div();
    wrap(p.notes).forEach((w) => b.line(w));
  }
  b.div();
  b.line(fmtTime(new Date(p.placedAt)));
  return b.build();
}

function webPrntPlateLabel(p: PlateLabelPayload): string {
  const b = new WebPrntBuilder();
  b.bold(true).double(true).line(`#${p.orderNumber}`).double(false).bold(false);
  b.line(`Guest: ${p.guestName}`);
  b.div();
  b.bold(true).double(true).line(p.plateLabel).double(false).bold(false);
  b.div();
  for (const l of p.lines) {
    b.bold(true).line(`${l.quantity}x ${l.name}`).bold(false);
    if (l.modifiers?.length) for (const m of l.modifiers) b.line(`  + ${m}`);
    if (l.notes) wrap(`* ${l.notes}`, 2).forEach((w) => b.line(w));
  }
  b.div();
  b.line(fmtTime(new Date(p.placedAt)));
  return b.build();
}

function webPrntTest(p: TestPayload): string {
  const b = new WebPrntBuilder();
  b.center().bold(true).double(true).line("TEST PRINT").double(false).bold(false).left();
  b.div("=");
  b.line(`Printer: ${p.printerName}`);
  b.line(`Time:    ${fmtTime(new Date())}`);
  b.div();
  b.line(p.message ?? "If you can read this, LAN printing works.");
  b.line();
  b.line("- Bold:");
  b.bold(true).line("    The quick brown fox").bold(false);
  b.line("- Double:");
  b.double(true).line(" 80mm test").double(false);
  return b.build();
}

/** Build a StarWebPRNT high-level XML request for browser-based LAN delivery. */
export function buildWebPrntXml(payload: RenderablePayload): string {
  switch (payload.type) {
    case "kitchen_ticket":  return webPrntKitchenTicket(payload);
    case "customer_receipt": return webPrntCustomerReceipt(payload);
    case "item_label":      return webPrntItemLabel(payload);
    case "plate_label":     return webPrntPlateLabel(payload);
    case "test":            return webPrntTest(payload);
  }
}
