import type { PrintTemplate } from "@workspace/db/schema";

const ESC = 0x1b;
const GS  = 0x1d;
const LF  = 0x0a;

const INIT = Buffer.from([ESC, 0x40]);
const BOLD_ON  = Buffer.from([ESC, 0x45, 0x01]);
const BOLD_OFF = Buffer.from([ESC, 0x45, 0x00]);
const ALIGN_CENTER = Buffer.from([ESC, 0x61, 0x01]);
const ALIGN_LEFT   = Buffer.from([ESC, 0x61, 0x00]);
const SIZE_NORMAL = Buffer.from([GS, 0x21, 0x00]);
const SIZE_DOUBLE = Buffer.from([GS, 0x21, 0x11]);
const CUT = Buffer.from([ESC, 0x64, 0x03, ESC, 0x6d]);

const LINE_WIDTH = 48;

function divider(char = "-"): string {
  return (char.slice(0, 1) || "-").repeat(LINE_WIDTH);
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
    timeZone: "America/New_York",
    month: "numeric",
    day: "numeric",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  });
}

function tmplDiv(tmpl?: PrintTemplate, fallback = "-"): string {
  return divider(tmpl?.dividerChar ?? fallback);
}

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
  placedAt: string;
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

export type { PrintTemplate };

// ─── ESC/POS renderers ───────────────────────────────────────────────────────

function renderKitchenTicket(p: KitchenTicketPayload, tmpl?: PrintTemplate): Buffer {
  const t = new TicketBuilder();
  const showNum   = tmpl?.showOrderNumber !== false;
  const showGuest = tmpl?.showGuestName !== false;
  const showTime  = tmpl?.showTimestamp !== false;
  const showSrc   = tmpl?.showSource !== false;
  const showTable = tmpl?.showTableNumber !== false;

  t.center().double(true).bold(true).line("KITCHEN").double(false).bold(false).left();
  t.line(tmplDiv(tmpl, "="));
  if (showNum)   t.bold(true).line(`ORDER #${p.header.orderNumber}`).bold(false);
  if (showGuest) t.line(`Guest: ${p.header.guestName}`);
  if (showTable && p.header.tableNumber) t.line(`Table: ${p.header.tableNumber}`);
  if (showTime)  t.line(`Time:  ${fmtTime(new Date(p.header.placedAt))}`);
  if (showSrc)   t.line(`Source: ${p.header.source}`);
  t.line(tmplDiv(tmpl));

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
    t.line(tmplDiv(tmpl));
    t.bold(true).line("NOTES:").bold(false);
    wrap(p.header.notes).forEach((w) => t.line(w));
  }
  return t.cut();
}

function renderCustomerReceipt(p: CustomerReceiptPayload, tmpl?: PrintTemplate): Buffer {
  const t = new TicketBuilder();
  const showNum   = tmpl?.showOrderNumber !== false;
  const showGuest = tmpl?.showGuestName !== false;
  const showTime  = tmpl?.showTimestamp !== false;
  const showTable = tmpl?.showTableNumber !== false;
  const bizName   = tmpl?.businessName ?? p.businessName;
  const footer    = tmpl?.footer ?? p.footer;

  if (bizName) t.center().bold(true).line(bizName).bold(false).left();
  if (showTime) t.center().line(fmtTime(new Date(p.header.placedAt))).left();
  t.line(tmplDiv(tmpl));
  if (showNum)   t.line(`Order #${p.header.orderNumber}`);
  if (showGuest) t.line(`Guest: ${p.header.guestName}`);
  if (showTable && p.header.tableNumber) t.line(`Table: ${p.header.tableNumber}`);
  t.line(tmplDiv(tmpl));
  for (const l of p.lines) {
    const right = l.unitPrice != null ? `$${(l.unitPrice * l.quantity).toFixed(2)}` : "";
    t.line(pad(`${l.quantity}x ${l.name}`, right));
    if (l.modifiers?.length) for (const m of l.modifiers) t.line(`   + ${m}`);
  }
  t.line(tmplDiv(tmpl));
  if (p.subtotal != null) t.line(pad("Subtotal", `$${p.subtotal.toFixed(2)}`));
  if (p.tax != null) t.line(pad("Tax", `$${p.tax.toFixed(2)}`));
  if (p.tip != null) t.line(pad("Tip", `$${p.tip.toFixed(2)}`));
  t.bold(true).line(pad("TOTAL", `$${p.total.toFixed(2)}`)).bold(false);
  if (p.paymentMethod) t.line(`Paid: ${p.paymentMethod}`);
  if (footer) {
    t.line();
    t.center();
    wrap(footer).forEach((w) => t.line(w));
    t.left();
  }
  return t.cut();
}

