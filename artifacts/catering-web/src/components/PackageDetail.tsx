import { useEffect, useMemo, useState } from "react";
import { X as XIcon, Users, AlertTriangle, ShoppingBag, Heart, Loader2, ImageIcon } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  fetchPublicPackage,
  fetchCurrentItemCount,
  loadPackageIntoCart,
  loadPackageIntoPlanner,
  type PublicMenuPackage,
  type LoadMode,
} from "@/lib/menuPackages";
import { sizeLabel as sizeLabelOf, sizePrice as sizePriceOf } from "@/lib/sizeSlotHelpers";
import { MergeReplaceDialog, type MergeReplaceChoice } from "@/components/MergeReplaceDialog";
import { useCategories, buildPlannerGroupMap } from "@/lib/categories";
import { getSessionId } from "@/lib/session";
import { formatCurrency } from "@/lib/utils";
import { getGetCartQueryKey, getGetPlanQueryKey } from "@workspace/api-client-react";

type Props = {
  packageId: number;
  onClose: () => void;
};

export function PackageDetail({ packageId, onClose }: Props) {
  const [pkg, setPkg] = useState<PublicMenuPackage | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<"cart" | "plan" | null>(null);
  const [pendingExisting, setPendingExisting] = useState(0);
  const sessionId = getSessionId();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const { data: categoryRows } = useCategories({ includeHidden: true });
  const groupMap = buildPlannerGroupMap(categoryRows);
  const groupOf = (cat: string) => groupMap.get(cat) ?? "other";

  useEffect(() => {
    setLoading(true);
    fetchPublicPackage(packageId)
      .then((p) => setPkg(p))
      .catch(() => toast({ title: "Couldn't load package", variant: "destructive" }))
      .finally(() => setLoading(false));
  }, [packageId, toast]);

  // Per-item subtotal: pan-size items use the size price; everything
  // else uses the unit price. Total is the sum.
  const breakdown = useMemo(() => {
    if (!pkg) return { rows: [] as { id: number; unitPrice: number; subtotal: number }[], total: 0 };
    let total = 0;
    const rows = pkg.items.map((it) => {
      let unitPrice = it.menuItem.price;
      if (it.sizeKey != null && it.sizeKey >= 1 && it.sizeKey <= 5) {
        const slot = it.sizeKey as 1 | 2 | 3 | 4 | 5;
        const sp = sizePriceOf(it.menuItem, slot);
        if (sp != null) unitPrice = sp;
      }
      const subtotal = unitPrice * it.quantity;
      total += subtotal;
      return { id: it.id, unitPrice, subtotal };
    });
    return { rows, total };
  }, [pkg]);

  const performLoad = async (target: "cart" | "plan", mode: LoadMode) => {
    if (!pkg) return;
    setBusy(true);
    try {
      if (target === "cart") {
        await loadPackageIntoCart(pkg, sessionId, mode);
        qc.invalidateQueries({ queryKey: getGetCartQueryKey({ sessionId }) });
        toast({ title: "Added to cart", description: `${pkg.name} loaded into your order.` });
        setPendingTarget(null);
        onClose();
        navigate("/cart");
      } else {
        await loadPackageIntoPlanner(pkg, sessionId, mode, groupOf);
        qc.invalidateQueries({ queryKey: getGetPlanQueryKey({ sessionId }) });
        toast({ title: "Saved to plan", description: `${pkg.name} loaded into your event plan.` });
        setPendingTarget(null);
        onClose();
        navigate("/plan");
      }
    } catch {
      toast({ title: "Something went wrong", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const handleClick = async (target: "cart" | "plan") => {
    if (busy) return;
    setBusy(true);
    // Always re-fetch the current cart/plan count on click so we
    // never silently merge into a populated cart/plan whose state
    // hasn't loaded yet.
    const count = await fetchCurrentItemCount(target, sessionId);
    setBusy(false);
    if (count > 0) {
      setPendingExisting(count);
      setPendingTarget(target);
    } else {
      performLoad(target, "merge");
    }
  };

  const handleChoice = (choice: MergeReplaceChoice) => {
    if (!pendingTarget) return;
    if (choice === "cancel") { setPendingTarget(null); return; }
    performLoad(pendingTarget, choice);
  };

  return (
    <div className="fixed inset-0 z-[110] bg-black/60 sm:flex sm:items-center sm:justify-center sm:p-4 overflow-auto">
      <div className="bg-card sm:rounded-3xl shadow-2xl sm:max-w-3xl w-full sm:my-8 relative min-h-screen sm:min-h-0">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-10 w-10 h-10 rounded-full bg-card border border-border flex items-center justify-center hover:bg-secondary shadow-md"
          aria-label="Close"
        >
          <XIcon className="w-5 h-5" />
        </button>

        {loading ? (
          <div className="p-16 flex justify-center">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : !pkg ? (
          <div className="p-12 text-center text-muted-foreground">Package not found.</div>
        ) : (
          <>
            {pkg.imageUrl && (
              <img
                src={pkg.imageUrl}
                alt={pkg.name}
                className="w-full h-56 sm:h-64 object-cover sm:rounded-t-3xl"
              />
            )}
            <div className="p-6 sm:p-8">
              <div className="flex flex-wrap items-baseline gap-3 mb-2">
                <h2 className="font-display font-bold text-3xl">{pkg.name}</h2>
                <span className="inline-flex items-center gap-1 text-sm text-muted-foreground bg-secondary px-3 py-1 rounded-full">
                  <Users className="w-4 h-4" /> Serves about {pkg.servesGuests}
                </span>
              </div>
              {pkg.description && (
                <p className="text-muted-foreground mb-6 whitespace-pre-line">{pkg.description}</p>
              )}

              {pkg.partiallyAvailable && (
                <div className="mb-4 flex items-start gap-2 text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-sm">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>Some items in this package aren't currently available — only the available ones will load.</span>
                </div>
              )}

              <div className="bg-secondary/40 rounded-2xl p-4 mb-6">
                <h3 className="font-bold text-sm uppercase tracking-wider text-muted-foreground mb-3">What's included</h3>
                {pkg.items.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">No available items in this package right now.</p>
                ) : (
                  <>
                    <ul className="divide-y divide-border/50">
                      {pkg.items.map((it, idx) => {
                        const slot = it.sizeKey != null && it.sizeKey >= 1 && it.sizeKey <= 5
                          ? (it.sizeKey as 1 | 2 | 3 | 4 | 5)
                          : null;
                        const sizeLbl = slot ? sizeLabelOf(it.menuItem, slot) : null;
                        const row = breakdown.rows[idx];
                        return (
                          <li key={it.id} className="flex items-center gap-3 py-2">
                            {it.menuItem.imageUrl ? (
                              <img
                                src={it.menuItem.imageUrl}
                                alt=""
                                className="w-12 h-12 rounded-lg object-cover bg-background shrink-0"
                                loading="lazy"
                              />
                            ) : (
                              <div className="w-12 h-12 rounded-lg bg-background flex items-center justify-center shrink-0">
                                <ImageIcon className="w-5 h-5 text-muted-foreground/60" />
                              </div>
                            )}
                            <div className="flex-1 min-w-0">
                              <div className="font-semibold text-sm truncate">{it.menuItem.name}</div>
                              {sizeLbl && (
                                <div className="text-xs text-muted-foreground truncate">{sizeLbl}</div>
                              )}
                            </div>
                            <div className="text-right shrink-0 text-sm">
                              <div className="text-muted-foreground tabular-nums">× {it.quantity}</div>
                              {row && (
                                <div className="font-semibold tabular-nums">{formatCurrency(row.subtotal)}</div>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                    <div className="mt-3 pt-3 border-t border-border flex justify-between items-baseline">
                      <span className="font-bold">Package total</span>
                      <span className="font-bold text-lg tabular-nums">{formatCurrency(breakdown.total)}</span>
                    </div>
                  </>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  onClick={() => handleClick("plan")}
                  disabled={busy || pkg.items.length === 0}
                  className="px-5 py-3 rounded-xl bg-secondary text-foreground font-semibold hover:bg-secondary/80 disabled:opacity-60 transition-colors flex items-center justify-center gap-2"
                >
                  <Heart className="w-4 h-4" /> Load into Event Planner
                </button>
                <button
                  onClick={() => handleClick("cart")}
                  disabled={busy || pkg.items.length === 0}
                  className="px-5 py-3 rounded-xl bg-primary text-primary-foreground font-semibold hover:bg-primary/90 disabled:opacity-60 transition-colors flex items-center justify-center gap-2"
                >
                  <ShoppingBag className="w-4 h-4" /> Add to Cart
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      <MergeReplaceDialog
        open={pendingTarget !== null}
        busy={busy}
        existingCount={pendingExisting}
        incomingCount={pkg?.items.length ?? 0}
        title={pendingTarget === "cart" ? "Cart already has items" : "Plan already has items"}
        message={
          pendingTarget === "cart"
            ? "Do you want to add this package to your existing cart, or replace what's there?"
            : "Do you want to add this package to your existing event plan, or replace what's there?"
        }
        onChoose={handleChoice}
      />
    </div>
  );
}
