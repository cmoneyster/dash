import { useState, useEffect, useCallback, useMemo, Fragment } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import { getAdminToken } from "@/components/AdminGuard";
import {
  Loader2, TrendingDown, DollarSign, Users, TrendingUp,
  BarChart3, AlertCircle, Briefcase, FlaskConical, Link,
  ChevronDown, ChevronRight,
} from "lucide-react";
import { Link as WouterLink } from "wouter";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authHeaders() {
  const token = getAdminToken();
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

function fmt(n: number | null | undefined) {
  if (n == null) return "—";
  return `$${n.toFixed(2)}`;
}

function fmtPct(n: number | null | undefined) {
  if (n == null) return "—";
  return `${n.toFixed(1)}%`;
}

function todayISO(d: Date = new Date()) {
  const x = new Date(d);
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 10);
}

type ScopeFilter = "events" | "catering" | "all";
type Preset = "today" | "yesterday" | "week" | "month" | "quarter" | "year" | "custom";

function presetRange(p: Preset): { from: string; to: string } | null {
  const now = new Date();
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  if (p === "today") return { from: todayISO(today), to: todayISO(today) };
  if (p === "yesterday") { const y = new Date(today); y.setDate(y.getDate() - 1); return { from: todayISO(y), to: todayISO(y) }; }
  if (p === "week") { const f = new Date(today); f.setDate(f.getDate() - 6); return { from: todayISO(f), to: todayISO(today) }; }
  if (p === "month") { const f = new Date(today); f.setDate(f.getDate() - 29); return { from: todayISO(f), to: todayISO(today) }; }
  if (p === "quarter") { const f = new Date(today); f.setDate(f.getDate() - 89); return { from: todayISO(f), to: todayISO(today) }; }
  if (p === "year") { const f = new Date(today); f.setDate(f.getDate() - 364); return { from: todayISO(f), to: todayISO(today) }; }
  return null;
}

type ItemBreakdownComponent = { name: string; quantity: number; cogs: number };
type ItemBreakdown = { name: string; quantity: number; cogs: number; revenue: number; margin: number | null; components?: ItemBreakdownComponent[] };
type LaborBreakdown = { referenceType: string; referenceId: number; name: string; laborCost: number };
type Summary = {
  from: string;
  to: string;
  scope: string;
  revenue: number;
  cogs: number;
  laborCost: number;
  grossProfit: number;
  grossMargin: number | null;
  itemsWithRecipe: number;
  itemsWithoutRecipe: number;
  itemBreakdown: ItemBreakdown[];
  laborBreakdown: LaborBreakdown[];
};

