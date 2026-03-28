import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { MenuCard, MenuCardCompact } from "@/components/MenuCard";
import { PanSizePicker } from "@/components/PanSizePicker";
import { 
  useListMenuItems, 
  useAddToCart, 
  useAddToPlan, 
  useGetPlan,
  getGetCartQueryKey,
  getGetPlanQueryKey
} from "@workspace/api-client-react";
import { getSessionId } from "@/lib/session";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Search } from "lucide-react";
import type { MenuItem } from "@workspace/api-client-react";
import { isPanSizesItem, type PanSizeMenuItem } from "@/lib/menu-types";
import type { PanSizeSelection } from "@/components/PanSizePicker";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function Menu() {
  const [category, setCategory] = useState<string>("");
  const [pickerItem, setPickerItem] = useState<PanSizeMenuItem | null>(null);
  const [pickerLoading, setPickerLoading] = useState(false);
  const sessionId = getSessionId();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: menuItems, isLoading } = useListMenuItems({ category: category || undefined });
  const { data: plan } = useGetPlan({ sessionId });
  
  const addToCart = useAddToCart({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetCartQueryKey({ sessionId }) });
        toast({ title: "Added to cart", description: "Item has been added to your order." });
      }
    }
  });

  // Silent variant used for pan-size multi-add — we invalidate + toast once at the end
  const addToCartSilent = useAddToCart();

  const addToPlan = useAddToPlan({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetPlanQueryKey({ sessionId }) });
        toast({ title: "Saved to plan", description: "Item saved to your event plan." });
      }
    }
  });

  const planItemIds = new Set(plan?.items?.map(i => i.menuItemId) || []);

  const handleAddToCart = (item: MenuItem) => {
    if (isPanSizesItem(item)) {
      setPickerItem(item);
    } else {
      addToCart.mutate({ data: { sessionId, menuItemId: item.id, quantity: 1 } });
    }
  };

  const handlePanSizeConfirm = async (selections: PanSizeSelection[]) => {
    if (!pickerItem) return;
    setPickerLoading(true);
    try {
      await Promise.all(
        selections.map(s =>
          addToCartSilent.mutateAsync({
            data: {
              sessionId,
              menuItemId: pickerItem.id,
              quantity: s.qty,
              sizeSlot: s.slot,
              sizeLabel: s.label,
              sizePrice: s.price,
            },
          })
        )
      );
      queryClient.invalidateQueries({ queryKey: getGetCartQueryKey({ sessionId }) });
      const totalPans = selections.reduce((sum, s) => sum + s.qty, 0);
      toast({
        title: "Added to cart",
        description: `${totalPans} pan${totalPans !== 1 ? "s" : ""} added to your order.`,
      });
      setPickerItem(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Could not add to cart. Please try again.";
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setPickerLoading(false);
    }
  };

  const handleTogglePlan = async (item: MenuItem) => {
    if (planItemIds.has(item.id)) {
      const planItem = plan?.items.find(i => i.menuItemId === item.id);
      if (!planItem) return;
      try {
        await fetch(`/api/plan/${planItem.id}?sessionId=${encodeURIComponent(sessionId)}`, { method: "DELETE" });
        queryClient.invalidateQueries({ queryKey: getGetPlanQueryKey({ sessionId }) });
        toast({ title: "Removed from plan", description: "Item removed from your event plan." });
      } catch {
        toast({ title: "Error", description: "Could not remove item. Please try again.", variant: "destructive" });
      }
    } else {
      addToPlan.mutate({ data: { sessionId, menuItemId: item.id } });
    }
  };

  const categories = [
    { value: "", label: "All Items" },
    { value: "Small Bites - Savory", label: "Small Bites - Savory" },
    { value: "Small Bites - Sweet", label: "Small Bites - Sweet" },
    { value: "Entrées - Meat", label: "Entrées - Meat" },
    { value: "Entrées - Seafood", label: "Entrées - Seafood" },
    { value: "Entrées - Noodles & Rice", label: "Noodles & Rice" },
  ];

  return (
    <Layout>
      {pickerItem && (
        <PanSizePicker
          item={pickerItem}
          onClose={() => setPickerItem(null)}
          onConfirm={handlePanSizeConfirm}
          loading={pickerLoading}
        />
      )}
      <div className="bg-secondary/30 py-16 border-b border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h1 className="font-display font-bold text-5xl mb-4">Curated Offerings</h1>
          <p className="text-muted-foreground max-w-2xl mx-auto text-lg">
            Discover our seasonal selections, crafted with passion and precision. Build your perfect event menu or add favorites to your wishlist.
          </p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        {/* Filters */}
        <div className="flex flex-col sm:flex-row justify-between items-center mb-12 gap-6">
          <div className="flex flex-wrap gap-2 justify-center">
            {categories.map(c => (
              <button
                key={c.value}
                onClick={() => setCategory(c.value)}
                className={`px-5 py-2 rounded-full font-medium text-sm transition-all ${
                  category === c.value
                    ? "bg-primary text-primary-foreground shadow-md"
                    : "bg-white border border-border text-foreground hover:border-primary/50"
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-24">
            <Loader2 className="w-12 h-12 text-primary animate-spin" />
          </div>
        ) : menuItems?.length === 0 ? (
          <div className="text-center py-24 bg-card rounded-3xl border border-border border-dashed">
            <Search className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
            <h3 className="font-display font-bold text-2xl mb-2">No items found</h3>
            <p className="text-muted-foreground">Try selecting a different category.</p>
          </div>
        ) : (() => {
          const featured = menuItems?.filter(i => i.imageUrl) ?? [];
          const listed   = menuItems?.filter(i => !i.imageUrl) ?? [];
          const cardProps = (item: typeof featured[0]) => ({
            item,
            onAddToCart: handleAddToCart,
            onTogglePlan: handleTogglePlan,
            isInPlan: planItemIds.has(item.id),
          });
          return (
            <div className="space-y-10">
              {/* Featured — items with photos */}
              {featured.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                  {featured.map(item => <MenuCard key={item.id} {...cardProps(item)} />)}
                </div>
              )}

              {/* Compact list — items without photos */}
              {listed.length > 0 && (
                <div>
                  {featured.length > 0 && (
                    <div className="flex items-center gap-4 mb-6">
                      <div className="flex-1 h-px bg-border" />
                      <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground px-2">
                        More on the Menu
                      </span>
                      <div className="flex-1 h-px bg-border" />
                    </div>
                  )}
                  <div className="space-y-3">
                    {listed.map(item => <MenuCardCompact key={item.id} {...cardProps(item)} />)}
                  </div>
                </div>
              )}
            </div>
          );
        })()}
      </div>
    </Layout>
  );
}
