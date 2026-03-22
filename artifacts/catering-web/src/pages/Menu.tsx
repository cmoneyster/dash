import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { MenuCard } from "@/components/MenuCard";
import { 
  useListMenuItems, 
  useAddToCart, 
  useAddToPlan, 
  useRemoveFromPlan, 
  useGetPlan,
  getGetCartQueryKey,
  getGetPlanQueryKey
} from "@workspace/api-client-react";
import { getSessionId } from "@/lib/session";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Search } from "lucide-react";
import type { MenuItem } from "@workspace/api-client-react";

export default function Menu() {
  const [category, setCategory] = useState<string>("");
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

  const addToPlan = useAddToPlan({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetPlanQueryKey({ sessionId }) });
        toast({ title: "Saved to plan", description: "Item saved to your event plan." });
      }
    }
  });

  const removeFromPlan = useRemoveFromPlan({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetPlanQueryKey({ sessionId }) });
      }
    }
  });

  const planItemIds = new Set(plan?.items?.map(i => i.menuItemId) || []);

  const handleAddToCart = (item: MenuItem) => {
    addToCart.mutate({ data: { sessionId, menuItemId: item.id, quantity: 1 } });
  };

  const handleTogglePlan = (item: MenuItem) => {
    if (planItemIds.has(item.id)) {
      const planItem = plan?.items.find(i => i.menuItemId === item.id);
      if (planItem) removeFromPlan.mutate({ itemId: planItem.id });
    } else {
      addToPlan.mutate({ data: { sessionId, menuItemId: item.id } });
    }
  };

  const categories = ["", "Appetizers", "Mains", "Sides", "Desserts", "Beverages"];

  return (
    <Layout>
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
                key={c}
                onClick={() => setCategory(c)}
                className={`px-5 py-2 rounded-full font-medium text-sm transition-all ${
                  category === c 
                    ? "bg-primary text-primary-foreground shadow-md" 
                    : "bg-white border border-border text-foreground hover:border-primary/50"
                }`}
              >
                {c || "All Items"}
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
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-8">
            {menuItems?.map(item => (
              <MenuCard 
                key={item.id} 
                item={item} 
                onAddToCart={handleAddToCart}
                onTogglePlan={handleTogglePlan}
                isInPlan={planItemIds.has(item.id)}
              />
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}
