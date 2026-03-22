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
import { Trash2, ShoppingBag, Heart } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";

export default function Plan() {
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
        // Auto remove from plan after moving to cart
        const planItem = plan?.items.find(i => i.menuItemId === variables.data.menuItemId);
        if (planItem) removeFromPlan.mutate({ itemId: planItem.id });
        toast({ title: "Moved to Cart", description: "Item is now in your order." });
      }
    }
  });

  const handleMoveToCart = (menuItemId: number) => {
    addToCart.mutate({ data: { sessionId, menuItemId, quantity: 1 } });
  };

  return (
    <Layout>
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
          <div className="space-y-4">
            {plan.items.map(item => (
              <div key={item.id} className="flex flex-col sm:flex-row gap-6 bg-card p-6 rounded-2xl border border-border shadow-sm group hover:border-primary/30 transition-colors">
                {item.menuItem.imageUrl && (
                  <img src={item.menuItem.imageUrl} alt="" className="w-full sm:w-32 h-32 rounded-xl object-cover shrink-0 bg-secondary" />
                )}
                <div className="flex-1 flex flex-col justify-between">
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1 block">{item.menuItem.category}</span>
                      <h4 className="font-display font-bold text-xl">{item.menuItem.name}</h4>
                    </div>
                    <span className="font-bold text-lg text-primary">{formatCurrency(item.menuItem.price)}</span>
                  </div>
                  
                  <p className="text-muted-foreground text-sm line-clamp-2 mb-4">{item.menuItem.description}</p>
                  
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
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}
