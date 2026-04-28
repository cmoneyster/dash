import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import { getAdminToken } from "@/components/AdminGuard";
import {
  Plus, Loader2, X, Save, Trash2, ChevronRight, CalendarDays,
  User, Mail, Phone, Building2, MapPin, Users, FileText, StickyNote, Check,
  Search, ShoppingCart, Receipt, Download, Send, MessageSquare, Copy, Link as LinkIcon,
  GripVertical, CreditCard, RefreshCw, ExternalLink, Ban, Lock, Flame, Truck,
} from "lucide-react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils";
import {
  computeEffectivePriceDetail,
  computeOtdSetupFeeRow,
  computeOtdSetupFeeWaivedDisplay,
  otdSetupFeeRowEquals,
  OTD_SETUP_FEE_ID,
  computeUninvoicedDelta,
} from "@workspace/pricing";
import { TAX_DISCLOSURE } from "@/lib/tax";
import { formatLocalDate, isDateOnlyString } from "@/lib/date";
import { VenueAutocomplete } from "@/components/VenueAutocomplete";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authHeaders() {
  const token = getAdminToken();
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

const STATUSES = [
  { key: "inquiry", label: "Inquiry", color: "bg-blue-100 text-blue-700" },
  { key: "quoted", label: "Quoted", color: "bg-violet-100 text-violet-700" },
  { key: "confirmed", label: "Confirmed", color: "bg-emerald-100 text-emerald-700" },
  { key: "completed", label: "Completed", color: "bg-secondary text-muted-foreground" },
  { key: "cancelled", label: "Cancelled", color: "bg-red-100 text-red-600" },
];

function getStatusMeta(key: string) {
  return STATUSES.find(s => s.key === key) ?? { key, label: key, color: "bg-secondary text-muted-foreground" };
}

type OrderItem = {
  name: string;
  quantity: number;
  price: number;
  // Optional sizing/unit snapshot the server captures from the cart at
  // checkout. Older inquiries created before this snapshot was added
  // leave these undefined and render with just the bare name.
  pricingTemplate?: "per_unit" | "pan_sizes" | null;
  sizeSlot?: number | null;
  sizeLabel?: string | null;
  sizeServings?: number | null;
  unit?: string | null;
  servingSize?: number | null;
};

type QuoteLineItem = {
  id: string;
  menuItemId: number | null;
  name: string;
  quantity: number;
  unitPrice: number;
  notes?: string | null;
  pricingTemplate?: "per_unit" | "pan_sizes" | null;
  sizeSlot?: number | null;
  sizeLabel?: string | null;
  sizeServings?: number | null;
  unit?: string | null;
  servingSize?: number | null;
  tierApplied?: boolean | null;
  priceMode?: "auto" | "manual" | null;
};

type QuoteAdjustment = {
  id: string;
  label: string;
  kind: "fixed" | "percent";
  amount: number;
};

type QuoteReply = {
  id: string;
  channel: "email" | "sms";
  message: string;
  sentAt: string;
  sentTo: string;
};

type Inquiry = {
  id: number;
  clientName: string;
  clientEmail: string | null;
  clientPhone: string | null;
  organization: string | null;
  eventDate: string | null;
  guestCount: number | null;
  venueAddress: string | null;
  menuNotes: string | null;
  adminNotes: string | null;
  status: string;
  source: string;
  serviceMode: string | null;
  otdSetupFee: string | null;
  otdFeeWaiverThreshold: string | null;
  otdIncludedHours: string | null;
  otdAdditionalHourRate: string | null;
  otdMaxAdditionalHours: number | null;
  orderItems: OrderItem[] | null;
  orderTotal: string | null;
  lineItems: QuoteLineItem[] | null;
  fees: QuoteAdjustment[] | null;
  discounts: QuoteAdjustment[] | null;
  subtotal: string | null;
  feesTotal: string | null;
  discountsTotal: string | null;
  total: string | null;
  quoteNumber: string | null;
  quoteToken: string | null;
  quoteIssuedAt: string | null;
  quoteExpiresAt: string | null;
  quoteLastEmailedAt: string | null;
  quoteLastTextedAt: string | null;
  quoteNotes: string | null;
  quoteAcceptedAt: string | null;
  quoteChangeRequestAt: string | null;
  quoteChangeRequestMessage: string | null;
  quoteChangeRequestRespondedAt: string | null;
  quoteReplies: QuoteReply[] | null;
  squareInvoiceId: string | null;
  squareInvoiceStatus: string | null;
  squareHostedUrl: string | null;
  squareAmountPaid: string | null;
  squareBalanceDue: string | null;
  squareDepositKind: "percent" | "fixed" | null;
  squareDepositValue: string | null;
  squareDueAt: string | null;
  squareDepositPaidAt: string | null;
  squarePaidInFullAt: string | null;
  // Snapshot of the quote arrays as of the moment the primary invoice was
  // published. Used as the baseline for the supplemental "uninvoiced delta"
  // computation. Null when no primary has ever been issued (or when the
  // primary was issued before this column existed).
  primarySnapshotLineItems: QuoteLineItem[] | null;
  primarySnapshotFees: QuoteAdjustment[] | null;
  primarySnapshotDiscounts: QuoteAdjustment[] | null;
  // Server-embedded child rows for the supplemental-invoice flow.
  supplementals: SupplementalInvoice[];
  createdAt: string;
  updatedAt: string;
};

type SupplementalInvoice = {
  id: number;
  cateringInquiryId: number;
  seq: number;
  squareInvoiceId: string;
  squareInvoiceVersion: number | null;
  squareOrderId: string | null;
  squareInvoiceStatus: string | null;
  squareHostedUrl: string | null;
  squareAmountPaid: string | null;
  squareBalanceDue: string | null;
  squareDueAt: string | null;
  squarePaidInFullAt: string | null;
  linesSnapshot: {
    lineItems: QuoteLineItem[];
    fees: QuoteAdjustment[];
    discounts: QuoteAdjustment[];
  };
  amountTotal: string;
  createdAt: string;
  updatedAt: string;
};

type AdminMenuItemSize = {
  slot: number;
  label: string;
  servings: number | null;
  price: number;
};
type AdminMenuItem = {
  id: number;
  name: string;
  category: string;
  price: number;
  pricingTemplate: "per_unit" | "pan_sizes";
  unit: string | null;
  servingSize: number | null;
  sizes: AdminMenuItemSize[]; // populated only for pan_sizes
  tier2Qty: number | null;
  tier2Price: number | null;
  tier3Qty: number | null;
  tier3Price: number | null;
  otdEligible: boolean;
};

function emptyForm(): Partial<Inquiry> {
  return {
    clientName: "", clientEmail: "", clientPhone: "", organization: "",
    eventDate: "", guestCount: undefined, venueAddress: "", menuNotes: "", adminNotes: "", status: "inquiry",
    source: "form", orderItems: null, orderTotal: null,
    lineItems: [], fees: [], discounts: [],
    quoteNotes: "", quoteExpiresAt: null,
  };
}

function formatDate(d: string | null | undefined) {
  if (!d) return null;
  try {
    if (isDateOnlyString(d)) {
      return formatLocalDate(d);
    }
    const date = new Date(d);
    if (isNaN(date.getTime())) return d;
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch { return d; }
}

function formatDateTime(d: string | null | undefined) {
  if (!d) return null;
  try {
    const date = new Date(d);
    if (isNaN(date.getTime())) return d;
    return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch { return d; }
}

function uid() {
  // Browsers support crypto.randomUUID in modern envs.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Structural equality for plain JSON-shaped values (objects, arrays,
// primitives). Used to compare the inquiry editor form against the last
// persisted snapshot so we can drive the "Unsaved changes" pill and the
// auto-save-before-quote-action behavior. JSON.stringify is unreliable
// here because key ordering can differ across object spreads.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ka = Object.keys(ao);
  const kb = Object.keys(bo);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

function round2(n: number) { return Math.round(n * 100) / 100; }

function computeTotalsClient(items: QuoteLineItem[], fees: QuoteAdjustment[], discounts: QuoteAdjustment[]) {
  const subtotal = round2(items.reduce((s, li) => s + (Number(li.quantity) || 0) * (Number(li.unitPrice) || 0), 0));
  const feesArr = fees.map(f => ({
    ...f,
    computed: f.kind === "percent" ? round2(subtotal * (Number(f.amount) || 0) / 100) : round2(Number(f.amount) || 0),
  }));
  const feesTotal = round2(feesArr.reduce((s, f) => s + f.computed, 0));
  const baseAfterFees = subtotal + feesTotal;
  const discArr = discounts.map(d => ({
    ...d,
    computed: d.kind === "percent" ? round2(baseAfterFees * (Number(d.amount) || 0) / 100) : round2(Number(d.amount) || 0),
  }));
  const discountsTotal = round2(discArr.reduce((s, d) => s + d.computed, 0));
  const total = round2(Math.max(0, subtotal + feesTotal - discountsTotal));
  return { subtotal, feesTotal, discountsTotal, total, feesArr, discArr };
}

function Field({ icon: Icon, label, children }: { icon: any; label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
        <Icon className="w-3.5 h-3.5" /> {label}
      </label>
      {children}
    </div>
  );
}

function OrderItemsTable({ items, total }: { items: OrderItem[]; total: string | null }) {
  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <div className="bg-secondary/40 px-4 py-2 border-b border-border flex items-center gap-2">
        <ShoppingCart className="w-3.5 h-3.5 text-primary" />
        <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Cart Order Items</span>
      </div>
      <table className="w-full text-sm">
        <thead className="border-b border-border bg-secondary/20">
          <tr className="text-left text-xs text-muted-foreground">
            <th className="px-4 py-2 font-semibold">Item</th>
            <th className="px-4 py-2 font-semibold text-center">Qty</th>
            <th className="px-4 py-2 font-semibold text-right">Unit</th>
            <th className="px-4 py-2 font-semibold text-right">Subtotal</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => {
            // Reuse the same descriptor helper the editable Quote
            // Builder rows use so "Medium Pan · 30 servings" / "tray
            // of 12" reads identically to the cook on both surfaces.
            // Older inquiries (pre-snapshot) return null here and just
            // render the item name on its own — no layout change.
            const descriptor = lineItemDescriptor(item);
            return (
              <tr key={i} className="border-b border-border/50 last:border-0">
                <td className="px-4 py-2.5 font-medium">
                  <div>{item.name}</div>
                  {descriptor && (
                    <div className="text-xs font-normal text-muted-foreground mt-0.5">{descriptor}</div>
                  )}
                </td>
                <td className="px-4 py-2.5 text-center align-top">{item.quantity}</td>
                <td className="px-4 py-2.5 text-right align-top text-muted-foreground">{formatCurrency(item.price)}</td>
                <td className="px-4 py-2.5 text-right align-top font-semibold">{formatCurrency(item.price * item.quantity)}</td>
              </tr>
            );
          })}
        </tbody>
        {total && (
          <tfoot>
            <tr className="border-t-2 border-border bg-secondary/20">
              <td colSpan={3} className="px-4 py-2.5 text-sm font-bold text-right">Total</td>
              <td className="px-4 py-2.5 text-right font-bold text-primary">{total}</td>
            </tr>
            <tr>
              <td colSpan={4} className="px-4 pb-2 text-xs text-muted-foreground text-right">{TAX_DISCLOSURE}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

// ── Quote Editor section ─────────────────────────────────────────────────────

// Build the descriptor shown under a line item name (admin Cart Order
// Items table, admin Quote Editor row, and the public quote page). The
// parameter is the structural subset of fields we read so the same
// helper handles both QuoteLineItem (editable quote line) and OrderItem
// (read-only cart snapshot) without one type having to import the
// other.
function lineItemDescriptor(li: {
  pricingTemplate?: "per_unit" | "pan_sizes" | null;
  sizeLabel?: string | null;
  sizeServings?: number | null;
  unit?: string | null;
  servingSize?: number | null;
}): string | null {
  if (li.pricingTemplate === "pan_sizes" && li.sizeLabel) {
    return li.sizeServings != null
      ? `${li.sizeLabel} · ${li.sizeServings} servings`
      : li.sizeLabel;
  }
  if (li.unit) {
    return li.servingSize && li.servingSize > 1
      ? `${li.unit} of ${li.servingSize}`
      : `per ${li.unit}`;
  }
  return null;
}

// Compute the appropriate per-unit price for a given quantity, picking the
// best matching tier break. Returns the price + whether a tier was applied.
// Delegates to the shared `@workspace/pricing` helper so the admin quote
// editor can never drift from the customer cart preview or the server-side
// order checkout (see lib/pricing).
function priceForQuantity(m: AdminMenuItem, qty: number): { price: number; tierApplied: boolean } {
  const { price, tier } = computeEffectivePriceDetail(m, qty, null);
  return { price, tierApplied: tier === "tier2" || tier === "tier3" };
}

function MenuPicker({ menu, onPick }: {
  menu: AdminMenuItem[];
  onPick: (item: AdminMenuItem, size?: AdminMenuItemSize) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [sizingFor, setSizingFor] = useState<AdminMenuItem | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSizingFor(null);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return menu.slice(0, 8);
    return menu.filter(m =>
      m.name.toLowerCase().includes(needle) || (m.category ?? "").toLowerCase().includes(needle),
    ).slice(0, 12);
  }, [menu, q]);

  function handleClick(m: AdminMenuItem) {
    if (m.pricingTemplate === "pan_sizes" && m.sizes.length > 0) {
      setSizingFor(m);
      return;
    }
    onPick(m);
    setQ(""); setOpen(false); setSizingFor(null);
  }

  function handleSize(m: AdminMenuItem, s: AdminMenuItemSize) {
    onPick(m, s);
    setQ(""); setOpen(false); setSizingFor(null);
  }

  return (
    <div className="relative" ref={ref}>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        <input
          value={q}
          onFocus={() => { setOpen(true); setSizingFor(null); }}
          onChange={e => { setQ(e.target.value); setOpen(true); setSizingFor(null); }}
          placeholder="Search menu items to add…"
          className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-xl bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
        />
      </div>
      {open && sizingFor && (
        <div className="absolute z-20 left-0 right-0 mt-1 bg-card border border-border rounded-xl shadow-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">{sizingFor.name}</p>
            <button
              type="button"
              onClick={() => setSizingFor(null)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              ← back
            </button>
          </div>
          <p className="text-xs text-muted-foreground">Choose a size</p>
          <div className="grid grid-cols-1 gap-1.5">
            {sizingFor.sizes.map(s => (
              <button
                key={s.slot}
                type="button"
                onClick={() => handleSize(sizingFor, s)}
                className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-sm border border-border rounded-lg hover:bg-secondary"
              >
                <div className="min-w-0">
                  <p className="font-medium truncate">{s.label}</p>
                  {s.servings != null && (
                    <p className="text-xs text-muted-foreground">{s.servings} servings</p>
                  )}
                </div>
                <span className="text-sm font-semibold shrink-0">{formatCurrency(s.price)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {open && !sizingFor && filtered.length > 0 && (
        <div className="absolute z-20 left-0 right-0 mt-1 bg-card border border-border rounded-xl shadow-lg max-h-64 overflow-y-auto">
          {filtered.map(m => {
            const isPan = m.pricingTemplate === "pan_sizes" && m.sizes.length > 0;
            const priceLabel = isPan
              ? `from ${formatCurrency(Math.min(...m.sizes.map(s => s.price)))}`
              : formatCurrency(m.price);
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => handleClick(m)}
                className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-secondary"
              >
                <div className="min-w-0">
                  <p className="font-medium truncate">{m.name}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {m.category}{isPan ? " · pick a size" : m.unit ? ` · per ${m.unit}` : ""}
                  </p>
                </div>
                <span className="text-xs font-semibold shrink-0">{priceLabel}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Stable id used for the synthesized "billed OTD extra hours" fee row.
// Using a fixed id lets us upsert/remove the row without ever doubling up
// when staff bumps the stepper, and keeps the line easily distinguishable
// from manually-added fees with the same label.
const OTD_EXTRA_HOURS_FEE_ID = "otd-extra-hours";

function SortableLineItem({
  id,
  children,
}: {
  id: string;
  children: (handle: { listeners: any; attributes: any; isDragging: boolean }) => React.ReactNode;
}) {
  const { setNodeRef, listeners, attributes, transform, transition, isDragging } = useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    background: isDragging ? "var(--card)" : undefined,
    position: isDragging ? "relative" : undefined,
    zIndex: isDragging ? 10 : undefined,
  };
  return (
    <div ref={setNodeRef} style={style} className="space-y-1" data-testid={`line-item-${id}`}>
      {children({ listeners: listeners ?? {}, attributes, isDragging })}
    </div>
  );
}

function QuoteEditor({
  lineItems, fees, discounts, quoteNotes, quoteExpiresAt,
  onChange, menu,
  serviceMode, otdSetupFee, otdFeeWaiverThreshold,
  otdAdditionalHourRate, otdMaxAdditionalHours,
}: {
  lineItems: QuoteLineItem[];
  fees: QuoteAdjustment[];
  discounts: QuoteAdjustment[];
  quoteNotes: string;
  quoteExpiresAt: string | null;
  onChange: (patch: {
    lineItems?: QuoteLineItem[];
    fees?: QuoteAdjustment[];
    discounts?: QuoteAdjustment[];
    quoteNotes?: string;
    quoteExpiresAt?: string | null;
  }) => void;
  menu: AdminMenuItem[];
  serviceMode: string | null;
  otdSetupFee: number | null;
  otdFeeWaiverThreshold: number | null;
  otdAdditionalHourRate: number | null;
  otdMaxAdditionalHours: number | null;
}) {
  const totals = useMemo(() => computeTotalsClient(lineItems, fees, discounts), [lineItems, fees, discounts]);

  const numCls = "w-20 px-2 py-1.5 text-sm text-right border border-border rounded-lg bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none";
  const txtCls = "w-full px-2 py-1.5 text-sm border border-border rounded-lg bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none";

  // Map of menuItemId -> AdminMenuItem for live size/tier lookups on saved lines.
  const menuById = useMemo(() => {
    const map = new Map<number, AdminMenuItem>();
    for (const m of menu) map.set(m.id, m);
    return map;
  }, [menu]);

  function addCustom() {
    onChange({ lineItems: [...lineItems, {
      id: uid(), menuItemId: null, name: "", quantity: 1, unitPrice: 0, notes: null,
      pricingTemplate: null, sizeSlot: null, sizeLabel: null, sizeServings: null,
      unit: null, servingSize: null, tierApplied: false, priceMode: "auto",
    }] });
  }
  function pickMenu(m: AdminMenuItem, size?: AdminMenuItemSize) {
    if (m.pricingTemplate === "pan_sizes" && size) {
      onChange({ lineItems: [...lineItems, {
        id: uid(), menuItemId: m.id,
        name: m.name,
        quantity: 1, unitPrice: size.price, notes: null,
        pricingTemplate: "pan_sizes",
        sizeSlot: size.slot, sizeLabel: size.label, sizeServings: size.servings,
        unit: null, servingSize: null, tierApplied: false, priceMode: "auto",
      }] });
    } else {
      const { price, tierApplied } = priceForQuantity(m, 1);
      onChange({ lineItems: [...lineItems, {
        id: uid(), menuItemId: m.id, name: m.name,
        quantity: 1, unitPrice: price, notes: null,
        pricingTemplate: "per_unit",
        sizeSlot: null, sizeLabel: null, sizeServings: null,
        unit: m.unit, servingSize: m.servingSize,
        tierApplied, priceMode: "auto",
      }] });
    }
  }
  function updateItem(id: string, patch: Partial<QuoteLineItem>) {
    onChange({ lineItems: lineItems.map(li => li.id === id ? { ...li, ...patch } : li) });
  }
  // Quantity change: re-apply tier price for per_unit menu items, but only
  // when the line is still in "auto" pricing mode. A manual price edit flips
  // the line to "manual" so subsequent quantity changes don't clobber it.
  function changeQuantity(id: string, qty: number) {
    const li = lineItems.find(x => x.id === id);
    if (!li) return;
    const m = li.menuItemId != null ? menuById.get(li.menuItemId) : undefined;
    const patch: Partial<QuoteLineItem> = { quantity: qty };
    // Treat legacy rows (no priceMode) as "auto" for backwards compatibility.
    const isAuto = li.priceMode !== "manual";
    if (m && li.pricingTemplate === "per_unit" && isAuto) {
      const { price, tierApplied } = priceForQuantity(m, qty);
      patch.unitPrice = price;
      patch.tierApplied = tierApplied;
    }
    updateItem(id, patch);
  }
  function changeUnitPrice(id: string, price: number) {
    // Manual price override locks the price and clears the tier auto-flag.
    updateItem(id, { unitPrice: price, tierApplied: false, priceMode: "manual" });
  }
  function changeSize(id: string, slot: number) {
    const li = lineItems.find(x => x.id === id);
    if (!li || li.menuItemId == null) return;
    const m = menuById.get(li.menuItemId);
    if (!m) return;
    const s = m.sizes.find(x => x.slot === slot);
    if (!s) return;
    updateItem(id, {
      sizeSlot: s.slot, sizeLabel: s.label, sizeServings: s.servings,
      unitPrice: s.price, tierApplied: false, priceMode: "auto",
    });
  }
  function removeItem(id: string) {
    onChange({ lineItems: lineItems.filter(li => li.id !== id) });
  }
  const lineItemSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  function handleLineItemsDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = lineItems.findIndex(li => li.id === active.id);
    const newIndex = lineItems.findIndex(li => li.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    onChange({ lineItems: arrayMove(lineItems, oldIndex, newIndex) });
  }
  function addAdj(kind: "fee" | "discount") {
    const newRow: QuoteAdjustment = { id: uid(), label: kind === "fee" ? "Fee" : "Discount", kind: "fixed", amount: 0 };
    if (kind === "fee") onChange({ fees: [...fees, newRow] });
    else onChange({ discounts: [...discounts, newRow] });
  }

  // OTD billed-extra-hours stepper state. We derive the current count from
  // the synthesized fee row (if any) by dividing by the snapshot rate so
  // re-opens of an existing inquiry pick up where we left off.
  const isOtd = serviceMode === "on_the_dash";
  const otdRate = otdAdditionalHourRate != null && Number.isFinite(otdAdditionalHourRate)
    ? otdAdditionalHourRate
    : null;
  const otdMax = otdMaxAdditionalHours != null && Number.isFinite(otdMaxAdditionalHours)
    ? Math.max(0, Math.floor(otdMaxAdditionalHours))
    : null;
  const otdExtraHoursRow = fees.find(f => f.id === OTD_EXTRA_HOURS_FEE_ID) ?? null;
  // Capture every synthesized OTD row that lives outside the editable
  // Fees list. Manual fee edit/remove handlers must re-attach these so
  // a save flush can never serialize a fees array missing them — we
  // can't rely on the auto-sync useEffect re-running before the patch
  // gets debounced to the server.
  const synthesizedOtdRows = fees.filter(f =>
    f.id === OTD_EXTRA_HOURS_FEE_ID || f.id === OTD_SETUP_FEE_ID,
  );
  const otdExtraHours = (() => {
    if (!otdExtraHoursRow || otdRate == null || otdRate <= 0) return 0;
    const n = Math.round(Number(otdExtraHoursRow.amount) / otdRate);
    if (!Number.isFinite(n) || n < 0) return 0;
    if (otdMax != null) return Math.min(n, otdMax);
    return n;
  })();
  function setOtdExtraHours(nRaw: number) {
    if (otdRate == null) return;
    let n = Math.max(0, Math.floor(nRaw));
    if (otdMax != null) n = Math.min(n, otdMax);
    const otherFees = fees.filter(f => f.id !== OTD_EXTRA_HOURS_FEE_ID);
    if (n === 0) {
      onChange({ fees: otherFees });
      return;
    }
    const row: QuoteAdjustment = {
      id: OTD_EXTRA_HOURS_FEE_ID,
      label: `On the Dash — ${n} extra staff hour${n === 1 ? "" : "s"}`,
      kind: "fixed",
      amount: round2(otdRate * n),
    };
    onChange({ fees: [...otherFees, row] });
  }
  // Hide the synthesized OTD rows from the regular Fees editor so they
  // can't be hand-edited (any manual edit would drift from the snapshot
  // / stepper). Totals + PDF still pull from the full `fees` array.
  const editableFees = fees.filter(f =>
    f.id !== OTD_EXTRA_HOURS_FEE_ID && f.id !== OTD_SETUP_FEE_ID,
  );

  // Auto-sync the synthesized OTD setup-fee row against the snapshot +
  // current subtotal. The row is created when the inquiry is OTD and the
  // subtotal is below the waiver threshold; removed (or kept absent)
  // otherwise. Runs after every meaningful change so toggling service
  // mode, editing line items across the waiver threshold, or loading an
  // inquiry that pre-dates this synthesizer all converge on the right
  // shape without admin intervention. Loop guard: we only call onChange
  // when the desired row actually differs from what's stored.
  useEffect(() => {
    const desired = computeOtdSetupFeeRow(
      serviceMode,
      otdSetupFee,
      otdFeeWaiverThreshold,
      totals.subtotal,
    );
    const existingRaw = fees.find(f => f.id === OTD_SETUP_FEE_ID) ?? null;
    // Coerce existing.amount to a number for the semantic compare (Drizzle
    // numeric columns hydrate as strings on first load).
    const existing = existingRaw
      ? { ...existingRaw, amount: Number(existingRaw.amount) }
      : null;
    if (otdSetupFeeRowEquals(desired, existing)) return;
    const otherFees = fees.filter(f => f.id !== OTD_SETUP_FEE_ID);
    onChange({ fees: desired ? [...otherFees, desired] : otherFees });
  }, [serviceMode, otdSetupFee, otdFeeWaiverThreshold, totals.subtotal, fees, onChange]);
  function updateAdj(arr: QuoteAdjustment[], id: string, patch: Partial<QuoteAdjustment>, target: "fee" | "discount") {
    const next = arr.map(a => a.id === id ? { ...a, ...patch } : a);
    if (target === "fee") onChange({ fees: next });
    else onChange({ discounts: next });
  }
  function removeAdj(arr: QuoteAdjustment[], id: string, target: "fee" | "discount") {
    const next = arr.filter(a => a.id !== id);
    if (target === "fee") onChange({ fees: next });
    else onChange({ discounts: next });
  }

  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <div className="bg-secondary/40 px-4 py-2 border-b border-border flex items-center gap-2">
        <Receipt className="w-3.5 h-3.5 text-primary" />
        <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Quote Builder</span>
      </div>

      <div className="p-4 space-y-4">
        {/* Picker */}
        <div className="space-y-2">
          <MenuPicker menu={menu} onPick={pickMenu} />
          <button
            type="button"
            onClick={addCustom}
            className="text-xs font-semibold text-primary hover:underline inline-flex items-center gap-1"
          >
            <Plus className="w-3 h-3" /> Add custom line
          </button>
        </div>

        {/* Line items */}
        {lineItems.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4 italic">No line items yet.</p>
        ) : (
          <div className="space-y-3">
            <DndContext
              sensors={lineItemSensors}
              collisionDetection={closestCenter}
              onDragEnd={handleLineItemsDragEnd}
            >
              <SortableContext items={lineItems.map(li => li.id)} strategy={verticalListSortingStrategy}>
            {lineItems.map((li) => {
              const lineTotal = (Number(li.quantity) || 0) * (Number(li.unitPrice) || 0);
              const m = li.menuItemId != null ? menuById.get(li.menuItemId) : undefined;
              const descriptor = lineItemDescriptor(li);
              const isPan = li.pricingTemplate === "pan_sizes" && m && m.sizes.length > 0;
              return (
                <SortableLineItem key={li.id} id={li.id}>
                  {(handle) => (
                  <>
                  <div className="grid grid-cols-[36px_1fr_60px_90px_80px_28px] gap-2 items-center">
                    <button
                      type="button"
                      {...handle.attributes}
                      {...handle.listeners}
                      title="Drag to reorder"
                      aria-label="Drag to reorder"
                      className="p-1 mx-auto rounded text-muted-foreground hover:text-foreground hover:bg-secondary cursor-grab active:cursor-grabbing"
                      data-testid={`drag-handle-line-${li.id}`}
                    >
                      <GripVertical className="w-4 h-4" />
                    </button>
                    <input
                      value={li.name}
                      onChange={e => updateItem(li.id, { name: e.target.value })}
                      placeholder="Item name"
                      className={txtCls}
                    />
                    <input
                      type="number" min={0} step="1" inputMode="numeric"
                      value={li.quantity}
                      onChange={e => changeQuantity(li.id, e.target.value === "" ? 0 : Number(e.target.value))}
                      className={numCls}
                    />
                    <input
                      type="number" min={0} step="0.01" inputMode="decimal"
                      value={li.unitPrice}
                      onChange={e => changeUnitPrice(li.id, e.target.value === "" ? 0 : Number(e.target.value))}
                      className={numCls}
                    />
                    <span className="text-right text-sm font-semibold tabular-nums">{formatCurrency(lineTotal)}</span>
                    <button type="button" onClick={() => removeItem(li.id)} className="p-1 rounded hover:bg-red-50 text-muted-foreground hover:text-destructive" title="Remove">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {(descriptor || li.tierApplied || isPan || li.priceMode === "manual") && (
                    <div className="pl-[44px] flex items-center flex-wrap gap-2 text-xs text-muted-foreground">
                      {isPan && m ? (
                        <>
                          <span>Size:</span>
                          <select
                            value={li.sizeSlot ?? ""}
                            onChange={e => changeSize(li.id, Number(e.target.value))}
                            className="px-2 py-0.5 text-xs border border-border rounded bg-background"
                          >
                            {m.sizes.map(s => (
                              <option key={s.slot} value={s.slot}>
                                {s.label}{s.servings != null ? ` · ${s.servings} servings` : ""} ({formatCurrency(s.price)})
                              </option>
                            ))}
                          </select>
                        </>
                      ) : descriptor ? (
                        <span>{descriptor}</span>
                      ) : null}
                      {li.priceMode === "manual" ? (
                        <span
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 text-[10px] font-semibold uppercase tracking-wider"
                          title="Manual price — quantity changes won't re-apply tier pricing. Re-pick the item or size to unlock."
                        >
                          <Lock className="w-2.5 h-2.5" /> Manual price
                        </span>
                      ) : li.tierApplied ? (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 text-[10px] font-semibold uppercase tracking-wider">
                          Tier price applied
                        </span>
                      ) : null}
                    </div>
                  )}
                  </>
                  )}
                </SortableLineItem>
              );
            })}
              </SortableContext>
            </DndContext>
          </div>
        )}

        {/* OTD billed extra hours — admins can quote staff-hour upcharges
            without doing the math by hand. Only the snapshot rate/cap from
            the inquiry are used so historical quotes stay stable even if
            event settings change later. */}
        {isOtd && otdRate != null && otdRate > 0 && otdMax != null && otdMax > 0 && (
          <div className="border border-orange-200 bg-orange-50/40 rounded-xl p-3 space-y-2">
            <div className="flex items-center gap-2">
              <Flame className="w-3.5 h-3.5 text-orange-700" />
              <span className="text-xs font-bold uppercase tracking-wider text-orange-900">
                Billed Extra Hours
              </span>
              <span className="text-[11px] text-orange-900/70">
                {formatCurrency(otdRate)}/hr · max {otdMax}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setOtdExtraHours(otdExtraHours - 1)}
                disabled={otdExtraHours <= 0}
                className="w-7 h-7 inline-flex items-center justify-center rounded-lg border border-orange-300 bg-white text-orange-900 font-bold disabled:opacity-30 disabled:cursor-not-allowed hover:bg-orange-100"
                aria-label="Decrease billed extra hours"
              >
                −
              </button>
              <input
                type="number"
                min={0}
                max={otdMax}
                step={1}
                value={otdExtraHours}
                onChange={e => setOtdExtraHours(e.target.value === "" ? 0 : Number(e.target.value))}
                className="w-16 px-2 py-1 text-center text-sm font-semibold border border-orange-300 rounded-lg bg-white text-orange-900 outline-none focus:ring-2 focus:ring-orange-200"
              />
              <span className="text-xs text-orange-900/80">
                hr × {formatCurrency(otdRate)} = <strong>{formatCurrency(round2(otdExtraHours * otdRate))}</strong>
              </span>
              <button
                type="button"
                onClick={() => setOtdExtraHours(otdExtraHours + 1)}
                disabled={otdExtraHours >= otdMax}
                className="w-7 h-7 inline-flex items-center justify-center rounded-lg border border-orange-300 bg-white text-orange-900 font-bold disabled:opacity-30 disabled:cursor-not-allowed hover:bg-orange-100"
                aria-label="Increase billed extra hours"
              >
                +
              </button>
            </div>
            <p className="text-[11px] text-orange-900/70 italic">
              Adds a fee line to the quote. Set to 0 to remove.
            </p>
          </div>
        )}

        {/* Fees */}
        <AdjustmentList kind="fee" rows={editableFees}
          onAdd={() => addAdj("fee")}
          onUpdate={(id, patch) => {
            const nextEditable = editableFees.map(a => a.id === id ? { ...a, ...patch } : a);
            onChange({ fees: [...nextEditable, ...synthesizedOtdRows] });
          }}
          onRemove={(id) => {
            const nextEditable = editableFees.filter(a => a.id !== id);
            onChange({ fees: [...nextEditable, ...synthesizedOtdRows] });
          }}
        />

        {/* Discounts */}
        <AdjustmentList kind="discount" rows={discounts}
          onAdd={() => addAdj("discount")}
          onUpdate={(id, patch) => updateAdj(discounts, id, patch, "discount")}
          onRemove={(id) => removeAdj(discounts, id, "discount")}
        />

        {/* Totals card */}
        <div className="border-t border-border pt-3 ml-auto max-w-xs space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Subtotal</span>
            <span className="font-medium tabular-nums">{formatCurrency(totals.subtotal)}</span>
          </div>
          {totals.feesArr.map(f => (
            <div key={f.id} className="flex justify-between text-xs">
              <span className="text-muted-foreground truncate pr-2">{f.label}{f.kind === "percent" ? ` (${f.amount}%)` : ""}</span>
              <span className="tabular-nums">{formatCurrency(f.computed)}</span>
            </div>
          ))}
          {(() => {
            // Ghost row for the OTD setup fee when the food subtotal cleared
            // the per-inquiry waiver threshold. The fee was already stripped
            // from `fees` (and therefore `totals.feesArr`) by the auto-sync
            // effect above, so the admin sees no signal in the persisted
            // fees array — render the original amount crossed out + a small
            // "Waived (minimum met)" caption so they can confirm the waiver
            // is actually in effect.
            const waived = computeOtdSetupFeeWaivedDisplay(
              serviceMode,
              otdSetupFee,
              otdFeeWaiverThreshold,
              totals.subtotal,
            );
            if (!waived) return null;
            return (
              <div key="otd-waived-display" className="text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground truncate pr-2">{waived.label}</span>
                  <span className="text-muted-foreground line-through tabular-nums">
                    {formatCurrency(waived.originalAmount)}
                  </span>
                </div>
                <div className="text-right text-emerald-700 text-[10px]">
                  Waived — order met {formatCurrency(waived.waiverThreshold)} minimum
                </div>
              </div>
            );
          })()}
          {totals.discArr.map(d => (
            <div key={d.id} className="flex justify-between text-xs text-emerald-700">
              <span className="truncate pr-2">{d.label}{d.kind === "percent" ? ` (${d.amount}%)` : ""}</span>
              <span className="tabular-nums">-{formatCurrency(d.computed)}</span>
            </div>
          ))}
          <div className="flex justify-between pt-2 border-t border-border font-bold">
            <span>Total</span>
            <span className="text-primary tabular-nums">{formatCurrency(totals.total)}</span>
          </div>
          <p className="text-xs text-muted-foreground">{TAX_DISCLOSURE}</p>
        </div>

        {/* Quote-level fields */}
        <div className="grid grid-cols-2 gap-3 pt-2">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Valid Until</label>
            <input
              type="date"
              value={quoteExpiresAt ? quoteExpiresAt.slice(0, 10) : ""}
              onChange={e => onChange({ quoteExpiresAt: e.target.value || null })}
              className="w-full px-3 py-2 border border-border rounded-xl bg-background text-sm"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Quote Notes (visible to client)</label>
          <textarea
            value={quoteNotes}
            onChange={e => onChange({ quoteNotes: e.target.value })}
            rows={2}
            placeholder="Setup time, deposit instructions, payment terms…"
            className="w-full px-3 py-2 border border-border rounded-xl bg-background text-sm resize-none"
          />
        </div>
      </div>
    </div>
  );
}

function AdjustmentList({
  kind, rows, onAdd, onUpdate, onRemove,
}: {
  kind: "fee" | "discount";
  rows: QuoteAdjustment[];
  onAdd: () => void;
  onUpdate: (id: string, patch: Partial<QuoteAdjustment>) => void;
  onRemove: (id: string) => void;
}) {
  const numCls = "w-20 px-2 py-1.5 text-sm text-right border border-border rounded-lg bg-background outline-none";
  const txtCls = "w-full px-2 py-1.5 text-sm border border-border rounded-lg bg-background outline-none";
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {kind === "fee" ? "Fees" : "Discounts"}
        </span>
        <button type="button" onClick={onAdd} className="text-xs font-semibold text-primary hover:underline inline-flex items-center gap-1">
          <Plus className="w-3 h-3" /> Add
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">None</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map(r => (
            <div key={r.id} className="grid grid-cols-[1fr_70px_90px_28px] gap-2 items-center">
              <input value={r.label} onChange={e => onUpdate(r.id, { label: e.target.value })} placeholder="Label" className={txtCls} />
              <select
                value={r.kind}
                onChange={e => onUpdate(r.id, { kind: e.target.value as "fixed" | "percent" })}
                className="px-2 py-1.5 text-sm border border-border rounded-lg bg-background"
              >
                <option value="fixed">$</option>
                <option value="percent">%</option>
              </select>
              <input
                type="number" min={0} step="0.01" inputMode="decimal"
                value={r.amount}
                onChange={e => onUpdate(r.id, { amount: e.target.value === "" ? 0 : Number(e.target.value) })}
                className={numCls}
              />
              <button type="button" onClick={() => onRemove(r.id)} className="p-1 rounded hover:bg-red-50 text-muted-foreground hover:text-destructive">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Quote Actions panel ──────────────────────────────────────────────────────

function QuoteActions({
  inquiry, onUpdated, isDirty, flushSave,
}: {
  inquiry: Inquiry;
  onUpdated: (i: Inquiry) => void;
  isDirty: boolean;
  flushSave: () => Promise<Inquiry>;
}) {
  const [busy, setBusy] = useState<null | "gen" | "email" | "sms" | "reply-email" | "reply-sms" | "dismiss">(null);
  const [savingFirst, setSavingFirst] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [replyText, setReplyText] = useState("");

  const viewUrl = inquiry.quoteToken
    ? `${window.location.origin}${BASE}/quote/${inquiry.quoteToken}`
    : null;
  const pdfUrl = `${BASE}/api/admin/catering/${inquiry.id}/quote.pdf`;
  const issued = !!inquiry.quoteIssuedAt;

  // Auto-save the inquiry editor before running a quote action so the
  // regenerated PDF, rotated public link, and email/SMS attachment all
  // reflect the admin's latest edits. Returns the persisted inquiry, or
  // null if the save failed (caller should abort).
  async function ensureSaved(): Promise<Inquiry | null> {
    if (!isDirty) return inquiry;
    setSavingFirst(true);
    try {
      return await flushSave();
    } catch (err) {
      const m = err instanceof Error && err.message ? err.message : "Failed to save changes.";
      setMsg(m);
      return null;
    } finally {
      setSavingFirst(false);
    }
  }

  async function generate() {
    setBusy("gen"); setMsg(null);
    try {
      const saved = await ensureSaved();
      if (!saved) return;
      const r = await fetch(`${BASE}/api/admin/catering/${saved.id}/quote`, { method: "POST", headers: authHeaders() });
      const data = await r.json();
      if (!r.ok) { setMsg(data.error ?? "Failed to generate"); return; }
      onUpdated(data.inquiry);
      setMsg(issued ? "Quote refreshed." : "Quote generated.");
    } catch { setMsg("Failed to generate."); }
    finally { setBusy(null); }
  }

  async function emailQuote() {
    if (!inquiry.clientEmail) { setMsg("No client email on file."); return; }
    setBusy("email"); setMsg(null);
    try {
      const saved = await ensureSaved();
      if (!saved) return;
      const r = await fetch(`${BASE}/api/admin/catering/${saved.id}/quote/email`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify({}),
      });
      const data = await r.json();
      if (!r.ok) { setMsg(data.error ?? "Failed to email"); return; }
      onUpdated(data.inquiry);
      setMsg(`Emailed to ${data.sentTo}.`);
    } catch { setMsg("Failed to email."); }
    finally { setBusy(null); }
  }

  async function smsQuote() {
    if (!inquiry.clientPhone) { setMsg("No client phone on file."); return; }
    setBusy("sms"); setMsg(null);
    try {
      const saved = await ensureSaved();
      if (!saved) return;
      const r = await fetch(`${BASE}/api/admin/catering/${saved.id}/quote/sms`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify({}),
      });
      const data = await r.json();
      if (!r.ok) { setMsg(data.error ?? "Failed to text"); return; }
      onUpdated(data.inquiry);
      setMsg(`Texted to ${data.sentTo}.`);
    } catch { setMsg("Failed to text."); }
    finally { setBusy(null); }
  }

  function copyLink() {
    if (!viewUrl) return;
    navigator.clipboard.writeText(viewUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  async function sendReply(channel: "email" | "sms") {
    const text = replyText.trim();
    if (!text) { setMsg("Type a reply first."); return; }
    if (channel === "email" && !inquiry.clientEmail) { setMsg("No client email on file."); return; }
    if (channel === "sms" && !inquiry.clientPhone) { setMsg("No client phone on file."); return; }
    setBusy(channel === "email" ? "reply-email" : "reply-sms");
    setMsg(null);
    try {
      const r = await fetch(`${BASE}/api/admin/catering/${inquiry.id}/change-request/reply`, {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ channel, message: text }),
      });
      const data = await r.json();
      if (!r.ok) { setMsg(data.error ?? "Failed to send reply"); return; }
      onUpdated(data.inquiry);
      setReplyText("");
      setMsg(`Reply sent ${channel === "email" ? "by email" : "by text"} to ${data.sentTo}.`);
    } catch { setMsg("Failed to send reply."); }
    finally { setBusy(null); }
  }

  async function dismissChangeRequest() {
    setBusy("dismiss"); setMsg(null);
    try {
      const r = await fetch(`${BASE}/api/admin/catering/${inquiry.id}/change-request/dismiss`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify({}),
      });
      const data = await r.json();
      if (!r.ok) { setMsg(data.error ?? "Failed to dismiss"); return; }
      onUpdated(data.inquiry);
      setMsg("Marked as responded.");
    } catch { setMsg("Failed to mark responded."); }
    finally { setBusy(null); }
  }

  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <div className="bg-violet-50 px-4 py-2 border-b border-border flex items-center gap-2">
        <Send className="w-3.5 h-3.5 text-violet-700" />
        <span className="text-xs font-bold uppercase tracking-wider text-violet-700">Quote Actions</span>
        {isDirty && (
          <span
            className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-semibold uppercase tracking-wider"
            title="Form has edits that haven't been saved yet — quote actions will save them automatically before running."
          >
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
            Unsaved changes
          </span>
        )}
      </div>
      <div className="p-4 space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Quote #</p>
            <p className="font-mono font-semibold">{inquiry.quoteNumber ?? <span className="text-muted-foreground italic">— not generated</span>}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Issued</p>
            <p>{formatDateTime(inquiry.quoteIssuedAt) ?? <span className="text-muted-foreground italic">—</span>}</p>
          </div>
        </div>

        {viewUrl && (
          <div className="flex items-center gap-2 p-2 bg-secondary/40 rounded-lg border border-border text-xs">
            <LinkIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="font-mono truncate flex-1">{viewUrl}</span>
            <button type="button" onClick={copyLink} className="p-1 rounded hover:bg-secondary" title="Copy link">
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
            <a href={viewUrl} target="_blank" rel="noreferrer" className="p-1 rounded hover:bg-secondary" title="Open">
              <ChevronRight className="w-3.5 h-3.5" />
            </a>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={generate}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-violet-600 text-white text-sm font-semibold rounded-xl hover:bg-violet-700 transition-colors disabled:opacity-50"
          >
            {busy === "gen" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Receipt className="w-4 h-4" />}
            {busy === "gen"
              ? (savingFirst
                  ? (issued ? "Saving & refreshing…" : "Saving & generating…")
                  : (issued ? "Refreshing…" : "Generating…"))
              : (issued ? "Refresh Quote" : "Generate Quote")}
          </button>
          <a
            href={pdfUrl + (getAdminToken() ? `?_t=${encodeURIComponent(getAdminToken()!)}` : "")}
            onClick={async (e) => {
              // The PDF route is auth-protected. We can't pass headers from <a>, so fetch + download.
              e.preventDefault();
              const r = await fetch(pdfUrl, { headers: authHeaders() });
              if (!r.ok) { setMsg("Could not download PDF."); return; }
              const blob = await r.blob();
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url; a.download = `${inquiry.quoteNumber ?? `quote-${inquiry.id}`}.pdf`;
              document.body.appendChild(a); a.click(); a.remove();
              URL.revokeObjectURL(url);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-secondary text-foreground text-sm font-semibold rounded-xl hover:bg-border transition-colors"
          >
            <Download className="w-4 h-4" /> Download PDF
          </a>
          <button
            type="button"
            onClick={emailQuote}
            disabled={busy !== null || !issued || !inquiry.clientEmail}
            title={!inquiry.clientEmail ? "No client email on file" : !issued ? "Generate the quote first" : ""}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-secondary text-foreground text-sm font-semibold rounded-xl hover:bg-border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy === "email" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
            {busy === "email"
              ? (savingFirst ? "Saving & emailing…" : "Emailing…")
              : "Email PDF"}
          </button>
          <button
            type="button"
            onClick={smsQuote}
            disabled={busy !== null || !issued || !inquiry.clientPhone}
            title={!inquiry.clientPhone ? "No client phone on file" : !issued ? "Generate the quote first" : ""}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-secondary text-foreground text-sm font-semibold rounded-xl hover:bg-border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy === "sms" ? <Loader2 className="w-4 h-4 animate-spin" /> : <MessageSquare className="w-4 h-4" />}
            {busy === "sms"
              ? (savingFirst ? "Saving & texting…" : "Texting…")
              : "Text Link"}
          </button>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {inquiry.quoteLastEmailedAt && <span>Emailed {formatDateTime(inquiry.quoteLastEmailedAt)}</span>}
          {inquiry.quoteLastTextedAt && <span>Texted {formatDateTime(inquiry.quoteLastTextedAt)}</span>}
        </div>

        {inquiry.quoteAcceptedAt && (
          <div className="flex items-start gap-2 p-3 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800">
            <Check className="w-4 h-4 mt-0.5 shrink-0" />
            <div className="text-xs">
              <p className="font-semibold">Client accepted this quote</p>
              <p className="text-emerald-700">{formatDateTime(inquiry.quoteAcceptedAt)}</p>
            </div>
          </div>
        )}
        {inquiry.quoteChangeRequestAt && !inquiry.quoteAcceptedAt && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 text-amber-900 overflow-hidden">
            <div className="flex items-start gap-2 p-3">
              <MessageSquare className="w-4 h-4 mt-0.5 shrink-0" />
              <div className="text-xs space-y-1 min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <p className="font-semibold">
                    Client requested changes — {formatDateTime(inquiry.quoteChangeRequestAt)}
                  </p>
                  {inquiry.quoteChangeRequestRespondedAt && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-semibold">
                      <Check className="w-3 h-3" /> Responded
                    </span>
                  )}
                </div>
                {inquiry.quoteChangeRequestMessage && (
                  <p className="italic whitespace-pre-wrap break-words">"{inquiry.quoteChangeRequestMessage}"</p>
                )}
              </div>
            </div>

            {inquiry.quoteReplies && inquiry.quoteReplies.length > 0 && (
              <div className="border-t border-amber-200 bg-amber-50/60 px-3 py-2 space-y-1.5">
                <p className="text-[10px] uppercase tracking-wider font-bold text-amber-800">Reply history</p>
                {inquiry.quoteReplies.map(reply => (
                  <div key={reply.id} className="text-xs bg-white/70 rounded-md p-2 border border-amber-200">
                    <div className="flex items-center justify-between gap-2 text-[11px] text-amber-800 mb-0.5">
                      <span className="inline-flex items-center gap-1 font-semibold">
                        {reply.channel === "email"
                          ? <><Mail className="w-3 h-3" /> Email</>
                          : <><MessageSquare className="w-3 h-3" /> Text</>}
                        <span className="font-normal text-amber-700">→ {reply.sentTo}</span>
                      </span>
                      <span>{formatDateTime(reply.sentAt)}</span>
                    </div>
                    <p className="whitespace-pre-wrap break-words text-amber-950">{reply.message}</p>
                  </div>
                ))}
              </div>
            )}

            <div className="border-t border-amber-200 p-3 bg-white/40 space-y-2">
              <label className="block">
                <span className="text-[10px] uppercase tracking-wider font-bold text-amber-800">
                  Reply to client
                </span>
                <textarea
                  value={replyText}
                  onChange={e => setReplyText(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  placeholder="Type your reply — sent to the client by email or text…"
                  className="mt-1 w-full px-3 py-2 border border-amber-300 rounded-lg bg-white text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-amber-400"
                />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => sendReply("email")}
                  disabled={busy !== null || !replyText.trim() || !inquiry.clientEmail}
                  title={!inquiry.clientEmail ? "No client email on file" : ""}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 text-white text-xs font-semibold rounded-lg hover:bg-amber-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {busy === "reply-email" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mail className="w-3.5 h-3.5" />}
                  Send email
                </button>
                <button
                  type="button"
                  onClick={() => sendReply("sms")}
                  disabled={busy !== null || !replyText.trim() || !inquiry.clientPhone}
                  title={!inquiry.clientPhone ? "No client phone on file" : ""}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 text-white text-xs font-semibold rounded-lg hover:bg-amber-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {busy === "reply-sms" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MessageSquare className="w-3.5 h-3.5" />}
                  Send text
                </button>
                {!inquiry.quoteChangeRequestRespondedAt && (
                  <button
                    type="button"
                    onClick={dismissChangeRequest}
                    disabled={busy !== null}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-transparent text-amber-800 text-xs font-semibold rounded-lg hover:bg-amber-100 transition-colors disabled:opacity-40 ml-auto"
                  >
                    {busy === "dismiss" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                    Mark responded
                  </button>
                )}
              </div>
              {replyText.length > 0 && (
                <p className="text-[10px] text-amber-700">{replyText.length}/2000</p>
              )}
            </div>
          </div>
        )}

        {msg && <p className="text-xs text-muted-foreground border-t border-border pt-2">{msg}</p>}
      </div>
    </div>
  );
}

// ── Square Invoice panel ─────────────────────────────────────────────────────

const SQUARE_STATUS_COLORS: Record<string, string> = {
  DRAFT: "bg-secondary text-muted-foreground",
  UNPAID: "bg-amber-100 text-amber-700",
  SCHEDULED: "bg-amber-100 text-amber-700",
  PARTIALLY_PAID: "bg-blue-100 text-blue-700",
  PAID: "bg-emerald-100 text-emerald-700",
  CANCELED: "bg-red-100 text-red-600",
  FAILED: "bg-red-100 text-red-600",
  REFUNDED: "bg-secondary text-muted-foreground",
};

function SquarePanel({
  inquiry, onUpdated,
}: {
  inquiry: Inquiry;
  onUpdated: (i: Inquiry) => void;
}) {
  const [busy, setBusy] = useState<null | "send" | "cancel" | "refresh">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [depositKind, setDepositKind] = useState<"none" | "percent" | "fixed">("percent");
  const [depositValue, setDepositValue] = useState<string>("25");
  const [dueDate, setDueDate] = useState<string>("");

  const hasInvoice = !!inquiry.squareInvoiceId;
  const status = inquiry.squareInvoiceStatus ?? null;
  const isPaid = !!inquiry.squarePaidInFullAt || status === "PAID";

  // Consolidated totals strip ("Billed · Supplemental · Uninvoiced"):
  //   - Billed primary  = whatever Square recorded for the primary
  //     invoice (paid + still-due), independent of any later supps.
  //   - Supplemental    = sum of every supplemental that actually
  //     billed the customer (excludes CANCELED + FAILED + transient
  //     PENDING reservation rows).
  //   - Uninvoiced      = current delta vs. the rolled-forward snapshot
  //     (i.e. what a NEW supplemental would bill right now).
  const billedPrimary = (Number(inquiry.squareAmountPaid ?? 0))
    + (Number(inquiry.squareBalanceDue ?? 0));
  const supplementalBilled = (inquiry.supplementals ?? [])
    .filter(s => {
      const st = (s.squareInvoiceStatus ?? "").toUpperCase();
      return st !== "CANCELED" && st !== "FAILED" && st !== "PENDING";
    })
    .reduce((sum, s) => sum + Number(s.amountTotal ?? 0), 0);
  const totalsDelta = useMemo(() => computeUninvoicedDelta({
    currentLineItems: inquiry.lineItems ?? [],
    currentFees: inquiry.fees ?? [],
    currentDiscounts: inquiry.discounts ?? [],
    snapshotLineItems: inquiry.primarySnapshotLineItems ?? [],
    snapshotFees: inquiry.primarySnapshotFees ?? [],
    snapshotDiscounts: inquiry.primarySnapshotDiscounts ?? [],
  }), [
    inquiry.lineItems, inquiry.fees, inquiry.discounts,
    inquiry.primarySnapshotLineItems, inquiry.primarySnapshotFees, inquiry.primarySnapshotDiscounts,
  ]);
  const uninvoicedDelta = inquiry.primarySnapshotLineItems != null ? totalsDelta.deltaTotal : 0;
  // Any supplemental that is NOT terminally CANCELED and NOT FAILED blocks
  // primary cancel. Mirrors `blocksPrimaryCancel` server-side in
  // admin-catering.ts. Critically this *includes* PAID and REFUNDED — a
  // primary cancel clears `primarySnapshot*` and `squareCustomerId`, so a
  // fresh re-issue would restart from scratch and could double-bill rows
  // that were already captured on a paid supplemental. The admin must
  // reconcile (refund/void in Square) and cancel each supplemental row
  // first to flip it to CANCELED, after which the primary can be canceled.
  const openSupplementals = (inquiry.supplementals ?? []).filter(s => {
    const st = (s.squareInvoiceStatus ?? "").toUpperCase();
    return st !== "CANCELED" && st !== "FAILED";
  });
  const hasOpenSupplementals = openSupplementals.length > 0;
  const canCancel = hasInvoice && !isPaid && !hasOpenSupplementals;

  async function sendInvoice() {
    if (!inquiry.clientEmail) { setMsg("Client must have an email on file."); return; }
    setBusy("send"); setMsg(null);
    try {
      const body = {
        deposit: depositKind === "none"
          ? { kind: "none" }
          : { kind: depositKind, value: Number(depositValue) || 0 },
        dueDate: dueDate || null,
      };
      const r = await fetch(`${BASE}/api/admin/catering/${inquiry.id}/square/invoice`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) { setMsg(data.error ?? "Failed to send invoice"); return; }
      onUpdated(data.inquiry);
      setMsg("Invoice sent — Square will email the customer.");
    } catch { setMsg("Failed to send invoice."); }
    finally { setBusy(null); }
  }

  async function cancelSquareInvoice() {
    if (!confirm("Cancel this Square invoice? You can issue a new one afterwards.")) return;
    setBusy("cancel"); setMsg(null);
    try {
      const r = await fetch(`${BASE}/api/admin/catering/${inquiry.id}/square/cancel`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify({}),
      });
      const data = await r.json();
      if (!r.ok) { setMsg(data.error ?? "Failed to cancel"); return; }
      onUpdated(data.inquiry);
      setMsg("Invoice cancelled.");
    } catch { setMsg("Failed to cancel."); }
    finally { setBusy(null); }
  }

  async function refresh() {
    setBusy("refresh"); setMsg(null);
    try {
      const r = await fetch(`${BASE}/api/admin/catering/${inquiry.id}/square/refresh`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify({}),
      });
      const data = await r.json();
      if (!r.ok) { setMsg(data.error ?? "Failed to refresh"); return; }
      onUpdated(data.inquiry);
      setMsg("Status refreshed from Square.");
    } catch { setMsg("Failed to refresh."); }
    finally { setBusy(null); }
  }

  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <div className="bg-emerald-50 px-4 py-2 border-b border-border flex items-center gap-2">
        <CreditCard className="w-3.5 h-3.5 text-emerald-700" />
        <span className="text-xs font-bold uppercase tracking-wider text-emerald-700">Square Invoice</span>
      </div>
      <div className="p-4 space-y-3 text-sm">
        {!hasInvoice ? (
          <>
            <p className="text-xs text-muted-foreground">
              Send a payable invoice via Square. The customer will receive an email with a hosted payment page.
              Requires a client email and a generated quote with totals greater than $0.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Deposit</span>
                <select
                  value={depositKind}
                  onChange={e => setDepositKind(e.target.value as "none" | "percent" | "fixed")}
                  className="mt-1 w-full px-3 py-2 border border-border rounded-xl bg-background text-sm"
                >
                  <option value="none">None — full balance</option>
                  <option value="percent">Percent of total</option>
                  <option value="fixed">Fixed amount</option>
                </select>
              </label>
              {depositKind !== "none" && (
                <label className="block">
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    {depositKind === "percent" ? "Percent (%)" : "Amount ($)"}
                  </span>
                  <input
                    type="number"
                    min="0"
                    max={depositKind === "percent" ? "100" : undefined}
                    step={depositKind === "percent" ? "1" : "0.01"}
                    value={depositValue}
                    onChange={e => setDepositValue(e.target.value)}
                    className="mt-1 w-full px-3 py-2 border border-border rounded-xl bg-background text-sm"
                  />
                </label>
              )}
              <label className="block col-span-2">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Due date (optional)</span>
                <input
                  type="date"
                  value={dueDate}
                  onChange={e => setDueDate(e.target.value)}
                  className="mt-1 w-full px-3 py-2 border border-border rounded-xl bg-background text-sm"
                />
              </label>
            </div>
            <button
              type="button"
              onClick={sendInvoice}
              disabled={busy !== null || !inquiry.clientEmail || !inquiry.quoteIssuedAt}
              title={
                !inquiry.clientEmail ? "Client email required" :
                !inquiry.quoteIssuedAt ? "Generate the quote first" : ""
              }
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-emerald-600 text-white text-sm font-semibold rounded-xl hover:bg-emerald-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy === "send" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Send Square Invoice
            </button>
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Status</p>
                <span className={cn(
                  "inline-block mt-1 px-2 py-0.5 rounded-full text-xs font-semibold",
                  SQUARE_STATUS_COLORS[status ?? ""] ?? "bg-secondary text-muted-foreground",
                )}>
                  {status ?? "—"}
                </span>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Balance / Paid</p>
                <p className="font-semibold">
                  {formatCurrency(Number(inquiry.squareBalanceDue ?? 0))} due
                  <span className="text-muted-foreground font-normal"> · {formatCurrency(Number(inquiry.squareAmountPaid ?? 0))} paid</span>
                </p>
              </div>
            </div>
            {(inquiry.squareDepositPaidAt || inquiry.squarePaidInFullAt) && (
              <div className="text-xs text-muted-foreground space-y-0.5">
                {inquiry.squareDepositPaidAt && <p>Deposit received {formatDateTime(inquiry.squareDepositPaidAt)}</p>}
                {inquiry.squarePaidInFullAt && <p>Paid in full {formatDateTime(inquiry.squarePaidInFullAt)}</p>}
              </div>
            )}
            <div className="rounded-xl bg-secondary/40 border border-border px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span>
                <span className="text-muted-foreground">Billed:</span>{" "}
                <span className="font-semibold tabular-nums">{formatCurrency(billedPrimary)}</span>
              </span>
              <span className="text-muted-foreground/50">·</span>
              <span>
                <span className="text-muted-foreground">Supplemental:</span>{" "}
                <span className="font-semibold tabular-nums">{formatCurrency(supplementalBilled)}</span>
              </span>
              <span className="text-muted-foreground/50">·</span>
              <span>
                <span className="text-muted-foreground">Uninvoiced:</span>{" "}
                <span className={cn(
                  "font-semibold tabular-nums",
                  uninvoicedDelta > 0 && "text-emerald-700",
                )}>
                  {formatCurrency(uninvoicedDelta)}
                </span>
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {inquiry.squareHostedUrl && (
                <a
                  href={inquiry.squareHostedUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-2 bg-secondary text-foreground text-sm font-semibold rounded-xl hover:bg-border transition-colors"
                >
                  <ExternalLink className="w-4 h-4" /> View on Square
                </a>
              )}
              <button
                type="button"
                onClick={refresh}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 px-3 py-2 bg-secondary text-foreground text-sm font-semibold rounded-xl hover:bg-border transition-colors disabled:opacity-50"
              >
                {busy === "refresh" ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                Refresh
              </button>
              {canCancel && (
                <button
                  type="button"
                  onClick={cancelSquareInvoice}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1.5 px-3 py-2 bg-red-50 text-destructive text-sm font-semibold rounded-xl hover:bg-red-100 transition-colors disabled:opacity-50"
                >
                  {busy === "cancel" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Ban className="w-4 h-4" />}
                  Cancel Invoice
                </button>
              )}
              {hasInvoice && !isPaid && hasOpenSupplementals && (
                <button
                  type="button"
                  disabled
                  title={`Cancel the ${openSupplementals.length} outstanding supplemental${openSupplementals.length === 1 ? "" : "s"} first`}
                  className="inline-flex items-center gap-1.5 px-3 py-2 bg-red-50/40 text-destructive/50 text-sm font-semibold rounded-xl cursor-not-allowed"
                >
                  <Ban className="w-4 h-4" /> Cancel Invoice
                </button>
              )}
            </div>
          </>
        )}
        {msg && <p className="text-xs text-muted-foreground border-t border-border pt-2">{msg}</p>}
      </div>
      {hasInvoice && inquiry.primarySnapshotLineItems != null && (
        <SupplementalSubPanel inquiry={inquiry} onUpdated={onUpdated} />
      )}
    </div>
  );
}

// ── Supplemental Invoices sub-panel ──────────────────────────────────────────
//
// Renders the "uninvoiced delta" preview + Issue button + the list of
// already-issued supplemental invoices for this inquiry. Lives inside the
// main SquarePanel border so it visually reads as part of the same Square
// surface.

function SupplementalSubPanel({
  inquiry, onUpdated,
}: {
  inquiry: Inquiry;
  onUpdated: (i: Inquiry) => void;
}) {
  const [busy, setBusy] = useState<null | "issue" | `refresh-${number}` | `cancel-${number}`>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Compute the delta against the live (possibly unsaved) inquiry. We
  // show whatever is on the server-returned `inquiry` object — the admin
  // is expected to save before issuing, so unsaved edits won't be billed.
  // Matches the server-side delta computation 1:1.
  const delta = useMemo(() => computeUninvoicedDelta({
    currentLineItems: inquiry.lineItems ?? [],
    currentFees: inquiry.fees ?? [],
    currentDiscounts: inquiry.discounts ?? [],
    snapshotLineItems: inquiry.primarySnapshotLineItems ?? [],
    snapshotFees: inquiry.primarySnapshotFees ?? [],
    snapshotDiscounts: inquiry.primarySnapshotDiscounts ?? [],
  }), [
    inquiry.lineItems, inquiry.fees, inquiry.discounts,
    inquiry.primarySnapshotLineItems, inquiry.primarySnapshotFees, inquiry.primarySnapshotDiscounts,
  ]);

  // Hide PENDING reservation rows — they're a transient artifact of
  // two-phase issuance (server claims a seq slot, then publishes to
  // Square). Under normal conditions they exist for sub-second windows
  // and the publish handler flips them to a real Square status before
  // returning. They'd only persist if the api process crashed mid-call.
  const supplementals = (inquiry.supplementals ?? []).filter(
    s => (s.squareInvoiceStatus ?? "").toUpperCase() !== "PENDING",
  );
  const hasDelta = delta.deltaTotal > 0;

  async function issueSupplement() {
    if (!hasDelta) return;
    if (!confirm(`Issue a supplemental Square invoice for ${formatCurrency(delta.deltaTotal)}? The customer will receive a separate email.`)) return;
    setBusy("issue"); setMsg(null);
    try {
      const r = await fetch(`${BASE}/api/admin/catering/${inquiry.id}/square/supplement`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify({}),
      });
      const data = await r.json();
      if (!r.ok) { setMsg(data.error ?? "Failed to issue supplemental"); return; }
      onUpdated(data.inquiry);
      setMsg("Supplemental invoice sent.");
    } catch { setMsg("Failed to issue supplemental."); }
    finally { setBusy(null); }
  }

  async function refreshSupplement(suppId: number) {
    setBusy(`refresh-${suppId}`); setMsg(null);
    try {
      const r = await fetch(`${BASE}/api/admin/catering/${inquiry.id}/square/supplement/${suppId}/refresh`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify({}),
      });
      const data = await r.json();
      if (!r.ok) { setMsg(data.error ?? "Failed to refresh"); return; }
      onUpdated(data.inquiry);
    } catch { setMsg("Failed to refresh supplemental."); }
    finally { setBusy(null); }
  }

  async function cancelSupplement(suppId: number) {
    if (!confirm("Cancel this supplemental Square invoice?")) return;
    setBusy(`cancel-${suppId}`); setMsg(null);
    try {
      const r = await fetch(`${BASE}/api/admin/catering/${inquiry.id}/square/supplement/${suppId}/cancel`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify({}),
      });
      const data = await r.json();
      if (!r.ok) { setMsg(data.error ?? "Failed to cancel"); return; }
      onUpdated(data.inquiry);
      setMsg("Supplemental cancelled.");
    } catch { setMsg("Failed to cancel supplemental."); }
    finally { setBusy(null); }
  }

  return (
    <div className="border-t border-border bg-emerald-50/40">
      <div className="px-4 py-2 border-b border-border flex items-center gap-2">
        <Plus className="w-3.5 h-3.5 text-emerald-700" />
        <span className="text-xs font-bold uppercase tracking-wider text-emerald-700">
          Supplemental Invoices
        </span>
      </div>
      <div className="p-4 space-y-3 text-sm">
        {/* Delta preview + Issue button */}
        <div className="rounded-xl border border-border bg-background p-3 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Uninvoiced extras</p>
              <p className="font-semibold text-base">
                {formatCurrency(delta.deltaTotal)}
              </p>
            </div>
            <button
              type="button"
              onClick={issueSupplement}
              disabled={busy !== null || !hasDelta || !inquiry.clientEmail}
              title={
                !inquiry.clientEmail ? "Client email required" :
                !hasDelta ? "No new charges since the primary invoice — nothing to bill" : ""
              }
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-emerald-600 text-white text-sm font-semibold rounded-xl hover:bg-emerald-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy === "issue" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Issue supplemental
            </button>
          </div>
          {hasDelta && (
            <div className="border-t border-border pt-2 space-y-1 text-xs">
              {delta.deltaLineItems.map(li => (
                <div key={`l-${li.id}`} className="flex justify-between gap-2">
                  <span className="text-muted-foreground truncate">
                    {li.name}
                    <span className="text-muted-foreground/70"> × {li.quantity}</span>
                  </span>
                  <span className="font-medium tabular-nums">
                    +{formatCurrency(li.quantity * li.unitPrice)}
                  </span>
                </div>
              ))}
              {delta.deltaFees.map(f => (
                <div key={`f-${f.id}`} className="flex justify-between gap-2">
                  <span className="text-muted-foreground truncate">{f.label}</span>
                  <span className="font-medium tabular-nums">
                    +{f.kind === "percent" ? `${f.amount}%` : formatCurrency(f.amount)}
                  </span>
                </div>
              ))}
              {delta.deltaDiscounts.map(d => (
                <div key={`d-${d.id}`} className="flex justify-between gap-2">
                  <span className="text-muted-foreground truncate">{d.label}</span>
                  <span className="font-medium tabular-nums text-emerald-700">
                    −{d.kind === "percent" ? `${d.amount}%` : formatCurrency(d.amount)}
                  </span>
                </div>
              ))}
            </div>
          )}
          {!hasDelta && supplementals.length === 0 && (
            <p className="text-xs text-muted-foreground border-t border-border pt-2">
              Edit the quote (e.g. bump the OTD extra-hours stepper or add a fee row), save, then issue a supplemental for any post-event extras.
            </p>
          )}
        </div>

        {/* Issued supplementals list */}
        {supplementals.length > 0 && (
          <ul className="space-y-2">
            {supplementals.map(s => {
              const sStatus = s.squareInvoiceStatus ?? "—";
              const sPaid = !!s.squarePaidInFullAt || sStatus === "PAID";
              const sCanceled = sStatus.toUpperCase() === "CANCELED";
              const sCanCancel = !sPaid && !sCanceled;
              return (
                <li
                  key={s.id}
                  className="rounded-xl border border-border bg-background p-3 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm">Supplemental #{s.seq}</span>
                      <span className={cn(
                        "inline-block px-2 py-0.5 rounded-full text-xs font-semibold",
                        SQUARE_STATUS_COLORS[sStatus] ?? "bg-secondary text-muted-foreground",
                      )}>
                        {sStatus}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Issued {formatDateTime(s.createdAt)}
                    </p>
                  </div>
                  <p className="text-sm">
                    <span className="font-semibold tabular-nums">
                      {formatCurrency(Number(s.squareBalanceDue ?? 0))}
                    </span>
                    <span className="text-muted-foreground"> due · </span>
                    <span className="tabular-nums">
                      {formatCurrency(Number(s.squareAmountPaid ?? 0))}
                    </span>
                    <span className="text-muted-foreground"> paid · </span>
                    <span className="text-muted-foreground tabular-nums">
                      total {formatCurrency(Number(s.amountTotal ?? 0))}
                    </span>
                  </p>
                  {s.squarePaidInFullAt && (
                    <p className="text-xs text-muted-foreground">
                      Paid in full {formatDateTime(s.squarePaidInFullAt)}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {s.squareHostedUrl && (
                      <a
                        href={s.squareHostedUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-secondary text-foreground text-xs font-semibold rounded-lg hover:bg-border transition-colors"
                      >
                        <ExternalLink className="w-3.5 h-3.5" /> View
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => refreshSupplement(s.id)}
                      disabled={busy !== null}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-secondary text-foreground text-xs font-semibold rounded-lg hover:bg-border transition-colors disabled:opacity-50"
                    >
                      {busy === `refresh-${s.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                      Refresh
                    </button>
                    {sCanCancel && (
                      <button
                        type="button"
                        onClick={() => cancelSupplement(s.id)}
                        disabled={busy !== null}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-50 text-destructive text-xs font-semibold rounded-lg hover:bg-red-100 transition-colors disabled:opacity-50"
                      >
                        {busy === `cancel-${s.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />}
                        Cancel
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {msg && <p className="text-xs text-muted-foreground border-t border-border pt-2">{msg}</p>}
      </div>
    </div>
  );
}

// ── Messages Panel (in-inquiry SMS chat) ─────────────────────────────────────
//
// Renders the two-way SMS thread for a single inquiry. Subscribes to the
// admin SSE stream while open (so new inbounds and admin sends from
// other tabs appear instantly). Marks all unread messages seen on
// mount. Disables the composer when the customer is on the blocklist.

type ChatMessage = {
  id: number;
  direction: "inbound" | "outbound";
  customerPhone: string;
  body: string;
  occurredAt: string;
  port: number | null;
  inquiryId: number | null;
  seenByAdmin: boolean;
  source: string;
};

function chatTimeLabel(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function MessagesPanel({ inquiryId, hasPhone }: { inquiryId: number; hasPhone: boolean }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [customerPhone, setCustomerPhone] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<"customer-opt-out" | "admin-blocked" | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${BASE}/api/admin/messages/by-inquiry/${inquiryId}`, { headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as {
        messages: ChatMessage[];
        customerPhone: string | null;
        blocked: "customer-opt-out" | "admin-blocked" | null;
      };
      setMessages(data.messages);
      setCustomerPhone(data.customerPhone);
      setBlocked(data.blocked);
      setError("");
    } catch (e: any) {
      setError(e?.message || "Failed to load messages");
    } finally {
      setLoading(false);
    }
  }, [inquiryId]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  // Scroll the thread to the latest message whenever the list changes.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  // Mark unread messages seen as soon as the panel loads them. The
  // server publishes a `messages-seen` event which clears the badge in
  // the inquiry list and the per-row badge.
  useEffect(() => {
    if (loading) return;
    const hasUnread = messages.some(m => m.direction === "inbound" && !m.seenByAdmin);
    if (!hasUnread) return;
    fetch(`${BASE}/api/admin/messages/by-inquiry/${inquiryId}/mark-seen`, {
      method: "POST",
      headers: authHeaders(),
    }).catch(() => { /* non-fatal */ });
  }, [loading, messages, inquiryId]);

  // Subscribe to the SSE stream for live thread updates.
  useEffect(() => {
    const token = getAdminToken();
    if (!token) return;
    let es: EventSource | null = null;
    let pollInt: ReturnType<typeof setInterval> | null = null;
    function startPoll() {
      if (!pollInt) pollInt = setInterval(load, 30_000);
    }
    function stopPoll() {
      if (pollInt) {
        clearInterval(pollInt);
        pollInt = null;
      }
    }
    try {
      es = new EventSource(`${BASE}/api/admin/messages/stream?token=${encodeURIComponent(token)}`);
      const reload = (raw: MessageEvent) => {
        try {
          const ev = JSON.parse(raw.data) as { inquiryId?: number };
          // Only reload if the event is unrelated-or-related to this inquiry
          // (no inquiryId means broad event like unmatched changes — ignore).
          if (ev.inquiryId === inquiryId) load();
        } catch {
          // unparseable payload — best to just reload
          load();
        }
      };
      es.addEventListener("inbound", reload as EventListener);
      es.addEventListener("outbound", reload as EventListener);
      es.addEventListener("hello", () => stopPoll());
      es.onerror = () => startPoll();
    } catch {
      startPoll();
    }
    return () => {
      es?.close();
      stopPoll();
    };
  }, [inquiryId, load]);

  async function handleSend(e: React.SyntheticEvent) {
    e.preventDefault();
    const text = composer.trim();
    if (!text || sending || blocked) return;
    setSending(true);
    setSendError("");
    try {
      const r = await fetch(`${BASE}/api/admin/messages/send`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ inquiryId, message: text }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || "Failed to send");
      setComposer("");
      // Optimistically reload — SSE will also fire, but reload guarantees
      // the bubble appears even if the stream is stalled.
      await load();
    } catch (e: any) {
      setSendError(e?.message || "Failed to send");
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="border border-border rounded-2xl overflow-hidden bg-card">
      <header className="px-4 py-2.5 border-b border-border bg-secondary/30 flex items-center gap-2 flex-wrap">
        <MessageSquare className="w-4 h-4 text-muted-foreground" />
        <h3 className="font-semibold text-sm">Messages</h3>
        {customerPhone && <span className="text-xs font-mono text-muted-foreground">{customerPhone}</span>}
        {blocked === "customer-opt-out" && (
          <span className="ml-auto text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 bg-amber-100 text-amber-800 rounded-full">
            Opted out
          </span>
        )}
        {blocked === "admin-blocked" && (
          <span className="ml-auto text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 bg-rose-100 text-rose-800 rounded-full">
            Blocked
          </span>
        )}
      </header>

      {!hasPhone ? (
        <div className="p-4 text-sm text-muted-foreground text-center">
          Add a client phone number to start texting from this inquiry.
        </div>
      ) : (
        <>
          <div ref={scrollRef} className="max-h-80 overflow-y-auto p-4 space-y-2 bg-background/40">
            {loading ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading messages…
              </div>
            ) : error ? (
              <div className="text-sm text-destructive">{error}</div>
            ) : messages.length === 0 ? (
              <div className="text-sm text-muted-foreground text-center py-6">
                No messages yet. Use the composer below to start the thread.
              </div>
            ) : (
              messages.map(m => {
                const isInbound = m.direction === "inbound";
                return (
                  <div key={m.id} className={cn("flex", isInbound ? "justify-start" : "justify-end")}>
                    <div
                      className={cn(
                        "max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words shadow-sm",
                        isInbound
                          ? "bg-secondary text-foreground rounded-bl-md"
                          : "bg-primary text-primary-foreground rounded-br-md",
                      )}
                    >
                      <div>{m.body}</div>
                      <div
                        className={cn(
                          "text-[10px] mt-1 flex items-center gap-1",
                          isInbound ? "text-muted-foreground" : "text-primary-foreground/80",
                        )}
                      >
                        <span>{chatTimeLabel(m.occurredAt)}</span>
                        {m.source === "owner_relay" && (
                          <span className="italic">· via owner SMS reply</span>
                        )}
                        {m.port != null && !isInbound && (
                          <span className="font-mono opacity-70">· port {m.port}</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Must stay a <div>, not a <form>: this is rendered inside the
              inquiry editor's outer <form>, and HTML5 forbids nested forms. */}
          <div className="p-3 border-t border-border space-y-2">
            <textarea
              value={composer}
              onChange={e => setComposer(e.target.value)}
              placeholder={blocked ? "Composer disabled — recipient is blocklisted." : "Reply to customer…"}
              disabled={!!blocked || sending}
              rows={2}
              maxLength={1500}
              className="w-full px-3 py-2 border border-border rounded-xl bg-background text-sm resize-none disabled:opacity-50 disabled:cursor-not-allowed focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend(e);
                }
              }}
            />
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">{composer.length}/1500</span>
              {sendError && <span className="text-xs text-destructive flex-1 truncate">{sendError}</span>}
              <button
                type="button"
                onClick={handleSend}
                disabled={!composer.trim() || sending || !!blocked}
                className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 bg-foreground text-background font-semibold rounded-xl text-sm hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

// ── Detail Panel ─────────────────────────────────────────────────────────────

function DetailPanel({
  inquiry,
  onClose,
  onSaved,
  onDeleted,
  isNew,
  menu,
}: {
  inquiry: Partial<Inquiry>;
  onClose: () => void;
  onSaved: (saved: Inquiry) => void;
  onDeleted?: () => void;
  isNew: boolean;
  menu: AdminMenuItem[];
}) {
  const [form, setForm] = useState<Partial<Inquiry>>(inquiry);
  // Snapshot of the last persisted version of this inquiry. We deep-equal
  // form against this to drive the "Unsaved changes" pill and the
  // auto-save-before-quote-action behavior in QuoteActions.
  const [savedSnapshot, setSavedSnapshot] = useState<Partial<Inquiry>>(inquiry);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    // Legacy migration: if a cart-source inquiry has orderItems but no lineItems
    // yet, prefill the quote editor from the cart so admins can edit/send.
    // New cart inquiries are seeded server-side (orders.ts) with full
    // sizing + tier info so this fallback only runs for inquiries created
    // before that change. We still forward any descriptor fields the
    // snapshot carries so the seeded line shows the right "Medium Pan"
    // / "tray of 12" descriptor right away — falling back to a bare
    // line is the worst case, never the default.
    let next: Partial<Inquiry> = inquiry;
    const hasNoLines = !Array.isArray(inquiry.lineItems) || (inquiry.lineItems?.length ?? 0) === 0;
    const cartItems = Array.isArray(inquiry.orderItems) ? inquiry.orderItems : null;
    if (hasNoLines && cartItems && cartItems.length > 0) {
      next = {
        ...inquiry,
        lineItems: cartItems.map(c => ({
          id: uid(),
          menuItemId: null,
          name: c.name,
          quantity: Number(c.quantity) || 0,
          unitPrice: Number(c.price) || 0,
          notes: null,
          pricingTemplate: c.pricingTemplate ?? null,
          sizeSlot: c.sizeSlot ?? null,
          sizeLabel: c.sizeLabel ?? null,
          sizeServings: c.sizeServings ?? null,
          unit: c.unit ?? null,
          servingSize: c.servingSize ?? null,
        })),
      };
    }
    setForm(next);
    // Snapshot is the persisted inquiry as the server gave it to us — the
    // legacy migration only mutates local state, so any mismatch (e.g. a
    // legacy cart inquiry that gained synthetic lineItems above) correctly
    // shows as dirty until the admin saves.
    setSavedSnapshot(inquiry);
    setSaved(false);
    setError("");
  }, [inquiry]);

  const isDirty = useMemo(() => !deepEqual(form, savedSnapshot), [form, savedSnapshot]);

  function set(key: keyof Inquiry, value: any) {
    setForm(p => ({ ...p, [key]: value }));
    setSaved(false);
  }
  function patch(p: Partial<Inquiry>) {
    setForm(prev => ({ ...prev, ...p }));
    setSaved(false);
  }

  // Persist the current form to the server and return the saved inquiry.
  // Throws on validation or network error so callers (manual Save click +
  // QuoteActions auto-save) can react. Updates the snapshot so isDirty
  // flips back to false once the server response is in.
  async function flushSave(): Promise<Inquiry> {
    if (!form.clientName?.trim()) {
      setError("Client name is required.");
      throw new Error("Client name is required.");
    }
    setSaving(true);
    setError("");
    try {
      const url = isNew ? `${BASE}/api/admin/catering` : `${BASE}/api/admin/catering/${(inquiry as Inquiry).id}`;
      const method = isNew ? "POST" : "PUT";
      const res = await fetch(url, { method, headers: authHeaders(), body: JSON.stringify(form) });
      if (!res.ok) throw new Error("Failed to save. Please try again.");
      const savedData: Inquiry = await res.json();
      setForm(savedData);
      setSavedSnapshot(savedData);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      onSaved(savedData);
      return savedData;
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : "Failed to save. Please try again.";
      setError(msg);
      throw err instanceof Error ? err : new Error(msg);
    } finally {
      setSaving(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    try { await flushSave(); } catch { /* error already surfaced via setError */ }
  }

  async function handleDelete() {
    if (!confirm(`Delete inquiry for "${form.clientName}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await fetch(`${BASE}/api/admin/catering/${(inquiry as Inquiry).id}`, { method: "DELETE", headers: authHeaders() });
      onDeleted?.();
    } catch {
      setError("Failed to delete.");
    } finally {
      setDeleting(false);
    }
  }

  const inputCls = "w-full px-3 py-2 border border-border rounded-xl bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all text-sm";
  const textareaCls = `${inputCls} resize-none`;
  const isCartOrder = form.source === "cart";
  const hasItems = isCartOrder && Array.isArray(form.orderItems) && form.orderItems.length > 0;
  const lineItems: QuoteLineItem[] = (form.lineItems as QuoteLineItem[] | null | undefined) ?? [];
  const fees: QuoteAdjustment[] = (form.fees as QuoteAdjustment[] | null | undefined) ?? [];
  const discounts: QuoteAdjustment[] = (form.discounts as QuoteAdjustment[] | null | undefined) ?? [];

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <h2 className="font-display font-bold text-lg">{isNew ? "New Inquiry" : form.clientName || "Edit Inquiry"}</h2>
          {isCartOrder && (
            <span className="flex items-center gap-1 px-2 py-0.5 bg-primary/10 text-primary text-xs font-bold rounded-full">
              <ShoppingCart className="w-3 h-3" /> Cart Order
            </span>
          )}
        </div>
        <button onClick={onClose} className="p-2 rounded-xl hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      <form onSubmit={handleSave} className="flex-1 overflow-y-auto">
        <div className="p-6 space-y-4">
          {/* Two-way SMS chat — only shown for persisted inquiries (need an id). */}
          {!isNew && (inquiry as Inquiry).id != null && (
            <MessagesPanel
              inquiryId={(inquiry as Inquiry).id}
              hasPhone={!!(form.clientPhone && form.clientPhone.trim())}
            />
          )}

          {/* Cart items table (read-only) */}
          {hasItems && (
            <OrderItemsTable items={form.orderItems!} total={form.orderTotal ?? null} />
          )}

          {/* On the Dash snapshot — shown when this inquiry was placed as OTD */}
          {form.serviceMode === "on_the_dash" && (() => {
            const setupFee = form.otdSetupFee != null ? Number(form.otdSetupFee) : null;
            const waiver   = form.otdFeeWaiverThreshold != null ? Number(form.otdFeeWaiverThreshold) : null;
            const incHrs   = form.otdIncludedHours != null ? Number(form.otdIncludedHours) : null;
            const addRate  = form.otdAdditionalHourRate != null ? Number(form.otdAdditionalHourRate) : null;
            const maxAdd   = form.otdMaxAdditionalHours ?? null;
            // Count how many of this inquiry's items are still On-the-Dash
            // eligible per the live menu. Prefer line items (have menuItemId);
            // fall back to legacy cart orderItems by name match. Items we
            // can't resolve to the menu are excluded from the denominator
            // so the ratio reflects what we can actually verify.
            const menuById = new Map<number, AdminMenuItem>(menu.map(m => [m.id, m]));
            const menuByName = new Map<string, AdminMenuItem>(
              menu.map(m => [m.name.trim().toLowerCase(), m]),
            );
            const lineItemsRaw = (form.lineItems as QuoteLineItem[] | null | undefined) ?? [];
            const orderItemsRaw = (form.orderItems as OrderItem[] | null | undefined) ?? [];
            const itemsForCheck: { name: string; menuItemId: number | null }[] =
              lineItemsRaw.length > 0
                ? lineItemsRaw.map(li => ({ name: li.name, menuItemId: li.menuItemId ?? null }))
                : orderItemsRaw.map(oi => ({ name: oi.name, menuItemId: null }));
            let resolved = 0;
            let eligible = 0;
            for (const it of itemsForCheck) {
              const m = (it.menuItemId != null ? menuById.get(it.menuItemId) : undefined)
                ?? menuByName.get(it.name.trim().toLowerCase());
              if (!m) continue;
              resolved++;
              if (m.otdEligible) eligible++;
            }
            const totalItems = itemsForCheck.length;
            const allResolvedEligible = resolved > 0 && eligible === resolved;
            const subtotalRaw = form.subtotal != null ? Number(form.subtotal) : null;
            const subtotalNum = subtotalRaw != null && Number.isFinite(subtotalRaw)
              ? subtotalRaw
              : (form.orderTotal != null ? (() => {
                  const n = Number(String(form.orderTotal).replace(/[^0-9.\-]/g, ""));
                  return Number.isFinite(n) ? n : null;
                })() : null);
            const canEvalWaiver = setupFee != null && waiver != null && subtotalNum != null;
            const waivedHere = canEvalWaiver && subtotalNum >= waiver;
            return (
              <div className="border border-orange-200 bg-orange-50/60 rounded-xl overflow-hidden">
                <div className="px-4 py-2 border-b border-orange-200 bg-orange-100/60 flex items-center gap-2">
                  <Flame className="w-3.5 h-3.5 text-orange-700" />
                  <span className="text-xs font-bold uppercase tracking-wider text-orange-900">
                    On the Dash Experience
                  </span>
                  {canEvalWaiver && (
                    waivedHere ? (
                      <span
                        className="ml-auto text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 bg-emerald-100 text-emerald-800 rounded-full"
                        title={`Subtotal ${formatCurrency(subtotalNum!)} ≥ waiver threshold ${formatCurrency(waiver!)}`}
                      >
                        Setup fee waived
                      </span>
                    ) : (
                      <span
                        className="ml-auto text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 bg-amber-100 text-amber-800 rounded-full"
                        title={`Subtotal ${formatCurrency(subtotalNum!)} < waiver threshold ${formatCurrency(waiver!)} — fee will be billed`}
                      >
                        Setup fee applies
                      </span>
                    )
                  )}
                </div>
                <div className="px-4 py-3 grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-orange-900/70 font-semibold mb-0.5">Setup fee</div>
                    <div className="font-bold text-orange-900">{setupFee != null ? formatCurrency(setupFee) : "—"}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-orange-900/70 font-semibold mb-0.5">Waived at</div>
                    <div className="font-bold text-orange-900">{waiver != null ? formatCurrency(waiver) : "—"}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-orange-900/70 font-semibold mb-0.5">Included hours</div>
                    <div className="font-bold text-orange-900">{incHrs != null ? `${incHrs} hr` : "—"}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-orange-900/70 font-semibold mb-0.5">Extra hour rate</div>
                    <div className="font-bold text-orange-900">{addRate != null ? `${formatCurrency(addRate)}/hr` : "—"}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-orange-900/70 font-semibold mb-0.5">Max extra hours</div>
                    <div className="font-bold text-orange-900">{maxAdd != null ? `${maxAdd} hr` : "—"}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-orange-900/70 font-semibold mb-0.5">Eligible items</div>
                    {totalItems === 0 ? (
                      <div className="font-bold text-orange-900/60">—</div>
                    ) : resolved === 0 ? (
                      <div
                        className="font-bold text-orange-900/60"
                        title="None of these items match the current menu, so eligibility can't be confirmed."
                      >
                        Unknown
                      </div>
                    ) : allResolvedEligible ? (
                      <div
                        className="font-bold text-emerald-700 inline-flex items-center gap-1"
                        title={`All ${eligible} of ${resolved} matched item(s) are flagged On the Dash–eligible.`}
                      >
                        <Check className="w-3.5 h-3.5" />
                        {eligible}/{resolved}
                      </div>
                    ) : (
                      <div
                        className="font-bold text-amber-700 inline-flex items-center gap-1"
                        title={`Only ${eligible} of ${resolved} matched item(s) are still flagged On the Dash–eligible — ${resolved - eligible} item(s) would now be blocked.`}
                      >
                        <Ban className="w-3.5 h-3.5" />
                        {eligible}/{resolved}
                      </div>
                    )}
                  </div>
                </div>
                <p className="px-4 pb-3 text-[11px] text-orange-900/70 italic">
                  These terms were snapshotted when the customer submitted this inquiry, so they remain accurate even if event settings change later.
                  {totalItems > 0 && resolved < totalItems && (
                    <> {totalItems - resolved} item(s) couldn't be matched to the current menu.</>
                  )}
                </p>
              </div>
            );
          })()}

          {/* Status pipeline + service-mode toggle */}
          <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-start">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground block mb-2">Status</label>
              <div className="flex flex-wrap gap-2">
                {STATUSES.map(s => (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => set("status", s.key)}
                    className={cn(
                      "px-3 py-1.5 rounded-lg text-sm font-medium transition-all",
                      form.status === s.key
                        ? `${s.color} ring-2 ring-offset-1 ring-current`
                        : "bg-secondary text-muted-foreground hover:bg-secondary/80"
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            {!isNew && (
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground block mb-2">Service Mode</label>
                <div className="inline-flex rounded-lg border border-border overflow-hidden">
                  <button
                    type="button"
                    onClick={() => set("serviceMode", "drop_off")}
                    className={cn(
                      "inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium transition-colors",
                      form.serviceMode === "drop_off"
                        ? "bg-foreground text-background"
                        : "bg-background text-muted-foreground hover:bg-secondary",
                    )}
                    title="Standard Drop-Off catering"
                  >
                    <Truck className="w-3.5 h-3.5" /> Drop-Off
                  </button>
                  <button
                    type="button"
                    onClick={() => set("serviceMode", "on_the_dash")}
                    className={cn(
                      "inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border-l border-border transition-colors",
                      form.serviceMode === "on_the_dash"
                        ? "bg-orange-600 text-white"
                        : "bg-background text-muted-foreground hover:bg-secondary",
                    )}
                    title="On the Dash Experience — food trailer cooking on-site"
                  >
                    <Flame className="w-3.5 h-3.5" /> On the Dash
                  </button>
                </div>
                {form.serviceMode !== inquiry.serviceMode && (
                  <p className="mt-1.5 text-[11px] text-amber-700 max-w-[16rem]">
                    {form.serviceMode === "on_the_dash"
                      ? "Save to snapshot OTD pricing from current event settings."
                      : "Save to clear the OTD pricing snapshot."}
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="border-t border-border pt-4 grid gap-4">
            <Field icon={User} label="Client Name">
              <input value={form.clientName ?? ""} onChange={e => set("clientName", e.target.value)} placeholder="Full name" className={inputCls} />
            </Field>

            <Field icon={Building2} label="Organization">
              <input value={form.organization ?? ""} onChange={e => set("organization", e.target.value)} placeholder="Company or group name" className={inputCls} />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field icon={Mail} label="Email">
                <input type="email" value={form.clientEmail ?? ""} onChange={e => set("clientEmail", e.target.value)} placeholder="client@example.com" className={inputCls} />
              </Field>
              <Field icon={Phone} label="Phone">
                <input type="tel" value={form.clientPhone ?? ""} onChange={e => set("clientPhone", e.target.value)} placeholder="(555) 000-0000" className={inputCls} />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field icon={CalendarDays} label="Event Date">
                <input type="date" value={form.eventDate ?? ""} onChange={e => set("eventDate", e.target.value)} className={inputCls} />
              </Field>
              <Field icon={Users} label="Guest Count">
                <input
                  type="number"
                  min={1}
                  value={form.guestCount ?? ""}
                  onChange={e => set("guestCount", e.target.value === "" ? null : parseInt(e.target.value))}
                  placeholder="50"
                  className={inputCls}
                />
              </Field>
            </div>

            <Field icon={MapPin} label="Venue / Address">
              <VenueAutocomplete
                value={form.venueAddress ?? ""}
                onChange={(val) => set("venueAddress", val)}
                placeholder="Event location"
                inputClassName={inputCls}
                className="relative"
              />
              {form.venueAddress?.trim() && (
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(form.venueAddress.trim())}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 mt-2 text-xs font-semibold text-primary hover:underline"
                  title="Open this address in Google Maps in a new tab"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Open in Maps
                </a>
              )}
            </Field>

            <Field icon={FileText} label="Menu Notes">
              <textarea
                value={form.menuNotes ?? ""}
                onChange={e => set("menuNotes", e.target.value)}
                rows={3}
                placeholder="Dietary restrictions, preferred items, special requests…"
                className={textareaCls}
              />
            </Field>

            <Field icon={StickyNote} label="Admin Notes">
              <textarea
                value={form.adminNotes ?? ""}
                onChange={e => set("adminNotes", e.target.value)}
                rows={3}
                placeholder="Internal notes — quotes sent, follow-ups needed, etc."
                className={textareaCls}
              />
            </Field>
          </div>

          {!isNew && (
            <>
              <QuoteEditor
                lineItems={lineItems}
                fees={fees}
                discounts={discounts}
                quoteNotes={form.quoteNotes ?? ""}
                quoteExpiresAt={form.quoteExpiresAt ?? null}
                onChange={(p) => patch(p as Partial<Inquiry>)}
                menu={menu}
                serviceMode={form.serviceMode ?? null}
                otdSetupFee={form.otdSetupFee != null ? Number(form.otdSetupFee) : null}
                otdFeeWaiverThreshold={form.otdFeeWaiverThreshold != null ? Number(form.otdFeeWaiverThreshold) : null}
                otdAdditionalHourRate={form.otdAdditionalHourRate != null ? Number(form.otdAdditionalHourRate) : null}
                otdMaxAdditionalHours={form.otdMaxAdditionalHours ?? null}
              />

              <p className="text-xs text-muted-foreground italic">
                Save changes to lock in totals before generating or sending the quote.
              </p>

              {form.id !== undefined && (
                <>
                  <QuoteActions
                    inquiry={form as Inquiry}
                    onUpdated={(i) => { setForm(i); setSavedSnapshot(i); onSaved(i); }}
                    isDirty={isDirty}
                    flushSave={flushSave}
                  />
                  <SquarePanel
                    inquiry={form as Inquiry}
                    onUpdated={(i) => { setForm(i); setSavedSnapshot(i); onSaved(i); }}
                  />
                </>
              )}
            </>
          )}

          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>
      </form>

      <div className="px-6 py-4 border-t border-border flex items-center gap-3 shrink-0">
        {!isNew && (
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-muted-foreground hover:text-destructive hover:bg-red-50 rounded-xl transition-colors"
          >
            {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            Delete
          </button>
        )}
        <button
          onClick={handleSave}
          disabled={saving}
          className="ml-auto flex items-center gap-2 px-5 py-2.5 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4 text-emerald-400" /> : <Save className="w-4 h-4" />}
          {saving ? "Saving…" : saved ? "Saved!" : "Save"}
        </button>
      </div>
    </div>
  );
}

export default function CateringOrders() {
  const [inquiries, setInquiries] = useState<Inquiry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Partial<Inquiry> | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [menu, setMenu] = useState<AdminMenuItem[]>([]);
  // Per-inquiry unread inbound SMS counts. Updated over the same SSE
  // stream the chat panel uses, so the list badge moves the moment a
  // new inbound lands or the admin opens the thread.
  const [unreadByInquiry, setUnreadByInquiry] = useState<Record<number, number>>({});

  const load = useCallback(() => {
    fetch(`${BASE}/api/admin/catering`, { headers: authHeaders() })
      .then(r => r.json())
      .then(setInquiries)
      .finally(() => setLoading(false));
  }, []);

  const loadBadges = useCallback(async () => {
    const token = getAdminToken();
    if (!token) return;
    try {
      const r = await fetch(`${BASE}/api/admin/messages/badges`, { headers: authHeaders() });
      if (!r.ok) return;
      const data = (await r.json()) as { perInquiry?: Array<{ inquiryId: number; unread: number }> };
      const map: Record<number, number> = {};
      (data.perInquiry ?? []).forEach(r => { map[r.inquiryId] = r.unread; });
      setUnreadByInquiry(map);
    } catch {
      // silent — list badges aren't critical
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadBadges(); }, [loadBadges]);

  // Subscribe to the SMS event stream so list-level badges update live
  // without depending on the chat panel being open. The chat panel
  // maintains its own subscription for thread updates.
  useEffect(() => {
    const token = getAdminToken();
    if (!token) return;
    let es: EventSource | null = null;
    let pollInt: ReturnType<typeof setInterval> | null = null;
    function startPoll() {
      if (!pollInt) pollInt = setInterval(loadBadges, 30_000);
    }
    try {
      es = new EventSource(`${BASE}/api/admin/messages/stream?token=${encodeURIComponent(token)}`);
      es.addEventListener("inbound", () => loadBadges());
      es.addEventListener("messages-seen", () => loadBadges());
      es.addEventListener("unmatched-changed", () => loadBadges());
      es.onerror = () => startPoll();
    } catch {
      startPoll();
    }
    return () => {
      es?.close();
      if (pollInt) clearInterval(pollInt);
    };
  }, [loadBadges]);

  useEffect(() => {
    type RawMenuItem = {
      id: number; name: string; category: string; price: number | string;
      pricingTemplate?: string | null;
      unit?: string | null;
      servingSize?: number | null;
      size1Label?: string | null; size1Servings?: number | null; size1Price?: string | number | null;
      size2Label?: string | null; size2Servings?: number | null; size2Price?: string | number | null;
      size3Label?: string | null; size3Servings?: number | null; size3Price?: string | number | null;
      size4Label?: string | null; size4Servings?: number | null; size4Price?: string | number | null;
      size5Label?: string | null; size5Servings?: number | null; size5Price?: string | number | null;
      tier2Qty?: number | null; tier2Price?: string | number | null;
      tier3Qty?: number | null; tier3Price?: string | number | null;
      otdEligible?: boolean | null;
    };
    const num = (v: unknown): number | null => {
      if (v == null || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    fetch(`${BASE}/api/admin/menu`, { headers: authHeaders() })
      .then(r => r.ok ? r.json() as Promise<RawMenuItem[]> : [] as RawMenuItem[])
      .then((data) => setMenu(
        (data ?? []).map((m): AdminMenuItem => {
          const tmpl = m.pricingTemplate === "pan_sizes" ? "pan_sizes" : "per_unit";
          const sizes: AdminMenuItemSize[] = [];
          if (tmpl === "pan_sizes") {
            const slots = [
              { slot: 1, label: m.size1Label, servings: m.size1Servings, price: m.size1Price },
              { slot: 2, label: m.size2Label, servings: m.size2Servings, price: m.size2Price },
              { slot: 3, label: m.size3Label, servings: m.size3Servings, price: m.size3Price },
              { slot: 4, label: m.size4Label, servings: m.size4Servings, price: m.size4Price },
              { slot: 5, label: m.size5Label, servings: m.size5Servings, price: m.size5Price },
            ];
            for (const s of slots) {
              const price = num(s.price);
              if (s.label && price != null) {
                sizes.push({ slot: s.slot, label: s.label, servings: num(s.servings), price });
              }
            }
          }
          return {
            id: m.id, name: m.name, category: m.category, price: Number(m.price) || 0,
            pricingTemplate: tmpl,
            unit: m.unit ?? null,
            servingSize: num(m.servingSize),
            sizes,
            tier2Qty: num(m.tier2Qty),
            tier2Price: num(m.tier2Price),
            tier3Qty: num(m.tier3Qty),
            tier3Price: num(m.tier3Price),
            otdEligible: m.otdEligible === true,
          };
        }),
      ))
      .catch(() => setMenu([]));
  }, []);

  // Auto-open inquiry from URL hash (?inquiry=ID) — used by Convert-to-inquiry from CateringPlans.
  useEffect(() => {
    if (!inquiries.length) return;
    const params = new URLSearchParams(window.location.search);
    const wantId = params.get("inquiry");
    if (wantId) {
      const match = inquiries.find(i => String(i.id) === wantId);
      if (match) {
        setSelected(match);
        setIsNew(false);
        // Clear the param so refresh doesn't re-trigger.
        const next = new URL(window.location.href);
        next.searchParams.delete("inquiry");
        window.history.replaceState({}, "", next.toString());
      }
    }
  }, [inquiries]);

  function openNew() {
    setSelected(emptyForm());
    setIsNew(true);
  }

  function closePanel() {
    setSelected(null);
    setIsNew(false);
  }

  function handleSaved(saved: Inquiry) {
    setInquiries(prev => {
      const idx = prev.findIndex(i => i.id === saved.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = saved;
        return next;
      }
      return [saved, ...prev];
    });
    setSelected(saved);
    setIsNew(false);
  }

  function handleDeleted() {
    if (selected && "id" in selected) {
      setInquiries(prev => prev.filter(i => i.id !== (selected as Inquiry).id));
    }
    closePanel();
  }

  const q = search.trim().toLowerCase();
  const filtered = inquiries
    .filter(i => statusFilter === "all" || i.status === statusFilter)
    .filter(i => !q || i.clientName.toLowerCase().includes(q) || (i.clientEmail ?? "").toLowerCase().includes(q) || (i.clientPhone ?? "").toLowerCase().includes(q));

  const counts: Record<string, number> = {};
  inquiries.forEach(i => { counts[i.status] = (counts[i.status] ?? 0) + 1; });

  return (
    <AdminLayout>
      <div className="flex h-[calc(100vh-8rem)] -m-4 md:-m-8 overflow-hidden">
        {/* Left panel — list */}
        <div className={cn("flex flex-col border-r border-border bg-background transition-all", selected ? "hidden md:flex md:w-80 lg:w-96 shrink-0" : "flex-1")}>
          {/* Header */}
          <div className="px-6 py-5 border-b border-border shrink-0">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h1 className="font-display font-bold text-2xl">Catering Inquiries</h1>
                <p className="text-sm text-muted-foreground">{inquiries.length} total inquir{inquiries.length !== 1 ? "ies" : "y"}</p>
              </div>
              <button
                onClick={openNew}
                className="flex items-center gap-2 px-4 py-2 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors text-sm"
              >
                <Plus className="w-4 h-4" /> New
              </button>
            </div>

            {/* Search */}
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search by name, email, or phone…"
                className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-xl bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all"
              />
              {search && (
                <button onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Status filter */}
            <div className="flex gap-1.5 flex-wrap">
              <button
                onClick={() => setStatusFilter("all")}
                className={cn("px-3 py-1 rounded-lg text-sm font-medium transition-colors", statusFilter === "all" ? "bg-foreground text-background" : "hover:bg-secondary text-muted-foreground")}
              >
                All {inquiries.length > 0 && `(${inquiries.length})`}
              </button>
              {STATUSES.map(s => (
                counts[s.key] ? (
                  <button
                    key={s.key}
                    onClick={() => setStatusFilter(s.key)}
                    className={cn("px-3 py-1 rounded-lg text-sm font-medium transition-colors", statusFilter === s.key ? "bg-foreground text-background" : "hover:bg-secondary text-muted-foreground")}
                  >
                    {s.label} ({counts[s.key]})
                  </button>
                ) : null
              ))}
            </div>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-20 text-muted-foreground px-6">
                <FileText className="w-12 h-12 mx-auto mb-4 opacity-20" />
                <p className="font-medium mb-1">
                  {q ? `No results for "${search}"` : statusFilter === "all" ? "No catering inquiries yet" : `No ${statusFilter} inquiries`}
                </p>
                {!q && statusFilter === "all" && <p className="text-sm">Click "New" to add a catering inquiry.</p>}
              </div>
            ) : (
              <div className="divide-y divide-border">
                {filtered.map(inquiry => {
                  const status = getStatusMeta(inquiry.status);
                  const isSelected = selected && "id" in selected && (selected as Inquiry).id === inquiry.id;
                  const isCart = inquiry.source === "cart";
                  return (
                    <button
                      key={inquiry.id}
                      onClick={() => { setSelected(inquiry); setIsNew(false); }}
                      className={cn(
                        "w-full text-left px-6 py-4 flex items-center gap-4 hover:bg-secondary/50 transition-colors",
                        isSelected && "bg-secondary"
                      )}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                          <span className="font-semibold text-sm truncate">{inquiry.clientName}</span>
                          {unreadByInquiry[inquiry.id] > 0 && (
                            <span
                              className="shrink-0 inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 bg-primary text-primary-foreground rounded-full font-bold"
                              title={`${unreadByInquiry[inquiry.id]} new inbound text${unreadByInquiry[inquiry.id] === 1 ? "" : "s"}`}
                            >
                              <MessageSquare className="w-2.5 h-2.5" /> {unreadByInquiry[inquiry.id]}
                            </span>
                          )}
                          <span className={cn("shrink-0 text-xs px-2 py-0.5 rounded-full font-medium", status.color)}>{status.label}</span>
                          {isCart && (
                            <span className="shrink-0 flex items-center gap-0.5 text-xs px-1.5 py-0.5 bg-primary/10 text-primary rounded-full font-semibold">
                              <ShoppingCart className="w-2.5 h-2.5" /> Cart
                            </span>
                          )}
                          {inquiry.serviceMode === "on_the_dash" ? (
                            <span
                              className="shrink-0 inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 bg-orange-100 text-orange-700 rounded-full font-bold uppercase tracking-wider"
                              title="On the Dash Experience — food trailer cooking on-site"
                            >
                              <Flame className="w-2.5 h-2.5" /> On the Dash
                            </span>
                          ) : inquiry.serviceMode === "drop_off" ? (
                            <span
                              className="shrink-0 inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 bg-secondary text-muted-foreground rounded-full font-semibold uppercase tracking-wider"
                              title="Standard Drop-Off catering"
                            >
                              <Truck className="w-2.5 h-2.5" /> Drop-Off
                            </span>
                          ) : null}
                          {inquiry.quoteNumber && (
                            <span className="shrink-0 text-[10px] font-mono px-1.5 py-0.5 bg-violet-100 text-violet-700 rounded-full">
                              {inquiry.quoteNumber}
                            </span>
                          )}
                          {inquiry.quoteAcceptedAt && (
                            <span className="shrink-0 inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded-full font-semibold">
                              <Check className="w-2.5 h-2.5" /> Accepted
                            </span>
                          )}
                          {inquiry.quoteChangeRequestAt && !inquiry.quoteAcceptedAt && (
                            <span className="shrink-0 inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded-full font-semibold">
                              <MessageSquare className="w-2.5 h-2.5" /> Changes requested
                            </span>
                          )}
                        </div>
                        {inquiry.organization && <p className="text-xs text-muted-foreground truncate">{inquiry.organization}</p>}
                        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                          {inquiry.eventDate && <span>{formatDate(inquiry.eventDate)}</span>}
                          {inquiry.guestCount && <span>{inquiry.guestCount} guests</span>}
                          {(inquiry.total ?? inquiry.orderTotal) && (
                            <span className="font-semibold text-foreground/70">
                              {inquiry.total ? formatCurrency(Number(inquiry.total)) : inquiry.orderTotal}
                            </span>
                          )}
                          {!inquiry.eventDate && !inquiry.guestCount && <span>Added {formatDate(inquiry.createdAt)}</span>}
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right panel — detail */}
        {selected ? (
          <div className="flex-1 flex flex-col bg-card min-w-0">
            <DetailPanel
              inquiry={selected}
              onClose={closePanel}
              onSaved={handleSaved}
              onDeleted={handleDeleted}
              isNew={isNew}
              menu={menu}
            />
          </div>
        ) : (
          <div className="flex-1 hidden md:flex items-center justify-center text-muted-foreground flex-col gap-3">
            <FileText className="w-16 h-16 opacity-10" />
            <p className="font-medium">Select an inquiry to view details</p>
            <p className="text-sm">or click New to create one</p>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
