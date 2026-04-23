import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import { getAdminToken } from "@/components/AdminGuard";
import {
  Plus, Loader2, X, Save, Trash2, ChevronRight, CalendarDays,
  User, Mail, Phone, Building2, MapPin, Users, FileText, StickyNote, Check,
  Search, ShoppingCart, Receipt, Download, Send, MessageSquare, Copy, Link as LinkIcon,
  ArrowUp, ArrowDown, CreditCard, RefreshCw, ExternalLink, Ban,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils";

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

type OrderItem = { name: string; quantity: number; price: number };

type QuoteLineItem = {
  id: string;
  menuItemId: number | null;
  name: string;
  quantity: number;
  unitPrice: number;
  notes?: string | null;
};

type QuoteAdjustment = {
  id: string;
  label: string;
  kind: "fixed" | "percent";
  amount: number;
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
  createdAt: string;
  updatedAt: string;
};

type AdminMenuItem = { id: number; name: string; category: string; price: number };

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
          {items.map((item, i) => (
            <tr key={i} className="border-b border-border/50 last:border-0">
              <td className="px-4 py-2.5 font-medium">{item.name}</td>
              <td className="px-4 py-2.5 text-center">{item.quantity}</td>
              <td className="px-4 py-2.5 text-right text-muted-foreground">{formatCurrency(item.price)}</td>
              <td className="px-4 py-2.5 text-right font-semibold">{formatCurrency(item.price * item.quantity)}</td>
            </tr>
          ))}
        </tbody>
        {total && (
          <tfoot>
            <tr className="border-t-2 border-border bg-secondary/20">
              <td colSpan={3} className="px-4 py-2.5 text-sm font-bold text-right">Total</td>
              <td className="px-4 py-2.5 text-right font-bold text-primary">{total}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

// ── Quote Editor section ─────────────────────────────────────────────────────

function MenuPicker({ menu, onPick }: { menu: AdminMenuItem[]; onPick: (item: AdminMenuItem) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
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

  return (
    <div className="relative" ref={ref}>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        <input
          value={q}
          onFocus={() => setOpen(true)}
          onChange={e => { setQ(e.target.value); setOpen(true); }}
          placeholder="Search menu items to add…"
          className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-xl bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
        />
      </div>
      {open && filtered.length > 0 && (
        <div className="absolute z-20 left-0 right-0 mt-1 bg-card border border-border rounded-xl shadow-lg max-h-64 overflow-y-auto">
          {filtered.map(m => (
            <button
              key={m.id}
              type="button"
              onClick={() => { onPick(m); setQ(""); setOpen(false); }}
              className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-secondary"
            >
              <div className="min-w-0">
                <p className="font-medium truncate">{m.name}</p>
                <p className="text-xs text-muted-foreground truncate">{m.category}</p>
              </div>
              <span className="text-xs font-semibold shrink-0">{formatCurrency(m.price)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function QuoteEditor({
  lineItems, fees, discounts, quoteNotes, quoteExpiresAt,
  onChange, menu,
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
}) {
  const totals = useMemo(() => computeTotalsClient(lineItems, fees, discounts), [lineItems, fees, discounts]);

  const numCls = "w-20 px-2 py-1.5 text-sm text-right border border-border rounded-lg bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none";
  const txtCls = "w-full px-2 py-1.5 text-sm border border-border rounded-lg bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none";

  function addCustom() {
    onChange({ lineItems: [...lineItems, { id: uid(), menuItemId: null, name: "", quantity: 1, unitPrice: 0, notes: null }] });
  }
  function pickMenu(m: AdminMenuItem) {
    onChange({ lineItems: [...lineItems, { id: uid(), menuItemId: m.id, name: m.name, quantity: 1, unitPrice: m.price, notes: null }] });
  }
  function updateItem(id: string, patch: Partial<QuoteLineItem>) {
    onChange({ lineItems: lineItems.map(li => li.id === id ? { ...li, ...patch } : li) });
  }
  function removeItem(id: string) {
    onChange({ lineItems: lineItems.filter(li => li.id !== id) });
  }
  function moveItem(id: string, dir: -1 | 1) {
    const idx = lineItems.findIndex(li => li.id === id);
    if (idx < 0) return;
    const next = idx + dir;
    if (next < 0 || next >= lineItems.length) return;
    const arr = lineItems.slice();
    [arr[idx], arr[next]] = [arr[next], arr[idx]];
    onChange({ lineItems: arr });
  }
  function addAdj(kind: "fee" | "discount") {
    const newRow: QuoteAdjustment = { id: uid(), label: kind === "fee" ? "Fee" : "Discount", kind: "fixed", amount: 0 };
    if (kind === "fee") onChange({ fees: [...fees, newRow] });
    else onChange({ discounts: [...discounts, newRow] });
  }
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
          <div className="space-y-2">
            {lineItems.map((li, idx) => {
              const lineTotal = (Number(li.quantity) || 0) * (Number(li.unitPrice) || 0);
              return (
                <div key={li.id} className="grid grid-cols-[36px_1fr_60px_90px_80px_28px] gap-2 items-center">
                  <div className="flex flex-col items-center -my-1">
                    <button
                      type="button"
                      onClick={() => moveItem(li.id, -1)}
                      disabled={idx === 0}
                      className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-20"
                      title="Move up"
                    >
                      <ArrowUp className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveItem(li.id, 1)}
                      disabled={idx === lineItems.length - 1}
                      className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-20"
                      title="Move down"
                    >
                      <ArrowDown className="w-3 h-3" />
                    </button>
                  </div>
                  <input
                    value={li.name}
                    onChange={e => updateItem(li.id, { name: e.target.value })}
                    placeholder="Item name"
                    className={txtCls}
                  />
                  <input
                    type="number" min={0} step="1" inputMode="numeric"
                    value={li.quantity}
                    onChange={e => updateItem(li.id, { quantity: e.target.value === "" ? 0 : Number(e.target.value) })}
                    className={numCls}
                  />
                  <input
                    type="number" min={0} step="0.01" inputMode="decimal"
                    value={li.unitPrice}
                    onChange={e => updateItem(li.id, { unitPrice: e.target.value === "" ? 0 : Number(e.target.value) })}
                    className={numCls}
                  />
                  <span className="text-right text-sm font-semibold tabular-nums">{formatCurrency(lineTotal)}</span>
                  <button type="button" onClick={() => removeItem(li.id)} className="p-1 rounded hover:bg-red-50 text-muted-foreground hover:text-destructive" title="Remove">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Fees */}
        <AdjustmentList kind="fee" rows={fees}
          onAdd={() => addAdj("fee")}
          onUpdate={(id, patch) => updateAdj(fees, id, patch, "fee")}
          onRemove={(id) => removeAdj(fees, id, "fee")}
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
  inquiry, onUpdated,
}: {
  inquiry: Inquiry;
  onUpdated: (i: Inquiry) => void;
}) {
  const [busy, setBusy] = useState<null | "gen" | "email" | "sms">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const viewUrl = inquiry.quoteToken
    ? `${window.location.origin}${BASE}/quote/${inquiry.quoteToken}`
    : null;
  const pdfUrl = `${BASE}/api/admin/catering/${inquiry.id}/quote.pdf`;
  const issued = !!inquiry.quoteIssuedAt;

  async function generate() {
    setBusy("gen"); setMsg(null);
    try {
      const r = await fetch(`${BASE}/api/admin/catering/${inquiry.id}/quote`, { method: "POST", headers: authHeaders() });
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
      const r = await fetch(`${BASE}/api/admin/catering/${inquiry.id}/quote/email`, {
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
      const r = await fetch(`${BASE}/api/admin/catering/${inquiry.id}/quote/sms`, {
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

  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <div className="bg-violet-50 px-4 py-2 border-b border-border flex items-center gap-2">
        <Send className="w-3.5 h-3.5 text-violet-700" />
        <span className="text-xs font-bold uppercase tracking-wider text-violet-700">Quote Actions</span>
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
            {issued ? "Refresh Quote" : "Generate Quote"}
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
            Email PDF
          </button>
          <button
            type="button"
            onClick={smsQuote}
            disabled={busy !== null || !issued || !inquiry.clientPhone}
            title={!inquiry.clientPhone ? "No client phone on file" : !issued ? "Generate the quote first" : ""}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-secondary text-foreground text-sm font-semibold rounded-xl hover:bg-border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy === "sms" ? <Loader2 className="w-4 h-4 animate-spin" /> : <MessageSquare className="w-4 h-4" />}
            Text Link
          </button>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {inquiry.quoteLastEmailedAt && <span>Emailed {formatDateTime(inquiry.quoteLastEmailedAt)}</span>}
          {inquiry.quoteLastTextedAt && <span>Texted {formatDateTime(inquiry.quoteLastTextedAt)}</span>}
        </div>

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
  const canCancel = hasInvoice && !isPaid;

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
            </div>
          </>
        )}
        {msg && <p className="text-xs text-muted-foreground border-t border-border pt-2">{msg}</p>}
      </div>
    </div>
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
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    // Legacy migration: if a cart-source inquiry has orderItems but no lineItems
    // yet, prefill the quote editor from the cart so admins can edit/send.
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
        })),
      };
    }
    setForm(next);
    setSaved(false);
    setError("");
  }, [inquiry]);

  function set(key: keyof Inquiry, value: any) {
    setForm(p => ({ ...p, [key]: value }));
    setSaved(false);
  }
  function patch(p: Partial<Inquiry>) {
    setForm(prev => ({ ...prev, ...p }));
    setSaved(false);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!form.clientName?.trim()) { setError("Client name is required."); return; }
    setSaving(true);
    setError("");
    try {
      const url = isNew ? `${BASE}/api/admin/catering` : `${BASE}/api/admin/catering/${(inquiry as Inquiry).id}`;
      const method = isNew ? "POST" : "PUT";
      const res = await fetch(url, { method, headers: authHeaders(), body: JSON.stringify(form) });
      if (!res.ok) throw new Error();
      const savedData = await res.json();
      setForm(savedData);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      onSaved(savedData);
    } catch {
      setError("Failed to save. Please try again.");
    } finally {
      setSaving(false);
    }
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
          {/* Cart items table (read-only) */}
          {hasItems && (
            <OrderItemsTable items={form.orderItems!} total={form.orderTotal ?? null} />
          )}

          {/* Status pipeline */}
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
              <input value={form.venueAddress ?? ""} onChange={e => set("venueAddress", e.target.value)} placeholder="Event location" className={inputCls} />
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
              />

              <p className="text-xs text-muted-foreground italic">
                Save changes to lock in totals before generating or sending the quote.
              </p>

              {form.id !== undefined && (
                <>
                  <QuoteActions
                    inquiry={form as Inquiry}
                    onUpdated={(i) => { setForm(i); onSaved(i); }}
                  />
                  <SquarePanel
                    inquiry={form as Inquiry}
                    onUpdated={(i) => { setForm(i); onSaved(i); }}
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

  const load = useCallback(() => {
    fetch(`${BASE}/api/admin/catering`, { headers: authHeaders() })
      .then(r => r.json())
      .then(setInquiries)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    type RawMenuItem = { id: number; name: string; category: string; price: number | string };
    fetch(`${BASE}/api/admin/menu`, { headers: authHeaders() })
      .then(r => r.ok ? r.json() as Promise<RawMenuItem[]> : [] as RawMenuItem[])
      .then((data) => setMenu(
        (data ?? []).map((m): AdminMenuItem => ({
          id: m.id, name: m.name, category: m.category, price: Number(m.price) || 0,
        })),
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
                          <span className={cn("shrink-0 text-xs px-2 py-0.5 rounded-full font-medium", status.color)}>{status.label}</span>
                          {isCart && (
                            <span className="shrink-0 flex items-center gap-0.5 text-xs px-1.5 py-0.5 bg-primary/10 text-primary rounded-full font-semibold">
                              <ShoppingCart className="w-2.5 h-2.5" /> Cart
                            </span>
                          )}
                          {inquiry.quoteNumber && (
                            <span className="shrink-0 text-[10px] font-mono px-1.5 py-0.5 bg-violet-100 text-violet-700 rounded-full">
                              {inquiry.quoteNumber}
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