function KpiCard({ label, value, sub, icon, accent }: { label: string; value: string; sub?: string; icon: React.ReactNode; accent: string }) {
  return (
    <div className="bg-card border border-border rounded-2xl p-4 shadow-sm">
      <div className="flex items-center gap-3 mb-2">
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${accent}`}>{icon}</div>
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      </div>
      <p className="text-2xl font-bold font-display">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

function MarginBadge({ margin }: { margin: number | null }) {
  if (margin == null) return <span className="text-muted-foreground">—</span>;
  const color = margin >= 40 ? "text-emerald-600 dark:text-emerald-400"
    : margin >= 20 ? "text-amber-600 dark:text-amber-400"
    : "text-rose-600 dark:text-rose-400";
  return <span className={`font-semibold ${color}`}>{margin.toFixed(1)}%</span>;
}

export default function CostSummary() {
  const [preset, setPreset] = useState<Preset>("month");
  const initial = presetRange("month")!;
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [scope, setScope] = useState<ScopeFilter>("events");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [itemView, setItemView] = useState<"combos" | "components">("combos");
  const [expandedCombos, setExpandedCombos] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ from, to, scope });
      const res = await fetch(`${BASE}/api/admin/costs/summary?${params}`, { headers: authHeaders() });
      if (!res.ok) throw new Error();
      setSummary(await res.json());
    } catch {
      setError("Failed to load cost summary");
    } finally {
      setLoading(false);
    }
  }, [from, to, scope]);

  useEffect(() => { load(); }, [load]);

  function applyPreset(p: Preset) {
    setPreset(p);
    const r = presetRange(p);
    if (r) { setFrom(r.from); setTo(r.to); }
  }

  // Flattened view: dissolve combos into their components and merge COGS + quantities
  const flattenedItems = useMemo(() => {
    const acc = new Map<string, { name: string; quantity: number; cogs: number }>();
    for (const item of (summary?.itemBreakdown ?? [])) {
      if (item.components && item.components.length > 0) {
        for (const comp of item.components) {
          const existing = acc.get(comp.name);
          if (existing) {
            existing.quantity += comp.quantity;
            existing.cogs = parseFloat((existing.cogs + comp.cogs).toFixed(2));
          } else {
            acc.set(comp.name, { name: comp.name, quantity: comp.quantity, cogs: comp.cogs });
          }
        }
      } else {
        const existing = acc.get(item.name);
        if (existing) {
          existing.quantity += item.quantity;
          existing.cogs = parseFloat((existing.cogs + item.cogs).toFixed(2));
        } else {
          acc.set(item.name, { name: item.name, quantity: item.quantity, cogs: item.cogs });
        }
      }
    }
    return Array.from(acc.values()).sort((a, b) => b.cogs - a.cogs || b.quantity - a.quantity);
  }, [summary]);

  return (
    <AdminLayout>
      <div className="mb-6">
        <h1 className="font-display font-bold text-2xl sm:text-4xl mb-1 flex items-center gap-3">
          <TrendingDown className="w-8 h-8 text-indigo-600" />
          Cost Summary
        </h1>
        <p className="text-muted-foreground text-sm">
          COGS, labor, and profitability estimates based on recipes and labor entries.
          Items missing recipes are excluded from COGS.
        </p>
      </div>

      {/* Filters */}
      <div className="bg-card border border-border rounded-2xl p-5 mb-6 shadow-sm space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mr-1">Range:</span>
          {(["today", "yesterday", "week", "month", "quarter", "year"] as Preset[]).map(p => (
            <button
              key={p}
              onClick={() => applyPreset(p)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${preset === p ? "bg-indigo-600 text-white" : "bg-secondary text-foreground hover:bg-secondary/70"}`}
            >
              {p === "today" ? "Today" : p === "yesterday" ? "Yesterday" : p === "week" ? "Last 7 Days" : p === "month" ? "Last 30 Days" : p === "quarter" ? "Last 90 Days" : "Last Year"}
            </button>
          ))}
          <button onClick={() => setPreset("custom")} className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${preset === "custom" ? "bg-indigo-600 text-white" : "bg-secondary text-foreground hover:bg-secondary/70"}`}>Custom</button>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">From</label>
            <input type="date" value={from} onChange={e => { setFrom(e.target.value); setPreset("custom"); }} className="px-3 py-2 border border-border rounded-lg bg-background text-sm" />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">To</label>
            <input type="date" value={to} onChange={e => { setTo(e.target.value); setPreset("custom"); }} className="px-3 py-2 border border-border rounded-lg bg-background text-sm" />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Scope</label>
            <select value={scope} onChange={e => setScope(e.target.value as ScopeFilter)} className="px-3 py-2 border border-border rounded-lg bg-background text-sm">
              <option value="events">On-Site Events</option>
              <option value="catering">Catering</option>
              <option value="all">All (Events + Catering)</option>
            </select>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="px-5 py-2 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2 text-sm"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <BarChart3 className="w-4 h-4" />}
            Refresh
          </button>
        </div>
      </div>

      {error && <div className="bg-destructive/10 text-destructive border border-destructive/20 rounded-xl p-4 mb-6 text-sm">{error}</div>}

      {!summary ? (
        loading ? <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div> : null
      ) : (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
            <KpiCard label="Revenue" value={fmt(summary.revenue)} icon={<DollarSign className="w-5 h-5" />} accent="text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40" />
            <KpiCard label="COGS" value={fmt(summary.cogs)} sub="Food cost" icon={<FlaskConical className="w-5 h-5" />} accent="text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40" />
            <KpiCard label="Labor" value={fmt(summary.laborCost)} icon={<Users className="w-5 h-5" />} accent="text-sky-600 dark:text-sky-400 bg-sky-50 dark:bg-sky-950/40" />
            <KpiCard label="Gross Profit" value={fmt(summary.grossProfit)} sub={summary.grossMargin != null ? `${summary.grossMargin.toFixed(1)}% margin` : undefined} icon={<TrendingUp className="w-5 h-5" />} accent={summary.grossProfit >= 0 ? "text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/40" : "text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40"} />
            <KpiCard label="Margin" value={fmtPct(summary.grossMargin)} sub="After COGS + Labor" icon={<BarChart3 className="w-5 h-5" />} accent="text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-950/40" />
          </div>

          {/* Warning about missing recipes */}
          {summary.itemsWithoutRecipe > 0 && (
            <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-xl p-4 mb-6 flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
                  {summary.itemsWithoutRecipe} item type{summary.itemsWithoutRecipe !== 1 ? "s" : ""} missing recipe data
                </p>
                <p className="text-xs text-amber-700 dark:text-amber-300 mt-0.5">
                  COGS figures are partial — items without recipes are excluded.{" "}
                  <WouterLink href="/admin/menu" className="underline hover:no-underline">
                    Edit menu items
                  </WouterLink>{" "}
                  to add recipes, or visit the{" "}
                  <WouterLink href="/admin/costs/ingredients" className="underline hover:no-underline">
                    Ingredient Library
                  </WouterLink>{" "}
                  to set up ingredients first.
                </p>
              </div>
            </div>
          )}

          {/* Item breakdown */}
          {summary.itemBreakdown.length > 0 && (
            <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden mb-6">
              <div className="px-5 py-4 border-b border-border bg-secondary/30 flex flex-wrap items-center gap-3">
                <div className="flex-1 min-w-0">
                  <h2 className="font-display font-bold text-lg">By Item</h2>
                  <p className="text-xs text-muted-foreground">COGS, revenue, and margin per item type. Items without recipes show $0.00 COGS.</p>
                </div>
                {summary.itemBreakdown.some(i => i.components && i.components.length > 0) && (
                  <div className="flex items-center gap-1 rounded-lg bg-secondary p-1 text-xs font-semibold shrink-0">
                    <button
                      onClick={() => setItemView("combos")}
                      className={`px-3 py-1.5 rounded-md transition-colors ${itemView === "combos" ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                    >
                      By combo
                    </button>
                    <button
                      onClick={() => setItemView("components")}
                      className={`px-3 py-1.5 rounded-md transition-colors ${itemView === "components" ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                    >
                      By component
                    </button>
                  </div>
                )}
              </div>
              <div className="overflow-x-auto">
                {itemView === "components" ? (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-secondary/20">
                        <th className="text-left px-5 py-3 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Item</th>
                        <th className="text-right px-4 py-3 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Qty</th>
                        <th className="text-right px-5 py-3 font-semibold text-xs uppercase tracking-wider text-muted-foreground">COGS</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {flattenedItems.map((item, i) => (
                        <tr key={i} className="hover:bg-secondary/20 transition-colors">
                          <td className="px-5 py-3 font-medium">{item.name}</td>
                          <td className="px-4 py-3 text-right text-muted-foreground">{item.quantity}</td>
                          <td className="px-5 py-3 text-right font-mono text-amber-600 dark:text-amber-400">
                            {item.cogs > 0 ? fmt(item.cogs) : <span className="text-muted-foreground italic text-xs">no recipe</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-secondary/20">
                        <th className="text-left px-5 py-3 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Item</th>
                        <th className="text-right px-4 py-3 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Qty</th>
                        <th className="text-right px-4 py-3 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Revenue</th>
                        <th className="text-right px-4 py-3 font-semibold text-xs uppercase tracking-wider text-muted-foreground">COGS</th>
                        <th className="text-right px-5 py-3 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Margin</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {summary.itemBreakdown.map((item, i) => {
                        const hasComponents = item.components && item.components.length > 0;
                        const isExpanded = expandedCombos.has(item.name);
                        return (
                          <Fragment key={i}>
                            <tr
                              className={`hover:bg-secondary/20 transition-colors ${hasComponents ? "cursor-pointer" : ""}`}
                              onClick={hasComponents ? () => setExpandedCombos(prev => {
                                const next = new Set(prev);
                                if (next.has(item.name)) next.delete(item.name); else next.add(item.name);
                                return next;
                              }) : undefined}
                            >
                              <td className="px-5 py-3 font-medium flex items-center gap-1.5">
                                {hasComponents ? (
                                  isExpanded
                                    ? <ChevronDown className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                                    : <ChevronRight className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                                ) : (
                                  <span className="w-3.5 shrink-0" />
                                )}
                                {item.name}
                              </td>
                              <td className="px-4 py-3 text-right text-muted-foreground">{item.quantity}</td>
                              <td className="px-4 py-3 text-right font-mono">{fmt(item.revenue)}</td>
                              <td className="px-4 py-3 text-right font-mono text-amber-600 dark:text-amber-400">
                                {item.cogs > 0 ? fmt(item.cogs) : <span className="text-muted-foreground italic text-xs">no recipe</span>}
                              </td>
                              <td className="px-5 py-3 text-right"><MarginBadge margin={item.cogs > 0 ? item.margin : null} /></td>
                            </tr>
                            {hasComponents && isExpanded && item.components!.map((comp, ci) => (
                              <tr key={ci} className="bg-secondary/10 border-b border-border/40 last:border-0">
                                <td className="py-2 text-muted-foreground">
                                  <span className="pl-10 pr-5 flex items-center gap-1.5">
                                    <span className="w-1 h-1 rounded-full bg-muted-foreground/50 shrink-0" />
                                    {comp.name}
                                  </span>
                                </td>
                                <td className="px-4 py-2 text-right text-muted-foreground text-xs">{comp.quantity}</td>
                                <td className="px-4 py-2 text-right text-muted-foreground text-xs">—</td>
                                <td className="px-4 py-2 text-right font-mono text-xs text-amber-500 dark:text-amber-400/80">
                                  {comp.cogs > 0 ? fmt(comp.cogs) : <span className="text-muted-foreground italic">no recipe</span>}
                                </td>
                                <td className="px-5 py-2 text-right text-muted-foreground text-xs">—</td>
                              </tr>
                            ))}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          {/* Labor breakdown */}
          {summary.laborBreakdown.length > 0 && (
            <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden mb-6">
              <div className="px-5 py-4 border-b border-border bg-secondary/30">
                <h2 className="font-display font-bold text-lg">Labor by Event / Inquiry</h2>
                <p className="text-xs text-muted-foreground">Total labor cost logged for each session or catering inquiry.</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-secondary/20">
                      <th className="text-left px-5 py-3 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Session / Inquiry</th>
                      <th className="text-left px-4 py-3 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Type</th>
                      <th className="text-right px-5 py-3 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Labor Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {summary.laborBreakdown.map((l, i) => (
                      <tr key={i} className="hover:bg-secondary/20 transition-colors">
                        <td className="px-5 py-3 font-medium flex items-center gap-2">
                          <WouterLink
                            href={l.referenceType === "event_session" ? "/admin/event-history" : `/admin/catering?inquiry=${l.referenceId}`}
                            className="text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-1"
                          >
                            {l.name}
                            <Link className="w-3 h-3 opacity-60" />
                          </WouterLink>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${l.referenceType === "event_session" ? "bg-indigo-100 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-400" : "bg-teal-100 dark:bg-teal-950/40 text-teal-700 dark:text-teal-400"}`}>
                            {l.referenceType === "event_session" ? "Event" : "Catering"}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-right font-mono font-semibold text-sky-600 dark:text-sky-400">{fmt(l.laborCost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {summary.itemBreakdown.length === 0 && summary.laborBreakdown.length === 0 && (
            <div className="bg-card border border-border rounded-2xl p-10 text-center text-muted-foreground">
              <Briefcase className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="font-semibold">No cost data for this period</p>
              <p className="text-sm mt-1">
                Add recipes to menu items and labor entries to sessions/inquiries to see cost breakdowns here.
              </p>
            </div>
          )}
        </>
      )}
    </AdminLayout>
  );
}
