import type { PrintTemplate, SectionKey, SectionAlign, TicketLayout } from "@workspace/db/schema";

const ESC = 0x1b;
const GS  = 0x1d;
const LF  = 0x0a;

const INIT        = Buffer.from([ESC, 0x40]);
const BOLD_ON     = Buffer.from([ESC, 0x45, 0x01]);
const BOLD_OFF    = Buffer.from([ESC, 0x45, 0x00]);
const ALIGN_CENTER = Buffer.from([ESC, 0x61, 0x01]);
const ALIGN_LEFT   = Buffer.from([ESC, 0x61, 0x00]);
const ALIGN_RIGHT  = Buffer.from([ESC, 0x61, 0x02]);
const SIZE_NORMAL  = Buffer.from([GS, 0x21, 0x00]);
const SIZE_DOUBLE  = Buffer.from([GS, 0x21, 0x11]);
const CUT          = Buffer.from([ESC, 0x64, 0x03, ESC, 0x6d]);

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

// ─── Section resolution ────────────────────────────────────────────────────────

type TicketType = "kitchen_ticket" | "customer_receipt" | "item_label" | "plate_label";

type ResolvedStyle = {
  visible: boolean;
  bold: boolean;
  align: SectionAlign;
  size: "normal" | "double";
  dividerAfter: boolean;
};

export const DEFAULT_SECTION_STYLES: Record<SectionKey, ResolvedStyle> = {
  header:      { visible: true,  bold: true,  align: "center", size: "double", dividerAfter: false },
  orderNumber: { visible: true,  bold: true,  align: "left",   size: "normal", dividerAfter: false },
  guestName:   { visible: true,  bold: false, align: "left",   size: "normal", dividerAfter: false },
  tableNumber: { visible: true,  bold: false, align: "left",   size: "normal", dividerAfter: false },
  timestamp:   { visible: true,  bold: false, align: "left",   size: "normal", dividerAfter: false },
  source:      { visible: true,  bold: false, align: "left",   size: "normal", dividerAfter: false },
  items:       { visible: true,  bold: false, align: "left",   size: "normal", dividerAfter: false },
  totals:      { visible: true,  bold: false, align: "left",   size: "normal", dividerAfter: false },
  notes:       { visible: true,  bold: false, align: "left",   size: "normal", dividerAfter: false },
  footer:      { visible: true,  bold: false, align: "center", size: "normal", dividerAfter: false },
};

const TICKET_SIZE_OVERRIDES: Partial<Record<TicketType, Partial<Record<SectionKey, Pick<ResolvedStyle, "size" | "bold">>>>> = {
  item_label:  { orderNumber: { size: "double", bold: true }, items: { size: "double", bold: true } },
  plate_label: { orderNumber: { size: "double", bold: true }, items: { size: "double", bold: true } },
};

export const DEFAULT_ORDERS: Record<TicketType, SectionKey[]> = {
  kitchen_ticket:   ["header", "orderNumber", "guestName", "tableNumber", "timestamp", "source", "items", "notes", "footer"],
  customer_receipt: ["header", "timestamp", "orderNumber", "guestName", "tableNumber", "items", "totals", "footer"],
  item_label:       ["orderNumber", "guestName", "tableNumber", "items", "timestamp"],
  plate_label:      ["orderNumber", "guestName", "items", "timestamp"],
};

function getLayout(tmpl: PrintTemplate | undefined, key: TicketType): TicketLayout | undefined {
  return tmpl?.[key] as TicketLayout | undefined;
}

function resolveOrder(tmpl: PrintTemplate | undefined, key: TicketType): SectionKey[] {
  const order = getLayout(tmpl, key)?.sectionOrder ?? DEFAULT_ORDERS[key];
  return tmpl?.reverseOrder ? [...order].reverse() : order;
}

