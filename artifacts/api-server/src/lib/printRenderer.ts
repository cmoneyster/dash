import type { PrintTemplate, SectionKey, SectionAlign, TicketLayout } from "@workspace/db/schema";
import type { ComboSelection } from "@workspace/db/schema";

const ESC = 0x1b;
const GS  = 0x1d;
const LF  = 0x0a;

// Star Line Mode (native StarPRNT) commands — NOT ESC/POS.
// Star printers default to Line Mode; ESC/POS commands like GS! and ESC a
// are NOT supported in Line Mode and produce garbage output.
const INIT        = Buffer.from([ESC, 0x40]);
const BOLD_ON     = Buffer.from([ESC, 0x45, 0x01]); // ESC E n — works in both modes
const BOLD_OFF    = Buffer.from([ESC, 0x45, 0x00]); // ESC E 0 — works in both modes (ESC F only works in Star Line Mode; ESC E 0 is the correct ESC/POS cancel and is accepted in Line Mode too)
// Alignment: Star Line Mode uses ESC GS a n (not ESC a n which feeds paper in Line Mode)
const ALIGN_LEFT   = Buffer.from([ESC, GS, 0x61, 0x00]);
const ALIGN_CENTER = Buffer.from([ESC, GS, 0x61, 0x01]);
const ALIGN_RIGHT  = Buffer.from([ESC, GS, 0x61, 0x02]);
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

type TicketType = "kitchen_ticket" | "customer_receipt" | "item_label" | "plate_label" | "combo_label";

type ResolvedStyle = {
  visible: boolean;
  bold: boolean;
  align: SectionAlign;
  size: number;
  dividerBefore: boolean;
  dividerAfter: boolean;
};

export const DEFAULT_SECTION_STYLES: Record<SectionKey, ResolvedStyle> = {
  header:      { visible: true,  bold: true,  align: "center", size: 2, dividerBefore: false, dividerAfter: false },
  orderNumber: { visible: true,  bold: true,  align: "left",   size: 1, dividerBefore: false, dividerAfter: false },
  guestName:   { visible: true,  bold: false, align: "left",   size: 1, dividerBefore: false, dividerAfter: false },
  tableNumber: { visible: true,  bold: false, align: "left",   size: 1, dividerBefore: false, dividerAfter: false },
  timestamp:   { visible: true,  bold: false, align: "left",   size: 1, dividerBefore: false, dividerAfter: false },
  source:      { visible: true,  bold: false, align: "left",   size: 1, dividerBefore: false, dividerAfter: false },
  items:       { visible: true,  bold: false, align: "left",   size: 1, dividerBefore: false, dividerAfter: false },
  totals:      { visible: true,  bold: false, align: "left",   size: 1, dividerBefore: false, dividerAfter: false },
  notes:       { visible: true,  bold: false, align: "left",   size: 1, dividerBefore: false, dividerAfter: false },
  footer:      { visible: true,  bold: false, align: "center", size: 1, dividerBefore: false, dividerAfter: false },
};

const TICKET_SIZE_OVERRIDES: Partial<Record<TicketType, Partial<Record<SectionKey, Pick<ResolvedStyle, "size" | "bold">>>>> = {
  // customer_receipt and item_label headers print the business name — keep at
  // 1x so long names don't wrap on a 48-column printer (2x = only 24 chars/line).
  customer_receipt: { header: { size: 1, bold: true } },
  item_label:  { header: { size: 1, bold: true }, orderNumber: { size: 2, bold: true }, items: { size: 2, bold: true } },
  plate_label: { orderNumber: { size: 2, bold: true }, items: { size: 2, bold: true } },
  combo_label: { header: { size: 1, bold: true }, orderNumber: { size: 2, bold: true }, items: { size: 2, bold: true } },
};

