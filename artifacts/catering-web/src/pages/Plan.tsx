import { useState, useMemo, useRef, useEffect } from "react";
import { Layout } from "@/components/Layout";
import {
  useGetPlan,
  useAddToCart,
  addToCart as addToCartApi,
  getGetPlanQueryKey,
  getGetCartQueryKey,
} from "@workspace/api-client-react";
import { getSessionId } from "@/lib/session";
import { useQueryClient } from "@tanstack/react-query";
import { formatCurrency } from "@/lib/utils";
import {
  Trash2, ShoppingBag, Heart, Users, Calculator, ChevronDown, ChevronUp, ChevronRight,
  Share2, Copy, CheckCheck, X, Loader2, Utensils,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Link, useLocation } from "wouter";
import { ImageLightbox } from "@/components/ImageLightbox";

// ── Category constants ───────────────────────────────────────────────────────

const SAVORY_CAT = "Small Bites - Savory";
const SWEET_CAT  = "Small Bites - Sweet";
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number) { return Math.max(min, Math.min(max, v)); }

function daysUntil(dateStr: string) {
  return Math.max(0, Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86_400_000));
}

function buildShareUrl(shareToken: string) {
  const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
  return `${window.location.origin}${base}/plan/share/${shareToken}`;
}

// ── Sub-components ───────────────────────────────────────────────────────────