function resolveStyle(tmpl: PrintTemplate | undefined, key: TicketType, section: SectionKey): ResolvedStyle {
  const globalDefault = DEFAULT_SECTION_STYLES[section] ?? DEFAULT_SECTION_STYLES.footer;
  const ticketDefault = TICKET_SIZE_OVERRIDES[key]?.[section] ?? {};
  const defaults: ResolvedStyle = { ...globalDefault, ...ticketDefault };
  const override = getLayout(tmpl, key)?.sections?.[section] ?? {};
  return {
    visible:      override.visible      ?? defaults.visible,
    bold:         override.bold         ?? defaults.bold,
    align:        override.align        ?? defaults.align,
    size:         override.size         ?? defaults.size,
    dividerAfter: override.dividerAfter ?? defaults.dividerAfter,
  };
}

// ─── ESC/POS TicketBuilder ─────────────────────────────────────────────────────

class TicketBuilder {
  private chunks: Buffer[] = [INIT];

  raw(b: Buffer)  { this.chunks.push(b); return this; }
  text(s: string) { this.chunks.push(Buffer.from(s, "utf-8")); return this; }
  line(s = "")    { this.text(s); this.chunks.push(Buffer.from([LF])); return this; }
  bold(on: boolean) { this.chunks.push(on ? BOLD_ON : BOLD_OFF); return this; }
  double(on: boolean) { this.chunks.push(on ? SIZE_DOUBLE : SIZE_NORMAL); return this; }
  align(a: SectionAlign) {
    if (a === "center") this.chunks.push(ALIGN_CENTER);
    else if (a === "right") this.chunks.push(ALIGN_RIGHT);
    else this.chunks.push(ALIGN_LEFT);
    return this;
  }
  center() { this.chunks.push(ALIGN_CENTER); return this; }
  left()   { this.chunks.push(ALIGN_LEFT);   return this; }
  div(c = "-") { return this.line(divider(c)); }

  cut(): Buffer {
    this.chunks.push(Buffer.from([LF, LF, LF]));
    this.chunks.push(CUT);
    return Buffer.concat(this.chunks);
  }
}

// ─── Payload types ─────────────────────────────────────────────────────────────

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

// ─── Logo helper (ESC/POS text path) ──────────────────────────────────────────

function escLogo(t: TicketBuilder, tmpl: PrintTemplate | undefined, align: SectionAlign): void {
  if (!tmpl?.logoUrl) return;
  t.align(align).line("[LOGO]");
}

// ─── ESC/POS kitchen ticket ────────────────────────────────────────────────────

function renderKitchenLines(t: TicketBuilder, lines: OrderLine[]) {
  for (const l of lines) {
    t.bold(true).line(`${l.quantity}x ${l.name}`).bold(false);
    if (l.modifiers?.length) for (const m of l.modifiers) wrap(`+ ${m}`, 4).forEach((w) => t.line(w));
    if (l.notes) wrap(`* ${l.notes}`, 4).forEach((w) => t.line(w));
  }
}

