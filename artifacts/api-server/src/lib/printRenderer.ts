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
const GS = 0x1d;
const LF = 0x0a;

/** Initialize printer (clears formatting, resets char set). */
const INIT = Buffer.from([ESC, 0x40]);
/** Bold on / off. */
const BOLD_ON = Buffer.from([ESC, 0x45, 0x01]);
const BOLD_OFF = Buffer.from([ESC, 0x45, 0x00]);
/** Center / left align. */
const ALIGN_CENTER = Buffer.from([ESC, 0x61, 0x01]);
const ALIGN_LEFT = Buffer.from([ESC, 0x61, 0x00]);
/** Character size: 0 = normal, 0x11 = double-width + double-height. */
const SIZE_NORMAL = Buffer.from([GS, 0x21, 0x00]);
const SIZE_DOUBLE = Buffer.from([GS, 0x21, 0x11]);
/** Star/ESC partial cut + feed. Works on TSP143IV CloudPRNT default. */
const CUT = Buffer.from([ESC, 0x64, 0x02]);

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
  return { bytes, contentType: "text/plain; charset=utf-8" };
}
