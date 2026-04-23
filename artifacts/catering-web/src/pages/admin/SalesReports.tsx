import { useEffect, useState } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import { getAdminToken } from "@/components/AdminGuard";
import { Loader2, Download, BarChart3, Users, ShoppingBag, DollarSign, Receipt, Package } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type SourceFilter = "all" | "guest" | "staff";

interface ReportTotals {
  orderCount: number;
  itemCount: number;
  subtotal: number;
  tax: number;
  revenue: number;
  avgOrderValue: number;
  items: Array<{ name: string; quantity: number; revenue: number }>;
}

interface Report {
  from: string;
  to: string;
  source: SourceFilter;
  totals: ReportTotals;
  bySource: { guest: ReportTotals; staff: ReportTotals };
}

function todayISO(d: Date = new Date()) {
  const x = new Date(d);
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 10);
}

function fmt(n: number) {
  return `$${n.toFixed(2)}`;
}

export default function SalesReports() {
  const [from, setFrom] = useState<string>(() => {
    const d = new Date(); d.setDate(d.getDate() - 30);
    return todayISO(d);
  });
  const [to, setTo] = useState<string>(() => todayISO());
  const [source, setSource] = useState<SourceFilter>("all");
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const token = getAdminToken();

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

  useEffect(() => { loadReport(); /* eslint-disable-next-line */ }, []);

  async function downloadCsv() {
    const params = new URLSearchParams({ from, to, source });
    const res = await fetch(`${BASE}/api/admin/sales-reports.csv?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) { setError("CSV download failed"); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sales-report_${from}_to_${to}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <AdminLayout>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display font-bold text-4xl mb-2 flex items-center gap-3">
            <BarChart3 className="w-8 h-8 text-indigo-600" />
            Sales Reports
          </h1>
          <p className="text-muted-foreground">Revenue and item breakdown across event orders.</p>
        </div>
      </div>

      <div className="bg-card border border-border rounded-2xl p-5 mb-6 flex flex-wrap items-end gap-3 shadow-sm">
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">From</label>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="px-3 py-2 border border-border rounded-lg bg-background" />
        </div>
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">To</label>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} className="px-3 py-2 border border-border rounded-lg bg-background" />
        </div>
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Source</label>
          <select value={source} onChange={e => setSource(e.target.value as SourceFilter)} className="px-3 py-2 border border-border rounded-lg bg-background">
            <option value="all">All sources</option>
            <option value="guest">Guest (/event)</option>
            <option value="staff">Staff Order Taker</option>
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
        <button
          onClick={downloadCsv}
          disabled={loading || !report}
          className="px-5 py-2 bg-foreground text-background font-semibold rounded-xl hover:opacity-90 disabled:opacity-50 flex items-center gap-2 ml-auto"
        >
          <Download className="w-4 h-4" /> Export CSV
        </button>
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
              <SourceCard title="Guest Orders (/event)" totals={report.bySource.guest} />
              <SourceCard title="Staff Order Taker (/event-taker)" totals={report.bySource.staff} accent />
            </div>
          )}

          <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-border bg-secondary/30">
              <h2 className="font-display font-bold text-lg">Item Breakdown</h2>
              <p className="text-xs text-muted-foreground">All items sold in the selected range, ranked by revenue.</p>
            </div>
            {report.totals.items.length === 0 ? (
              <div className="px-5 py-12 text-center text-muted-foreground text-sm">No orders in this range.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-secondary/20">
                  <tr className="text-left text-xs text-muted-foreground uppercase tracking-wider">
                    <th className="px-5 py-2.5 font-semibold">Item</th>
                    <th className="px-5 py-2.5 font-semibold text-center w-32">Qty</th>
                    <th className="px-5 py-2.5 font-semibold text-right w-40">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {report.totals.items.map(it => (
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
          <p className="text-lg font-bold">{fmt(totals.revenue)}</p>
        </div>
      </div>
    </div>
  );
}