function renderKitchenSection(
  t: TicketBuilder,
  p: KitchenTicketPayload,
  section: SectionKey,
  style: ResolvedStyle,
  tmpl?: PrintTemplate,
): void {
  const dchar = tmpl?.dividerChar ?? "-";
  t.align(style.align);
  switch (section) {
    case "header": {
      const title = tmpl?.headerText ?? "KITCHEN";
      if (tmpl?.logoUrl && tmpl.logoPosition === "before_name") escLogo(t, tmpl, style.align);
      t.double(style.size === "double").bold(style.bold).line(title).double(false).bold(false).left();
      if (tmpl?.logoUrl && tmpl.logoPosition !== "before_name") escLogo(t, tmpl, style.align);
      t.div(dchar === "-" ? "=" : dchar);
      break;
    }
    case "orderNumber":
      t.bold(style.bold).double(style.size === "double").line(`ORDER #${p.header.orderNumber}`).double(false).bold(false);
      break;
    case "guestName":
      t.bold(style.bold).double(style.size === "double").line(`Guest: ${p.header.guestName}`).double(false).bold(false);
      break;
    case "tableNumber":
      if (p.header.tableNumber) t.bold(style.bold).double(style.size === "double").line(`Table: ${p.header.tableNumber}`).double(false).bold(false);
      break;
    case "timestamp":
      t.bold(style.bold).double(style.size === "double").line(`Time:  ${fmtTime(new Date(p.header.placedAt))}`).double(false).bold(false);
      break;
    case "source":
      t.bold(style.bold).double(style.size === "double").line(`Source: ${p.header.source}`).double(false).bold(false);
      break;
    case "items":
      t.left().div(dchar);
      if (p.plates?.length) {
        for (const plate of p.plates) {
          t.bold(true).line(`-- ${plate.label} --`).bold(false);
          renderKitchenLines(t, plate.lines);
          t.line();
        }
      }
      if (p.lines.length) {
        if (p.plates?.length) t.bold(true).line("-- Unassigned --").bold(false);
        renderKitchenLines(t, p.lines);
      }
      break;
    case "notes":
      if (p.header.notes) {
        t.left().div(dchar);
        t.bold(true).line("NOTES:").bold(false);
        wrap(p.header.notes).forEach((w) => t.line(w));
      }
      break;
    case "footer": {
      const footer = tmpl?.footer;
      if (footer) {
        t.line();
        t.align(style.align);
        wrap(footer).forEach((w) => t.bold(style.bold).line(w).bold(false));
        t.left();
      }
      break;
    }
    default: break;
  }
  if (section !== "items" && section !== "notes" && section !== "header" && section !== "footer") t.left();
}

function renderKitchenTicket(p: KitchenTicketPayload, tmpl?: PrintTemplate): Buffer {
  const t = new TicketBuilder();
  const order = resolveOrder(tmpl, "kitchen_ticket");
  const dchar = tmpl?.dividerChar ?? "-";
  for (const section of order) {
    const style = resolveStyle(tmpl, "kitchen_ticket", section);
    if (!style.visible) continue;
    renderKitchenSection(t, p, section, style, tmpl);
    if (style.dividerAfter) t.left().div(dchar);
  }
  return t.cut();
}

// ─── ESC/POS customer receipt ──────────────────────────────────────────────────

function renderReceiptSection(
  t: TicketBuilder,
  p: CustomerReceiptPayload,
  section: SectionKey,
  style: ResolvedStyle,
  tmpl?: PrintTemplate,
): void {
  const dchar = tmpl?.dividerChar ?? "-";
  const bizName = tmpl?.businessName ?? p.businessName;
  const footer  = tmpl?.footer ?? p.footer;
  t.align(style.align);
  switch (section) {
    case "header": {
      if (tmpl?.logoUrl && tmpl.logoPosition === "before_name") escLogo(t, tmpl, style.align);
      if (bizName) t.bold(style.bold).double(style.size === "double").line(bizName).double(false).bold(false);
      if (tmpl?.logoUrl && tmpl.logoPosition !== "before_name") escLogo(t, tmpl, style.align);
      if (!bizName && tmpl?.logoUrl) escLogo(t, tmpl, style.align);
      t.left().div(dchar);
      break;
    }
    case "timestamp":
      t.bold(style.bold).double(style.size === "double").line(fmtTime(new Date(p.header.placedAt))).double(false).bold(false);
      break;
    case "orderNumber":
      t.bold(style.bold).double(style.size === "double").line(`Order #${p.header.orderNumber}`).double(false).bold(false);
      break;
    case "guestName":
      t.bold(style.bold).double(style.size === "double").line(`Guest: ${p.header.guestName}`).double(false).bold(false);
      break;
    case "tableNumber":
      if (p.header.tableNumber) t.bold(style.bold).double(style.size === "double").line(`Table: ${p.header.tableNumber}`).double(false).bold(false);
      break;
    case "items":
      t.left().div(dchar);
      for (const l of p.lines) {
        const right = l.unitPrice != null ? `$${(l.unitPrice * l.quantity).toFixed(2)}` : "";
        t.line(pad(`${l.quantity}x ${l.name}`, right));
        if (l.modifiers?.length) for (const m of l.modifiers) t.line(`   + ${m}`);
      }
      t.div(dchar);
      break;
    case "totals":
      t.left();
      if (p.subtotal != null) t.line(pad("Subtotal", `$${p.subtotal.toFixed(2)}`));
      if (p.tax != null) t.line(pad("Tax", `$${p.tax.toFixed(2)}`));
      if (p.tip != null) t.line(pad("Tip", `$${p.tip.toFixed(2)}`));
      t.bold(true).line(pad("TOTAL", `$${p.total.toFixed(2)}`)).bold(false);
      if (p.paymentMethod) t.line(`Paid: ${p.paymentMethod}`);
      break;
    case "footer":
      if (footer) {
        t.line();
        t.align(style.align);
        wrap(footer).forEach((w) => t.bold(style.bold).line(w).bold(false));
        t.left();
      }
      break;
    default: break;
  }
  if (section !== "items" && section !== "totals" && section !== "header" && section !== "footer") t.left();
}

