import { useEffect, useState, useMemo, Fragment } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import { getAdminToken } from "@/components/AdminGuard";
import {
  Loader2, Download, BarChart3, Users, ShoppingBag, DollarSign,
  Receipt, Package, ChevronDown, ChevronRight, Wallet, Timer,
  Ban, AlertCircle,
} from "lucide-react";
import type {
  SalesReport,
  SalesReportTotals,
  SalesReportOrder,
  SalesReportOrderLine,
  SalesReportItem,
  SalesReportVoids,
  SalesReportVoidRow,
  SalesReportPickupStats,
  SalesReportPaymentMethodTotal,
  SalesReportScope,
  CateringReportTotals,
  CateringReportOrder,
  CateringReportItem,
} from "@workspace/api-client-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type SourceFilter = "all" | "guest" | "staff";
type ScopeFilter = SalesReportScope;
type StatusFilter = "all" | "completed";
type Preset = "today" | "yesterday" | "week" | "month" | "quarter" | "year" | "custom";

// Re-export generated contract types under the names used throughout this component.
type ReportItem = SalesReportItem;
type ReportOrderLine = SalesReportOrderLine;
type PaymentMethod = SalesReportOrder["paymentMethod"];
type ReportOrder = SalesReportOrder;
type CateringItem = CateringReportItem;
type CateringOrder = CateringReportOrder;
type AnyOrder = ReportOrder | CateringOrder;
function isCateringOrder(o: AnyOrder): o is CateringOrder {
  return (o as CateringOrder).type === "catering";
}
type CateringTotals = CateringReportTotals;
type PaymentMethodTotal = SalesReportPaymentMethodTotal;
type PickupStats = SalesReportPickupStats;
type ReportVoidRow = SalesReportVoidRow;
type ReportVoids = SalesReportVoids;
type ReportTotals = SalesReportTotals;
type Report = SalesReport;

