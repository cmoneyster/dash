import { useState, useMemo } from "react";
import { Layout } from "@/components/Layout";
import { 
  useGetPlan, 
  useRemoveFromPlan, 
  useAddToCart,
  getGetPlanQueryKey,
  getGetCartQueryKey
} from "@workspace/api-client-react";
import { getSessionId } from "@/lib/session";
import { useQueryClient } from "@tanstack/react-query";
import { formatCurrency } from "@/lib/utils";
import { Trash2, ShoppingBag, Heart, Users, Calculator, ChevronDown, ChevronUp } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import { ImageLightbox } from "@/components/ImageLightbox";

const SAVORY_CAT = "Small Bites - Savory";
const SWEET_CAT  = "Small Bites - Sweet";

function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}

function StatusBar({ need, have, label }: { need: number; have: number; label: string }) {
  const pct = need === 0 ? 100 : clamp((have / need) * 100, 0, 100);
  const over = have > need;
  const color = have >= need ? "bg-emerald-500" : pct >= 75 ? "bg-amber-400" : "bg-red-400";
  const textColor = have >= need ? "text-emerald-600" : pct >= 75 ? "text-amber-600" : "text-red-500";

  return (
    <div className="space-y-1.5">
      <div className="flex justify-between items-baseline text-sm">
        <span className="font-semibold text-foreground">{label}</span>
        <span className={`font-bold tabular-nums ${textColor}`}>
          {have} / {need} pcs
          {over && <span className="text-xs font-normal text-muted-foreground ml-1">(+{have - need} extra)</span>}
        </span>
      </div>
      <div className="h-2 bg-secondary rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {have >= need
          ? `You're covered${over ? " and then some" : ""}!`
          : `Need ${need - have} more piece${need - have !== 1 ? "s" : ""}`}
      </p>
    </div>
  );
}

function NumInput({
  label, value, onChange, min = 1, max = 999, step = 1, hint,
}: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; max?: number; step?: number; hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{label}</label>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => {
          const v = parseInt(e.target.value);
          if (!isNaN(v)) onChange(clamp(v, min, max));
        }}
        className="w-full px-3 py-2 text-center text-lg font-bold rounded-xl border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
      />
      {hint && <p className="text-xs text-muted-foreground text-center">{hint}</p>}
    </div>
  );
}