function renderCustomerReceipt(p: CustomerReceiptPayload, tmpl?: PrintTemplate): Buffer {
  const t = new TicketBuilder();
  const order = resolveOrder(tmpl, "customer_receipt");
  const dchar = tmpl?.dividerChar ?? "-";
  for (const section of order) {
    const style = resolveStyle(tmpl, "customer_receipt", section);
    if (!style.visible) continue;
    renderReceiptSection(t, p, section, style, tmpl);
    if (style.dividerAfter) t.left().div(dchar);
  }
  return t.cut();
}

// ─── ESC/POS item label ────────────────────────────────────────────────────────

function renderItemLabelSection(
  t: TicketBuilder,
  p: ItemLabelPayload,
  section: SectionKey,
  style: ResolvedStyle,
  tmpl?: PrintTemplate,
): void {
  const dchar = tmpl?.dividerChar ?? "-";
  t.align(style.align);
  switch (section) {
    case "orderNumber":
      t.bold(style.bold).double(style.size === "double").line(`#${p.orderNumber}`).double(false).bold(false);
      break;
    case "guestName":
      t.bold(style.bold).double(style.size === "double").line(`Guest: ${p.guestName}`).double(false).bold(false);
      break;
    case "tableNumber":
      break;
    case "items":
      t.align(style.align).div(dchar);
      t.bold(style.bold).double(style.size === "double");
      wrap(`${p.quantity}x ${p.itemName}`).forEach((w) => t.line(w));
      t.double(false).bold(false);
      if (p.isFullBox) t.line("[FULL BOX]");
      if (p.modifiers?.length) for (const m of p.modifiers) wrap(`+ ${m}`, 2).forEach((w) => t.line(w));
      if (p.notes) {
        t.div(dchar);
        wrap(p.notes).forEach((w) => t.line(w));
      }
      t.div(dchar);
      break;
    case "timestamp":
      t.bold(style.bold).double(style.size === "double").line(fmtTime(new Date(p.placedAt))).double(false).bold(false);
      break;
    case "footer": {
      const footer = tmpl?.footer;
      if (footer) {
        t.line();
        t.align(style.align);
        wrap(footer).forEach((w) => t.line(w));
        t.left();
      }
      break;
    }
    default: break;
  }
  if (section !== "items" && section !== "footer") t.left();
}

function renderItemLabel(p: ItemLabelPayload, tmpl?: PrintTemplate): Buffer {
  const t = new TicketBuilder();
  const order = resolveOrder(tmpl, "item_label");
  const dchar = tmpl?.dividerChar ?? "-";
  for (const section of order) {
    const style = resolveStyle(tmpl, "item_label", section);
    if (!style.visible) continue;
    renderItemLabelSection(t, p, section, style, tmpl);
    if (style.dividerAfter) t.left().div(dchar);
  }
  return t.cut();
}

