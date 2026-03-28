import { useState, useEffect, useCallback, useMemo } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import { getAdminToken } from "@/components/AdminGuard";
import {
  ClipboardList, Search, ArrowUpDown, ArrowUp, ArrowDown, ExternalLink,
  ChevronRight, X, Loader2, Save, Trash2, Users, Calendar, Clock,
  StickyNote, Package, RefreshCw, Hash, Copy, Check,
} from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authHeaders() {
  return { "Content-Type": "application/json", Authorization: `Bearer ${getAdminToken()}` };
}

type PlanSummary = {
  shareToken: string;
  planNumber: number | null;
  planName: string | null;
  adminNotes: string | null;
  createdAt: string | null;
  lastModifiedAt: string;
  expiresAt: string;
  itemCount: number;
  guestCount: number | null;
};

type MenuItemData = {
  id: number; name: string; category: string; price: number; unit: string;
  pricingTemplate: string; servingSize: number;
  size1Label: string | null; size1Price: number | null;
  size2Label: string | null; size2Price: number | null;
  size3Label: string | null; size3Price: number | null;
  size4Label: string | null; size4Price: number | null;
  size5Label: string | null; size5Price: number | null;
};

type PlanItem = {
  id: number;
  menuItemId: number;
  createdAt: string;
  menuItem: MenuItemData;
};

type PlannerState = {
  guests?: number;
  savoryPPG?: number;
  sweetPPG?: number;
  servingsPPG?: number;
  piecesMap?: Record<string, number>;
  servingsMap?: Record<string, number>;
  panQtys?: Record<string, Record<string, number>>;
};

type SizeBreakdown = { label: string; price: number; qty: number; subtotal: number };

function getItemQuantityInfo(item: PlanItem, ps: PlannerState | null): {
  qty: number | null;
  subtotal: number | null;
  sizes: SizeBreakdown[];
} {
  const mi = item.menuItem;
  // piecesMap and panQtys are keyed by plan_items.id (not menu_items.id) — matches SharedPlan.tsx line 280
  const idStr = String(item.id);

  if (mi.pricingTemplate === "pan_sizes") {
    const slots = ps?.panQtys?.[idStr] ?? {};
    const sizeEntries = [
      { idx: 1, label: mi.size1Label, price: mi.size1Price },
      { idx: 2, label: mi.size2Label, price: mi.size2Price },
      { idx: 3, label: mi.size3Label, price: mi.size3Price },
      { idx: 4, label: mi.size4Label, price: mi.size4Price },
      { idx: 5, label: mi.size5Label, price: mi.size5Price },
    ].filter(s => s.label && s.price != null);

    const sizes: SizeBreakdown[] = sizeEntries
      .map(s => {
        const qty = slots[String(s.idx)] ?? 0;
        return { label: s.label!, price: s.price!, qty, subtotal: qty * s.price! };
      })
      .filter(s => s.qty > 0);

    const totalQty = sizes.reduce((sum, s) => sum + s.qty, 0);
    const totalSubtotal = sizes.reduce((sum, s) => sum + s.subtotal, 0);
    return { qty: totalQty || null, subtotal: totalSubtotal || null, sizes };
  }

  // per_unit items — quantity comes from piecesMap
  const qty = ps?.piecesMap?.[idStr] ?? null;
  const subtotal = qty != null ? qty * mi.price : null;
  return { qty, subtotal, sizes: [] };
}

type PlanDetail = PlanSummary & {
  plannerState: PlannerState | null;
  items: PlanItem[];
};

type SortKey = "planNumber" | "planName" | "itemCount" | "guestCount" | "createdAt" | "lastModifiedAt" | "expiresAt";
type SortDir = "asc" | "desc";

function formatDate(s: string | null | undefined, includeTime = false) {
  if (!s) return "—";
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return "—";
    return includeTime
      ? d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
      : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch { return "—"; }
}

function isExpired(s: string) {
  return new Date(s) < new Date();
}