function renderItemLabel(p: ItemLabelPayload, tmpl?: PrintTemplate): Buffer {
  const t = new TicketBuilder();
  const showNum   = tmpl?.showOrderNumber !== false;
  const showGuest = tmpl?.showGuestName !== false;
  const footer    = tmpl?.footer;

  if (showNum)   t.bold(true).double(true).line(`#${p.orderNumber}`).double(false).bold(false);
  if (showGuest) t.line(`Guest: ${p.guestName}`);
  t.line(tmplDiv(tmpl));
  t.bold(true).double(true);
  wrap(`${p.quantity}x ${p.itemName}`).forEach((w) => t.line(w));
  t.double(false).bold(false);
  if (p.isFullBox) t.line("[FULL BOX]");
  if (p.modifiers?.length) {
    for (const m of p.modifiers) wrap(`+ ${m}`, 2).forEach((w) => t.line(w));
  }
  if (p.notes) {
    t.line(tmplDiv(tmpl));
    wrap(p.notes).forEach((w) => t.line(w));
  }
  t.line(tmplDiv(tmpl));
  t.line(fmtTime(new Date(p.placedAt)));
  if (footer) {
    t.line();
    t.center();
    wrap(footer).forEach((w) => t.line(w));
    t.left();
  }
  return t.cut();
}

function renderPlateLabel(p: PlateLabelPayload, tmpl?: PrintTemplate): Buffer {
  const t = new TicketBuilder();
  const showNum   = tmpl?.showOrderNumber !== false;
  const showGuest = tmpl?.showGuestName !== false;
  const footer    = tmpl?.footer;

  if (showNum)   t.bold(true).double(true).line(`#${p.orderNumber}`).double(false).bold(false);
  if (showGuest) t.line(`Guest: ${p.guestName}`);
  t.line(tmplDiv(tmpl));
  t.bold(true).double(true).line(p.plateLabel).double(false).bold(false);
  t.line(tmplDiv(tmpl));
  for (const l of p.lines) {
    t.bold(true).line(`${l.quantity}x ${l.name}`).bold(false);
    if (l.modifiers?.length) for (const m of l.modifiers) t.line(`  + ${m}`);
    if (l.notes) wrap(`* ${l.notes}`, 2).forEach((w) => t.line(w));
  }
  t.line(tmplDiv(tmpl));
  t.line(fmtTime(new Date(p.placedAt)));
  if (footer) {
    t.line();
    t.center();
    wrap(footer).forEach((w) => t.line(w));
    t.left();
  }
  return t.cut();
}

function renderTest(p: TestPayload): Buffer {
  const t = new TicketBuilder();
  t.center().bold(true).double(true).line("TEST PRINT").double(false).bold(false).left();
  t.div("=");
  t.line(`Printer: ${p.printerName}`);
  t.line(`Time:    ${fmtTime(new Date())}`);
  t.div();
  t.line(p.message ?? "If you can read this, LAN printing works.");
  t.line();
  t.line("- Bold:");
  t.bold(true).line("    The quick brown fox").bold(false);
  t.line("- Double:");
  t.double(true).line(" 80mm test").double(false);
  return t.cut();
}

export function renderJob(
  payload: RenderablePayload,
  template?: PrintTemplate,
): { bytes: Buffer; contentType: string } {
  let bytes: Buffer;
  switch (payload.type) {
    case "kitchen_ticket":   bytes = renderKitchenTicket(payload, template); break;
    case "customer_receipt": bytes = renderCustomerReceipt(payload, template); break;
    case "item_label":       bytes = renderItemLabel(payload, template); break;
    case "plate_label":      bytes = renderPlateLabel(payload, template); break;
    case "test":             bytes = renderTest(payload); break;
  }
  return { bytes, contentType: "application/vnd.star.starprntcore" };
}

// ─── StarWebPRNT XML renderer ────────────────────────────────────────────────

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
  div(c = "-") { return this.line(divider(c)); }

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

function webPrntKitchenTicket(p: KitchenTicketPayload, tmpl?: PrintTemplate): string {
  const b = new WebPrntBuilder();
  const showNum   = tmpl?.showOrderNumber !== false;
  const showGuest = tmpl?.showGuestName !== false;
  const showTime  = tmpl?.showTimestamp !== false;
  const showSrc   = tmpl?.showSource !== false;
  const showTable = tmpl?.showTableNumber !== false;
  const dc = tmpl?.dividerChar ?? "-";

  b.center().double(true).bold(true).line("KITCHEN").double(false).bold(false).left();
  b.line(tmplDiv(tmpl, "="));
  if (showNum)   b.bold(true).line(`ORDER #${p.header.orderNumber}`).bold(false);
  if (showGuest) b.line(`Guest: ${p.header.guestName}`);
  if (showTable && p.header.tableNumber) b.line(`Table: ${p.header.tableNumber}`);
  if (showTime)  b.line(`Time:  ${fmtTime(new Date(p.header.placedAt))}`);
  if (showSrc)   b.line(`Source: ${p.header.source}`);
  b.div(dc);

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
    b.div(dc);
    b.bold(true).line("NOTES:").bold(false);
    wrap(p.header.notes).forEach((w) => b.line(w));
  }
  return b.build();
}

