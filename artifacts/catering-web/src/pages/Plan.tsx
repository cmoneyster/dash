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
import { TAX_DISCLOSURE_SHORT } from "@/lib/tax";
import {
  Trash2, ShoppingBag, Heart, Users, Calculator, ChevronDown, ChevronUp, ChevronRight,
  Share2, Copy, CheckCheck, X, Loader2, Utensils, AlertTriangle, Truck,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Link, useLocation } from "wouter";
import { ImageLightbox } from "@/components/ImageLightbox";
import { useCategories, splitCategoryName, type Category } from "@/lib/categories";
import { ServiceModeBanner } from "@/components/ServiceModeBanner";
import { loadServiceMode, saveServiceMode, type ServiceMode } from "@/lib/serviceMode";

// ── Category helpers (derived from API) ──────────────────────────────────────

interface CategoryMaps {
  savory: Set<string>;
  sweet: Set<string>;
  entree: Set<string>;
  other: Set<string>;
  order: string[];
}

function buildCategoryMaps(categories: Category[] | undefined): CategoryMaps {
  const maps: CategoryMaps = { savory: new Set(), sweet: new Set(), entree: new Set(), other: new Set(), order: [] };
  (categories ?? []).forEach((c) => {
    if (c.plannerGroup === "savory") maps.savory.add(c.name);
    else if (c.plannerGroup === "sweet") maps.sweet.add(c.name);
    else if (c.plannerGroup === "entree") maps.entree.add(c.name);
    else maps.other.add(c.name);
    maps.order.push(c.name);
  });
  return maps;
}