// ─── ESC/POS plate label ───────────────────────────────────────────────────────

function renderPlateLabelSection(
  t: TicketBuilder,
  p: PlateLabelPayload,
  section: SectionKey,
  style: ResolvedStyle,
  tmpl?: PrintTemplate,
): void {
  const dchar = tmpl?.dividerChar ?? "-";
  t.align(style.align);
  switch (section) {
    case "orderNumber":
      t.bold(style.bold).double(style.size === "double").line(`#${p.orderNumber}`).double(false).bold(false);
      break;
    case "guestName":
      t.bold(style.bold).double(style.size === "double").line(`Guest: ${p.guestName}`).double(false).bold(false);
      break;
    case "items":
      t.align(style.align).div(dchar);
      t.bold(style.bold).double(style.size === "double").line(p.plateLabel).double(false).bold(false);
      t.div(dchar);
      for (const l of p.lines) {
        t.bold(true).line(`${l.quantity}x ${l.name}`).bold(false);
        if (l.modifiers?.length) for (const m of l.modifiers) t.line(`  + ${m}`);
        if (l.notes) wrap(`* ${l.notes}`, 2).forEach((w) => t.line(w));
      }
      t.div(dchar);
      break;
    case "timestamp":
      t.bold(style.bold).double(style.size === "double").line(fmtTime(new Date(p.placedAt))).double(false).bold(false);
      break;
    case "footer": {
      const footer = tmpl?.footer;
      if (footer) {
        t.line();
        t.align(style.align);
        wrap(footer).forEach((w) => t.line(w));
        t.left();
      }
      break;
    }
    default: break;
  }
  if (section !== "items" && section !== "footer") t.left();
}

