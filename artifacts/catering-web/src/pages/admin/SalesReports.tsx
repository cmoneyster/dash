import { useEffect, useState, useMemo, Fragment } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import { getAdminToken } from "@/components/AdminGuard";
import {
  Loader2, Download, BarChart3, Users, ShoppingBag, DollarSign,
  Receipt, Package, ChevronDown, ChevronRight,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type SourceFilter = "all" | "guest" | "staff";
type Preset = "today" | "yesterday" | "week" | "month" | "quarter" | "year" | "custom";

interface ReportItem { name: string; quantity: number; revenue: number }
interface ReportOrderLine { itemId: number; name: string; quantity: number; unitPrice: number; lineTotal: number }
interface ReportOrder {
  id: number; createdAt: string; source: string; guestName: string;
  phoneNumber: string | null; status: string;
  items: ReportOrderLine[]; subtotal: number; taxRate: number | null; tax: number; total: number;
}
interface ReportTotals {
  orderCount: number; itemCount: number; subtotal: number; tax: number;
  revenue: number; avgOrderValue: number; items: ReportItem[]; orders: ReportOrder[];
}
interface Report {
  from: string; to: string; source: SourceFilter;
  totals: ReportTotals;
  bySource: { guest: ReportTotals; staff: ReportTotals };
}

function todayISO(d: Date = new Date()) {
  const x = new Date(d);
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 10);
}
function fmt(n: number) { return `$${n.toFixed(2)}`; }

function presetRange(p: Preset): { from: string; to: string } | null {
  const now = new Date();
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  if (p === "today") return { from: todayISO(today), to: todayISO(today) };
  if (p === "yesterday") {
    const y = new Date(today); y.setDate(y.getDate() - 1);
    return { from: todayISO(y), to: todayISO(y) };
  }
  if (p === "week") {
    const f = new Date(today); f.setDate(f.getDate() - 6);
    return { from: todayISO(f), to: todayISO(today) };
  }
  if (p === "month") {
    const f = new Date(today); f.setDate(f.getDate() - 29);
    return { from: todayISO(f), to: todayISO(today) };
  }
  if (p === "quarter") {
    const f = new Date(today); f.setDate(f.getDate() - 89);
    return { from: todayISO(f), to: todayISO(today) };
  }
  if (p === "year") {
    const f = new Date(today); f.setDate(f.getDate() - 364);
    return { from: todayISO(f), to: todayISO(today) };
  }
  return null;
}