const PLANNER_STORAGE_KEY = "dash_plan_planner_v1";

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

  // ── Categories from API ──
  // Plan needs every category (incl. hidden) so existing items in a hidden
  // category still classify into their planner_group instead of "Other items".
  const { data: categoryData } = useCategories({ includeHidden: true });
  const catMaps = useMemo(() => buildCategoryMaps(categoryData), [categoryData]);
  const isSavory    = (c: string) => catMaps.savory.has(c);
  const isSweet     = (c: string) => catMaps.sweet.has(c);
  const isSmallBite = (c: string) => catMaps.savory.has(c) || catMaps.sweet.has(c);
  const isEntree    = (c: string) => catMaps.entree.has(c);

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
  const currentPlannerRef  = useRef({ guests: 20, savoryPPG: 3, sweetPPG: 2, servingsPPG: 4, piecesMap: {} as Record<number,number>, servingsMap: {} as Record<number,number>, panQtys: {} as Record<number,Record<number,number>>, serviceMode: "drop_off" as ServiceMode });
  const currentItemIdsRef  = useRef<string>("[]");
  const shareUrl = shareToken ? buildShareUrl(shareToken) : null;

  // Keep refs in sync
  useEffect(() => { shareTokenRef.current = shareToken; }, [shareToken]);

  const getPlannerState = () => ({
    guests, savoryPPG, sweetPPG, servingsPPG, piecesMap, servingsMap, panQtys, serviceMode,
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

  // On mount, recover an existing share record so auto-sync resumes without re-clicking Share
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/plan/share/by-session?sessionId=${encodeURIComponent(sessionId)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.found) {
          setShareToken(data.shareToken);
          setShareExpiry(data.expiresAt);
          if (data.planName) setPlanName(data.planName);
        }
      } catch {}
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      for (const item of plan.items) {
        const isPanSizes = (item.menuItem as any).pricingTemplate === "pan_sizes";
        if (isPanSizes) {
          const slots = panQtys[item.id] ?? {};
          const entries = Object.entries(slots).filter(([, q]) => q > 0);
          for (const [idxStr, qty] of entries) {
            const idx = Number(idxStr);
            const lbl = (item.menuItem as any)[`size${idx}Label`];
            const prc = parseFloat(String((item.menuItem as any)[`size${idx}Price`]));
            await fetch("/api/cart", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId, menuItemId: item.menuItemId, quantity: qty, sizeSlot: idx, sizeLabel: lbl, sizePrice: prc }),
            });
          }
        } else {
          const minQ = item.menuItem.minimumOrderQty ?? 1;
          const isSb  = isSmallBite(item.menuItem.category);
          const isEnt = isEntree(item.menuItem.category);
          const qty = isSb  ? Math.max(minQ, piecesMap[item.id]   ?? 0)
                    : isEnt ? Math.max(minQ, servingsMap[item.id] ?? 0)
                    : minQ;
          await addToCartApi({ sessionId, menuItemId: item.menuItemId, quantity: qty });
        }
      }
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
      setPanQtys({});
      localStorage.removeItem(PLANNER_STORAGE_KEY);
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
  const [panQtys,     setPanQtys]     = useState<Record<number, Record<number, number>>>({}); // planItemId → slotIdx → qty
  const [serviceMode, setServiceMode] = useState<ServiceMode>(() => loadServiceMode());
  useEffect(() => { saveServiceMode(serviceMode); }, [serviceMode]);

  // ── Persist planner state to localStorage so it survives navigation ──
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PLANNER_STORAGE_KEY);
      if (!raw) return;
      const { guests: g, savoryPPG: sv, sweetPPG: sw, servingsPPG: sp, piecesMap: pm, servingsMap: sm, panQtys: pq, planName: pn, shareToken: st, shareExpiry: se } = JSON.parse(raw);
      if (typeof g === "number")  setGuests(g);
      if (typeof sv === "number") setSavoryPPG(sv);
      if (typeof sw === "number") setSweetPPG(sw);
      if (typeof sp === "number") setServingsPPG(sp);
      if (pm && typeof pm === "object")
        setPiecesMap(Object.fromEntries(Object.entries(pm).map(([k, v]) => [Number(k), Number(v)])));
      if (sm && typeof sm === "object")
        setServingsMap(Object.fromEntries(Object.entries(sm).map(([k, v]) => [Number(k), Number(v)])));
      if (pq && typeof pq === "object")
        setPanQtys(Object.fromEntries(
          Object.entries(pq as Record<string, Record<string, number>>).map(([k, slots]) => [
            Number(k),
            Object.fromEntries(Object.entries(slots).map(([sk, sv2]) => [Number(sk), Number(sv2)])),
          ])
        ));
      if (typeof pn === "string" && pn) setPlanName(pn);
      if (typeof st === "string" && st) setShareToken(st);
      if (typeof se === "string" && se) setShareExpiry(se);
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(PLANNER_STORAGE_KEY, JSON.stringify({ guests, savoryPPG, sweetPPG, servingsPPG, piecesMap, servingsMap, panQtys, planName, shareToken, shareExpiry }));
    } catch {}
  }, [guests, savoryPPG, sweetPPG, servingsPPG, piecesMap, servingsMap, panQtys, planName, shareToken, shareExpiry]);

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
        body: JSON.stringify({ plannerState: { guests, savoryPPG, sweetPPG, servingsPPG, piecesMap, servingsMap, panQtys, serviceMode } }),
      }).catch(() => {});
    }, 800);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareToken, guests, savoryPPG, sweetPPG, servingsPPG, piecesMap, servingsMap, panQtys, serviceMode]);

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
        const polledMode: ServiceMode = ps.serviceMode === "on_the_dash" ? "on_the_dash" : "drop_off";
        const changed =
          ps.guests !== cur.guests ||
          ps.savoryPPG !== cur.savoryPPG ||
          ps.sweetPPG !== cur.sweetPPG ||
          ps.servingsPPG !== cur.servingsPPG ||
          JSON.stringify(ps.piecesMap) !== JSON.stringify(cur.piecesMap) ||
          JSON.stringify(ps.servingsMap) !== JSON.stringify(cur.servingsMap) ||
          JSON.stringify(ps.panQtys) !== JSON.stringify(cur.panQtys) ||
          polledMode !== cur.serviceMode;
        if (!changed) return;
        receivedFromPoll.current = true;
        if (polledMode !== cur.serviceMode) setServiceMode(polledMode);
        if (ps.guests !== cur.guests) setGuests(ps.guests);
        if (ps.savoryPPG !== cur.savoryPPG) setSavoryPPG(ps.savoryPPG);
        if (ps.sweetPPG !== cur.sweetPPG) setSweetPPG(ps.sweetPPG);
        if (ps.servingsPPG !== cur.servingsPPG) setServingsPPG(ps.servingsPPG);
        if (JSON.stringify(ps.piecesMap) !== JSON.stringify(cur.piecesMap))
          setPiecesMap(Object.fromEntries(Object.entries(ps.piecesMap).map(([k,v]) => [Number(k), Number(v)])));
        if (JSON.stringify(ps.servingsMap) !== JSON.stringify(cur.servingsMap))
          setServingsMap(Object.fromEntries(Object.entries(ps.servingsMap).map(([k,v]) => [Number(k), Number(v)])));
        if (ps.panQtys && JSON.stringify(ps.panQtys) !== JSON.stringify(cur.panQtys)) {
          setPanQtys(Object.fromEntries(
            Object.entries(ps.panQtys as Record<string, Record<string, number>>).map(([k, slots]) => [
              Number(k),
              Object.fromEntries(Object.entries(slots).map(([sk, sv]) => [Number(sk), Number(sv)])),
            ])
          ));
        }
      } catch {}
    };
    planPollTimer.current = setInterval(poll, 3000);
    return () => { if (planPollTimer.current) clearInterval(planPollTimer.current); };
  }, [shareToken, sessionId, queryClient]);

  // Sync guestRaw when guests changes externally (e.g. from poll)
  useEffect(() => { setGuestRaw(String(guests)); }, [guests]);

  // Keep currentPlannerRef up to date for poll comparisons
  useEffect(() => {
    currentPlannerRef.current = { guests, savoryPPG, sweetPPG, servingsPPG, piecesMap, servingsMap, panQtys, serviceMode };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guests, savoryPPG, sweetPPG, servingsPPG, piecesMap, servingsMap, panQtys, serviceMode]);

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

  // Auto-seed maps at minimumOrderQty for each new item — returns same ref if nothing changed.
  // Depends on catMaps so seeding re-runs once categories load (in case they arrive after plan).
  useEffect(() => {
    if (!plan?.items) return;
    setPiecesMap(prev => {
      let seeded = false;
      const next = { ...prev };
      plan.items.forEach(item => {
        if (isSmallBite(item.menuItem.category) && (item.menuItem as any).pricingTemplate !== "pan_sizes" && !(item.id in next)) { next[item.id] = item.menuItem.minimumOrderQty ?? 1; seeded = true; }
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
    setPanQtys(prev => {
      let seeded = false;
      const next = { ...prev };
      plan.items.forEach(item => {
        const isPanSizes = (item.menuItem as any).pricingTemplate === "pan_sizes";
        if (!isPanSizes || (item.id in next)) return;
        if (!isEntree(item.menuItem.category) && !isSmallBite(item.menuItem.category)) return;
        const isSmallBiteItem = isSmallBite(item.menuItem.category);
        const minQty = item.menuItem.minimumOrderQty ?? 1;
        const slots: Record<number, number> = {};
        let first = true;
        for (let i = 1; i <= 5; i++) {
          const lbl = (item.menuItem as any)[`size${i}Label`];
          const prc = (item.menuItem as any)[`size${i}Price`];
          if (lbl != null && prc != null) {
            slots[i] = first ? (isSmallBiteItem ? minQty : 1) : 0;
            first = false;
          }
        }
        next[item.id] = slots;
        seeded = true;
      });
      return seeded ? next : prev;
    });
  }, [plan?.items, catMaps]);

  // ── Computed totals ──
  const smallBiteItems = useMemo(
    () => plan?.items.filter(i => isSmallBite(i.menuItem.category)) ?? [],
    [plan, catMaps],
  );
  const entreeItems = useMemo(
    () => plan?.items.filter(i => isEntree(i.menuItem.category)) ?? [],
    [plan, catMaps],
  );

  const needSavory  = guests * savoryPPG;
  const needSweet   = guests * sweetPPG;
  const needSbTotal = needSavory + needSweet;
  const needEntrees = guests * servingsPPG;

  const haveSavory = useMemo(
    () => smallBiteItems.filter(i => isSavory(i.menuItem.category))
      .reduce((s, i) => {
        if ((i.menuItem as any).pricingTemplate === "pan_sizes") {
          const slots = panQtys[i.id] ?? {};
          return s + Object.entries(slots).reduce((ss, [idxStr, qty]) => {
            const spu = (i.menuItem as any)[`size${idxStr}Servings`] ?? (i.menuItem as any).servingSize ?? 1;
            return ss + qty * spu;
          }, 0);
        }
        return s + (piecesMap[i.id] ?? 0) * ((i.menuItem as any).servingSize ?? 1);
      }, 0),
    [smallBiteItems, piecesMap, panQtys],
  );
  const haveSweet = useMemo(
    () => smallBiteItems.filter(i => isSweet(i.menuItem.category))
      .reduce((s, i) => {
        if ((i.menuItem as any).pricingTemplate === "pan_sizes") {
          const slots = panQtys[i.id] ?? {};
          return s + Object.entries(slots).reduce((ss, [idxStr, qty]) => {
            const spu = (i.menuItem as any)[`size${idxStr}Servings`] ?? (i.menuItem as any).servingSize ?? 1;
            return ss + qty * spu;
          }, 0);
        }
        return s + (piecesMap[i.id] ?? 0) * ((i.menuItem as any).servingSize ?? 1);
      }, 0),
    [smallBiteItems, piecesMap, panQtys],
  );
  const haveSbTotal = haveSavory + haveSweet;

  const entreeServingsBycat = useMemo(() => {
    const map: Record<string, number> = {};
    entreeItems.forEach(i => {
      const isPanSizes = (i.menuItem as any).pricingTemplate === "pan_sizes";
      let srv = 0;
      if (isPanSizes) {
        const slots = panQtys[i.id] ?? {};
        Object.entries(slots).forEach(([idxStr, qty]) => {
          const idx = Number(idxStr);
          const srvPerUnit = (i.menuItem as any)[`size${idx}Servings`] ?? (i.menuItem as any).servingSize ?? 1;
          srv += qty * srvPerUnit;
        });
      } else {
        const srvPerUnit = (i.menuItem as any).servingSize ?? 1;
        srv = (servingsMap[i.id] ?? 0) * srvPerUnit;
      }
      map[i.menuItem.category] = (map[i.menuItem.category] ?? 0) + srv;
    });
    return map;
  }, [entreeItems, servingsMap, panQtys]);

  const haveEntreesTotal = Object.values(entreeServingsBycat).reduce((s, v) => s + v, 0);

  // ── Grouped items for display ──
  // Special label used for the consolidated "Other items" section. All categories
  // whose plannerGroup is "other" (or unknown) are grouped together since they
  // do not contribute to savory/sweet/entrée targets.
  const OTHER_GROUP_LABEL = "Other items";
  const groupedItems = useMemo(() => {
    type PlanItems = NonNullable<NonNullable<typeof plan>["items"]>;
    if (!plan || !plan.items) return [] as [string, PlanItems][];
    const map = new Map<string, PlanItems>();
    // Seed only savory/sweet/entree categories in their configured order to keep
    // their grouping intact.
    catMaps.order.forEach(cat => {
      if (catMaps.savory.has(cat) || catMaps.sweet.has(cat) || catMaps.entree.has(cat)) {
        map.set(cat, []);
      }
    });
    map.set(OTHER_GROUP_LABEL, []);
    plan.items.forEach(item => {
      const cat = item.menuItem.category;
      if (catMaps.savory.has(cat) || catMaps.sweet.has(cat) || catMaps.entree.has(cat)) {
        if (!map.has(cat)) map.set(cat, []);
        map.get(cat)!.push(item);
      } else {
        map.get(OTHER_GROUP_LABEL)!.push(item);
      }
    });
    return Array.from(map.entries()).filter(([, items]) => items.length > 0);
  }, [plan?.items, catMaps]);

  const hasSmallBites = smallBiteItems.length > 0;
  const hasEntrees    = entreeItems.length > 0;

  // Plan items not eligible for the on-site food trailer. Surfaced as a
  // warning when the customer has selected On the Dash so they can either
  // switch modes or remove the flagged items before sending to cart.
  const ineligiblePlanItems = useMemo(() => {
    if (!plan?.items?.length) return [] as { id: number; name: string; menuItemId: number }[];
    return plan.items
      .filter(i => !i.menuItem.otdEligible)
      .map(i => ({ id: i.id, name: i.menuItem.name, menuItemId: i.menuItemId }));
  }, [plan?.items]);
  const planHasIneligible = ineligiblePlanItems.length > 0;

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
                  {/* Name field — primary CTA */}
                  <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1.5">
                      Name your plan
                    </label>
                    <input
                      ref={planNameRef}
                      type="text"
                      value={planName}
                      onChange={e => setPlanName(e.target.value)}
                      onBlur={e => updatePlanName(e.target.value)}
                      placeholder="e.g. Smith Wedding Reception"
                      className={`w-full px-4 py-2.5 rounded-xl border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all ${
                        planName.trim() ? "border-border" : "border-amber-400 ring-1 ring-amber-200"
                      }`}
                    />
                    {!planName.trim() ? (
                      <p className="text-xs text-amber-600 mt-1.5 flex items-center gap-1">
                        <span className="font-bold">↑</span> Your plan won't save until the event plan is named.
                      </p>
                    ) : (
                      <p className="text-xs text-emerald-600 mt-1.5 font-medium">
                        ✓ Event plan has been saved, and ready to share with your event collaborators.
                      </p>
                    )}
                  </div>

                  {/* Share link */}
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

        <ServiceModeBanner mode={serviceMode} onChange={setServiceMode} />

        {/* ── On the Dash ineligibility warning ── */}
        {serviceMode === "on_the_dash" && planHasIneligible && (
          <div className="mb-6 p-5 rounded-2xl border border-amber-300 bg-amber-50 space-y-3">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0 text-amber-700" />
              <div className="flex-1">
                <p className="text-sm font-bold text-amber-900">
                  Some saved items can't be cooked on-site
                </p>
                <p className="text-xs text-amber-800/90 mt-0.5">
                  You're set to <strong>On the Dash Experience</strong>, but our food trailer can't prepare these items live. Switch to Standard Drop-Off Catering to keep them, or remove them from your plan.
                </p>
              </div>
            </div>
            <ul className="space-y-1.5">
              {ineligiblePlanItems.map(it => (
                <li
                  key={it.id}
                  className="flex items-center justify-between gap-3 px-3 py-2 bg-white rounded-lg border border-amber-200"
                >
                  <span className="text-sm font-medium text-amber-900 truncate">{it.name}</span>
                  <button
                    type="button"
                    onClick={() => removePlanItem(it.id)}
                    className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-amber-900 border border-amber-400 rounded-lg hover:bg-amber-600 hover:text-white hover:border-amber-600 transition-colors"
                    title="Remove from plan"
                  >
                    <Trash2 className="w-3 h-3" />
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => setServiceMode("drop_off")}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-amber-700 text-white text-sm font-semibold rounded-xl hover:bg-amber-800 transition-colors"
            >
              <Truck className="w-4 h-4" />
              Switch to Standard Drop-Off
            </button>
          </div>
        )}

        {/* ── Page header ── */}
        <div className="flex items-center gap-4 mb-10">
          <div className="w-12 h-12 bg-primary/10 rounded-2xl flex items-center justify-center text-primary">
            <Heart className="w-6 h-6 fill-current" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="font-display font-bold text-4xl leading-tight truncate">
              {planName || "Your Event Plan"}
            </h1>
            {planName && (
              <p className="text-sm text-muted-foreground mt-0.5">Event Plan</p>
            )}
          </div>
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
                            {catMaps.order
                              .filter(cat => catMaps.entree.has(cat) && entreeServingsBycat[cat] != null)
                              .map(cat => {
                                const { label, sub } = splitCategoryName(cat);
                                return (
                                  <span key={cat} className="text-xs bg-secondary rounded-full px-3 py-1 text-muted-foreground">
                                    {sub ?? label}:{" "}
                                    <span className="font-bold text-foreground">{entreeServingsBycat[cat]} srv</span>
                                  </span>
                                );
                              })}
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
                const catPrice   = items.reduce((s, i) => {
                  if ((i.menuItem as any).pricingTemplate === "pan_sizes") {
                    const slots = panQtys[i.id] ?? {};
                    let panTotal = 0;
                    for (let idx = 1; idx <= 5; idx++) {
                      const prc = (i.menuItem as any)[`size${idx}Price`];
                      if (prc != null) panTotal += (slots[idx] ?? 0) * parseFloat(String(prc));
                    }
                    return s + panTotal;
                  }
                  const minQ = i.menuItem.minimumOrderQty ?? 1;
                  const qty = sb ? Math.max(minQ, piecesMap[i.id] ?? 0)
                            : ent ? Math.max(minQ, servingsMap[i.id] ?? 0)
                            : 1;
                  return s + qty * parseFloat(String(i.menuItem.price));
                }, 0);

                const catPieces  = sb
                  ? items.reduce((s, i) => {
                      if ((i.menuItem as any).pricingTemplate === "pan_sizes") {
                        const slots = panQtys[i.id] ?? {};
                        return s + Object.entries(slots).reduce((ss, [idxStr, qty]) => {
                          const spu = (i.menuItem as any)[`size${idxStr}Servings`] ?? (i.menuItem as any).servingSize ?? 1;
                          return ss + qty * spu;
                        }, 0);
                      }
                      return s + (piecesMap[i.id] ?? 0) * ((i.menuItem as any).servingSize ?? 1);
                    }, 0)
                  : null;
                const catServings = ent
                  ? items.reduce((s, i) => {
                      const isPan = (i.menuItem as any).pricingTemplate === "pan_sizes";
                      if (isPan) {
                        const slots = panQtys[i.id] ?? {};
                        return s + Object.entries(slots).reduce((ss, [idxStr, q]) => {
                          const spu = (i.menuItem as any)[`size${idxStr}Servings`] ?? (i.menuItem as any).servingSize ?? 1;
                          return ss + q * spu;
                        }, 0);
                      }
                      return s + (servingsMap[i.id] ?? 0) * ((i.menuItem as any).servingSize ?? 1);
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
                                {(() => {
                                  const isPanItem = (item.menuItem as any).pricingTemplate === "pan_sizes";
                                  const panTotal  = isPanItem
                                    ? (() => {
                                        const slots = panQtys[item.id] ?? {};
                                        let t = 0;
                                        for (let i = 1; i <= 5; i++) {
                                          const prc = (item.menuItem as any)[`size${i}Price`];
                                          if (prc != null) t += (slots[i] ?? 0) * parseFloat(String(prc));
                                        }
                                        return t;
                                      })()
                                    : null;
                                  return (
                                    <div className="flex justify-between items-start gap-2">
                                      <h4 className="font-display font-bold text-lg leading-tight">{item.menuItem.name}</h4>
                                      <span className="font-bold text-primary shrink-0">
                                        {isPanItem
                                          ? (panTotal != null && panTotal > 0 ? formatCurrency(panTotal) : "—")
                                          : (() => {
                                              const minQ2 = item.menuItem.minimumOrderQty ?? 1;
                                              const qty2 = sb ? Math.max(minQ2, piecesMap[item.id] ?? 0)
                                                         : ent ? Math.max(minQ2, servingsMap[item.id] ?? 0)
                                                         : 1;
                                              return formatCurrency(qty2 * parseFloat(String(item.menuItem.price)));
                                            })()}
                                      </span>
                                    </div>
                                  );
                                })()}

                                <p className="text-muted-foreground text-sm line-clamp-2">{item.menuItem.description}</p>

                                {/* Small Bites — pan sizes multi-slot or unit stepper */}
                                {sb && (() => {
                                  const isPanSizes = (item.menuItem as any).pricingTemplate === "pan_sizes";
                                  if (isPanSizes) {
                                    const activeSizes: Array<{ idx: number; label: string; pieces: number; price: number }> = [];
                                    for (let i = 1; i <= 5; i++) {
                                      const lbl = (item.menuItem as any)[`size${i}Label`] as string | null | undefined;
                                      const pcs = (item.menuItem as any)[`size${i}Servings`] as number | null | undefined;
                                      const prc = (item.menuItem as any)[`size${i}Price`];
                                      if (lbl && prc != null) activeSizes.push({ idx: i, label: lbl, pieces: pcs ?? (item.menuItem as any).servingSize ?? 1, price: parseFloat(String(prc)) });
                                    }
                                    const slots = panQtys[item.id] ?? {};
                                    const totalPanPrice = activeSizes.reduce((s2, s3) => s2 + (slots[s3.idx] ?? 0) * s3.price, 0);
                                    const totalPanPcs   = activeSizes.reduce((s2, s3) => s2 + (slots[s3.idx] ?? 0) * s3.pieces, 0);
                                    return (
                                      <div className="space-y-2">
                                        {activeSizes.map(s => {
                                          const slotQty = slots[s.idx] ?? 0;
                                          return (
                                            <div key={s.idx} className="flex flex-wrap items-center justify-between gap-3 p-3 bg-secondary/50 rounded-xl border border-border/60">
                                              <div>
                                                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{s.label}</p>
                                                <p className="text-xs text-muted-foreground">
                                                  {formatCurrency(s.price)}/pan · ~{s.pieces} pcs
                                                  {slotQty > 0 && ` · ${slotQty * s.pieces} pcs total`}
                                                </p>
                                              </div>
                                              <CountStepper
                                                value={slotQty}
                                                onChange={v => setPanQtys(p => ({ ...p, [item.id]: { ...(p[item.id] ?? {}), [s.idx]: v } }))}
                                                hint="pan"
                                                defaultVal={1}
                                                min={0}
                                              />
                                            </div>
                                          );
                                        })}
                                        {totalPanPrice > 0 && (
                                          <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
                                            <span>{totalPanPcs} pieces total</span>
                                            <span className="font-bold text-foreground">{formatCurrency(totalPanPrice)}</span>
                                          </div>
                                        )}
                                      </div>
                                    );
                                  }
                                  return (
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
                                  );
                                })()}

                                {/* Entrée — pan sizes multi-slot steppers or single stepper */}
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
                                  // Pan sizes — per-slot steppers
                                  const activeSizes: Array<{ idx: number; label: string; servings: number; price: number }> = [];
                                  for (let i = 1; i <= 5; i++) {
                                    const lbl = (item.menuItem as any)[`size${i}Label`] as string | null | undefined;
                                    const srv = (item.menuItem as any)[`size${i}Servings`] as number | null | undefined;
                                    const prc = (item.menuItem as any)[`size${i}Price`];
                                    if (lbl && prc != null) activeSizes.push({ idx: i, label: lbl, servings: srv ?? 1, price: parseFloat(String(prc)) });
                                  }
                                  const slots = panQtys[item.id] ?? {};
                                  const totalPanPrice = activeSizes.reduce((s, sz2) => s + (slots[sz2.idx] ?? 0) * sz2.price, 0);
                                  const totalPanSrv   = activeSizes.reduce((s, sz2) => s + (slots[sz2.idx] ?? 0) * sz2.servings, 0);
                                  return (
                                    <div className="space-y-2">
                                      {activeSizes.map(s => {
                                        const slotQty = slots[s.idx] ?? 0;
                                        return (
                                          <div key={s.idx} className="flex flex-wrap items-center justify-between gap-3 p-3 bg-secondary/50 rounded-xl border border-border/60">
                                            <div>
                                              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{s.label}</p>
                                              <p className="text-xs text-muted-foreground">
                                                {formatCurrency(s.price)}/pan · ~{s.servings} srv
                                                {slotQty > 0 && ` · ${slotQty * s.servings} srv total`}
                                              </p>
                                            </div>
                                            <CountStepper
                                              value={slotQty}
                                              onChange={v => setPanQtys(p => ({ ...p, [item.id]: { ...(p[item.id] ?? {}), [s.idx]: v } }))}
                                              hint="pan"
                                              defaultVal={1}
                                              min={0}
                                            />
                                          </div>
                                        );
                                      })}
                                      {totalPanPrice > 0 && (
                                        <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
                                          <span>{totalPanSrv} servings total</span>
                                          <span className="font-bold text-foreground">{formatCurrency(totalPanPrice)}</span>
                                        </div>
                                      )}
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
                                    onClick={async () => {
                                      const isPanSizes = (item.menuItem as any).pricingTemplate === "pan_sizes";
                                      if (isPanSizes) {
                                        const slots = panQtys[item.id] ?? {};
                                        const entries = Object.entries(slots).filter(([, q]) => q > 0);
                                        if (entries.length === 0) {
                                          toast({ title: "Select quantities", description: "Choose at least one pan size before adding to cart.", variant: "destructive" });
                                          return;
                                        }
                                        for (const [idxStr, qty] of entries) {
                                          const idx = Number(idxStr);
                                          const lbl = (item.menuItem as any)[`size${idx}Label`];
                                          const prc = parseFloat(String((item.menuItem as any)[`size${idx}Price`]));
                                          await fetch("/api/cart", {
                                            method: "POST",
                                            headers: { "Content-Type": "application/json" },
                                            body: JSON.stringify({ sessionId, menuItemId: item.menuItemId, quantity: qty, sizeSlot: idx, sizeLabel: lbl, sizePrice: prc }),
                                          });
                                        }
                                        queryClient.invalidateQueries({ queryKey: getGetCartQueryKey({ sessionId }) });
                                        removePlanItem(item.id);
                                        toast({ title: "Moved to Cart", description: "Item is now in your order." });
                                      } else {
                                        addToCart.mutate({ data: { sessionId, menuItemId: item.menuItemId, quantity: item.menuItem.minimumOrderQty ?? 1 } });
                                      }
                                    }}
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
              const total = plan.items.reduce((s, i) => {
                if ((i.menuItem as any).pricingTemplate === "pan_sizes") {
                  const slots = panQtys[i.id] ?? {};
                  let panTotal = 0;
                  for (let idx = 1; idx <= 5; idx++) {
                    const prc = (i.menuItem as any)[`size${idx}Price`];
                    if (prc != null) panTotal += (slots[idx] ?? 0) * parseFloat(String(prc));
                  }
                  return s + panTotal;
                }
                const minQ = i.menuItem.minimumOrderQty ?? 1;
                const qty = isSmallBite(i.menuItem.category) ? Math.max(minQ, piecesMap[i.id] ?? 0)
                          : isEntree(i.menuItem.category)    ? Math.max(minQ, servingsMap[i.id] ?? 0)
                          : 1;
                return s + qty * parseFloat(String(i.menuItem.price));
              }, 0);
              return (
                <div className="sticky bottom-4 z-20">
                  <div className="bg-foreground text-background rounded-2xl shadow-xl px-5 py-4 flex items-center justify-between gap-4">
                    <div>
                      <p className="font-display font-bold text-base leading-tight">
                        {plan.items.length} item{plan.items.length !== 1 ? "s" : ""} ready to order
                      </p>
                      <p className="text-sm opacity-70">{formatCurrency(total)} estimated · {TAX_DISCLOSURE_SHORT}</p>
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