function todayISO(d: Date = new Date()) {
  const x = new Date(d);
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 10);
}
function fmt(n: number) { return `$${n.toFixed(2)}`; }
function fmtDuration(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

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
  const [status, setStatus] = useState<StatusFilter>("all");
  // Scope: "events" (default) = event orders only; "catering" = paid catering only; "all" = unified.
  const [scope, setScope] = useState<ScopeFilter>("events");
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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
      const params = new URLSearchParams({ from, to, source, status, scope });
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

  useEffect(() => { loadReport(); /* eslint-disable-next-line */ }, [from, to, source, status, scope]);

  async function downloadCsv(type: "orders" | "items" | "voids") {
    const params = new URLSearchParams({ from, to, source, status, type, scope });
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

  function toggleExpanded(key: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  // Combined order list comes from the backend byType.allOrders (sorted by createdAt desc).
  // Backend tags event orders with type="event" and catering orders with type="catering".
  const allOrders = useMemo(
    (): AnyOrder[] => (report?.byType?.allOrders ?? []) as AnyOrder[],
    [report],
  );

  const [itemSort, setItemSort] = useState<{ col: "name" | "quantity" | "revenue"; dir: "asc" | "desc" }>({ col: "revenue", dir: "desc" });
  // Backend merges items across event+catering in totals.items based on scope.
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
          <p className="text-muted-foreground">Revenue, orders, and item breakdown across on-site event orders and paid catering inquiries.</p>
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
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Scope</label>
            <select value={scope} onChange={e => setScope(e.target.value as ScopeFilter)} className="px-3 py-2 border border-border rounded-lg bg-background">
              <option value="events">On-Site Events</option>
              <option value="catering">Catering</option>
              <option value="all">All (Events + Catering)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Status</label>
            <select value={status} onChange={e => setStatus(e.target.value as StatusFilter)} className="px-3 py-2 border border-border rounded-lg bg-background">
              <option value="all">All statuses</option>
              <option value="completed">Completed / Picked Up only</option>
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
            <button
              onClick={() => downloadCsv("voids")}
              disabled={loading || !report || scope === "catering" || (report?.totals.voids.count ?? 0) === 0}
              className="px-4 py-2 bg-rose-600 text-white font-semibold rounded-xl hover:bg-rose-700 disabled:opacity-50 flex items-center gap-2 text-sm"
              data-testid="button-download-voids-csv"
            >
              <Download className="w-4 h-4" /> Voids CSV
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive border border-destructive/20 rounded-xl p-4 mb-6 text-sm">{error}</div>
      )}

      {report && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 mb-6">
            <Kpi label="Revenue" value={fmt(report.totals.revenue)} icon={<DollarSign className="w-5 h-5" />} accent="text-emerald-600 bg-emerald-50" />
            <Kpi label="Orders" value={String(report.totals.orderCount)} icon={<ShoppingBag className="w-5 h-5" />} accent="text-indigo-600 bg-indigo-50" />
            <Kpi label="Items Sold" value={String(report.totals.itemCount)} icon={<Package className="w-5 h-5" />} accent="text-amber-600 bg-amber-50" />
            <Kpi label="Avg Order" value={fmt(report.totals.avgOrderValue)} icon={<Users className="w-5 h-5" />} accent="text-sky-600 bg-sky-50" />
            <Kpi label="Tax Collected" value={scope === "catering" ? "—" : fmt(report.totals.tax)} icon={<Receipt className="w-5 h-5" />} accent="text-rose-600 bg-rose-50" />
            {scope !== "catering" && <VoidsKpi voids={report.totals.voids} />}
          </div>

          {scope !== "catering" && (
            <PickupTimeCard stats={report.totals.pickupStats} totalOrders={report.totals.orderCount} />
          )}

          {scope === "all" && report.catering && (
            <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden mb-6">
              <div className="px-5 py-4 border-b border-border bg-secondary/30 flex items-center gap-2">
                <BarChart3 className="w-5 h-5 text-indigo-600" />
                <div>
                  <h2 className="font-display font-bold text-lg">By Type</h2>
                  <p className="text-xs text-muted-foreground">Revenue split between on-site events and paid catering inquiries.</p>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-border">
                <div className="bg-card p-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">On-Site Events</p>
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div><p className="text-xs text-muted-foreground">Orders</p><p className="text-lg font-bold">{report.totals.orderCount}</p></div>
                    <div><p className="text-xs text-muted-foreground">Items</p><p className="text-lg font-bold">{report.totals.itemCount}</p></div>
                    <div><p className="text-xs text-muted-foreground">Revenue</p><p className="text-lg font-bold">{fmt(report.totals.revenue)}</p></div>
                  </div>
                </div>
                <div className="bg-indigo-50/50 dark:bg-indigo-950/20 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Catering</p>
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div><p className="text-xs text-muted-foreground">Orders</p><p className="text-lg font-bold">{report.catering.orderCount}</p></div>
                    <div><p className="text-xs text-muted-foreground">Items</p><p className="text-lg font-bold">{report.catering.itemCount}</p></div>
                    <div><p className="text-xs text-muted-foreground">Revenue</p><p className="text-lg font-bold">{fmt(report.catering.revenue)}</p></div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {scope !== "all" && source === "all" && scope !== "catering" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
              <SourceCard title="Guest Event Ordering" totals={report.bySource.guest} />
              <SourceCard title="Staff Order Taker" totals={report.bySource.staff} accent />
            </div>
          )}

          {scope !== "catering" && <PaymentMethodBreakdown totals={report.totals} />}

          {scope !== "catering" && <VoidsSection voids={report.totals.voids} />}

          {/* Order-level table with expandable line details */}
          <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden mb-6">
            <div className="px-5 py-4 border-b border-border bg-secondary/30 flex items-center justify-between">
              <div>
                <h2 className="font-display font-bold text-lg">Orders</h2>
                <p className="text-xs text-muted-foreground">Click a row to expand line items.</p>
              </div>
              <span className="text-xs text-muted-foreground">{allOrders.length} orders</span>
            </div>
            {allOrders.length === 0 ? (
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
                      <th className="px-3 py-2.5 font-semibold">Payment</th>
                      <th className="px-3 py-2.5 font-semibold text-right">Subtotal</th>
                      <th className="px-3 py-2.5 font-semibold text-right">Tax</th>
                      <th className="px-3 py-2.5 font-semibold text-right">Total</th>
                      <th className="px-3 py-2.5 font-semibold text-right">Time to Pickup</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allOrders.map(o => {
                      const isCatering = isCateringOrder(o);
                      const rowKey = isCatering ? `c-${o.id}` : `e-${o.id}`;
                      const isOpen = expanded.has(rowKey);
                      const isVoided = !isCatering && (o as ReportOrder).voided;
                      const rowClass = isVoided
                        ? "border-b border-border/50 cursor-pointer bg-rose-50/40 hover:bg-rose-50/60 text-muted-foreground"
                        : "border-b border-border/50 hover:bg-secondary/30 cursor-pointer";
                      return (
                        <Fragment key={rowKey}>
                          <tr
                            className={rowClass}
                            onClick={() => toggleExpanded(rowKey)}
                            data-testid={isVoided ? `voided-row-${o.id}` : undefined}
                          >
                            <td className="px-3 py-2.5 text-muted-foreground">
                              {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                            </td>
                            <td className="px-3 py-2.5 font-mono text-xs">
                              {isCatering ? `C-${o.id}` : `#${o.id}`}
                              {isVoided && (
                                <span className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 border border-rose-200">
                                  <Ban className="w-3 h-3" /> Voided
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-xs text-muted-foreground">
                              {new Date(o.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                            </td>
                            <td className="px-3 py-2.5">
                              {isCatering ? (
                                <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-teal-100 text-teal-700">catering</span>
                              ) : (
                                <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                                  (o as ReportOrder).source === "staff" ? "bg-indigo-100 text-indigo-700" : "bg-emerald-100 text-emerald-700"
                                }`}>{(o as ReportOrder).source}</span>
                              )}
                            </td>
                            <td className="px-3 py-2.5">
                              {isCatering ? (
                                <div>
                                  <span>{(o as CateringOrder).clientName}</span>
                                  {(o as CateringOrder).eventDate && (
                                    <span className="block text-[10px] text-muted-foreground">
                                      Event: {(o as CateringOrder).eventDate}
                                    </span>
                                  )}
                                </div>
                              ) : (o as ReportOrder).guestName}
                            </td>
                            <td className="px-3 py-2.5">
                              {isCatering ? (
                                <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-teal-100 text-teal-700">
                                  {(o as CateringOrder).squareInvoiceStatus ?? "Invoice"}
                                </span>
                              ) : (
                                <PaymentBadge method={(o as ReportOrder).paymentMethod} />
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-right">
                              {isCatering ? "—" : fmt((o as ReportOrder).subtotal)}
                            </td>
                            <td className="px-3 py-2.5 text-right text-muted-foreground">
                              {isCatering ? "—" : fmt((o as ReportOrder).tax)}
                            </td>
                            <td className={`px-3 py-2.5 text-right font-semibold ${isVoided ? "line-through" : ""}`}>
                              {isCatering ? fmt((o as CateringOrder).squareAmountPaid) : fmt((o as ReportOrder).total)}
                            </td>
                            <td className="px-3 py-2.5 text-right text-xs">
                              {!isCatering && (o as ReportOrder).timeToPickupSec != null ? (
                                <span className="font-medium">{fmtDuration((o as ReportOrder).timeToPickupSec ?? null)}</span>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                          </tr>
                          {isOpen && (
                            <tr key={`${rowKey}-d`} className="border-b border-border/50 bg-secondary/20">
                              <td colSpan={10} className="px-12 py-3">
                                {!isCatering && ((o as ReportOrder).readyAt || (o as ReportOrder).pickedUpAt) && (
                                  <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                                    {(o as ReportOrder).readyAt && (
                                      <span>
                                        <span className="font-semibold text-foreground">Ready:</span>{" "}
                                        {new Date((o as ReportOrder).readyAt!).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                                      </span>
                                    )}
                                    {(o as ReportOrder).pickedUpAt && (
                                      <span>
                                        <span className="font-semibold text-foreground">Picked up:</span>{" "}
                                        {new Date((o as ReportOrder).pickedUpAt!).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                                      </span>
                                    )}
                                    {(o as ReportOrder).timeToPickupSec != null && (
                                      <span>
                                        <span className="font-semibold text-foreground">Total wait:</span>{" "}
                                        {fmtDuration((o as ReportOrder).timeToPickupSec ?? null)}
                                      </span>
                                    )}
                                  </div>
                                )}
                                {isCatering && (o as CateringOrder).eventDate && (
                                  <div className="mb-3 text-xs text-muted-foreground">
                                    <span className="font-semibold text-foreground">Event date:</span>{" "}
                                    {(o as CateringOrder).eventDate}
                                  </div>
                                )}
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
                                    {isCatering
                                      ? (o as CateringOrder).items.map((li, idx) => (
                                          <tr key={`${rowKey}-${idx}`}>
                                            <td className="py-1">{li.name}</td>
                                            <td className="py-1 text-center">{li.quantity}</td>
                                            <td className="py-1 text-right text-muted-foreground">—</td>
                                            <td className="py-1 text-right font-medium">{fmt(li.revenue)}</td>
                                          </tr>
                                        ))
                                      : (o as ReportOrder).items.map((li, idx) => (
                                          <tr key={`${rowKey}-${idx}`}>
                                            <td className="py-1">{li.name}</td>
                                            <td className="py-1 text-center">{li.quantity}</td>
                                            <td className="py-1 text-right">{fmt(li.unitPrice)}</td>
                                            <td className="py-1 text-right font-medium">{fmt(li.lineTotal)}</td>
                                          </tr>
                                        ))
                                    }
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          )}
                        </Fragment>
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

const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  cash: "Cash",
  card: "Card",
  venmo: "Venmo",
  override: "Override",
  other: "Other",
};
const PAYMENT_STYLES: Record<PaymentMethod, string> = {
  cash: "bg-emerald-100 text-emerald-700",
  card: "bg-sky-100 text-sky-700",
  venmo: "bg-violet-100 text-violet-700",
  override: "bg-amber-100 text-amber-800",
  other: "bg-secondary text-muted-foreground",
};

function PaymentBadge({ method }: { method: PaymentMethod }) {
  return (
    <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${PAYMENT_STYLES[method]}`}>
      {PAYMENT_LABELS[method]}
    </span>
  );
}

function ServicePhaseCard({
  title, subtitle, count, avgSec, medianSec, totalOrders, accent,
}: {
  title: string; subtitle: string; count: number;
  avgSec: number | null | undefined; medianSec: number | null | undefined;
  totalOrders: number; accent: string;
}) {
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className={`px-4 py-3 border-b border-border ${accent}`}>
        <p className="font-semibold text-sm">{title}</p>
        <p className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</p>
      </div>
      {count === 0 ? (
        <div className="px-4 py-6 text-center text-muted-foreground text-xs">
          No data in range.
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-px bg-border">
          <div className="bg-card p-3">
            <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">Avg</p>
            <p className="text-lg font-bold mt-0.5">{fmtDuration(avgSec ?? null)}</p>
          </div>
          <div className="bg-card p-3">
            <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">Median</p>
            <p className="text-lg font-bold mt-0.5">{fmtDuration(medianSec ?? null)}</p>
          </div>
          <div className="bg-card p-3">
            <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">Orders</p>
            <p className="text-lg font-bold mt-0.5">
              {count}
              {totalOrders > count && (
                <span className="text-xs font-normal text-muted-foreground"> / {totalOrders}</span>
              )}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function PickupTimeCard({ stats, totalOrders }: { stats: PickupStats; totalOrders: number }) {
  return (
    <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden mb-6">
      <div className="px-5 py-4 border-b border-border bg-secondary/30 flex items-center gap-2">
        <Timer className="w-5 h-5 text-indigo-600" />
        <div>
          <h2 className="font-display font-bold text-lg">Service Time</h2>
          <p className="text-xs text-muted-foreground">Kitchen flow and counter wait, broken down by phase.</p>
        </div>
      </div>
      <div className="p-4 grid grid-cols-1 lg:grid-cols-3 gap-3">
        <ServicePhaseCard
          title="Prep Time"
          subtitle="Placed → Ready (kitchen)"
          count={stats.prepCount}
          avgSec={stats.avgPrepSec}
          medianSec={stats.medianPrepSec}
          totalOrders={totalOrders}
          accent="bg-amber-50"
        />
        <ServicePhaseCard
          title="Counter Wait"
          subtitle="Ready → Picked Up"
          count={stats.readyToPickupCount}
          avgSec={stats.avgReadyToPickupSec}
          medianSec={stats.medianReadyToPickupSec}
          totalOrders={totalOrders}
          accent="bg-blue-50"
        />
        <ServicePhaseCard
          title="Total Wait"
          subtitle="Placed → Picked Up"
          count={stats.pickedUpCount}
          avgSec={stats.avgPickupSec}
          medianSec={stats.medianPickupSec}
          totalOrders={totalOrders}
          accent="bg-emerald-50"
        />
      </div>
    </div>
  );
}

function PaymentMethodBreakdown({ totals }: { totals: ReportTotals }) {
  // Hide buckets that have no orders so the layout stays focused on what was
  // actually rung up — but always show cash/card/venmo so the owner can see
  // a $0 reconciliation when nothing was taken in that method.
  const ALWAYS: PaymentMethod[] = ["cash", "card", "venmo"];
  const buckets = totals.byPaymentMethod.filter(
    b => ALWAYS.includes(b.method) || b.orderCount > 0
  );
  if (buckets.length === 0) return null;
  return (
    <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden mb-6">
      <div className="px-5 py-4 border-b border-border bg-secondary/30 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Wallet className="w-5 h-5 text-indigo-600" />
          <div>
            <h2 className="font-display font-bold text-lg">Payment Method Breakdown</h2>
            <p className="text-xs text-muted-foreground">Use this to reconcile the cash drawer at end of day.</p>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-px bg-border">
        {buckets.map(b => (
          <div key={b.method} className="bg-card p-4">
            <div className="flex items-center justify-between mb-1">
              <PaymentBadge method={b.method} />
              <span className="text-xs text-muted-foreground">{b.orderCount} {b.orderCount === 1 ? "order" : "orders"}</span>
            </div>
            <p className="text-2xl font-bold mt-1">{fmt(b.revenue)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// Voids KPI tile — slots into the top KPI strip. Stays muted (gray text on
// a neutral card) when there are no voids in the range so it doesn't add
// alarm signal to a clean shift; flips to a red accent when there are
// voids, and surfaces "refund owed" as a sub-line for the cashier.
function VoidsKpi({ voids }: { voids: ReportVoids }) {
  const hasVoids = voids.count > 0;
  const accent = hasVoids ? "text-rose-700 bg-rose-100" : "text-muted-foreground bg-secondary";
  return (
    <div className="bg-card border border-border rounded-2xl p-4 shadow-sm" data-testid="kpi-voids">
      <div className={`inline-flex items-center justify-center w-9 h-9 rounded-xl mb-2 ${accent}`}>
        <Ban className="w-5 h-5" />
      </div>
      <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Voids</p>
      <p className="text-2xl font-bold mt-0.5">
        {voids.count}
        <span className="text-base font-medium text-muted-foreground"> · {fmt(voids.totalAmount)}</span>
      </p>
      {voids.refundOwedAmount > 0 && (
        <p className="text-[11px] text-rose-700 font-semibold mt-1 flex items-center gap-1">
          <AlertCircle className="w-3 h-3" />
          {fmt(voids.refundOwedAmount)} refund owed
        </p>
      )}
    </div>
  );
}

// Voids section — one row per void with order #, when placed, customer,
// dollar amount, payment method, who voided it, when, reason, and a clear
// "Refund owed" badge for paid voids. Already sorted by voided-at desc on
// the server. Hidden when there are no voids in the range so the page
// doesn't grow an empty card.
function VoidsSection({ voids }: { voids: ReportVoids }) {
  if (voids.count === 0) return null;
  return (
    <div className="bg-card border border-rose-200 rounded-2xl shadow-sm overflow-hidden mb-6" data-testid="voids-section">
      <div className="px-5 py-4 border-b border-rose-200 bg-rose-50 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Ban className="w-5 h-5 text-rose-700" />
          <div>
            <h2 className="font-display font-bold text-lg">Voids</h2>
            <p className="text-xs text-muted-foreground">
              Excluded from revenue and item totals above. Refund-owed voids need a manual refund.
            </p>
          </div>
        </div>
        <div className="text-right text-xs">
          <p className="text-muted-foreground">{voids.count} void{voids.count === 1 ? "" : "s"} · {fmt(voids.totalAmount)}</p>
          {voids.refundOwedAmount > 0 && (
            <p className="text-rose-700 font-semibold mt-0.5">{fmt(voids.refundOwedAmount)} refund owed</p>
          )}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-secondary/20">
            <tr className="text-left text-xs text-muted-foreground uppercase tracking-wider">
              <th className="px-3 py-2.5 font-semibold">Order #</th>
              <th className="px-3 py-2.5 font-semibold">Placed</th>
              <th className="px-3 py-2.5 font-semibold">Customer</th>
              <th className="px-3 py-2.5 font-semibold">Payment</th>
              <th className="px-3 py-2.5 font-semibold text-right">Amount</th>
              <th className="px-3 py-2.5 font-semibold">Voided By</th>
              <th className="px-3 py-2.5 font-semibold">Voided At</th>
              <th className="px-3 py-2.5 font-semibold">Reason</th>
              <th className="px-3 py-2.5 font-semibold">Refund</th>
            </tr>
          </thead>
          <tbody>
            {voids.list.map(v => (
              <tr key={v.id} className="border-b border-border/50 last:border-0" data-testid={`void-row-${v.id}`}>
                <td className="px-3 py-2.5 font-mono text-xs">#{v.id}</td>
                <td className="px-3 py-2.5 text-xs text-muted-foreground">
                  {new Date(v.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </td>
                <td className="px-3 py-2.5">{v.guestName}</td>
                <td className="px-3 py-2.5"><PaymentBadge method={v.paymentMethod} /></td>
                <td className="px-3 py-2.5 text-right font-semibold">{fmt(v.total)}</td>
                <td className="px-3 py-2.5 text-sm">
                  {v.voidedBy ? v.voidedBy : <span className="text-muted-foreground italic">—</span>}
                </td>
                <td className="px-3 py-2.5 text-xs text-muted-foreground">
                  {new Date(v.voidedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </td>
                <td className="px-3 py-2.5 text-xs max-w-[280px] break-words">{v.voidReason ?? ""}</td>
                <td className="px-3 py-2.5">
                  {v.refundRequired ? (
                    <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 border border-rose-200">
                      Refund owed
                    </span>
                  ) : (
                    <span className="text-[10px] text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