// Per-ticket-type divider defaults – controls which sections have dividers shown
// by default. Users can override any of these via the print template builder.
const TICKET_DIVIDER_OVERRIDES: Partial<Record<TicketType, Partial<Record<SectionKey, Pick<ResolvedStyle, "dividerBefore" | "dividerAfter">>>>> = {
  kitchen_ticket: {
    header: { dividerBefore: false, dividerAfter: true },
    items:  { dividerBefore: true,  dividerAfter: false },
  },
  customer_receipt: {
    header: { dividerBefore: false, dividerAfter: true },
    items:  { dividerBefore: true,  dividerAfter: true },
  },
  item_label: {
    items: { dividerBefore: true, dividerAfter: true },
  },
  plate_label: {
    items: { dividerBefore: true, dividerAfter: true },
  },
  combo_label: {
    items: { dividerBefore: true, dividerAfter: true },
  },
};

export const DEFAULT_ORDERS: Record<TicketType, SectionKey[]> = {
  kitchen_ticket:   ["header", "orderNumber", "guestName", "tableNumber", "timestamp", "source", "items", "notes", "footer"],
  customer_receipt: ["header", "timestamp", "orderNumber", "guestName", "tableNumber", "items", "totals", "footer"],
  // Non-bold sections (guestName, timestamp) come first so bold sections follow with no bold→non-bold
  // transitions, eliminating the stray 'F' that <Bold on="false"/> causes on some Star firmware.
  item_label:       ["guestName", "timestamp", "header", "orderNumber", "items", "footer"],
  plate_label:      ["guestName", "timestamp", "orderNumber", "items", "footer"],
  combo_label:      ["guestName", "timestamp", "header", "orderNumber", "items", "footer"],
};

function getLayout(tmpl: PrintTemplate | undefined, key: TicketType): TicketLayout | undefined {
  // combo_label re-uses item_label template layout when one exists
  const lookupKey = key === "combo_label" ? "item_label" : key;
  return tmpl?.[lookupKey as keyof PrintTemplate] as TicketLayout | undefined;
}

function resolveOrder(tmpl: PrintTemplate | undefined, key: TicketType): SectionKey[] {
  const order = getLayout(tmpl, key)?.sectionOrder ?? DEFAULT_ORDERS[key];
  return tmpl?.reverseOrder ? [...order].reverse() : order;
}

function resolveStyle(tmpl: PrintTemplate | undefined, key: TicketType, section: SectionKey): ResolvedStyle {
  const globalDefault = DEFAULT_SECTION_STYLES[section] ?? DEFAULT_SECTION_STYLES.footer;
  const ticketSizeDefault = TICKET_SIZE_OVERRIDES[key]?.[section] ?? {};
  const ticketDivDefault  = TICKET_DIVIDER_OVERRIDES[key]?.[section] ?? {};
  const defaults: ResolvedStyle = { ...globalDefault, ...ticketSizeDefault, ...ticketDivDefault };
  const override = getLayout(tmpl, key)?.sections?.[section] ?? {};
  return {
    visible:       override.visible       ?? defaults.visible,
    bold:          override.bold          ?? defaults.bold,
    align:         override.align         ?? defaults.align,
    size:          override.size          ?? defaults.size,
    dividerBefore: override.dividerBefore ?? defaults.dividerBefore,
    dividerAfter:  override.dividerAfter  ?? defaults.dividerAfter,
  };
}

// ─── ESC/POS TicketBuilder ─────────────────────────────────────────────────────

class TicketBuilder {
  // Note: INIT (ESC @) is intentionally NOT prepended here.
  // Star Line Mode does not recognise ESC @ as a reset command and instead
  // prints the literal character "@" at the start of the job.
  private chunks: Buffer[] = [];

  raw(b: Buffer)  { this.chunks.push(b); return this; }
  text(s: string) { this.chunks.push(Buffer.from(s, "utf-8")); return this; }
  line(s = "")    { this.text(s); this.chunks.push(Buffer.from([LF])); return this; }
  bold(on: boolean) { this.chunks.push(on ? BOLD_ON : BOLD_OFF); return this; }
  sizeN(n: number) {
    // Star Line Mode: ESC i n1 n2 — n1=height, n2=width (0=single, 1=double)
    // GS ! (ESC/POS) is NOT supported in Star Line Mode and prints garbage.
    const doubled = Math.round(n) >= 2 ? 1 : 0;
    this.chunks.push(Buffer.from([ESC, 0x69, doubled, doubled]));
    return this;
  }
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
  // Populated for combo items — the selected components to print indented
  comboSelections?: ComboSelection[];
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
  labelIndex?: number;
  labelTotal?: number;
  // When this label is a component of a combo, carries the combo name so
  // kitchen staff can group items belonging to the same combo together.
  partOfCombo?: string;
};