function daysUntilExpiry(s: string) {
  const diff = Math.floor((new Date(s).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  return diff;
}

function PlanNumberBadge({ n }: { n: number | null }) {
  if (n == null) return <span className="text-muted-foreground text-xs">—</span>;
  return (
    <span className="inline-flex items-center gap-1 font-mono text-sm font-bold text-primary">
      #{n}
    </span>
  );
}

function SortButton({
  label, sortKey, current, dir, onClick,
}: {
  label: string; sortKey: SortKey; current: SortKey; dir: SortDir; onClick: (k: SortKey) => void;
}) {
  const active = current === sortKey;
  return (
    <button
      onClick={() => onClick(sortKey)}
      className={cn(
        "flex items-center gap-1 text-xs font-semibold uppercase tracking-wider whitespace-nowrap select-none transition-colors",
        active ? "text-primary" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
      {active ? (
        dir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />
      ) : (
        <ArrowUpDown className="w-3 h-3 opacity-40" />
      )}
    </button>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };
  return (
    <button onClick={copy} title="Copy" className="p-1 rounded hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground">
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function DetailPanel({
  plan, onClose, onUpdated, onDeleted,
}: {
  plan: PlanSummary;
  onClose: () => void;
  onUpdated: (token: string, patch: Partial<PlanSummary>) => void;
  onDeleted: (token: string) => void;
}) {
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [planName, setPlanName] = useState(plan.planName ?? "");
  const [adminNotes, setAdminNotes] = useState(plan.adminNotes ?? "");
  const [dirty, setDirty] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`${BASE}/api/admin/plans/${plan.shareToken}`, { headers: authHeaders() as HeadersInit })
      .then(r => r.json())
      .then(d => { setDetail(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [plan.shareToken]);

  const shareUrl = `${window.location.origin}${BASE}/plan/share/${plan.shareToken}`;

  const save = async () => {
    setSaving(true);
    try {
      await fetch(`${BASE}/api/admin/plans/${plan.shareToken}`, {
        method: "PATCH",
        headers: authHeaders() as HeadersInit,
        body: JSON.stringify({ planName: planName.trim() || null, adminNotes: adminNotes.trim() || null }),
      });
      onUpdated(plan.shareToken, { planName: planName.trim() || null, adminNotes: adminNotes.trim() || null });
      setDirty(false);
    } finally {
      setSaving(false);
    }
  };

  const removeItem = async (item: PlanItem) => {
    setRemovingId(item.id);
    try {
      const r = await fetch(`${BASE}/api/admin/plans/${plan.shareToken}/items/${item.id}`, {
        method: "DELETE",
        headers: authHeaders() as HeadersInit,
      });
      const d = await r.json();
      if (detail) setDetail({ ...detail, items: d.items });
      onUpdated(plan.shareToken, { itemCount: d.items.length });
    } finally {
      setRemovingId(null);
    }
  };

  const deletePlan = async () => {
    setDeleting(true);
    try {
      await fetch(`${BASE}/api/admin/plans/${plan.shareToken}`, {
        method: "DELETE",
        headers: authHeaders() as HeadersInit,
      });
      onDeleted(plan.shareToken);
      onClose();
    } finally {
      setDeleting(false);
    }
  };

  const expired = isExpired(plan.expiresAt);
  const days = daysUntilExpiry(plan.expiresAt);
  const plannerState = detail?.plannerState as Record<string, unknown> | null | undefined;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="w-full max-w-xl bg-card shadow-2xl flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-border flex items-start justify-between bg-secondary/30 shrink-0">
          <div>
            <div className="flex items-center gap-2">
              {plan.planNumber != null && (
                <span className="font-mono text-lg font-bold text-primary">#{plan.planNumber}</span>
              )}
              <h2 className="font-display font-bold text-xl truncate">
                {plan.planName || <span className="text-muted-foreground italic">Untitled Plan</span>}
              </h2>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Created {formatDate(plan.createdAt)} · Last modified {formatDate(plan.lastModifiedAt, true)}
            </p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-secondary rounded-full shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Share link */}
          <div className="flex items-center gap-2 p-3 bg-secondary/50 rounded-xl border border-border">
            <span className="text-xs text-muted-foreground font-mono truncate flex-1">{shareUrl}</span>
            <CopyButton text={shareUrl} />
            <a
              href={shareUrl}
              target="_blank"
              rel="noreferrer"
              className="p-1 rounded hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
              title="Open plan"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-3 gap-3">
            <div className="p-3 bg-secondary/40 rounded-xl text-center">
              <p className="text-2xl font-bold">{plan.itemCount}</p>
              <p className="text-xs text-muted-foreground font-medium mt-0.5">Items</p>
            </div>
            <div className="p-3 bg-secondary/40 rounded-xl text-center">
              <p className="text-2xl font-bold">{plan.guestCount ?? "—"}</p>
              <p className="text-xs text-muted-foreground font-medium mt-0.5">Guests</p>
            </div>
            <div className={cn("p-3 rounded-xl text-center", expired ? "bg-red-50" : days <= 7 ? "bg-amber-50" : "bg-secondary/40")}>
              <p className={cn("text-2xl font-bold", expired ? "text-red-600" : days <= 7 ? "text-amber-600" : "")}>
                {expired ? "Exp." : `${days}d`}
              </p>
              <p className="text-xs text-muted-foreground font-medium mt-0.5">Until expiry</p>
            </div>
          </div>

          {/* Plan name edit */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Event / Plan Name</label>
            <input
              type="text"
              value={planName}
              onChange={e => { setPlanName(e.target.value); setDirty(true); }}
              placeholder="e.g. Johnson Wedding · June 2025"
              className="w-full px-4 py-2.5 border border-border rounded-xl bg-background text-sm"
            />
          </div>

          {/* Admin notes */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Admin Notes</label>
            <textarea
              value={adminNotes}
              onChange={e => { setAdminNotes(e.target.value); setDirty(true); }}
              placeholder="Internal notes about this customer's order — not visible to the customer"
              rows={3}
              className="w-full px-4 py-2.5 border border-border rounded-xl bg-background text-sm resize-none"
            />
          </div>

          {dirty && (
            <button
              onClick={save}
              disabled={saving}
              className="w-full flex items-center justify-center gap-2 py-2.5 bg-primary text-primary-foreground font-semibold rounded-xl hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save Changes
            </button>
          )}

          {/* Planner state summary */}
          {plannerState && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Calculator Settings</p>
              <div className="p-4 bg-secondary/40 rounded-xl text-sm space-y-1.5">
                {typeof plannerState.guests !== "undefined" && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Guests</span>
                    <span className="font-semibold">{String(plannerState.guests)}</span>
                  </div>
                )}
                {typeof plannerState.savoryPpg !== "undefined" && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Savory pieces/guest</span>
                    <span className="font-semibold">{String(plannerState.savoryPpg)}</span>
                  </div>
                )}
                {typeof plannerState.sweetPpg !== "undefined" && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Sweet pieces/guest</span>
                    <span className="font-semibold">{String(plannerState.sweetPpg)}</span>
                  </div>
                )}
                {plannerState.panQtys && typeof plannerState.panQtys === "object" && Object.keys(plannerState.panQtys as object).length > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Pan size selections</span>
                    <span className="font-semibold">{Object.keys(plannerState.panQtys as object).length} items</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Items list */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Menu Items ({loading ? "…" : detail?.items.length ?? 0})
              </p>
              {detail && detail.items.length > 0 && (() => {
                const grandTotal = detail.items.reduce((sum, item) => {
                  const { subtotal } = getItemQuantityInfo(item, detail.plannerState);
                  return sum + (subtotal ?? 0);
                }, 0);
                return grandTotal > 0 ? (
                  <p className="text-xs font-bold text-primary">Total: ${grandTotal.toFixed(2)}</p>
                ) : null;
              })()}
            </div>
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : detail?.items.length === 0 ? (
              <div className="text-center py-6 text-muted-foreground text-sm border border-dashed border-border rounded-xl">
                No items in this plan
              </div>
            ) : (
              <div className="space-y-1.5">
                {detail?.items.map(item => {
                  const { qty, subtotal, sizes } = getItemQuantityInfo(item, detail.plannerState);
                  const isPanSizes = item.menuItem.pricingTemplate === "pan_sizes";
                  return (
                    <div
                      key={item.id}
                      className="p-3 bg-secondary/40 border border-border/60 rounded-xl"
                    >
                      <div className="flex items-start gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold truncate">{item.menuItem.name}</p>
                          <p className="text-xs text-muted-foreground">{item.menuItem.category}</p>
                        </div>
                        <div className="text-right shrink-0">
                          {subtotal != null ? (
                            <p className="text-sm font-bold text-primary">${subtotal.toFixed(2)}</p>
                          ) : (
                            <p className="text-xs text-muted-foreground italic">No qty set</p>
                          )}
                          {qty != null && (
                            <p className="text-xs text-muted-foreground">
                              {isPanSizes ? `${qty} pan${qty !== 1 ? "s" : ""}` : `${qty} ${item.menuItem.unit}`}
                            </p>
                          )}
                        </div>
                        <button
                          onClick={() => removeItem(item)}
                          disabled={removingId === item.id}
                          title="Remove from plan"
                          className="p-1 rounded-lg text-muted-foreground hover:bg-red-50 hover:text-red-500 transition-colors disabled:opacity-30 shrink-0 mt-0.5"
                        >
                          {removingId === item.id
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <X className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                      {/* Pan size breakdown */}
                      {isPanSizes && sizes.length > 0 && (
                        <div className="mt-2 pl-0 space-y-0.5 border-t border-border/40 pt-2">
                          {sizes.map(s => (
                            <div key={s.label} className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground">{s.qty}× {s.label} <span className="text-muted-foreground/60">(${s.price.toFixed(2)}/ea)</span></span>
                              <span className="font-semibold">${s.subtotal.toFixed(2)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Open plan link */}
          <a
            href={shareUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-center gap-2 w-full py-2.5 border border-border rounded-xl text-sm font-semibold hover:bg-secondary/60 transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
            Open Full Plan Editor
          </a>

          {/* Danger zone */}
          <div className="border border-red-200 rounded-xl p-4 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-red-500">Danger Zone</p>
            {confirmDelete ? (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">This will permanently delete the plan and all its items. Are you sure?</p>
                <div className="flex gap-2">
                  <button
                    onClick={deletePlan}
                    disabled={deleting}
                    className="flex-1 flex items-center justify-center gap-2 py-2 bg-red-500 text-white font-semibold rounded-lg hover:bg-red-600 transition-colors disabled:opacity-50 text-sm"
                  >
                    {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    Yes, Delete
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="flex-1 py-2 border border-border rounded-lg text-sm font-semibold hover:bg-secondary/60 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="flex items-center gap-2 text-sm font-semibold text-red-500 hover:text-red-600 transition-colors"
              >
                <Trash2 className="w-4 h-4" />
                Delete this plan
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function CateringPlans() {
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("lastModifiedAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selected, setSelected] = useState<PlanSummary | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/admin/plans`, { headers: authHeaders() as HeadersInit });
      const d = await r.json();
      setPlans(d);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  };

  const filtered = useMemo(() => {
    let list = [...plans];
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(p =>
        (p.planName ?? "").toLowerCase().includes(q) ||
        String(p.planNumber ?? "").includes(q)
      );
    }
    list.sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      const av = a[sortKey], bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return list;
  }, [plans, search, sortKey, sortDir]);

  const handleUpdated = (token: string, patch: Partial<PlanSummary>) => {
    setPlans(prev => prev.map(p => p.shareToken === token ? { ...p, ...patch } : p));
    if (selected?.shareToken === token) setSelected(prev => prev ? { ...prev, ...patch } : prev);
  };

  const handleDeleted = (token: string) => {
    setPlans(prev => prev.filter(p => p.shareToken !== token));
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="font-display font-bold text-3xl">Event Plans</h1>
            <p className="text-muted-foreground text-sm mt-1">All customer-shared catering plans</p>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 border border-border rounded-xl text-sm font-semibold hover:bg-secondary/60 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
            Refresh
          </button>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by plan # or event name…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 border border-border rounded-xl bg-background text-sm"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Table */}
        <div className="bg-card rounded-2xl border border-border overflow-hidden">
          {/* Table header */}
          <div className="grid grid-cols-[80px_1fr_60px_70px_110px_110px_80px] gap-x-4 px-4 py-3 border-b border-border bg-secondary/30 items-center">
            <SortButton label="Plan #"    sortKey="planNumber"     current={sortKey} dir={sortDir} onClick={toggleSort} />
            <SortButton label="Name"      sortKey="planName"       current={sortKey} dir={sortDir} onClick={toggleSort} />
            <SortButton label="Items"     sortKey="itemCount"      current={sortKey} dir={sortDir} onClick={toggleSort} />
            <SortButton label="Guests"    sortKey="guestCount"     current={sortKey} dir={sortDir} onClick={toggleSort} />
            <SortButton label="Created"   sortKey="createdAt"      current={sortKey} dir={sortDir} onClick={toggleSort} />
            <SortButton label="Modified"  sortKey="lastModifiedAt" current={sortKey} dir={sortDir} onClick={toggleSort} />
            <SortButton label="Expires"   sortKey="expiresAt"      current={sortKey} dir={sortDir} onClick={toggleSort} />
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-20 text-muted-foreground">
              <ClipboardList className="w-12 h-12 mx-auto mb-4 opacity-20" />
              <p className="font-semibold text-lg">
                {plans.length === 0 ? "No shared plans yet" : "No plans match your search"}
              </p>
              <p className="text-sm mt-1">
                {plans.length === 0
                  ? "Shared plans will appear here once customers create and share their catering plans"
                  : "Try a different plan number or event name"}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {filtered.map(plan => {
                const expired = isExpired(plan.expiresAt);
                const days = daysUntilExpiry(plan.expiresAt);
                return (
                  <button
                    key={plan.shareToken}
                    onClick={() => setSelected(plan)}
                    className="w-full grid grid-cols-[80px_1fr_60px_70px_110px_110px_80px] gap-x-4 px-4 py-3.5 items-center hover:bg-secondary/40 transition-colors text-left group"
                  >
                    <PlanNumberBadge n={plan.planNumber} />

                    <div className="min-w-0">
                      <p className={cn("text-sm font-semibold truncate", !plan.planName && "text-muted-foreground italic")}>
                        {plan.planName ?? "Untitled"}
                      </p>
                      {plan.adminNotes && (
                        <p className="text-xs text-amber-600 font-medium truncate mt-0.5 flex items-center gap-1">
                          <StickyNote className="w-3 h-3 shrink-0" />
                          {plan.adminNotes}
                        </p>
                      )}
                    </div>

                    <span className="text-sm font-semibold text-center">{plan.itemCount}</span>

                    <span className="text-sm text-center">{plan.guestCount ?? "—"}</span>

                    <span className="text-xs text-muted-foreground">{formatDate(plan.createdAt)}</span>

                    <span className="text-xs text-muted-foreground">{formatDate(plan.lastModifiedAt)}</span>

                    <span className={cn(
                      "text-xs font-medium",
                      expired ? "text-red-500" : days <= 7 ? "text-amber-500" : "text-muted-foreground"
                    )}>
                      {expired ? "Expired" : `${days}d`}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {!loading && filtered.length > 0 && (
            <div className="px-4 py-2.5 border-t border-border bg-secondary/20 text-xs text-muted-foreground">
              Showing {filtered.length} of {plans.length} plans
            </div>
          )}
        </div>
      </div>

      {selected && (
        <DetailPanel
          plan={selected}
          onClose={() => setSelected(null)}
          onUpdated={handleUpdated}
          onDeleted={handleDeleted}
        />
      )}
    </AdminLayout>
  );
}
