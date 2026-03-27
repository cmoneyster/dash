import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useParams, Link } from "wouter";
import { Layout } from "@/components/Layout";
import { formatCurrency } from "@/lib/utils";
import { getSessionId } from "@/lib/session";
import {
  Trash2, Heart, Users, AlertTriangle, Copy, CheckCheck, Loader2,
  Calculator, Utensils, ChevronDown, ChevronUp,
} from "lucide-react";
import { ImageLightbox } from "@/components/ImageLightbox";
import { useToast } from "@/hooks/use-toast";

// ── Category helpers ──────────────────────────────────────────────────────────

const SAVORY_CAT  = "Small Bites - Savory";
const SWEET_CAT   = "Small Bites - Sweet";
const ENTREE_CATS = new Set(["Entrées - Meat", "Entrées - Seafood", "Entrées - Noodles & Rice"]);

const CAT_ORDER = [
  SAVORY_CAT,
  SWEET_CAT,
  "Entrées - Meat",
  "Entrées - Seafood",
  "Entrées - Noodles & Rice",
];

function isSmallBite(cat: string) { return cat === SAVORY_CAT || cat === SWEET_CAT; }
function isEntree(cat: string)    { return ENTREE_CATS.has(cat); }

// ── Types ────────────────────────────────────────────────────────────────────

type MenuItemData = {
  id: number;
  name: string;
  category: string;
  description: string | null;
  price: number;
  imageUrl: string | null;
  allergens: string[];
  servingSize?: number;
  minimumOrderQty?: number;
};

type PlanItem = {
  id: number;
  menuItemId: number;
  menuItem: MenuItemData;
};

type PlannerState = {
  guests: number;
  savoryPPG: number;
  sweetPPG: number;
  servingsPPG: number;
  piecesMap: Record<string, number>;
  servingsMap: Record<string, number>;
};

type SharedPlanData = {
  sessionId: string;
  shareToken: string;
  planName: string | null;
  plannerState: PlannerState | null;
  expiresAt: string;
  items: PlanItem[];
};

const DEFAULT_PLANNER: PlannerState = {
  guests: 20,
  savoryPPG: 3,
  sweetPPG: 2,
  servingsPPG: 4,
  piecesMap: {},
  servingsMap: {},
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number) { return Math.max(min, Math.min(max, v)); }

function daysUntil(dateStr: string) {
  return Math.max(0, Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86_400_000));
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusBar({ need, have, label, unit = "pcs" }: { need: number; have: number; label: string; unit?: string }) {
  const pct      = need === 0 ? 100 : clamp((have / need) * 100, 0, 100);
  const over     = have > need;
  const met      = have >= need;
  const barColor = met ? "bg-emerald-500" : pct >= 75 ? "bg-amber-400" : "bg-red-400";
  const txtColor = met ? "text-emerald-600" : pct >= 75 ? "text-amber-600" : "text-red-500";

  return (
    <div className="space-y-1.5">
      <div className="flex justify-between items-baseline text-sm">
        <span className="font-semibold text-foreground">{label}</span>
        <span className={`font-bold tabular-nums ${txtColor}`}>
          {have} / {need} {unit}
          {over && <span className="text-xs font-normal text-muted-foreground ml-1">(+{have - need} extra)</span>}
        </span>
      </div>
      <div className="h-2 bg-secondary rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">
        {met
          ? `You're covered${over ? " and then some" : ""}!`
          : `Need ${need - have} more ${unit === "srv" ? "serving" : "piece"}${need - have !== 1 ? "s" : ""}`}
      </p>
    </div>
  );
}

function NumInput({ label, value, onChange, min = 1, max = 999, hint }: {
  label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; hint?: string;
}) {
  const [raw, setRaw] = useState(String(value));
  useEffect(() => { setRaw(String(value)); }, [value]);
  const commit = () => {
    const v = parseInt(raw, 10);
    if (!isNaN(v)) onChange(clamp(v, min, max));
    else setRaw(String(value));
  };
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{label}</label>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={raw}
        onChange={e => setRaw(e.target.value)}
        onBlur={commit}
        onKeyDown={e => e.key === "Enter" && commit()}
        className="w-full px-3 py-2 text-center text-lg font-bold rounded-xl border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
      />
      {hint && <p className="text-xs text-muted-foreground text-center">{hint}</p>}
    </div>
  );
}