function StatusBar({
  need, have, label, unit = "pcs",
}: {
  need: number; have: number; label: string; unit?: string;
}) {
  const pct       = need === 0 ? 100 : clamp((have / need) * 100, 0, 100);
  const over      = have > need;
  const met       = have >= need;
  const barColor  = met ? "bg-emerald-500" : pct >= 75 ? "bg-amber-400" : "bg-red-400";
  const textColor = met ? "text-emerald-600" : pct >= 75 ? "text-amber-600" : "text-red-500";

  return (
    <div className="space-y-1.5">
      <div className="flex justify-between items-baseline text-sm">
        <span className="font-semibold text-foreground">{label}</span>
        <span className={`font-bold tabular-nums ${textColor}`}>
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

function NumInput({
  label, value, onChange, min = 1, max = 999, hint,
}: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; max?: number; hint?: string;
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

function CountStepper({
  value, onChange, hint, defaultVal, min = 0, minMessage,
}: {
  value: number; onChange: (v: number) => void; hint?: string; defaultVal?: number; min?: number; minMessage?: string;
}) {
  const { toast } = useToast();
  const [rawText, setRawText] = useState(value > 0 ? String(value) : "");

  // Keep display in sync when value changes externally (+ button, parent reset, etc.)
  useEffect(() => { setRawText(value > 0 ? String(value) : ""); }, [value]);

  const handleDecrement = () => {
    if (value <= min) {
      if (minMessage) toast({ description: minMessage, variant: "destructive" });
      return;
    }
    onChange(value - 1);
  };

  // While typing: just update the raw display — no validation yet
  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    setRawText(e.target.value.replace(/[^0-9]/g, ""));
  };

  // On blur: commit and validate
  const handleBlur = () => {
    const v = parseInt(rawText, 10);
    if (isNaN(v) || v < min) {
      setRawText(String(min));
      onChange(min);
      if (!isNaN(v) && v < min && minMessage) {
        toast({ description: minMessage, variant: "destructive" });
      }
      return;
    }
    onChange(v);
    setRawText(String(v));
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
        value={rawText}
        placeholder={min > 0 ? String(min) : "0"}
        onChange={handleInput}
        onBlur={handleBlur}
        className="w-14 text-center font-bold text-base rounded-lg border border-border bg-background px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
      />
      <button
        onClick={() => onChange(value + 1)}
        className="w-8 h-8 rounded-lg border border-border bg-background flex items-center justify-center font-bold text-lg hover:bg-secondary transition-colors"
      >+</button>
      {defaultVal !== undefined && value !== defaultVal && (
        <button
          onClick={() => onChange(defaultVal)}
          className="ml-1 text-xs text-muted-foreground underline hover:text-foreground transition-colors"
          title={`Reset to default (${defaultVal})`}
        >↺</button>
      )}
      {hint && <span className="text-xs text-muted-foreground ml-1">{hint}</span>}
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function Plan() {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const sessionId = getSessionId();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [addingAll, setAddingAll] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);

  // ── Share modal ──
  const [shareOpen,    setShareOpen]    = useState(false);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareToken,   setShareToken]   = useState<string | null>(null);
  const [shareExpiry,  setShareExpiry]  = useState<string | null>(null);
  const [planName,     setPlanName]     = useState("");
  const [linkCopied,   setLinkCopied]   = useState(false);
  const planNameRef       = useRef<HTMLInputElement>(null);
  const shareTokenRef      = useRef<string | null>(null);
  const plannerSyncTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const planPollTimer      = useRef<ReturnType<typeof setInterval> | null>(null);
  const receivedFromPoll   = useRef(false); // prevents auto-save echo after a poll update
  const currentPlannerRef  = useRef({ guests: 20, savoryPPG: 3, sweetPPG: 2, servingsPPG: 4, piecesMap: {} as Record<number,number>, servingsMap: {} as Record<number,number>, sizeMap: {} as Record<number,number> });
  const currentItemIdsRef  = useRef<string>("[]");
  const shareUrl = shareToken ? buildShareUrl(shareToken) : null;

  // Keep refs in sync
  useEffect(() => { shareTokenRef.current = shareToken; }, [shareToken]);

  const getPlannerState = () => ({
    guests, savoryPPG, sweetPPG, servingsPPG, piecesMap, servingsMap,
  });

  const openShare = async () => {
    setShareOpen(true);
    setShareLoading(true);
    try {
      const res  = await fetch("/api/plan/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, planName: planName || undefined, plannerState: getPlannerState() }),
      });
      const data = await res.json();
      setShareToken(data.shareToken);
      setShareExpiry(data.expiresAt);
    } catch {
      toast({ title: "Error", description: "Could not create share link.", variant: "destructive" });
      setShareOpen(false);
    } finally {
      setShareLoading(false);
    }
  };

  const updatePlanName = async (name: string) => {
    if (!shareToken) return;
    await fetch("/api/plan/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, planName: name || undefined, plannerState: getPlannerState() }),
    }).catch(() => {});
  };

  const handleCopyLink = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2500);
    } catch {
      toast({ title: "Could not copy", description: "Select and copy the link manually.", variant: "destructive" });
    }
  };

  useEffect(() => {
    if (shareOpen && !shareLoading) setTimeout(() => planNameRef.current?.focus(), 50);
  }, [shareOpen, shareLoading]);

  // ── Data ──
  const { data: plan, isLoading } = useGetPlan({ sessionId });

  const removePlanItem = async (itemId: number) => {
    try {
      await fetch(`/api/plan/${itemId}?sessionId=${encodeURIComponent(sessionId)}`, { method: "DELETE" });
      queryClient.invalidateQueries({ queryKey: getGetPlanQueryKey({ sessionId }) });
    } catch {
      toast({ title: "Error", description: "Could not remove item. Please try again.", variant: "destructive" });
    }
  };

  const addToCart = useAddToCart({
    mutation: {
      onSuccess: (_, variables) => {
        queryClient.invalidateQueries({ queryKey: getGetCartQueryKey({ sessionId }) });
        const planItem = plan?.items.find(i => i.menuItemId === variables.data.menuItemId);
        if (planItem) removePlanItem(planItem.id);
        toast({ title: "Moved to Cart", description: "Item is now in your order." });
      },
    },
  });

  const handleAddAllToCart = async () => {
    if (!plan?.items.length || addingAll) return;
    setAddingAll(true);
    try {
      await Promise.all(
        plan.items.map(item =>
          addToCartApi({ sessionId, menuItemId: item.menuItemId, quantity: item.menuItem.minimumOrderQty ?? 1 })
        )
      );
      queryClient.invalidateQueries({ queryKey: getGetCartQueryKey({ sessionId }) });
      toast({ title: "Added to cart!", description: `${plan.items.length} item${plan.items.length !== 1 ? "s" : ""} added — ready to checkout.` });
      navigate("/cart");
    } catch {
      toast({ title: "Something went wrong", description: "Some items may not have been added. Please try again.", variant: "destructive" });
    } finally {
      setAddingAll(false);
    }
  };

  const handleClearPlan = async () => {
    try {
      await fetch("/api/plan", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      queryClient.invalidateQueries({ queryKey: getGetPlanQueryKey({ sessionId }) });
      setPiecesMap({});
      setServingsMap({});
      setSizeMap({});
      setClearConfirm(false);
      toast({ title: "Plan cleared", description: "Your event plan has been cleared." });
    } catch {
      toast({ title: "Error", description: "Could not clear the plan. Please try again.", variant: "destructive" });
    }
  };

  // ── Planner state ──
  const [sbOpen,  setSbOpen]  = useState(true);
  const [entOpen, setEntOpen] = useState(true);

  const [guests,      setGuests]      = useState(20);
  const [guestRaw,    setGuestRaw]    = useState("20");
  const [savoryPPG,   setSavoryPPG]   = useState(3);
  const [sweetPPG,    setSweetPPG]    = useState(2);
  const [servingsPPG, setServingsPPG] = useState(4);

  const [piecesMap,   setPiecesMap]   = useState<Record<number, number>>({});
  const [servingsMap, setServingsMap] = useState<Record<number, number>>({});
  const [sizeMap,     setSizeMap]     = useState<Record<number, number>>({}); // planItemId → size slot 1–5

  // Auto-push plannerState to the shared record — skip when change came from a poll
  useEffect(() => {
    if (!shareToken) return;
    if (receivedFromPoll.current) { receivedFromPoll.current = false; return; }
    if (plannerSyncTimer.current) clearTimeout(plannerSyncTimer.current);
    plannerSyncTimer.current = setTimeout(async () => {
      const tok = shareTokenRef.current;
      if (!tok) return;
      await fetch(`/api/plan/share/${tok}/planner`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plannerState: { guests, savoryPPG, sweetPPG, servingsPPG, piecesMap, servingsMap, sizeMap } }),
      }).catch(() => {});
    }, 800);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareToken, guests, savoryPPG, sweetPPG, servingsPPG, piecesMap, servingsMap, sizeMap]);

  // Poll for changes made by the sharee (only active once a share token exists)
  useEffect(() => {
    if (!shareToken) return;
    const poll = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const res = await fetch(`/api/plan/share/${shareToken}`);
        if (!res.ok) return;
        const data = await res.json();

        // ── Check for item list changes (sharee added/removed items) ──
        const polledIds = JSON.stringify((data.items ?? []).map((i: { id: number }) => i.id).sort());
        if (polledIds !== currentItemIdsRef.current) {
          currentItemIdsRef.current = polledIds;
          queryClient.invalidateQueries({ queryKey: getGetPlanQueryKey({ sessionId }) });
        }

        // ── Check for plannerState changes ──
        const ps = data.plannerState;
        if (!ps) return;
        const cur = currentPlannerRef.current;
        const changed =
          ps.guests !== cur.guests ||
          ps.savoryPPG !== cur.savoryPPG ||
          ps.sweetPPG !== cur.sweetPPG ||
          ps.servingsPPG !== cur.servingsPPG ||
          JSON.stringify(ps.piecesMap) !== JSON.stringify(cur.piecesMap) ||
          JSON.stringify(ps.servingsMap) !== JSON.stringify(cur.servingsMap) ||
          JSON.stringify(ps.sizeMap) !== JSON.stringify(cur.sizeMap);
        if (!changed) return;
        receivedFromPoll.current = true;
        if (ps.guests !== cur.guests) setGuests(ps.guests);
        if (ps.savoryPPG !== cur.savoryPPG) setSavoryPPG(ps.savoryPPG);
        if (ps.sweetPPG !== cur.sweetPPG) setSweetPPG(ps.sweetPPG);
        if (ps.servingsPPG !== cur.servingsPPG) setServingsPPG(ps.servingsPPG);
        if (JSON.stringify(ps.piecesMap) !== JSON.stringify(cur.piecesMap))
          setPiecesMap(Object.fromEntries(Object.entries(ps.piecesMap).map(([k,v]) => [Number(k), Number(v)])));
        if (JSON.stringify(ps.servingsMap) !== JSON.stringify(cur.servingsMap))
          setServingsMap(Object.fromEntries(Object.entries(ps.servingsMap).map(([k,v]) => [Number(k), Number(v)])));
        if (ps.sizeMap && JSON.stringify(ps.sizeMap) !== JSON.stringify(cur.sizeMap))
          setSizeMap(Object.fromEntries(Object.entries(ps.sizeMap).map(([k,v]) => [Number(k), Number(v)])));
      } catch {}
    };
    planPollTimer.current = setInterval(poll, 3000);
    return () => { if (planPollTimer.current) clearInterval(planPollTimer.current); };
  }, [shareToken, sessionId, queryClient]);

  // Sync guestRaw when guests changes externally (e.g. from poll)
  useEffect(() => { setGuestRaw(String(guests)); }, [guests]);

  // Keep currentPlannerRef up to date for poll comparisons
  useEffect(() => {
    currentPlannerRef.current = { guests, savoryPPG, sweetPPG, servingsPPG, piecesMap, servingsMap, sizeMap };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guests, savoryPPG, sweetPPG, servingsPPG, piecesMap, servingsMap]);

  // Keep currentItemIdsRef in sync with plan items
  useEffect(() => {
    const ids = JSON.stringify((plan?.items ?? []).map(i => i.id).sort());
    currentItemIdsRef.current = ids;
  }, [plan?.items]);

  // ── Per-category collapse ──
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set());
  const toggleCat = (cat: string) =>
    setCollapsedCats(prev => {
      const next = new Set(prev);
      next.has(cat) ? next.delete(cat) : next.add(cat);
      return next;
    });

  // Auto-seed maps at minimumOrderQty for each new item — returns same ref if nothing changed
  useEffect(() => {
    if (!plan?.items) return;
    setPiecesMap(prev => {
      let seeded = false;
      const next = { ...prev };
      plan.items.forEach(item => {
        if (isSmallBite(item.menuItem.category) && !(item.id in next)) { next[item.id] = item.menuItem.minimumOrderQty ?? 1; seeded = true; }
      });
      return seeded ? next : prev;
    });
    setServingsMap(prev => {
      let seeded = false;
      const next = { ...prev };
      plan.items.forEach(item => {
        if (isEntree(item.menuItem.category) && !(item.id in next)) { next[item.id] = item.menuItem.minimumOrderQty ?? 1; seeded = true; }
      });
      return seeded ? next : prev;
    });
    setSizeMap(prev => {
      let seeded = false;
      const next = { ...prev };
      plan.items.forEach(item => {
        if (isEntree(item.menuItem.category) && (item.menuItem as any).pricingTemplate === "pan_sizes" && !(item.id in next)) {
          // Default to first size slot that has a price, otherwise slot 1
          let firstIdx = 1;
          for (let i = 1; i <= 5; i++) {
            if ((item.menuItem as any)[`size${i}Price`] != null) { firstIdx = i; break; }
          }
          next[item.id] = firstIdx;
          seeded = true;
        }
      });
      return seeded ? next : prev;
    });
  }, [plan?.items]);

  // ── Computed totals ──
  const smallBiteItems = useMemo(
    () => plan?.items.filter(i => isSmallBite(i.menuItem.category)) ?? [],
    [plan],
  );
  const entreeItems = useMemo(
    () => plan?.items.filter(i => isEntree(i.menuItem.category)) ?? [],
    [plan],
  );

  const needSavory  = guests * savoryPPG;
  const needSweet   = guests * sweetPPG;
  const needSbTotal = needSavory + needSweet;
  const needEntrees = guests * servingsPPG;

  const haveSavory = useMemo(
    () => smallBiteItems.filter(i => i.menuItem.category === SAVORY_CAT)
      .reduce((s, i) => s + (piecesMap[i.id] ?? 0) * ((i.menuItem as any).servingSize ?? 1), 0),
    [smallBiteItems, piecesMap],
  );
  const haveSweet = useMemo(
    () => smallBiteItems.filter(i => i.menuItem.category === SWEET_CAT)
      .reduce((s, i) => s + (piecesMap[i.id] ?? 0) * ((i.menuItem as any).servingSize ?? 1), 0),
    [smallBiteItems, piecesMap],
  );
  const haveSbTotal = haveSavory + haveSweet;

  const entreeServingsBycat = useMemo(() => {
    const map: Record<string, number> = {};
    entreeItems.forEach(i => {
      const isPanSizes = (i.menuItem as any).pricingTemplate === "pan_sizes";
      let srvPerUnit: number;
      if (isPanSizes) {
        const idx = sizeMap[i.id] ?? 1;
        srvPerUnit = (i.menuItem as any)[`size${idx}Servings`] ?? (i.menuItem as any).servingSize ?? 1;
      } else {
        srvPerUnit = (i.menuItem as any).servingSize ?? 1;
      }
      const srv = (servingsMap[i.id] ?? 0) * srvPerUnit;
      map[i.menuItem.category] = (map[i.menuItem.category] ?? 0) + srv;
    });
    return map;
  }, [entreeItems, servingsMap, sizeMap]);

  const haveEntreesTotal = Object.values(entreeServingsBycat).reduce((s, v) => s + v, 0);

  // ── Grouped items for display ──
  const groupedItems = useMemo(() => {
    if (!plan?.items) return [] as [string, typeof plan.items][];
    const map = new Map<string, typeof plan.items>();
    CAT_ORDER.forEach(cat => map.set(cat, []));
    plan.items.forEach(item => {
      if (!map.has(item.menuItem.category)) map.set(item.menuItem.category, []);
      map.get(item.menuItem.category)!.push(item);
    });
    return Array.from(map.entries()).filter(([, items]) => items.length > 0);
  }, [plan?.items]);

  const hasSmallBites = smallBiteItems.length > 0;
  const hasEntrees    = entreeItems.length > 0;

  // ── Collapsed planner summaries ──
  const sbSummary  = `${guests} guests · ${needSbTotal} pcs needed · ${haveSbTotal} tracked`;
  const entSummary = `${guests} guests · ${needEntrees} srv needed · ${haveEntreesTotal} tracked`;

  return (
    <Layout>
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}

      {/* ── Share Modal ── */}
      {shareOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) setShareOpen(false); }}
        >
          <div className="bg-card border border-border rounded-3xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="flex items-center justify-between px-6 py-5 border-b border-border">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 bg-primary/10 rounded-xl flex items-center justify-center">
                  <Share2 className="w-4 h-4 text-primary" />
                </div>
                <h2 className="font-display font-bold text-xl">Save & Share Plan</h2>
              </div>
              <button
                onClick={() => setShareOpen(false)}
                className="w-8 h-8 rounded-full hover:bg-secondary flex items-center justify-center transition-colors"
              >
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>

            <div className="px-6 py-5 space-y-5">
              {shareLoading ? (
                <div className="h-32 flex items-center justify-center gap-3 text-muted-foreground">
                  <Loader2 className="w-5 h-5 animate-spin" /> Creating your link…
                </div>
              ) : (
                <>
                  <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1.5">
                      Plan name <span className="font-normal normal-case tracking-normal text-muted-foreground/60">(optional)</span>
                    </label>
                    <input
                      ref={planNameRef}
                      type="text"
                      value={planName}
                      onChange={e => setPlanName(e.target.value)}
                      onBlur={e => updatePlanName(e.target.value)}
                      placeholder="e.g. Smith Wedding Reception"
                      className="w-full px-4 py-2.5 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1.5">
                      Your share link
                    </label>
                    <div className="flex gap-2">
                      <input
                        readOnly
                        value={shareUrl ?? ""}
                        className="flex-1 px-3 py-2 rounded-xl border border-border bg-secondary text-sm font-mono text-muted-foreground select-all focus:outline-none"
                        onClick={e => (e.target as HTMLInputElement).select()}
                      />
                      <button
                        onClick={handleCopyLink}
                        className={`px-4 py-2 rounded-xl font-semibold text-sm flex items-center gap-2 transition-colors ${
                          linkCopied ? "bg-emerald-100 text-emerald-700" : "bg-foreground text-background hover:bg-primary"
                        }`}
                      >
                        {linkCopied ? <CheckCheck className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        {linkCopied ? "Copied!" : "Copy"}
                      </button>
                    </div>
                    {shareExpiry && (
                      <p className="text-xs text-muted-foreground mt-1.5">
                        Link active for {daysUntil(shareExpiry)} days after last use. Anyone with the link can view and edit.
                      </p>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground bg-secondary/60 rounded-xl px-3 py-2">
                    Your guest count and piece/serving quantities are saved with this link so collaborators see your current numbers.
                  </p>
                  <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1.5">
                      Email the link
                    </label>
                    <a
                      href={`mailto:?subject=${encodeURIComponent((planName || "Catering Event Plan") + " — dash by Hollywood East Cafe")}&body=${encodeURIComponent(`Here's our shared catering plan:\n\n${shareUrl}\n\nAnyone with the link can view and add items. The link stays active for 60 days after last use.\n\n— dash by Hollywood East Cafe`)}`}
                      className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-border bg-background text-sm font-semibold hover:bg-secondary transition-colors"
                    >
                      Open in email app →
                    </a>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-20">

        {/* ── Page header ── */}
        <div className="flex items-center gap-4 mb-10">
          <div className="w-12 h-12 bg-primary/10 rounded-2xl flex items-center justify-center text-primary">
            <Heart className="w-6 h-6 fill-current" />
          </div>
          <h1 className="font-display font-bold text-4xl flex-1">Your Event Plan</h1>
          {!isLoading && (plan?.items.length ?? 0) > 0 && (
            <div className="flex items-center gap-2 shrink-0">
              {clearConfirm ? (
                <>
                  <span className="text-sm font-semibold text-destructive hidden sm:inline">Clear all items?</span>
                  <button
                    onClick={handleClearPlan}
                    className="flex items-center gap-1.5 px-3 py-2 bg-destructive text-destructive-foreground font-semibold rounded-xl text-sm hover:bg-destructive/90 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Yes, clear it
                  </button>
                  <button
                    onClick={() => setClearConfirm(false)}
                    className="px-3 py-2 border border-border font-semibold rounded-xl text-sm hover:bg-secondary transition-colors"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setClearConfirm(true)}
                  className="flex items-center gap-2 px-3 py-2.5 border border-border text-muted-foreground font-semibold rounded-xl text-sm hover:border-destructive hover:text-destructive transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                  <span className="hidden sm:inline">Clear Plan</span>
                </button>
              )}
              <button
                onClick={openShare}
                className="flex items-center gap-2 px-4 py-2.5 bg-foreground text-background font-semibold rounded-xl text-sm hover:bg-primary transition-colors"
              >
                <Share2 className="w-4 h-4" />
                <span className="hidden sm:inline">Save & Share</span>
                <span className="sm:hidden">Share</span>
              </button>
            </div>
          )}
        </div>

        {isLoading ? (
          <div className="h-64 flex items-center justify-center text-muted-foreground">Loading…</div>
        ) : !plan?.items.length ? (
          <div className="text-center py-24 bg-card rounded-3xl border border-border border-dashed">
            <Heart className="w-12 h-12 text-muted-foreground/50 mx-auto mb-4" />
            <h3 className="font-display font-bold text-2xl mb-2">No items saved yet</h3>
            <p className="text-muted-foreground mb-6">Browse our menu and click the heart icon to save items for later.</p>
            <Link href="/menu" className="px-6 py-3 bg-primary text-primary-foreground font-semibold rounded-xl inline-block">
              Browse Menu
            </Link>
          </div>
        ) : (
          <div className="space-y-6">

            {/* ── Guests strip ── */}
            {(hasSmallBites || hasEntrees) && (
              <div className="flex items-center gap-4 px-5 py-3 bg-card border border-border rounded-2xl shadow-sm">
                <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground shrink-0">
                  <Users className="w-4 h-4" />
                  <span>Guests</span>
                </div>
                <div className="flex items-center gap-2 flex-1 justify-center">
                  <button
                    onClick={() => setGuests(g => Math.max(1, g - 1))}
                    className="w-8 h-8 rounded-full border border-border bg-background flex items-center justify-center text-base font-bold hover:bg-secondary transition-colors"
                  >−</button>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={guestRaw}
                    onChange={e => setGuestRaw(e.target.value)}
                    onBlur={() => { const v = parseInt(guestRaw, 10); if (!isNaN(v)) setGuests(clamp(v, 1, 500)); else setGuestRaw(String(guests)); }}
                    onKeyDown={e => { if (e.key === "Enter") { const v = parseInt(guestRaw, 10); if (!isNaN(v)) setGuests(clamp(v, 1, 500)); else setGuestRaw(String(guests)); } }}
                    className="w-20 text-center font-bold text-xl rounded-xl border border-border bg-background py-1 px-2 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
                  />
                  <button
                    onClick={() => setGuests(g => Math.min(500, g + 1))}
                    className="w-8 h-8 rounded-full border border-border bg-background flex items-center justify-center text-base font-bold hover:bg-secondary transition-colors"
                  >+</button>
                </div>
                <span className="text-xs text-muted-foreground shrink-0 hidden sm:block">shared between planners</span>
              </div>
            )}

            {/* ── Planners row ── */}
            {(hasSmallBites || hasEntrees) && (
              <div className="flex flex-col sm:flex-row gap-4">

                {/* Small Bites Planner */}
                {hasSmallBites && (
                  <div className={`bg-card border border-border rounded-2xl overflow-hidden shadow-sm flex flex-col ${
                    sbOpen ? "sm:flex-1 sm:min-w-0" : "sm:flex-none sm:w-14"
                  }`}>
                    {/* Normal header — always on mobile, only when open on desktop */}
                    <button
                      onClick={() => setSbOpen(o => !o)}
                      className={`flex w-full items-center justify-between px-5 py-4 hover:bg-secondary/40 transition-colors text-left ${!sbOpen ? "sm:hidden" : ""}`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                          <Calculator className="w-4 h-4 text-primary" />
                        </div>
                        <div className="min-w-0">
                          <p className="font-display font-bold text-sm">Small Bites Planner</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {sbOpen ? "Tap to collapse" : sbSummary}
                          </p>
                        </div>
                      </div>
                      {sbOpen
                        ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0 ml-2" />
                        : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0 ml-2" />}
                    </button>

                    {/* Desktop-only vertical strip when collapsed */}
                    {!sbOpen && (
                      <button
                        onClick={() => setSbOpen(true)}
                        className="hidden sm:flex flex-col items-center justify-center gap-3 w-full flex-1 py-6 px-3 hover:bg-secondary/40 transition-colors"
                      >
                        <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                        <span
                          className="text-xs font-bold uppercase tracking-widest text-muted-foreground"
                          style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
                        >
                          Small Bites
                        </span>
                        <Calculator className="w-4 h-4 text-primary shrink-0" />
                      </button>
                    )}

                    {sbOpen && (
                      <div className="px-5 pb-5 border-t border-border space-y-4">
                        <div className="grid grid-cols-2 gap-3 mt-4">
                          <NumInput label="Savory pcs/person" value={savoryPPG} onChange={setSavoryPPG} min={1} max={20} hint="rec. 3–4" />
                          <NumInput label="Sweet pcs/person"  value={sweetPPG}  onChange={setSweetPPG}  min={1} max={20} hint="rec. 2–3" />
                        </div>

                        <p className="text-xs text-muted-foreground px-1">
                          Target: <span className="font-bold text-foreground">{needSbTotal} pcs</span>
                          <span className="text-muted-foreground"> ({needSavory} savory + {needSweet} sweet)</span>
                        </p>

                        <div className="space-y-3">
                          <StatusBar need={needSavory} have={haveSavory} label="Savory" unit="pcs" />
                          <StatusBar need={needSweet}  have={haveSweet}  label="Sweet"  unit="pcs" />
                        </div>

                        <p className="text-xs text-muted-foreground text-center">
                          Enter how many pieces each item provides using the stepper on each item below.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Entrée Planner */}
                {hasEntrees && (
                  <div className={`bg-card border border-border rounded-2xl overflow-hidden shadow-sm flex flex-col ${
                    entOpen ? "sm:flex-1 sm:min-w-0" : "sm:flex-none sm:w-14"
                  }`}>
                    {/* Normal header */}
                    <button
                      onClick={() => setEntOpen(o => !o)}
                      className={`flex w-full items-center justify-between px-5 py-4 hover:bg-secondary/40 transition-colors text-left ${!entOpen ? "sm:hidden" : ""}`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                          <Utensils className="w-4 h-4 text-primary" />
                        </div>
                        <div className="min-w-0">
                          <p className="font-display font-bold text-sm">Entrée Planner</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {entOpen ? "Tap to collapse" : entSummary}
                          </p>
                        </div>
                      </div>
                      {entOpen
                        ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0 ml-2" />
                        : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0 ml-2" />}
                    </button>

                    {/* Desktop-only vertical strip when collapsed */}
                    {!entOpen && (
                      <button
                        onClick={() => setEntOpen(true)}
                        className="hidden sm:flex flex-col items-center justify-center gap-3 w-full flex-1 py-6 px-3 hover:bg-secondary/40 transition-colors"
                      >
                        <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                        <span
                          className="text-xs font-bold uppercase tracking-widest text-muted-foreground"
                          style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
                        >
                          Entrées
                        </span>
                        <Utensils className="w-4 h-4 text-primary shrink-0" />
                      </button>
                    )}

                    {entOpen && (
                      <div className="px-5 pb-5 border-t border-border space-y-4">
                        <div className="mt-4">
                          <NumInput label="Servings / person" value={servingsPPG} onChange={setServingsPPG} min={1} max={20} hint="rec. 4–5 per guest" />
                        </div>

                        <p className="text-xs text-muted-foreground px-1">
                          Target: <span className="font-bold text-foreground">{needEntrees} total servings</span>
                        </p>

                        <StatusBar need={needEntrees} have={haveEntreesTotal} label="Total Entrée Servings" unit="srv" />

                        {Object.keys(entreeServingsBycat).length > 0 && (
                          <div className="flex flex-wrap gap-2">
                            {Object.entries(entreeServingsBycat).map(([cat, srv]) => (
                              <span key={cat} className="text-xs bg-secondary rounded-full px-3 py-1 text-muted-foreground">
                                {cat.replace("Entrées - ", "")}:{" "}
                                <span className="font-bold text-foreground">{srv} srv</span>
                              </span>
                            ))}
                          </div>
                        )}

                        <p className="text-xs text-muted-foreground text-center">
                          Each item's servings pre-filled from its tray size. Adjust using the stepper on each item below.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── Category sections ── */}
            <div className="space-y-4">
              {groupedItems.map(([cat, items]) => {
                const sb         = isSmallBite(cat);
                const ent        = isEntree(cat);
                const collapsed  = collapsedCats.has(cat);
                const catPrice   = items.reduce((s, i) => s + i.menuItem.price, 0);

                const catPieces  = sb
                  ? items.reduce((s, i) => s + (piecesMap[i.id] ?? 0) * ((i.menuItem as any).servingSize ?? 1), 0)
                  : null;
                const catServings = ent
                  ? items.reduce((s, i) => {
                      const isPan = (i.menuItem as any).pricingTemplate === "pan_sizes";
                      const idx   = isPan ? (sizeMap[i.id] ?? 1) : 0;
                      const spu   = isPan ? ((i.menuItem as any)[`size${idx}Servings`] ?? (i.menuItem as any).servingSize ?? 1) : ((i.menuItem as any).servingSize ?? 1);
                      return s + (servingsMap[i.id] ?? 0) * spu;
                    }, 0)
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
                          const traysSmall = Math.max(minQty, piecesMap[item.id]   ?? 0);
                          const traysEnt   = Math.max(minQty, servingsMap[item.id] ?? 0);
                          const sz         = (item.menuItem as any).servingSize ?? 1;
                          const unit       = ((item.menuItem as any).unit as string | undefined)?.trim() || "trays";
                          const unitCap    = unit.charAt(0).toUpperCase() + unit.slice(1);
                          const minMsg     = `Minimum order is ${minQty} ${unit} for this item.`;

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

                                {/* Small Bites — unit stepper */}
                                {sb && (
                                  <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-secondary/50 rounded-xl border border-border/60">
                                    <div>
                                      <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{unitCap} ordered</p>
                                      {sz > 1 && (
                                        <p className="text-xs text-muted-foreground">
                                          {sz} pcs per {unit} · {traysSmall * sz} pcs total
                                        </p>
                                      )}
                                    </div>
                                    <CountStepper
                                      value={traysSmall}
                                      onChange={v => setPiecesMap(p => ({ ...p, [item.id]: v }))}
                                      hint={unit}
                                      defaultVal={minQty}
                                      min={minQty}
                                      minMessage={minMsg}
                                    />
                                  </div>
                                )}

                                {/* Entrée — pan sizes picker + unit stepper */}
                                {ent && (() => {
                                  const isPanSizes = (item.menuItem as any).pricingTemplate === "pan_sizes";
                                  if (!isPanSizes) {
                                    return (
                                      <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-secondary/50 rounded-xl border border-border/60">
                                        <div>
                                          <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{unitCap} ordered</p>
                                          {sz > 1 && (
                                            <p className="text-xs text-muted-foreground">
                                              {sz} servings per {unit} · {traysEnt * sz} srv total
                                            </p>
                                          )}
                                        </div>
                                        <CountStepper
                                          value={traysEnt}
                                          onChange={v => setServingsMap(p => ({ ...p, [item.id]: v }))}
                                          hint={unit}
                                          defaultVal={minQty}
                                          min={minQty}
                                          minMessage={minMsg}
                                        />
                                      </div>
                                    );
                                  }
                                  // Pan sizes
                                  const activeSizes: Array<{ idx: number; label: string; servings: number; price: number }> = [];
                                  for (let i = 1; i <= 5; i++) {
                                    const lbl = (item.menuItem as any)[`size${i}Label`] as string | null | undefined;
                                    const srv = (item.menuItem as any)[`size${i}Servings`] as number | null | undefined;
                                    const prc = (item.menuItem as any)[`size${i}Price`];
                                    if (lbl && prc != null) activeSizes.push({ idx: i, label: lbl, servings: srv ?? 1, price: parseFloat(String(prc)) });
                                  }
                                  const selectedIdx = sizeMap[item.id] ?? activeSizes[0]?.idx ?? 1;
                                  const selectedSize = activeSizes.find(s => s.idx === selectedIdx) ?? activeSizes[0];
                                  const traysEntPan = Math.max(minQty, servingsMap[item.id] ?? 0);
                                  return (
                                    <div className="space-y-2">
                                      {/* Size selector */}
                                      <div className="flex flex-wrap gap-2">
                                        {activeSizes.map(s => (
                                          <button
                                            key={s.idx}
                                            onClick={() => setSizeMap(p => ({ ...p, [item.id]: s.idx }))}
                                            className={`px-3 py-1.5 rounded-xl border text-sm font-semibold transition-colors ${
                                              s.idx === selectedIdx
                                                ? "bg-foreground text-background border-foreground"
                                                : "bg-secondary border-border hover:bg-secondary/80"
                                            }`}
                                          >
                                            {s.label}
                                            <span className={`ml-1.5 text-xs font-normal ${s.idx === selectedIdx ? "opacity-70" : "text-muted-foreground"}`}>
                                              ~{s.servings} srv · ${s.price.toFixed(0)}
                                            </span>
                                          </button>
                                        ))}
                                      </div>
                                      {/* Quantity stepper */}
                                      <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-secondary/50 rounded-xl border border-border/60">
                                        <div>
                                          <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Pans ordered</p>
                                          {selectedSize && (
                                            <p className="text-xs text-muted-foreground">
                                              {selectedSize.label} · {selectedSize.servings} srv/pan · {traysEntPan * selectedSize.servings} srv total
                                            </p>
                                          )}
                                        </div>
                                        <CountStepper
                                          value={traysEntPan}
                                          onChange={v => setServingsMap(p => ({ ...p, [item.id]: v }))}
                                          hint="pan"
                                          defaultVal={minQty}
                                          min={minQty}
                                          minMessage={minMsg}
                                        />
                                      </div>
                                    </div>
                                  );
                                })()}

                                <div className="flex justify-between items-center">
                                  <button
                                    onClick={() => removePlanItem(item.id)}
                                    className="text-sm font-semibold text-muted-foreground hover:text-destructive transition-colors flex items-center gap-1.5"
                                  >
                                    <Trash2 className="w-4 h-4" /> Remove
                                  </button>
                                  <button
                                    onClick={() => addToCart.mutate({ data: { sessionId, menuItemId: item.menuItemId, quantity: item.menuItem.minimumOrderQty ?? 1 } })}
                                    className="px-4 py-2 bg-foreground text-background font-semibold rounded-xl hover:bg-primary transition-colors flex items-center gap-2 text-sm"
                                  >
                                    <ShoppingBag className="w-4 h-4" /> Move to Cart
                                  </button>
                                </div>
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

            {/* ── Add All to Cart ── */}
            {plan.items.length > 0 && (() => {
              const total = plan.items.reduce((s, i) => s + i.menuItem.price, 0);
              return (
                <div className="sticky bottom-4 z-20">
                  <div className="bg-foreground text-background rounded-2xl shadow-xl px-5 py-4 flex items-center justify-between gap-4">
                    <div>
                      <p className="font-display font-bold text-base leading-tight">
                        {plan.items.length} item{plan.items.length !== 1 ? "s" : ""} ready to order
                      </p>
                      <p className="text-sm opacity-70">{formatCurrency(total)} estimated</p>
                    </div>
                    <button
                      onClick={handleAddAllToCart}
                      disabled={addingAll}
                      className="shrink-0 flex items-center gap-2 bg-background text-foreground font-bold px-5 py-2.5 rounded-xl hover:bg-secondary transition-colors disabled:opacity-60 text-sm"
                    >
                      {addingAll
                        ? <><Loader2 className="w-4 h-4 animate-spin" /> Adding…</>
                        : <><ShoppingBag className="w-4 h-4" /> Add All to Cart</>}
                    </button>
                  </div>
                </div>
              );
            })()}

          </div>
        )}
      </div>
    </Layout>
  );
}
