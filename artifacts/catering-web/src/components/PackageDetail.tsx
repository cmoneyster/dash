import { useEffect, useState } from "react";
import { X as XIcon, Users, AlertTriangle, ShoppingBag, Heart, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  fetchPublicPackage,
  loadPackageIntoCart,
  loadPackageIntoPlanner,
  type PublicMenuPackage,
  type LoadMode,
} from "@/lib/menuPackages";
import { MergeReplaceDialog, type MergeReplaceChoice } from "@/components/MergeReplaceDialog";
import { useCategories, buildPlannerGroupMap } from "@/lib/categories";
import { getSessionId } from "@/lib/session";
import { getGetCartQueryKey, getGetPlanQueryKey, useGetCart, useGetPlan } from "@workspace/api-client-react";

type Props = {
  packageId: number;
  onClose: () => void;
};

export function PackageDetail({ packageId, onClose }: Props) {
  const [pkg, setPkg] = useState<PublicMenuPackage | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<"cart" | "plan" | null>(null);
  const sessionId = getSessionId();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const { data: cart } = useGetCart({ sessionId });
  const { data: plan } = useGetPlan({ sessionId });
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

  const cartHasItems = (cart?.items?.length ?? 0) > 0;
  const planHasItems = (plan?.items?.length ?? 0) > 0;

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

  const handleClick = (target: "cart" | "plan") => {
    const hasExisting = target === "cart" ? cartHasItems : planHasItems;
    if (hasExisting) setPendingTarget(target);
    else performLoad(target, "merge");
  };

  const handleChoice = (choice: MergeReplaceChoice) => {
    if (!pendingTarget) return;
    if (choice === "cancel") { setPendingTarget(null); return; }
    performLoad(pendingTarget, choice);
  };

  return (
    <div className="fixed inset-0 z-[110] bg-black/60 flex items-center justify-center p-4 overflow-auto">
      <div className="bg-card rounded-3xl shadow-2xl max-w-3xl w-full my-8 relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-10 w-10 h-10 rounded-full bg-card border border-border flex items-center justify-center hover:bg-secondary"
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
                className="w-full h-64 object-cover rounded-t-3xl"
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
                  <ul className="space-y-2">
                    {pkg.items.map((it) => {
                      const sizeLbl = it.sizeKey != null
                        ? (it.menuItem as any)[`size${it.sizeKey}Label`]
                        : null;
                      return (
                        <li key={it.id} className="flex justify-between items-baseline gap-3 text-sm">
                          <span>
                            <span className="font-semibold">{it.menuItem.name}</span>
                            {sizeLbl && <span className="text-muted-foreground"> — {sizeLbl}</span>}
                          </span>
                          <span className="text-muted-foreground tabular-nums shrink-0">× {it.quantity}</span>
                        </li>
                      );
                    })}
                  </ul>
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