function CountStepper({ value, onChange, hint, defaultVal, min = 0, minMessage }: {
  value: number; onChange: (v: number) => void; hint?: string; defaultVal?: number; min?: number; minMessage?: string;
}) {
  const { toast } = useToast();

  const handleDecrement = () => {
    if (value <= min) {
      if (minMessage) toast({ description: minMessage, variant: "destructive" });
      return;
    }
    onChange(value - 1);
  };

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseInt(e.target.value.replace(/[^0-9]/g, ""));
    if (isNaN(v)) { onChange(min); return; }
    if (v < min) {
      onChange(min);
      if (minMessage) toast({ description: minMessage, variant: "destructive" });
      return;
    }
    onChange(v);
  };

  return (
    <div className="flex items-center gap-1 shrink-0">
      <button
        onClick={handleDecrement}
        disabled={value <= min}
        className="w-8 h-8 rounded-lg border border-border bg-background flex items-center justify-center font-bold text-lg hover:bg-secondary disabled:opacity-30 transition-colors"
      >−</button>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={value === 0 ? "" : value}
        placeholder={min > 0 ? String(min) : "0"}
        onChange={handleInput}
        className="w-14 text-center font-bold text-base rounded-lg border border-border bg-background px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
      />
      <button
        onClick={() => onChange(value + 1)}
        className="w-8 h-8 rounded-lg border border-border bg-background flex items-center justify-center font-bold text-lg hover:bg-secondary transition-colors"
      >+</button>
      {defaultVal !== undefined && value !== defaultVal && (
        <button onClick={() => onChange(defaultVal)} className="ml-1 text-xs text-muted-foreground underline hover:text-foreground" title={`Reset to default (${defaultVal})`}>↺</button>
      )}
      {hint && <span className="text-xs text-muted-foreground ml-1">{hint}</span>}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function SharedPlan() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const { toast } = useToast();
  const sessionId = getSessionId();
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  const [plan, setPlan] = useState<SharedPlanData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [copying, setCopying] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [allMenuItems, setAllMenuItems] = useState<MenuItemData[]>([]);
  const [addingId, setAddingId] = useState<number | null>(null);

  // ── Planner state ──
  const [plannerState, setPlannerState] = useState<PlannerState>(DEFAULT_PLANNER);
  const [guestRaw, setGuestRaw] = useState(String(DEFAULT_PLANNER.guests));
  const [plannerSaving, setPlannerSaving] = useState(false);
  const [plannerSaved, setPlannerSaved] = useState(false);
  const [plannerOpen, setPlannerOpen] = useState(true);
  const saveTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const isEditingRef  = useRef(false); // true while the debounce save is pending

  const fetchPlan = useCallback(async (isInitial = false) => {
    try {
      const res = await fetch(`/api/plan/share/${token}`);
      if (res.status === 404) { setError("This plan link is invalid or does not exist."); return; }
      if (res.status === 410) { setError("This shared plan has expired (links last 60 days from last use)."); return; }
      if (!res.ok) { setError("Failed to load plan."); return; }
      const data: SharedPlanData = await res.json();
      setPlan(data);
      // On initial load always apply plannerState; on subsequent polls skip if user is editing
      if (data.plannerState && (isInitial || !isEditingRef.current)) {
        setPlannerState({ ...DEFAULT_PLANNER, ...data.plannerState });
      }
    } catch {
      if (isInitial) setError("Could not connect to server.");
    } finally {
      if (isInitial) setLoading(false);
    }
  }, [token]);

  // Initial load
  useEffect(() => { fetchPlan(true); }, [fetchPlan]);

  // Poll every 3 s for remote changes — paused automatically when the tab is hidden
  useEffect(() => {
    if (!token) return;
    pollTimerRef.current = setInterval(() => {
      if (document.visibilityState === "hidden") return; // skip while tab is not visible
      fetchPlan(false);
    }, 3000);
    return () => { if (pollTimerRef.current) clearInterval(pollTimerRef.current); };
  }, [token, fetchPlan]);

  // Auto-seed maps at 1 tray for each new item — returns same ref if nothing changed
  useEffect(() => {
    if (!plan?.items) return;
    setPlannerState(prev => {
      let seeded = false;
      const piecesMap   = { ...prev.piecesMap };
      const servingsMap = { ...prev.servingsMap };
      plan.items.forEach(item => {
        const key = String(item.id);
        if (isSmallBite(item.menuItem.category) && !(key in piecesMap))   { piecesMap[key]   = 1; seeded = true; }
        if (isEntree(item.menuItem.category)    && !(key in servingsMap))  { servingsMap[key] = 1; seeded = true; }
      });
      return seeded ? { ...prev, piecesMap, servingsMap } : prev;
    });
  }, [plan?.items]);

  // Load menu items for add panel
  useEffect(() => {
    fetch("/api/menu")
      .then(r => r.json())
      .then((data: MenuItemData[]) => setAllMenuItems(data.filter((i: any) => i.isAvailable !== false && i.available !== false)))
      .catch(() => {});
  }, []);

  // Debounced save to DB
  const savePlannerState = useCallback(async (state: PlannerState) => {
    setPlannerSaving(true);
    try {
      await fetch(`/api/plan/share/${token}/planner`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plannerState: state }),
      });
      setPlannerSaved(true);
      setTimeout(() => setPlannerSaved(false), 2500);
    } catch {}
    finally {
      setPlannerSaving(false);
      isEditingRef.current = false; // Release edit lock so polls can resume
    }
  }, [token]);

  const updatePlanner = useCallback((updater: (prev: PlannerState) => PlannerState) => {
    isEditingRef.current = true; // Block polls while user is typing
    setPlannerState(prev => {
      const next = updater(prev);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => savePlannerState(next), 800);
      return next;
    });
  }, [savePlannerState]);

  // ── Computed quantities ──
  const { guests, savoryPPG, sweetPPG, servingsPPG, piecesMap, servingsMap } = plannerState;

  // Sync guestRaw when guests changes externally (poll / initial load)
  useEffect(() => { setGuestRaw(String(guests)); }, [guests]);

  const smallBiteItems = useMemo(() => plan?.items.filter(i => isSmallBite(i.menuItem.category)) ?? [], [plan]);
  const entreeItems    = useMemo(() => plan?.items.filter(i => isEntree(i.menuItem.category)) ?? [], [plan]);

  // ── Category grouping ──
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set());
  const toggleCat = (cat: string) =>
    setCollapsedCats(prev => { const n = new Set(prev); n.has(cat) ? n.delete(cat) : n.add(cat); return n; });

  const groupedItems = useMemo(() => {
    if (!plan?.items) return [];
    const map = new Map<string, typeof plan.items>();
    CAT_ORDER.forEach(cat => map.set(cat, []));
    plan.items.forEach(item => {
      const cat = item.menuItem.category;
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(item);
    });
    return Array.from(map.entries()).filter(([, items]) => items.length > 0);
  }, [plan?.items]);
  const hasSmallBites  = smallBiteItems.length > 0;
  const hasEntrees     = entreeItems.length > 0;
  const showPlanner    = hasSmallBites || hasEntrees;

  const needSavory  = guests * savoryPPG;
  const needSweet   = guests * sweetPPG;
  const needEntrees = guests * servingsPPG;

  const haveSavory  = useMemo(() => smallBiteItems.filter(i => i.menuItem.category === SAVORY_CAT).reduce((s, i) => s + (Number(piecesMap[String(i.id)]) || 0) * (i.menuItem.servingSize ?? 1), 0), [smallBiteItems, piecesMap]);
  const haveSweet   = useMemo(() => smallBiteItems.filter(i => i.menuItem.category === SWEET_CAT).reduce((s, i)  => s + (Number(piecesMap[String(i.id)]) || 0) * (i.menuItem.servingSize ?? 1), 0), [smallBiteItems, piecesMap]);
  const haveEntrees = useMemo(() => entreeItems.reduce((s, i) => s + (Number(servingsMap[String(i.id)]) || 0) * (i.menuItem.servingSize ?? 1), 0), [entreeItems, servingsMap]);

  // ── Item actions ──
  const handleRemove = async (itemId: number) => {
    setRemovingId(itemId);
    try {
      const res = await fetch(`/api/plan/share/${token}/items/${itemId}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setPlan(await res.json());
      toast({ title: "Removed", description: "Item removed from the shared plan." });
    } catch {
      toast({ title: "Error", description: "Could not remove item.", variant: "destructive" });
    } finally {
      setRemovingId(null);
    }
  };

  const handleAdd = async (menuItemId: number) => {
    setAddingId(menuItemId);
    try {
      const res = await fetch(`/api/plan/share/${token}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ menuItemId }),
      });
      if (!res.ok) throw new Error();
      setPlan(await res.json());
      toast({ title: "Added", description: "Item added to the shared plan." });
    } catch {
      toast({ title: "Error", description: "Could not add item.", variant: "destructive" });
    } finally {
      setAddingId(null);
    }
  };

  const handleCopyToMyPlan = async () => {
    if (!plan || copying) return;
    setCopying(true);
    try {
      let added = 0;
      for (const item of plan.items) {
        const res = await fetch("/api/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, menuItemId: item.menuItemId }),
        });
        if (res.ok) added++;
      }
      toast({ title: "Copied!", description: `${added} item${added !== 1 ? "s" : ""} added to your plan.` });
    } catch {
      toast({ title: "Error", description: "Could not copy plan.", variant: "destructive" });
    } finally {
      setCopying(false);
    }
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2500);
    } catch {
      toast({ title: "Error", description: "Could not copy link.", variant: "destructive" });
    }
  };

  // ── Loading / error states ──
  if (loading) {
    return (
      <Layout>
        <div className="h-96 flex items-center justify-center text-muted-foreground gap-3">
          <Loader2 className="w-5 h-5 animate-spin" /> Loading shared plan…
        </div>
      </Layout>
    );
  }

  if (error) {
    return (
      <Layout>
        <div className="max-w-xl mx-auto px-4 py-24 text-center">
          <AlertTriangle className="w-12 h-12 text-amber-500 mx-auto mb-4" />
          <h2 className="font-display font-bold text-2xl mb-2">Oops</h2>
          <p className="text-muted-foreground mb-8">{error}</p>
          <Link href="/menu" className="px-6 py-3 bg-primary text-primary-foreground font-semibold rounded-xl inline-block">Browse Menu</Link>
        </div>
      </Layout>
    );
  }

  if (!plan) return null;

  const days = daysUntil(plan.expiresAt);
  const planItemIds = new Set(plan.items.map(i => i.menuItemId));
  const categories = Array.from(new Set(allMenuItems.map(i => i.category))).sort();

  return (
    <Layout>
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}

      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-20">

        {/* ── Header ── */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-4 mb-4">
          <div className="w-12 h-12 bg-primary/10 rounded-2xl flex items-center justify-center text-primary shrink-0">
            <Users className="w-6 h-6" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="font-display font-bold text-3xl sm:text-4xl truncate">
              {plan.planName || "Shared Event Plan"}
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Anyone with this link can view and edit
            </p>
          </div>
        </div>

        {/* ── Expiry + actions ── */}
        <div className="flex flex-wrap items-center gap-3 mb-10">
          <span className={`text-xs font-semibold px-3 py-1.5 rounded-full ${
            days <= 7 ? "bg-amber-100 text-amber-700" : "bg-secondary text-muted-foreground"
          }`}>
            {days === 0 ? "Expires today!" : `Link active for ${days} more day${days !== 1 ? "s" : ""}`}
          </span>

          <button
            onClick={handleCopyLink}
            className="flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-full border border-border hover:bg-secondary transition-colors"
          >
            {linkCopied ? <CheckCheck className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
            {linkCopied ? "Copied!" : "Copy link"}
          </button>

          {plan.items.length > 0 && (
            <button
              onClick={handleCopyToMyPlan}
              disabled={copying}
              className="flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-60"
            >
              {copying
                ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Copying…</>
                : <><Heart className="w-3.5 h-3.5" /> Save to my plan</>}
            </button>
          )}
        </div>

        {plan.items.length === 0 ? (
          <div className="text-center py-20 bg-card rounded-3xl border border-dashed border-border mb-10">
            <Heart className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
            <h3 className="font-display font-bold text-xl mb-2">No items yet</h3>
            <p className="text-muted-foreground text-sm">Add items from the section below to get started.</p>
          </div>
        ) : (
          <div className="space-y-4 mb-10">

            {/* ── Guests strip ── */}
            {showPlanner && (
              <div className="flex items-center gap-4 px-5 py-3 bg-card border border-border rounded-2xl shadow-sm">
                <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground shrink-0">
                  <Users className="w-4 h-4" />
                  <span>Guests</span>
                </div>
                <div className="flex items-center gap-2 flex-1 justify-center">
                  <button
                    onClick={() => updatePlanner(p => ({ ...p, guests: Math.max(1, p.guests - 1) }))}
                    className="w-8 h-8 rounded-full border border-border bg-background flex items-center justify-center text-base font-bold hover:bg-secondary transition-colors"
                  >−</button>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={guestRaw}
                    onChange={e => setGuestRaw(e.target.value)}
                    onBlur={() => { const v = parseInt(guestRaw, 10); if (!isNaN(v)) updatePlanner(p => ({ ...p, guests: clamp(v, 1, 500) })); else setGuestRaw(String(guests)); }}
                    onKeyDown={e => { if (e.key === "Enter") { const v = parseInt(guestRaw, 10); if (!isNaN(v)) updatePlanner(p => ({ ...p, guests: clamp(v, 1, 500) })); else setGuestRaw(String(guests)); } }}
                    className="w-20 text-center font-bold text-xl rounded-xl border border-border bg-background py-1 px-2 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
                  />
                  <button
                    onClick={() => updatePlanner(p => ({ ...p, guests: Math.min(500, p.guests + 1) }))}
                    className="w-8 h-8 rounded-full border border-border bg-background flex items-center justify-center text-base font-bold hover:bg-secondary transition-colors"
                  >+</button>
                </div>
                <span className="text-xs shrink-0">
                  {plannerSaving
                    ? <span className="text-muted-foreground flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Saving…</span>
                    : plannerSaved
                    ? <span className="text-emerald-600 font-semibold">Saved ✓</span>
                    : <span className="text-muted-foreground hidden sm:inline">shared planner</span>}
                </span>
              </div>
            )}

            {/* ── Event Planner card ── */}
            {showPlanner && (
              <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
                <button
                  onClick={() => setPlannerOpen(o => !o)}
                  className="w-full flex items-center justify-between px-5 py-4 hover:bg-secondary/40 transition-colors text-left"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                      <Calculator className="w-4 h-4 text-primary" />
                    </div>
                    <div>
                      <p className="font-display font-bold text-sm">Event Planner</p>
                      <p className="text-xs text-muted-foreground">
                        {plannerOpen ? "Tap to collapse" : `${guests} guests · ${hasSmallBites ? `${haveSavory + haveSweet}/${needSavory + needSweet} pcs` : ""} ${hasEntrees ? `${haveEntrees}/${needEntrees} srv` : ""}`.trim()}
                      </p>
                    </div>
                  </div>
                  {plannerOpen
                    ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" />
                    : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
                </button>

                {plannerOpen && (
                  <div className="px-5 pb-5 border-t border-border space-y-5">

                    {/* Small Bites section */}
                    {hasSmallBites && (
                      <div className="space-y-3 pt-4">
                        <div className="flex items-center gap-2">
                          <Calculator className="w-3.5 h-3.5 text-primary" />
                          <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Small Bites</p>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <NumInput label="Savory pcs/person" value={savoryPPG} onChange={v => updatePlanner(p => ({ ...p, savoryPPG: v }))} min={1} max={20} hint="rec. 3–4" />
                          <NumInput label="Sweet pcs/person"  value={sweetPPG}  onChange={v => updatePlanner(p => ({ ...p, sweetPPG: v }))}  min={1} max={20} hint="rec. 2–3" />
                        </div>
                        <StatusBar need={needSavory} have={haveSavory} label="Savory" unit="pcs" />
                        <StatusBar need={needSweet}  have={haveSweet}  label="Sweet"  unit="pcs" />
                      </div>
                    )}

                    {/* Entrée section */}
                    {hasEntrees && (
                      <div className="space-y-3 pt-2">
                        <div className="flex items-center gap-2">
                          <Utensils className="w-3.5 h-3.5 text-primary" />
                          <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Entrées</p>
                        </div>
                        <NumInput label="Servings / person" value={servingsPPG} onChange={v => updatePlanner(p => ({ ...p, servingsPPG: v }))} min={1} max={20} hint="rec. 4–5 per guest" />
                        <StatusBar need={needEntrees} have={haveEntrees} label="Total Entrée Servings" unit="srv" />
                      </div>
                    )}

                    <p className="text-xs text-muted-foreground text-center pt-1">
                      All changes are shared in real-time with anyone who has this link.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* ── Category sections ── */}
            <div className="space-y-4">
              {groupedItems.map(([cat, items]) => {
                const sb        = isSmallBite(cat);
                const ent       = isEntree(cat);
                const collapsed = collapsedCats.has(cat);
                const catPrice  = items.reduce((s, i) => s + i.menuItem.price, 0);

                const catPieces   = sb
                  ? items.reduce((s, i) => s + (Number(piecesMap[String(i.id)]) || 0) * (i.menuItem.servingSize ?? 1), 0)
                  : null;
                const catServings = ent
                  ? items.reduce((s, i) => s + (Number(servingsMap[String(i.id)]) || 0) * (i.menuItem.servingSize ?? 1), 0)
                  : null;

                return (
                  <div key={cat} className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
                    {/* Category header */}
                    <button
                      onClick={() => toggleCat(cat)}
                      className="w-full flex items-center gap-3 px-5 py-4 hover:bg-secondary/40 transition-colors text-left"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="font-display font-bold text-base">{cat}</span>
                          <span className="text-xs text-muted-foreground">
                            {items.length} item{items.length !== 1 ? "s" : ""}
                          </span>
                          {catPieces !== null && (
                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                              catPieces > 0 ? "bg-primary/10 text-primary" : "bg-secondary text-muted-foreground"
                            }`}>
                              {catPieces} pcs tracked
                            </span>
                          )}
                          {catServings !== null && (
                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                              catServings > 0 ? "bg-primary/10 text-primary" : "bg-secondary text-muted-foreground"
                            }`}>
                              {catServings} srv
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Subtotal: <span className="font-semibold text-foreground">{formatCurrency(catPrice)}</span>
                        </p>
                      </div>
                      {collapsed
                        ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                        : <ChevronUp   className="w-4 h-4 text-muted-foreground shrink-0" />}
                    </button>

                    {/* Items */}
                    {!collapsed && (
                      <div className="divide-y divide-border border-t border-border">
                        {items.map(item => {
                          const minQty     = item.menuItem.minimumOrderQty ?? 1;
                          const traysSmall = piecesMap[String(item.id)]   !== undefined ? Number(piecesMap[String(item.id)])   : minQty;
                          const traysEnt   = servingsMap[String(item.id)] !== undefined ? Number(servingsMap[String(item.id)]) : minQty;
                          const sz         = item.menuItem.servingSize ?? 1;
                          const minMsg     = `Minimum order is ${minQty} tray${minQty !== 1 ? "s" : ""} for this item.`;

                          return (
                            <div key={item.id} className="flex flex-col sm:flex-row gap-4 p-5">
                              {item.menuItem.imageUrl && (
                                <img
                                  src={item.menuItem.imageUrl}
                                  alt=""
                                  onClick={() => setLightboxSrc(item.menuItem.imageUrl!)}
                                  className="w-full sm:w-24 h-24 rounded-xl object-cover shrink-0 bg-secondary cursor-zoom-in hover:opacity-90 transition-opacity"
                                />
                              )}
                              <div className="flex-1 flex flex-col justify-between gap-3">
                                <div className="flex justify-between items-start gap-2">
                                  <h4 className="font-display font-bold text-lg leading-tight">{item.menuItem.name}</h4>
                                  <span className="font-bold text-primary shrink-0">{formatCurrency(item.menuItem.price)}</span>
                                </div>

                                <p className="text-muted-foreground text-sm line-clamp-2">{item.menuItem.description}</p>

                                {/* Tray stepper */}
                                {(sb || ent) && (
                                  <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-secondary/50 rounded-xl border border-border/60">
                                    <div>
                                      <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                                        {sb ? "Trays / packs ordered" : "Trays ordered"}
                                      </p>
                                      <p className="text-xs text-muted-foreground">
                                        {sz} {sb ? "pcs" : "srv"} per tray · {(sb ? traysSmall : traysEnt) * sz} {sb ? "pcs" : "srv"} total
                                      </p>
                                    </div>
                                    <CountStepper
                                      value={sb ? traysSmall : traysEnt}
                                      onChange={v => {
                                        if (sb) updatePlanner(p => ({ ...p, piecesMap:   { ...p.piecesMap,   [String(item.id)]: v } }));
                                        else    updatePlanner(p => ({ ...p, servingsMap: { ...p.servingsMap, [String(item.id)]: v } }));
                                      }}
                                      hint="trays"
                                      defaultVal={minQty}
                                      min={minQty}
                                      minMessage={minMsg}
                                    />
                                  </div>
                                )}

                                <button
                                  onClick={() => handleRemove(item.id)}
                                  disabled={removingId === item.id}
                                  className="self-start text-sm font-semibold text-muted-foreground hover:text-destructive transition-colors flex items-center gap-1.5 disabled:opacity-50"
                                >
                                  {removingId === item.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                                  Remove
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Add items section ── */}
        {allMenuItems.length > 0 && (
          <div className="bg-card border border-border rounded-3xl overflow-hidden shadow-sm">
            <div className="px-6 py-4 border-b border-border">
              <h2 className="font-display font-bold text-lg">Add items to this plan</h2>
              <p className="text-sm text-muted-foreground">Click + to add any item to the shared plan</p>
            </div>
            <div className="divide-y divide-border">
              {categories.map(cat => {
                const catItems = allMenuItems.filter(i => i.category === cat);
                return (
                  <div key={cat} className="px-6 py-4">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">{cat}</h3>
                    <div className="space-y-2">
                      {catItems.map(mi => {
                        const inPlan = planItemIds.has(mi.id);
                        return (
                          <div
                            key={mi.id}
                            className={`flex items-center gap-3 p-3 rounded-xl transition-colors ${
                              inPlan ? "bg-primary/5 border border-primary/20" : "bg-secondary/40 hover:bg-secondary/70"
                            }`}
                          >
                            {mi.imageUrl && <img src={mi.imageUrl} alt="" className="w-10 h-10 rounded-lg object-cover shrink-0" />}
                            <div className="flex-1 min-w-0">
                              <p className="font-semibold text-sm truncate">{mi.name}</p>
                              <p className="text-xs text-muted-foreground">{formatCurrency(mi.price)}</p>
                            </div>
                            {inPlan ? (
                              <span className="text-xs font-semibold text-primary px-3 py-1.5 rounded-full bg-primary/10">In plan ✓</span>
                            ) : (
                              <button
                                onClick={() => handleAdd(mi.id)}
                                disabled={addingId === mi.id}
                                className="w-8 h-8 rounded-full bg-foreground text-background flex items-center justify-center font-bold text-lg hover:bg-primary transition-colors disabled:opacity-50 shrink-0"
                              >
                                {addingId === mi.id ? <Loader2 className="w-4 h-4 animate-spin" /> : "+"}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