function renderPlateLabel(p: PlateLabelPayload, tmpl?: PrintTemplate): Buffer {
  const t = new TicketBuilder();
  const order = resolveOrder(tmpl, "plate_label");
  const dchar = tmpl?.dividerChar ?? "-";
  for (const section of order) {
    const style = resolveStyle(tmpl, "plate_label", section);
    if (!style.visible) continue;
    renderPlateLabelSection(t, p, section, style, tmpl);
    if (style.dividerAfter) t.left().div(dchar);
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

// ─── StarWebPRNT XML builder ───────────────────────────────────────────────────

function xmlEsc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

class WebPrntBuilder {
  private cmds: string[] = [];

  text(s: string) { if (s) this.cmds.push(`<Text>${xmlEsc(s)}</Text>`); return this; }
  line(s = "")    { this.cmds.push(`<Text>${xmlEsc(s)}\n</Text>`); return this; }
  bold(on: boolean) { this.cmds.push(`<Bold on="${on}"/>`); return this; }
  double(on: boolean) {
    this.cmds.push(on
      ? `<CharacterExpansion Method="DoubleWidthDoubleHeight"/>`
      : `<CharacterExpansion Method="Normal"/>`);
    return this;
  }
  align(a: SectionAlign) {
    const method = a === "center" ? "Center" : a === "right" ? "Right" : "Left";
    this.cmds.push(`<Alignment Method="${method}"/>`);
    return this;
  }
  center() { this.cmds.push(`<Alignment Method="Center"/>`); return this; }
  left()   { this.cmds.push(`<Alignment Method="Left"/>`);   return this; }
  div(c = "-") { return this.line(divider(c)); }
  image(src: string, width = 200) {
    this.cmds.push(`<Image Source="${xmlEsc(src)}" Width="${width}"/>`);
    return this;
  }

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

// ─── Logo helper (WebPRNT path) ────────────────────────────────────────────────

function webLogo(b: WebPrntBuilder, tmpl: PrintTemplate | undefined, align: SectionAlign): void {
  if (!tmpl?.logoUrl) return;
  b.align(align).image(tmpl.logoUrl);
}

// ─── StarWebPRNT kitchen ticket ────────────────────────────────────────────────

function webKitchenLines(b: WebPrntBuilder, lines: OrderLine[]) {
  for (const l of lines) {
    b.bold(true).line(`${l.quantity}x ${l.name}`).bold(false);
    if (l.modifiers?.length) for (const m of l.modifiers) wrap(`+ ${m}`, 4).forEach((w) => b.line(w));
    if (l.notes) wrap(`* ${l.notes}`, 4).forEach((w) => b.line(w));
  }
}

function webKitchenSection(
  b: WebPrntBuilder,
  p: KitchenTicketPayload,
  section: SectionKey,
  style: ResolvedStyle,
  tmpl?: PrintTemplate,
): void {
  const dchar = tmpl?.dividerChar ?? "-";
  b.align(style.align);
  switch (section) {
    case "header": {
      const title = tmpl?.headerText ?? "KITCHEN";
      if (tmpl?.logoUrl && tmpl.logoPosition === "before_name") webLogo(b, tmpl, style.align);
      b.double(style.size === "double").bold(style.bold).line(title).double(false).bold(false).left();
      if (tmpl?.logoUrl && tmpl.logoPosition !== "before_name") webLogo(b, tmpl, style.align);
      b.div(dchar === "-" ? "=" : dchar);
      break;
    }
    case "orderNumber":
      b.bold(style.bold).double(style.size === "double").line(`ORDER #${p.header.orderNumber}`).double(false).bold(false);
      break;
    case "guestName":
      b.bold(style.bold).double(style.size === "double").line(`Guest: ${p.header.guestName}`).double(false).bold(false);
      break;
    case "tableNumber":
      if (p.header.tableNumber) b.bold(style.bold).double(style.size === "double").line(`Table: ${p.header.tableNumber}`).double(false).bold(false);
      break;
    case "timestamp":
      b.bold(style.bold).double(style.size === "double").line(`Time:  ${fmtTime(new Date(p.header.placedAt))}`).double(false).bold(false);
      break;
    case "source":
      b.bold(style.bold).double(style.size === "double").line(`Source: ${p.header.source}`).double(false).bold(false);
      break;
    case "items":
      b.left().div(dchar);
      if (p.plates?.length) {
        for (const plate of p.plates) {
          b.bold(true).line(`-- ${plate.label} --`).bold(false);
          webKitchenLines(b, plate.lines);
          b.line();
        }
      }
      if (p.lines.length) {
        if (p.plates?.length) b.bold(true).line("-- Unassigned --").bold(false);
        webKitchenLines(b, p.lines);
      }
      break;
    case "notes":
      if (p.header.notes) {
        b.left().div(dchar);
        b.bold(true).line("NOTES:").bold(false);
        wrap(p.header.notes).forEach((w) => b.line(w));
      }
      break;
    case "footer": {
      const footer = tmpl?.footer;
      if (footer) {
        b.line();
        b.align(style.align);
        wrap(footer).forEach((w) => b.bold(style.bold).line(w).bold(false));
        b.left();
      }
      break;
    }
    default: break;
  }
  if (section !== "items" && section !== "notes" && section !== "header" && section !== "footer") b.left();
}

function webPrntKitchenTicket(p: KitchenTicketPayload, tmpl?: PrintTemplate): string {
  const b = new WebPrntBuilder();
  const order = resolveOrder(tmpl, "kitchen_ticket");
  const dchar = tmpl?.dividerChar ?? "-";
  for (const section of order) {
    const style = resolveStyle(tmpl, "kitchen_ticket", section);
    if (!style.visible) continue;
    webKitchenSection(b, p, section, style, tmpl);
    if (style.dividerAfter) b.left().div(dchar);
  }
  return b.build();
}

// ─── StarWebPRNT customer receipt ──────────────────────────────────────────────

function webReceiptSection(
  b: WebPrntBuilder,
  p: CustomerReceiptPayload,
  section: SectionKey,
  style: ResolvedStyle,
  tmpl?: PrintTemplate,
): void {
  const dchar = tmpl?.dividerChar ?? "-";
  const bizName = tmpl?.businessName ?? p.businessName;
  const footer  = tmpl?.footer ?? p.footer;
  b.align(style.align);
  switch (section) {
    case "header": {
      if (tmpl?.logoUrl && tmpl.logoPosition === "before_name") webLogo(b, tmpl, style.align);
      if (bizName) b.bold(style.bold).double(style.size === "double").line(bizName).double(false).bold(false);
      if (tmpl?.logoUrl && tmpl.logoPosition !== "before_name") webLogo(b, tmpl, style.align);
      if (!bizName && tmpl?.logoUrl) webLogo(b, tmpl, style.align);
      b.left().div(dchar);
      break;
    }
    case "timestamp":
      b.bold(style.bold).double(style.size === "double").line(fmtTime(new Date(p.header.placedAt))).double(false).bold(false);
      break;
    case "orderNumber":
      b.bold(style.bold).double(style.size === "double").line(`Order #${p.header.orderNumber}`).double(false).bold(false);
      break;
    case "guestName":
      b.bold(style.bold).double(style.size === "double").line(`Guest: ${p.header.guestName}`).double(false).bold(false);
      break;
    case "tableNumber":
      if (p.header.tableNumber) b.bold(style.bold).double(style.size === "double").line(`Table: ${p.header.tableNumber}`).double(false).bold(false);
      break;
    case "items":
      b.left().div(dchar);
      for (const l of p.lines) {
        const right = l.unitPrice != null ? `$${(l.unitPrice * l.quantity).toFixed(2)}` : "";
        b.line(pad(`${l.quantity}x ${l.name}`, right));
        if (l.modifiers?.length) for (const m of l.modifiers) b.line(`   + ${m}`);
      }
      b.div(dchar);
      break;
    case "totals":
      b.left();
      if (p.subtotal != null) b.line(pad("Subtotal", `$${p.subtotal.toFixed(2)}`));
      if (p.tax != null) b.line(pad("Tax", `$${p.tax.toFixed(2)}`));
      if (p.tip != null) b.line(pad("Tip", `$${p.tip.toFixed(2)}`));
      b.bold(true).line(pad("TOTAL", `$${p.total.toFixed(2)}`)).bold(false);
      if (p.paymentMethod) b.line(`Paid: ${p.paymentMethod}`);
      break;
    case "footer":
      if (footer) {
        b.line();
        b.align(style.align);
        wrap(footer).forEach((w) => b.bold(style.bold).line(w).bold(false));
        b.left();
      }
      break;
    default: break;
  }
  if (section !== "items" && section !== "totals" && section !== "header" && section !== "footer") b.left();
}

function webPrntCustomerReceipt(p: CustomerReceiptPayload, tmpl?: PrintTemplate): string {
  const b = new WebPrntBuilder();
  const order = resolveOrder(tmpl, "customer_receipt");
  const dchar = tmpl?.dividerChar ?? "-";
  for (const section of order) {
    const style = resolveStyle(tmpl, "customer_receipt", section);
    if (!style.visible) continue;
    webReceiptSection(b, p, section, style, tmpl);
    if (style.dividerAfter) b.left().div(dchar);
  }
  return b.build();
}

// ─── StarWebPRNT item label ────────────────────────────────────────────────────

function webItemLabelSection(
  b: WebPrntBuilder,
  p: ItemLabelPayload,
  section: SectionKey,
  style: ResolvedStyle,
  tmpl?: PrintTemplate,
): void {
  const dchar = tmpl?.dividerChar ?? "-";
  b.align(style.align);
  switch (section) {
    case "orderNumber":
      b.bold(style.bold).double(style.size === "double").line(`#${p.orderNumber}`).double(false).bold(false);
      break;
    case "guestName":
      b.bold(style.bold).double(style.size === "double").line(`Guest: ${p.guestName}`).double(false).bold(false);
      break;
    case "tableNumber":
      break;
    case "items":
      b.align(style.align).div(dchar);
      b.bold(style.bold).double(style.size === "double");
      wrap(`${p.quantity}x ${p.itemName}`).forEach((w) => b.line(w));
      b.double(false).bold(false);
      if (p.isFullBox) b.line("[FULL BOX]");
      if (p.modifiers?.length) for (const m of p.modifiers) wrap(`+ ${m}`, 2).forEach((w) => b.line(w));
      if (p.notes) {
        b.div(dchar);
        wrap(p.notes).forEach((w) => b.line(w));
      }
      b.div(dchar);
      break;
    case "timestamp":
      b.bold(style.bold).double(style.size === "double").line(fmtTime(new Date(p.placedAt))).double(false).bold(false);
      break;
    case "footer": {
      const footer = tmpl?.footer;
      if (footer) {
        b.line();
        b.align(style.align);
        wrap(footer).forEach((w) => b.line(w));
        b.left();
      }
      break;
    }
    default: break;
  }
  if (section !== "items" && section !== "footer") b.left();
}

function webPrntItemLabel(p: ItemLabelPayload, tmpl?: PrintTemplate): string {
  const b = new WebPrntBuilder();
  const order = resolveOrder(tmpl, "item_label");
  const dchar = tmpl?.dividerChar ?? "-";
  for (const section of order) {
    const style = resolveStyle(tmpl, "item_label", section);
    if (!style.visible) continue;
    webItemLabelSection(b, p, section, style, tmpl);
    if (style.dividerAfter) b.left().div(dchar);
  }
  return b.build();
}

// ─── StarWebPRNT plate label ───────────────────────────────────────────────────

function webPlateLabelSection(
  b: WebPrntBuilder,
  p: PlateLabelPayload,
  section: SectionKey,
  style: ResolvedStyle,
  tmpl?: PrintTemplate,
): void {
  const dchar = tmpl?.dividerChar ?? "-";
  b.align(style.align);
  switch (section) {
    case "orderNumber":
      b.bold(style.bold).double(style.size === "double").line(`#${p.orderNumber}`).double(false).bold(false);
      break;
    case "guestName":
      b.bold(style.bold).double(style.size === "double").line(`Guest: ${p.guestName}`).double(false).bold(false);
      break;
    case "items":
      b.align(style.align).div(dchar);
      b.bold(style.bold).double(style.size === "double").line(p.plateLabel).double(false).bold(false);
      b.div(dchar);
      for (const l of p.lines) {
        b.bold(true).line(`${l.quantity}x ${l.name}`).bold(false);
        if (l.modifiers?.length) for (const m of l.modifiers) b.line(`  + ${m}`);
        if (l.notes) wrap(`* ${l.notes}`, 2).forEach((w) => b.line(w));
      }
      b.div(dchar);
      break;
    case "timestamp":
      b.bold(style.bold).double(style.size === "double").line(fmtTime(new Date(p.placedAt))).double(false).bold(false);
      break;
    case "footer": {
      const footer = tmpl?.footer;
      if (footer) {
        b.line();
        b.align(style.align);
        wrap(footer).forEach((w) => b.line(w));
        b.left();
      }
      break;
    }
    default: break;
  }
  if (section !== "items" && section !== "footer") b.left();
}

function webPrntPlateLabel(p: PlateLabelPayload, tmpl?: PrintTemplate): string {
  const b = new WebPrntBuilder();
  const order = resolveOrder(tmpl, "plate_label");
  const dchar = tmpl?.dividerChar ?? "-";
  for (const section of order) {
    const style = resolveStyle(tmpl, "plate_label", section);
    if (!style.visible) continue;
    webPlateLabelSection(b, p, section, style, tmpl);
    if (style.dividerAfter) b.left().div(dchar);
  }
  return b.build();
}

// ─── StarWebPRNT test page ─────────────────────────────────────────────────────

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

// ─── Public WebPRNT render dispatcher ─────────────────────────────────────────

export function renderJobWebPrnt(
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