export default function Plan() {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const sessionId = getSessionId();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: plan, isLoading } = useGetPlan({ sessionId });

  const removeFromPlan = useRemoveFromPlan({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetPlanQueryKey({ sessionId }) })
    }
  });

  const addToCart = useAddToCart({
    mutation: {
      onSuccess: (_, variables) => {
        queryClient.invalidateQueries({ queryKey: getGetCartQueryKey({ sessionId }) });
        const planItem = plan?.items.find(i => i.menuItemId === variables.data.menuItemId);
        if (planItem) removeFromPlan.mutate({ itemId: planItem.id });
        toast({ title: "Moved to Cart", description: "Item is now in your order." });
      }
    }
  });

  const handleMoveToCart = (menuItemId: number) => {
    addToCart.mutate({ data: { sessionId, menuItemId, quantity: 1 } });
  };

  // --- Calculator state ---
  const [calcOpen, setCalcOpen] = useState(true);
  const [guests, setGuests]       = useState(20);
  const [savoryPPG, setSavoryPPG] = useState(3);
  const [sweetPPG, setSweetPPG]   = useState(2);
  // pieces per plan item (keyed by plan item id, local only)
  const [piecesMap, setPiecesMap] = useState<Record<number, number>>({});

  const smallBiteItems = useMemo(
    () => plan?.items.filter(i =>
      i.menuItem.category === SAVORY_CAT || i.menuItem.category === SWEET_CAT
    ) ?? [],
    [plan]
  );

  const hasSmallBites = smallBiteItems.length > 0;

  const needSavory = guests * savoryPPG;
  const needSweet  = guests * sweetPPG;
  const needTotal  = needSavory + needSweet;

  const haveSavory = useMemo(
    () => smallBiteItems
      .filter(i => i.menuItem.category === SAVORY_CAT)
      .reduce((sum, i) => sum + (piecesMap[i.id] ?? 0), 0),
    [smallBiteItems, piecesMap]
  );
  const haveSweet = useMemo(
    () => smallBiteItems
      .filter(i => i.menuItem.category === SWEET_CAT)
      .reduce((sum, i) => sum + (piecesMap[i.id] ?? 0), 0),
    [smallBiteItems, piecesMap]
  );
  const haveTotal = haveSavory + haveSweet;

  const setPieces = (itemId: number, val: number) =>
    setPiecesMap(prev => ({ ...prev, [itemId]: Math.max(0, val) }));

  return (
    <Layout>
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-20">
        <div className="flex items-center gap-4 mb-10">
          <div className="w-12 h-12 bg-primary/10 rounded-2xl flex items-center justify-center text-primary">
            <Heart className="w-6 h-6 fill-current" />
          </div>
          <h1 className="font-display font-bold text-4xl">Your Event Plan</h1>
        </div>

        {isLoading ? (
          <div className="h-64 flex items-center justify-center text-muted-foreground">Loading...</div>
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
          <div className="space-y-8">

            {/* ── Small Bites Calculator ── */}
            {hasSmallBites && (
              <div className="bg-card border border-border rounded-3xl overflow-hidden shadow-sm">
                <button
                  onClick={() => setCalcOpen(o => !o)}
                  className="w-full flex items-center justify-between px-6 py-4 hover:bg-secondary/40 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
                      <Calculator className="w-4 h-4 text-primary" />
                    </div>
                    <div className="text-left">
                      <p className="font-display font-bold text-base">Small Bites Planner</p>
                      <p className="text-xs text-muted-foreground">
                        {calcOpen
                          ? "Adjust guests & servings to calculate how many pieces you need"
                          : `${guests} guests · ${needTotal} pcs needed · ${haveTotal} pcs selected`}
                      </p>
                    </div>
                  </div>
                  {calcOpen ? (
                    <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                  )}
                </button>

                {calcOpen && (
                  <div className="px-6 pb-6 border-t border-border">
                    {/* Inputs row */}
                    <div className="grid grid-cols-3 gap-4 mt-5 mb-6">
                      <NumInput
                        label="Guests"
                        value={guests}
                        onChange={setGuests}
                        min={1}
                        max={500}
                        hint="# of people"
                      />
                      <NumInput
                        label="Savory pcs/person"
                        value={savoryPPG}
                        onChange={setSavoryPPG}
                        min={1}
                        max={20}
                        hint="recommended 3–4"
                      />
                      <NumInput
                        label="Sweet pcs/person"
                        value={sweetPPG}
                        onChange={setSweetPPG}
                        min={1}
                        max={20}
                        hint="recommended 2–3"
                      />
                    </div>

                    {/* Totals summary row */}
                    <div className="flex items-center justify-between gap-4 mb-5 p-3 bg-secondary/50 rounded-xl">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Users className="w-4 h-4" />
                        <span><span className="font-bold text-foreground">{guests}</span> guests</span>
                      </div>
                      <div className="text-sm text-muted-foreground text-right">
                        Total target:{" "}
                        <span className="font-bold text-foreground">
                          {needTotal} pcs
                        </span>
                        <span className="text-xs ml-1">({needSavory} savory + {needSweet} sweet)</span>
                      </div>
                    </div>

                    {/* Progress bars */}
                    <div className="grid sm:grid-cols-2 gap-5">
                      <StatusBar need={needSavory} have={haveSavory} label="Savory Small Bites" />
                      <StatusBar need={needSweet}  have={haveSweet}  label="Sweet Small Bites" />
                    </div>

                    <p className="text-xs text-muted-foreground mt-4 text-center">
                      Enter how many pieces each item provides below — the bars update automatically.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* ── Plan Items ── */}
            <div className="space-y-4">
              {plan.items.map(item => {
                const isSmallBite = item.menuItem.category === SAVORY_CAT || item.menuItem.category === SWEET_CAT;
                const pieces = piecesMap[item.id] ?? 0;

                return (
                  <div
                    key={item.id}
                    className={`flex flex-col sm:flex-row gap-6 bg-card p-6 rounded-2xl border shadow-sm group transition-colors ${
                      isSmallBite ? "border-primary/20 hover:border-primary/40" : "border-border hover:border-primary/30"
                    }`}
                  >
                    {item.menuItem.imageUrl && (
                      <img
                        src={item.menuItem.imageUrl}
                        alt=""
                        onClick={() => setLightboxSrc(item.menuItem.imageUrl!)}
                        className="w-full sm:w-32 h-32 rounded-xl object-cover shrink-0 bg-secondary cursor-zoom-in hover:opacity-90 transition-opacity"
                      />
                    )}
                    <div className="flex-1 flex flex-col justify-between">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <span className={`text-xs font-bold uppercase tracking-wider mb-1 block ${
                            isSmallBite ? "text-primary/70" : "text-muted-foreground"
                          }`}>{item.menuItem.category}</span>
                          <h4 className="font-display font-bold text-xl">{item.menuItem.name}</h4>
                        </div>
                        <span className="font-bold text-lg text-primary">{formatCurrency(item.menuItem.price)}</span>
                      </div>

                      <p className="text-muted-foreground text-sm line-clamp-2 mb-4">{item.menuItem.description}</p>

                      {/* Pieces input — Small Bites only */}
                      {isSmallBite && (
                        <div className="flex items-center gap-3 mb-4 p-3 bg-secondary/50 rounded-xl border border-border/60">
                          <div className="flex-1">
                            <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-0.5">
                              Pieces this item provides
                            </p>
                            <p className="text-xs text-muted-foreground">
                              How many individual pieces in your order of this item?
                            </p>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              onClick={() => setPieces(item.id, pieces - 1)}
                              disabled={pieces <= 0}
                              className="w-8 h-8 rounded-lg border border-border bg-background flex items-center justify-center font-bold text-lg hover:bg-secondary disabled:opacity-30 transition-colors"
                            >
                              −
                            </button>
                            <input
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              value={pieces === 0 ? "" : pieces}
                              placeholder="0"
                              onChange={e => {
                                const v = parseInt(e.target.value.replace(/[^0-9]/g, ""));
                                setPieces(item.id, isNaN(v) ? 0 : v);
                              }}
                              className="w-14 text-center font-bold text-base rounded-lg border border-border bg-background px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
                            />
                            <button
                              onClick={() => setPieces(item.id, pieces + 1)}
                              className="w-8 h-8 rounded-lg border border-border bg-background flex items-center justify-center font-bold text-lg hover:bg-secondary transition-colors"
                            >
                              +
                            </button>
                            <span className="text-xs text-muted-foreground ml-1">pcs</span>
                          </div>
                        </div>
                      )}

                      <div className="flex justify-between items-center mt-auto">
                        <button
                          onClick={() => removeFromPlan.mutate({ itemId: item.id })}
                          className="text-sm font-semibold text-muted-foreground hover:text-destructive transition-colors flex items-center gap-1.5"
                        >
                          <Trash2 className="w-4 h-4" /> Remove
                        </button>

                        <button
                          onClick={() => handleMoveToCart(item.menuItemId)}
                          className="px-5 py-2.5 bg-foreground text-background font-semibold rounded-xl hover:bg-primary transition-colors flex items-center gap-2"
                        >
                          <ShoppingBag className="w-4 h-4" /> Move to Cart
                        </button>
                      </div>
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