function webPrntCustomerReceipt(p: CustomerReceiptPayload, tmpl?: PrintTemplate): string {
  const b = new WebPrntBuilder();
  const showNum   = tmpl?.showOrderNumber !== false;
  const showGuest = tmpl?.showGuestName !== false;
  const showTime  = tmpl?.showTimestamp !== false;
  const showTable = tmpl?.showTableNumber !== false;
  const bizName   = tmpl?.businessName ?? p.businessName;
  const footer    = tmpl?.footer ?? p.footer;
  const dc = tmpl?.dividerChar ?? "-";

  if (bizName) b.center().bold(true).line(bizName).bold(false).left();
  if (showTime) b.center().line(fmtTime(new Date(p.header.placedAt))).left();
  b.div(dc);
  if (showNum)   b.line(`Order #${p.header.orderNumber}`);
  if (showGuest) b.line(`Guest: ${p.header.guestName}`);
  if (showTable && p.header.tableNumber) b.line(`Table: ${p.header.tableNumber}`);
  b.div(dc);
  for (const l of p.lines) {
    const right = l.unitPrice != null ? `$${(l.unitPrice * l.quantity).toFixed(2)}` : "";
    b.line(pad(`${l.quantity}x ${l.name}`, right));
    if (l.modifiers?.length) for (const m of l.modifiers) b.line(`   + ${m}`);
  }
  b.div(dc);
  if (p.subtotal != null) b.line(pad("Subtotal", `$${p.subtotal.toFixed(2)}`));
  if (p.tax != null) b.line(pad("Tax", `$${p.tax.toFixed(2)}`));
  if (p.tip != null) b.line(pad("Tip", `$${p.tip.toFixed(2)}`));
  b.bold(true).line(pad("TOTAL", `$${p.total.toFixed(2)}`)).bold(false);
  if (p.paymentMethod) b.line(`Paid: ${p.paymentMethod}`);
  if (footer) {
    b.line();
    b.center();
    wrap(footer).forEach((w) => b.line(w));
    b.left();
  }
  return b.build();
}

function webPrntItemLabel(p: ItemLabelPayload, tmpl?: PrintTemplate): string {
  const b = new WebPrntBuilder();
  const showNum   = tmpl?.showOrderNumber !== false;
  const showGuest = tmpl?.showGuestName !== false;
  const footer    = tmpl?.footer;
  const dc = tmpl?.dividerChar ?? "-";

  if (showNum)   b.bold(true).double(true).line(`#${p.orderNumber}`).double(false).bold(false);
  if (showGuest) b.line(`Guest: ${p.guestName}`);
  b.div(dc);
  b.bold(true).double(true);
  wrap(`${p.quantity}x ${p.itemName}`).forEach((w) => b.line(w));
  b.double(false).bold(false);
  if (p.isFullBox) b.line("[FULL BOX]");
  if (p.modifiers?.length) for (const m of p.modifiers) wrap(`+ ${m}`, 2).forEach((w) => b.line(w));
  if (p.notes) {
    b.div(dc);
    wrap(p.notes).forEach((w) => b.line(w));
  }
  b.div(dc);
  b.line(fmtTime(new Date(p.placedAt)));
  if (footer) {
    b.line();
    b.center();
    wrap(footer).forEach((w) => b.line(w));
    b.left();
  }
  return b.build();
}

function webPrntPlateLabel(p: PlateLabelPayload, tmpl?: PrintTemplate): string {
  const b = new WebPrntBuilder();
  const showNum   = tmpl?.showOrderNumber !== false;
  const showGuest = tmpl?.showGuestName !== false;
  const footer    = tmpl?.footer;
  const dc = tmpl?.dividerChar ?? "-";

  if (showNum)   b.bold(true).double(true).line(`#${p.orderNumber}`).double(false).bold(false);
  if (showGuest) b.line(`Guest: ${p.guestName}`);
  b.div(dc);
  b.bold(true).double(true).line(p.plateLabel).double(false).bold(false);
  b.div(dc);
  for (const l of p.lines) {
    b.bold(true).line(`${l.quantity}x ${l.name}`).bold(false);
    if (l.modifiers?.length) for (const m of l.modifiers) b.line(`  + ${m}`);
    if (l.notes) wrap(`* ${l.notes}`, 2).forEach((w) => b.line(w));
  }
  b.div(dc);
  b.line(fmtTime(new Date(p.placedAt)));
  if (footer) {
    b.line();
    b.center();
    wrap(footer).forEach((w) => b.line(w));
    b.left();
  }
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

export function buildWebPrntXml(
  payload: RenderablePayload,
  template?: PrintTemplate,
): string {
  switch (payload.type) {
    case "kitchen_ticket":   return webPrntKitchenTicket(payload, template);
    case "customer_receipt": return webPrntCustomerReceipt(payload, template);
    case "item_label":       return webPrntItemLabel(payload, template);
    case "plate_label":      return webPrntPlateLabel(payload, template);
    case "test":             return webPrntTest(payload);
  }
}