export type ComboLabelPayload = {
  type: "combo_label";
  orderNumber: string | number;
  guestName: string;
  comboName: string;
  comboSelections: ComboSelection[];
  placedAt: string;
  labelIndex?: number;
  labelTotal?: number;
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

export type CashDrawerPayload = {
  type: "cash_drawer";
};

export type RenderablePayload =
  | KitchenTicketPayload
  | CustomerReceiptPayload
  | ItemLabelPayload
  | ComboLabelPayload
  | PlateLabelPayload
  | CashDrawerPayload
  | TestPayload;

export type { PrintTemplate };

// ─── Logo helper (ESC/POS text path) ──────────────────────────────────────────

function escLogo(t: TicketBuilder, tmpl: PrintTemplate | undefined, align: SectionAlign): void {
  if (!tmpl?.logoUrl) return;
  t.align(align).line("[LOGO]");
}

// ─── Combo selection collapse helper ─────────────────────────────────────────
// Collapses repeated picks of the same menuItemId within a combo's selections
// into a single line with the summed quantity, multiplied by the combo order qty.

function collapseComboSelections(
  selections: ComboSelection[],
  comboQty: number,
): { name: string; qty: number }[] {
  const byId = new Map<number, { name: string; qty: number }>();
  for (const s of selections) {
    const existing = byId.get(s.menuItemId);
    if (existing) {
      existing.qty += s.quantity;
    } else {
      byId.set(s.menuItemId, { name: s.name, qty: s.quantity });
    }
  }
  return Array.from(byId.values()).map(({ name, qty }) => ({
    name,
    qty: qty * comboQty,
  }));
}

// ─── ESC/POS kitchen ticket ────────────────────────────────────────────────────

function renderKitchenLines(t: TicketBuilder, lines: OrderLine[]) {
  for (const l of lines) {
    t.bold(true).line(`${l.quantity}x ${l.name}`).bold(false);
    if (l.modifiers?.length) for (const m of l.modifiers) wrap(`+ ${m}`, 4).forEach((w) => t.line(w));
    if (l.notes) wrap(`* ${l.notes}`, 4).forEach((w) => t.line(w));
    // Combo components: collapse same-item picks and print indented beneath the combo line.
    if (l.comboSelections?.length) {
      const collapsed = collapseComboSelections(l.comboSelections, l.quantity);
      for (const { name, qty } of collapsed) {
        t.line(`  - ${qty}x ${name}`);
      }
    }
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
      if (tmpl?.businessName) t.sizeN(style.size).bold(style.bold).line(tmpl.businessName).sizeN(1).bold(false);
      t.sizeN(style.size).bold(style.bold).line(title).sizeN(1).bold(false).left();
      if (tmpl?.logoUrl && tmpl.logoPosition !== "before_name") escLogo(t, tmpl, style.align);
      break;
    }
    case "orderNumber":
      t.bold(style.bold).sizeN(style.size).line(`ORDER #${p.header.orderNumber}`).sizeN(1).bold(false);
      break;
    case "guestName":
      t.bold(style.bold).sizeN(style.size).line(`Guest: ${p.header.guestName}`).sizeN(1).bold(false);
      break;
    case "tableNumber":
      if (p.header.tableNumber) t.bold(style.bold).sizeN(style.size).line(`Table: ${p.header.tableNumber}`).sizeN(1).bold(false);
      break;
    case "timestamp":
      t.bold(style.bold).sizeN(style.size).line(`Time:  ${fmtTime(new Date(p.header.placedAt))}`).sizeN(1).bold(false);
      break;
    case "source":
      t.bold(style.bold).sizeN(style.size).line(`Source: ${p.header.source}`).sizeN(1).bold(false);
      break;
    case "items":
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
  t.left().line();
  const order = resolveOrder(tmpl, "kitchen_ticket");
  const dchar = tmpl?.dividerChar ?? "-";
  for (const section of order) {
    const style = resolveStyle(tmpl, "kitchen_ticket", section);
    if (!style.visible) continue;
    if (style.dividerBefore) t.left().div(dchar);
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
      if (bizName) t.bold(style.bold).sizeN(style.size).line(bizName).sizeN(1).bold(false);
      if (tmpl?.logoUrl && tmpl.logoPosition !== "before_name") escLogo(t, tmpl, style.align);
      if (!bizName && tmpl?.logoUrl) escLogo(t, tmpl, style.align);
      break;
    }
    case "timestamp":
      t.bold(style.bold).sizeN(style.size).line(fmtTime(new Date(p.header.placedAt))).sizeN(1).bold(false);
      break;
    case "orderNumber":
      t.bold(style.bold).sizeN(style.size).line(`Order #${p.header.orderNumber}`).sizeN(1).bold(false);
      break;
    case "guestName":
      t.bold(style.bold).sizeN(style.size).line(`Guest: ${p.header.guestName}`).sizeN(1).bold(false);
      break;
    case "tableNumber":
      if (p.header.tableNumber) t.bold(style.bold).sizeN(style.size).line(`Table: ${p.header.tableNumber}`).sizeN(1).bold(false);
      break;
    case "items":
      for (const l of p.lines) {
        const right = l.unitPrice != null ? `$${(l.unitPrice * l.quantity).toFixed(2)}` : "";
        t.line(pad(`${l.quantity}x ${l.name}`, right));
        if (l.modifiers?.length) for (const m of l.modifiers) t.line(`   + ${m}`);
      }
      break;
    case "totals":
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
  t.left().line();
  const order = resolveOrder(tmpl, "customer_receipt");
  const dchar = tmpl?.dividerChar ?? "-";
  for (const section of order) {
    const style = resolveStyle(tmpl, "customer_receipt", section);
    if (!style.visible) continue;
    if (style.dividerBefore) t.left().div(dchar);
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
    case "header":
      if (tmpl?.businessName) t.sizeN(style.size).bold(style.bold).line(tmpl.businessName).sizeN(1).bold(false);
      break;
    case "orderNumber":
      t.bold(style.bold).sizeN(style.size).line(`#${p.orderNumber}`).sizeN(1).bold(false);
      break;
    case "guestName":
      t.bold(style.bold).sizeN(style.size).line(`Guest: ${p.guestName}`).sizeN(1).bold(false);
      break;
    case "items":
      t.bold(style.bold).sizeN(style.size);
      wrap(`${p.quantity}x ${p.itemName}`).forEach((w) => t.line(w));
      t.sizeN(1).bold(false);
      if (p.isFullBox) t.line("[FULL BOX]");
      if (p.modifiers?.length) for (const m of p.modifiers) wrap(`+ ${m}`, 2).forEach((w) => t.line(w));
      if (p.partOfCombo) t.line(`Part of: ${p.partOfCombo}`);
      if (p.notes) {
        t.div(dchar);
        wrap(p.notes).forEach((w) => t.line(w));
      }
      break;
    case "timestamp":
      t.bold(style.bold).sizeN(style.size).line(fmtTime(new Date(p.placedAt))).sizeN(1).bold(false);
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
  t.bold(false).sizeN(1).left().line();
  const order = resolveOrder(tmpl, "item_label");
  const dchar = tmpl?.dividerChar ?? "-";
  for (const section of order) {
    const style = resolveStyle(tmpl, "item_label", section);
    if (!style.visible) continue;
    if (style.dividerBefore) t.left().div(dchar);
    renderItemLabelSection(t, p, section, style, tmpl);
    if (style.dividerAfter) t.left().div(dchar);
  }
  if (p.labelIndex !== undefined && p.labelTotal !== undefined) {
    t.align("right").bold(true).sizeN(1).line(`BOX ${p.labelIndex} of ${p.labelTotal}`).bold(false).left();
  }
  return t.cut();
}

// ─── ESC/POS combo label ───────────────────────────────────────────────────────

function renderComboLabelSection(
  t: TicketBuilder,
  p: ComboLabelPayload,
  section: SectionKey,
  style: ResolvedStyle,
  tmpl?: PrintTemplate,
): void {
  const dchar = tmpl?.dividerChar ?? "-";
  t.align(style.align);
  switch (section) {
    case "header":
      if (tmpl?.businessName) t.sizeN(style.size).bold(style.bold).line(tmpl.businessName).sizeN(1).bold(false);
      break;
    case "orderNumber":
      t.bold(style.bold).sizeN(style.size).line(`#${p.orderNumber}`).sizeN(1).bold(false);
      break;
    case "guestName":
      t.bold(style.bold).sizeN(style.size).line(`Guest: ${p.guestName}`).sizeN(1).bold(false);
      break;
    case "items": {
      // Combo name — large and bold
      t.bold(style.bold).sizeN(style.size);
      wrap(p.comboName).forEach((w) => t.line(w));
      t.sizeN(1).bold(false);
      t.div(dchar);
      // Collapsed component lines
      const collapsed = collapseComboSelections(p.comboSelections, 1);
      for (const { name, qty } of collapsed) {
        t.line(`  ${qty}x ${name}`);
      }
      break;
    }
    case "timestamp":
      t.bold(style.bold).sizeN(style.size).line(fmtTime(new Date(p.placedAt))).sizeN(1).bold(false);
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

function renderComboLabel(p: ComboLabelPayload, tmpl?: PrintTemplate): Buffer {
  const t = new TicketBuilder();
  t.bold(false).sizeN(1).left().line();
  const order = resolveOrder(tmpl, "combo_label");
  const dchar = tmpl?.dividerChar ?? "-";
  for (const section of order) {
    const style = resolveStyle(tmpl, "combo_label", section);
    if (!style.visible) continue;
    if (style.dividerBefore) t.left().div(dchar);
    renderComboLabelSection(t, p, section, style, tmpl);
    if (style.dividerAfter) t.left().div(dchar);
  }
  if (p.labelIndex !== undefined && p.labelTotal !== undefined) {
    t.align("right").bold(true).sizeN(1).line(`${p.labelIndex} of ${p.labelTotal}`).bold(false).left();
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
      t.bold(style.bold).sizeN(style.size).line(`#${p.orderNumber}`).sizeN(1).bold(false);
      break;
    case "guestName":
      t.bold(style.bold).sizeN(style.size).line(`Guest: ${p.guestName}`).sizeN(1).bold(false);
      break;
    case "items":
      t.bold(style.bold).sizeN(style.size).line(p.plateLabel).sizeN(1).bold(false);
      t.div(dchar);
      for (const l of p.lines) {
        t.bold(true).line(`${l.quantity}x ${l.name}`).bold(false);
        if (l.modifiers?.length) for (const m of l.modifiers) t.line(`  + ${m}`);
        if (l.notes) wrap(`* ${l.notes}`, 2).forEach((w) => t.line(w));
      }
      break;
    case "timestamp":
      t.bold(style.bold).sizeN(style.size).line(fmtTime(new Date(p.placedAt))).sizeN(1).bold(false);
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
  t.bold(false).sizeN(1).left().line();
  const order = resolveOrder(tmpl, "plate_label");
  const dchar = tmpl?.dividerChar ?? "-";
  for (const section of order) {
    const style = resolveStyle(tmpl, "plate_label", section);
    if (!style.visible) continue;
    if (style.dividerBefore) t.left().div(dchar);
    renderPlateLabelSection(t, p, section, style, tmpl);
    if (style.dividerAfter) t.left().div(dchar);
  }
  return t.cut();
}

function renderCashDrawerOpen(): Buffer {
  // ESC p pin onTime offTime — opens cash drawer on pin 2 (0x00) with
  // a 200 ms pulse (0x19 = 25 × 8 ms = 200 ms, 0xFA = 250 × 2 ms off).
  return Buffer.from([ESC, 0x70, 0x00, 0x19, 0xfa]);
}

function renderTest(p: TestPayload): Buffer {
  const t = new TicketBuilder();
  t.center().bold(true).sizeN(2).line("TEST PRINT").sizeN(1).bold(false).left();
  t.div("=");
  t.line(`Printer: ${p.printerName}`);
  t.line(`Time:    ${fmtTime(new Date())}`);
  t.div();
  t.line(p.message ?? "If you can read this, LAN printing works.");
  t.line();
  t.line("- Bold:");
  t.bold(true).line("    The quick brown fox").bold(false);
  t.line("- Double:");
  t.sizeN(2).line(" 80mm test").sizeN(1);
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
    case "combo_label":      bytes = renderComboLabel(payload, template); break;
    case "plate_label":      bytes = renderPlateLabel(payload, template); break;
    case "cash_drawer":      bytes = renderCashDrawerOpen(); break;
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
  /** Tracks current bold state to suppress no-op <Bold> tags that cause stray 'F' characters. */
  private _bold = false;

  text(s: string) { if (s) this.cmds.push(`<Text>${xmlEsc(s)}</Text>`); return this; }
  line(s = "")    { this.cmds.push(`<Text>${xmlEsc(s)}\n</Text>`); return this; }
  bold(on: boolean) {
    if (this._bold === on) return this;
    this._bold = on;
    this.cmds.push(on ? `<Bold on="true"/>` : `<Bold on="false"/>`);
    return this;
  }
  sizeN(n: number) {
    const capped = Math.max(1, Math.min(2, Math.round(n)));
    this.cmds.push(capped >= 2
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
  /** Resets all print settings to default (bold off, size 1, left align). Safe to call at label start. */
  initialize() { this.cmds.push(`<Initialize/>`); this._bold = false; return this; }
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
    // Combo components: collapse same-item picks and print indented beneath the combo line.
    if (l.comboSelections?.length) {
      const collapsed = collapseComboSelections(l.comboSelections, l.quantity);
      for (const { name, qty } of collapsed) {
        b.line(`  - ${qty}x ${name}`);
      }
    }
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
      if (tmpl?.businessName) b.sizeN(style.size).bold(style.bold).line(tmpl.businessName).sizeN(1).bold(false);
      b.sizeN(style.size).bold(style.bold).line(title).sizeN(1).bold(false).left();
      if (tmpl?.logoUrl && tmpl.logoPosition !== "before_name") webLogo(b, tmpl, style.align);
      break;
    }
    case "orderNumber":
      b.bold(style.bold).sizeN(style.size).line(`ORDER #${p.header.orderNumber}`).sizeN(1).bold(false);
      break;
    case "guestName":
      b.bold(style.bold).sizeN(style.size).line(`Guest: ${p.header.guestName}`).sizeN(1).bold(false);
      break;
    case "tableNumber":
      if (p.header.tableNumber) b.bold(style.bold).sizeN(style.size).line(`Table: ${p.header.tableNumber}`).sizeN(1).bold(false);
      break;
    case "timestamp":
      b.bold(style.bold).sizeN(style.size).line(`Time:  ${fmtTime(new Date(p.header.placedAt))}`).sizeN(1).bold(false);
      break;
    case "source":
      b.bold(style.bold).sizeN(style.size).line(`Source: ${p.header.source}`).sizeN(1).bold(false);
      break;
    case "items":
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
    if (style.dividerBefore) b.left().div(dchar);
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
      if (bizName) b.bold(style.bold).sizeN(style.size).line(bizName).sizeN(1).bold(false);
      if (tmpl?.logoUrl && tmpl.logoPosition !== "before_name") webLogo(b, tmpl, style.align);
      if (!bizName && tmpl?.logoUrl) webLogo(b, tmpl, style.align);
      break;
    }
    case "timestamp":
      b.bold(style.bold).sizeN(style.size).line(fmtTime(new Date(p.header.placedAt))).sizeN(1).bold(false);
      break;
    case "orderNumber":
      b.bold(style.bold).sizeN(style.size).line(`Order #${p.header.orderNumber}`).sizeN(1).bold(false);
      break;
    case "guestName":
      b.bold(style.bold).sizeN(style.size).line(`Guest: ${p.header.guestName}`).sizeN(1).bold(false);
      break;
    case "tableNumber":
      if (p.header.tableNumber) b.bold(style.bold).sizeN(style.size).line(`Table: ${p.header.tableNumber}`).sizeN(1).bold(false);
      break;
    case "items":
      for (const l of p.lines) {
        const right = l.unitPrice != null ? `$${(l.unitPrice * l.quantity).toFixed(2)}` : "";
        b.line(pad(`${l.quantity}x ${l.name}`, right));
        if (l.modifiers?.length) for (const m of l.modifiers) b.line(`   + ${m}`);
      }
      break;
    case "totals":
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
    if (style.dividerBefore) b.left().div(dchar);
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
    case "header":
      // No trailing bold(false): with non-bold sections first in DEFAULT_ORDERS, the next
      // section is always bold too (orderNumber / items), so no bold→non-bold transition occurs.
      if (tmpl?.businessName) b.sizeN(style.size).bold(style.bold).line(tmpl.businessName).sizeN(1).left();
      break;
    case "orderNumber":
      b.bold(style.bold).sizeN(style.size).line(`#${p.orderNumber}`).sizeN(1);
      break;
    case "guestName":
      b.bold(style.bold).sizeN(style.size).line(`Guest: ${p.guestName}`).sizeN(1);
      break;
    case "items":
      b.bold(style.bold).sizeN(style.size);
      wrap(`${p.quantity}x ${p.itemName}`).forEach((w) => b.line(w));
      b.sizeN(1);
      if (p.isFullBox) b.line("[FULL BOX]");
      if (p.modifiers?.length) for (const m of p.modifiers) wrap(`+ ${m}`, 2).forEach((w) => b.line(w));
      if (p.partOfCombo) b.line(`Part of: ${p.partOfCombo}`);
      if (p.notes) {
        b.div(dchar);
        wrap(p.notes).forEach((w) => b.line(w));
      }
      break;
    case "timestamp":
      b.bold(style.bold).sizeN(style.size).line(fmtTime(new Date(p.placedAt))).sizeN(1);
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
  b.initialize();
  const order = resolveOrder(tmpl, "item_label");
  const dchar = tmpl?.dividerChar ?? "-";
  for (const section of order) {
    const style = resolveStyle(tmpl, "item_label", section);
    if (!style.visible) continue;
    if (style.dividerBefore) b.left().div(dchar);
    webItemLabelSection(b, p, section, style, tmpl);
    if (style.dividerAfter) b.left().div(dchar);
  }
  return b.build();
}

// ─── StarWebPRNT combo label ───────────────────────────────────────────────────

function webComboLabelSection(
  b: WebPrntBuilder,
  p: ComboLabelPayload,
  section: SectionKey,
  style: ResolvedStyle,
  tmpl?: PrintTemplate,
): void {
  const dchar = tmpl?.dividerChar ?? "-";
  b.align(style.align);
  switch (section) {
    case "header":
      if (tmpl?.businessName) b.sizeN(style.size).bold(style.bold).line(tmpl.businessName).sizeN(1).left();
      break;
    case "orderNumber":
      b.bold(style.bold).sizeN(style.size).line(`#${p.orderNumber}`).sizeN(1);
      break;
    case "guestName":
      b.bold(style.bold).sizeN(style.size).line(`Guest: ${p.guestName}`).sizeN(1);
      break;
    case "items": {
      b.bold(style.bold).sizeN(style.size);
      wrap(p.comboName).forEach((w) => b.line(w));
      // No bold(false) here: remaining content (divider, selections) stays bold for
      // visual consistency; size returns to 1 so the combo name stands out by size alone.
      b.sizeN(1);
      b.div(dchar);
      const collapsed = collapseComboSelections(p.comboSelections, 1);
      for (const { name, qty } of collapsed) {
        b.line(`  ${qty}x ${name}`);
      }
      break;
    }
    case "timestamp":
      b.bold(style.bold).sizeN(style.size).line(fmtTime(new Date(p.placedAt))).sizeN(1);
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

function webPrntComboLabel(p: ComboLabelPayload, tmpl?: PrintTemplate): string {
  const b = new WebPrntBuilder();
  b.initialize();
  const order = resolveOrder(tmpl, "combo_label");
  const dchar = tmpl?.dividerChar ?? "-";
  for (const section of order) {
    const style = resolveStyle(tmpl, "combo_label", section);
    if (!style.visible) continue;
    if (style.dividerBefore) b.left().div(dchar);
    webComboLabelSection(b, p, section, style, tmpl);
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
      b.bold(style.bold).sizeN(style.size).line(`#${p.orderNumber}`).sizeN(1);
      break;
    case "guestName":
      b.bold(style.bold).sizeN(style.size).line(`Guest: ${p.guestName}`).sizeN(1);
      break;
    case "items":
      // Plate label: bold=true at size=2 for the plate header, then size=1 for line items.
      // No bold(false) after header — line items and modifiers remain bold at size=1 so
      // we never emit <Bold on="false"/> (which prints a stray 'F' on Star firmware).
      b.bold(style.bold).sizeN(style.size).line(p.plateLabel).sizeN(1);
      b.div(dchar);
      for (const l of p.lines) {
        b.line(`${l.quantity}x ${l.name}`);
        if (l.modifiers?.length) for (const m of l.modifiers) b.line(`  + ${m}`);
        if (l.notes) wrap(`* ${l.notes}`, 2).forEach((w) => b.line(w));
      }
      break;
    case "timestamp":
      b.bold(style.bold).sizeN(style.size).line(fmtTime(new Date(p.placedAt))).sizeN(1);
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
  b.initialize();
  const order = resolveOrder(tmpl, "plate_label");
  const dchar = tmpl?.dividerChar ?? "-";
  for (const section of order) {
    const style = resolveStyle(tmpl, "plate_label", section);
    if (!style.visible) continue;
    if (style.dividerBefore) b.left().div(dchar);
    webPlateLabelSection(b, p, section, style, tmpl);
    if (style.dividerAfter) b.left().div(dchar);
  }
  return b.build();
}

// ─── StarWebPRNT test page ─────────────────────────────────────────────────────

function webPrntTest(p: TestPayload): string {
  const b = new WebPrntBuilder();
  b.center().bold(true).sizeN(2).line("TEST PRINT").sizeN(1).bold(false).left();
  b.div("=");
  b.line(`Printer: ${p.printerName}`);
  b.line(`Time:    ${fmtTime(new Date())}`);
  b.div();
  b.line(p.message ?? "If you can read this, LAN printing works.");
  b.line();
  b.line("- Bold:");
  b.bold(true).line("    The quick brown fox").bold(false);
  b.line("- Double:");
  b.sizeN(2).line(" 80mm test").sizeN(1);
  return b.build();
}

// ─── StarWebPRNT cash drawer ───────────────────────────────────────────────────

function webPrntCashDrawer(): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<StarWebPRNT:Request Version="1.00" xmlns:StarWebPRNT="http://www.star-m.jp/StarWebPRNT/V1.00/">` +
    `<PrintData><Printer>` +
    `<PeripheralDevice type="CashDrawer" no="1" openTime="200"/>` +
    `</Printer></PrintData>` +
    `</StarWebPRNT:Request>`
  );
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
    case "combo_label":      return webPrntComboLabel(payload, template);
    case "plate_label":      return webPrntPlateLabel(payload, template);
    case "cash_drawer":      return webPrntCashDrawer();
    case "test":             return webPrntTest(payload);
  }
}