export default function SalesReports() {
  const [preset, setPreset] = useState<Preset>("today");
  const initial = presetRange("today")!;
  const [from, setFrom] = useState<string>(initial.from);
  const [to, setTo] = useState<string>(initial.to);
  // Default to staff source per spec — most relevant for the new POS reporting workflow.
  const [source, setSource] = useState<SourceFilter>("staff");
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const token = getAdminToken();

  function applyPreset(p: Preset) {
    setPreset(p);
    const r = presetRange(p);
    if (r) { setFrom(r.from); setTo(r.to); }
  }

  async function loadReport() {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ from, to, source });
      const res = await fetch(`${BASE}/api/admin/sales-reports?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error();
      setReport(await res.json());
    } catch {
      setError("Failed to load report");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadReport(); /* eslint-disable-next-line */ }, [from, to, source]);

  async function downloadCsv(type: "orders" | "items") {
    const params = new URLSearchParams({ from, to, source, type });
    const res = await fetch(`${BASE}/api/admin/sales-reports.csv?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) { setError("CSV download failed"); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sales-report_${type}_${from}_to_${to}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function toggleExpanded(id: number) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const orders = useMemo(() => report?.totals.orders ?? [], [report]);
  const [itemSort, setItemSort] = useState<{ col: "name" | "quantity" | "revenue"; dir: "asc" | "desc" }>({ col: "revenue", dir: "desc" });
  const sortedItems = useMemo(() => {
    const items = [...(report?.totals.items ?? [])];
    items.sort((a, b) => {
      const av = a[itemSort.col];
      const bv = b[itemSort.col];
      const cmp = typeof av === "string" ? (av as string).localeCompare(bv as string) : (av as number) - (bv as number);
      return itemSort.dir === "asc" ? cmp : -cmp;
    });
    return items;
  }, [report, itemSort]);

  return (
    <AdminLayout>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display font-bold text-4xl mb-2 flex items-center gap-3">
            <BarChart3 className="w-8 h-8 text-indigo-600" />
            Sales Reports
          </h1>
          <p className="text-muted-foreground">Revenue, orders, and item breakdown across event orders.</p>
        </div>
      </div>

      <div className="bg-card border border-border rounded-2xl p-5 mb-6 shadow-sm space-y-3">
        {/* Date presets */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mr-1">Range:</span>
          {([
            ["today", "Today"],
            ["yesterday", "Yesterday"],
            ["week", "Last 7 Days"],
            ["month", "Last 30 Days"],
            ["quarter", "Last 90 Days"],
            ["year", "Last Year"],
          ] as Array<[Preset, string]>).map(([k, label]) => (
            <button
              key={k}
              onClick={() => applyPreset(k)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                preset === k ? "bg-indigo-600 text-white" : "bg-secondary text-foreground hover:bg-secondary/70"
              }`}
            >{label}</button>
          ))}
          <button
            onClick={() => setPreset("custom")}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
              preset === "custom" ? "bg-indigo-600 text-white" : "bg-secondary text-foreground hover:bg-secondary/70"
            }`}
          >Custom</button>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">From</label>
            <input type="date" value={from} onChange={e => { setFrom(e.target.value); setPreset("custom"); }} className="px-3 py-2 border border-border rounded-lg bg-background" />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">To</label>
            <input type="date" value={to} onChange={e => { setTo(e.target.value); setPreset("custom"); }} className="px-3 py-2 border border-border rounded-lg bg-background" />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Source</label>
            <select value={source} onChange={e => setSource(e.target.value as SourceFilter)} className="px-3 py-2 border border-border rounded-lg bg-background">
              <option value="staff">Staff Order Taker</option>
              <option value="guest">Guest Event Ordering</option>
              <option value="all">All sources</option>
            </select>
          </div>
          <button
            onClick={loadReport}
            disabled={loading}
            className="px-5 py-2 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <BarChart3 className="w-4 h-4" />}
            Refresh
          </button>
          <div className="ml-auto flex flex-wrap gap-2">
            <button
              onClick={() => downloadCsv("orders")}
              disabled={loading || !report}
              className="px-4 py-2 bg-foreground text-background font-semibold rounded-xl hover:opacity-90 disabled:opacity-50 flex items-center gap-2 text-sm"
            >
              <Download className="w-4 h-4" /> Orders CSV
            </button>
            <button
              onClick={() => downloadCsv("items")}
              disabled={loading || !report}
              className="px-4 py-2 bg-foreground text-background font-semibold rounded-xl hover:opacity-90 disabled:opacity-50 flex items-center gap-2 text-sm"
            >
              <Download className="w-4 h-4" /> Items CSV
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive border border-destructive/20 rounded-xl p-4 mb-6 text-sm">{error}</div>
      )}

      {report && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
            <Kpi label="Revenue" value={fmt(report.totals.revenue)} icon={<DollarSign className="w-5 h-5" />} accent="text-emerald-600 bg-emerald-50" />
            <Kpi label="Orders" value={String(report.totals.orderCount)} icon={<ShoppingBag className="w-5 h-5" />} accent="text-indigo-600 bg-indigo-50" />
            <Kpi label="Items Sold" value={String(report.totals.itemCount)} icon={<Package className="w-5 h-5" />} accent="text-amber-600 bg-amber-50" />
            <Kpi label="Avg Order" value={fmt(report.totals.avgOrderValue)} icon={<Users className="w-5 h-5" />} accent="text-sky-600 bg-sky-50" />
            <Kpi label="Tax Collected" value={fmt(report.totals.tax)} icon={<Receipt className="w-5 h-5" />} accent="text-rose-600 bg-rose-50" />
          </div>

          {source === "all" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
              <SourceCard title="Guest Event Ordering" totals={report.bySource.guest} />
              <SourceCard title="Staff Order Taker" totals={report.bySource.staff} accent />
            </div>
          )}

          {/* Order-level table with expandable line details */}
          <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden mb-6">
            <div className="px-5 py-4 border-b border-border bg-secondary/30 flex items-center justify-between">
              <div>
                <h2 className="font-display font-bold text-lg">Orders</h2>
                <p className="text-xs text-muted-foreground">Click a row to expand line items.</p>
              </div>
              <span className="text-xs text-muted-foreground">{orders.length} orders</span>
            </div>
            {orders.length === 0 ? (
              <div className="px-5 py-12 text-center text-muted-foreground text-sm">No orders in this range.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-border bg-secondary/20">
                    <tr className="text-left text-xs text-muted-foreground uppercase tracking-wider">
                      <th className="px-3 py-2.5 w-8"></th>
                      <th className="px-3 py-2.5 font-semibold">Order #</th>
                      <th className="px-3 py-2.5 font-semibold">When</th>
                      <th className="px-3 py-2.5 font-semibold">Source</th>
                      <th className="px-3 py-2.5 font-semibold">Customer</th>
                      <th className="px-3 py-2.5 font-semibold text-right">Subtotal</th>
                      <th className="px-3 py-2.5 font-semibold text-right">Tax</th>
                      <th className="px-3 py-2.5 font-semibold text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map(o => {
                      const isOpen = expanded.has(o.id);
                      return (
                        <Fragment key={o.id}>
                          <tr
                            className="border-b border-border/50 hover:bg-secondary/30 cursor-pointer"
                            onClick={() => toggleExpanded(o.id)}
                          >
                            <td className="px-3 py-2.5 text-muted-foreground">
                              {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                            </td>
                            <td className="px-3 py-2.5 font-mono text-xs">#{o.id}</td>
                            <td className="px-3 py-2.5 text-xs text-muted-foreground">
                              {new Date(o.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                            </td>
                            <td className="px-3 py-2.5">
                              <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                                o.source === "staff" ? "bg-indigo-100 text-indigo-700" : "bg-emerald-100 text-emerald-700"
                              }`}>{o.source}</span>
                            </td>
                            <td className="px-3 py-2.5">{o.guestName}</td>
                            <td className="px-3 py-2.5 text-right">{fmt(o.subtotal)}</td>
                            <td className="px-3 py-2.5 text-right text-muted-foreground">{fmt(o.tax)}</td>
                            <td className="px-3 py-2.5 text-right font-semibold">{fmt(o.total)}</td>
                          </tr>
                          {isOpen && (
                            <tr key={`${o.id}-d`} className="border-b border-border/50 bg-secondary/20">
                              <td colSpan={8} className="px-12 py-3">
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="text-left text-muted-foreground">
                                      <th className="py-1 font-semibold">Item</th>
                                      <th className="py-1 font-semibold text-center w-16">Qty</th>
                                      <th className="py-1 font-semibold text-right w-24">Unit</th>
                                      <th className="py-1 font-semibold text-right w-24">Line</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {o.items.map((li, idx) => (
                                      <tr key={`${o.id}-${idx}`}>
                                        <td className="py-1">{li.name}</td>
                                        <td className="py-1 text-center">{li.quantity}</td>
                                        <td className="py-1 text-right">{fmt(li.unitPrice)}</td>
                                        <td className="py-1 text-right font-medium">{fmt(li.lineTotal)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          )}
                        </>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-border bg-secondary/30">
              <h2 className="font-display font-bold text-lg">Item Breakdown</h2>
              <p className="text-xs text-muted-foreground">Click any column header to sort.</p>
            </div>
            {report.totals.items.length === 0 ? (
              <div className="px-5 py-12 text-center text-muted-foreground text-sm">No items sold.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-secondary/20">
                  <tr className="text-left text-xs text-muted-foreground uppercase tracking-wider">
                    {(["name", "quantity", "revenue"] as const).map(col => {
                      const isActive = itemSort.col === col;
                      const arrow = isActive ? (itemSort.dir === "asc" ? " ▲" : " ▼") : "";
                      const align = col === "name" ? "text-left" : col === "quantity" ? "text-center w-32" : "text-right w-40";
                      const label = col === "name" ? "Item" : col === "quantity" ? "Qty" : "Revenue";
                      return (
                        <th
                          key={col}
                          onClick={() => setItemSort(s => ({ col, dir: s.col === col && s.dir === "desc" ? "asc" : "desc" }))}
                          className={`px-5 py-2.5 font-semibold cursor-pointer select-none hover:text-foreground ${align} ${isActive ? "text-foreground" : ""}`}
                        >
                          {label}{arrow}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {sortedItems.map(it => (
                    <tr key={it.name} className="border-b border-border/50 last:border-0">
                      <td className="px-5 py-2.5">{it.name}</td>
                      <td className="px-5 py-2.5 text-center font-medium">{it.quantity}</td>
                      <td className="px-5 py-2.5 text-right font-semibold">{fmt(it.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {!report && loading && (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      )}
    </AdminLayout>
  );
}

function Kpi({ label, value, icon, accent }: { label: string; value: string; icon: React.ReactNode; accent: string }) {
  return (
    <div className="bg-card border border-border rounded-2xl p-4 shadow-sm">
      <div className={`inline-flex items-center justify-center w-9 h-9 rounded-xl mb-2 ${accent}`}>{icon}</div>
      <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">{label}</p>
      <p className="text-2xl font-bold mt-0.5">{value}</p>
    </div>
  );
}

function SourceCard({ title, totals, accent = false }: { title: string; totals: ReportTotals; accent?: boolean }) {
  return (
    <div className={`border rounded-2xl p-4 ${accent ? "border-indigo-200 bg-indigo-50/50" : "border-border bg-card"}`}>
      <p className="font-semibold text-sm mb-2">{title}</p>
      <div className="grid grid-cols-3 gap-3 text-center">
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Orders</p>
          <p className="text-lg font-bold">{totals.orderCount}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Items</p>
          <p className="text-lg font-bold">{totals.itemCount}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Revenue</p>
          <p className="text-lg font-bold">${totals.revenue.toFixed(2)}</p>
        </div>
      </div>
    </div>
  );
}
