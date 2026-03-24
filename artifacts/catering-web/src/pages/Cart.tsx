import { useState } from "react";
import { useLocation } from "wouter";
import { ImageLightbox } from "@/components/ImageLightbox";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Layout } from "@/components/Layout";
import { 
  useGetCart, 
  useUpdateCartItem, 
  useRemoveFromCart, 
  useCreateOrder,
  getGetCartQueryKey
} from "@workspace/api-client-react";
import { getSessionId } from "@/lib/session";
import { formatCurrency } from "@/lib/utils";
import { Minus, Plus, Trash2, ArrowRight, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const checkoutSchema = z.object({
  customerName: z.string().min(2, "Name is required"),
  customerEmail: z.string().email("Valid email is required"),
  customerPhone: z.string().optional(),
  eventDate: z.string().optional(),
  eventType: z.string().optional(),
  guestCount: z.coerce.number().min(1, "At least 1 guest required").optional(),
  serviceStyle: z.string().optional(),
  deliveryNotes: z.string().optional()
});

type CheckoutForm = z.infer<typeof checkoutSchema>;

export default function Cart() {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const sessionId = getSessionId();
  const queryClient = useQueryClient();

  const { data: cart, isLoading } = useGetCart({ sessionId });
  
  const updateItem = useUpdateCartItem({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetCartQueryKey({ sessionId }) })
    }
  });

  const removeItem = useRemoveFromCart({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetCartQueryKey({ sessionId }) })
    }
  });

  const createOrder = useCreateOrder({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetCartQueryKey({ sessionId }) });
        setLocation("/confirmation");
      },
      onError: () => toast({ title: "Error", description: "Failed to place order.", variant: "destructive" })
    }
  });

  const { register, handleSubmit, formState: { errors } } = useForm<CheckoutForm>({
    resolver: zodResolver(checkoutSchema)
  });

  const onSubmit = (data: CheckoutForm) => {
    if (!cart?.items.length) {
      toast({ title: "Cart empty", description: "Add items before checking out.", variant: "destructive" });
      return;
    }
    createOrder.mutate({ data: { sessionId, ...data } });
  };

  const isEmpty = !cart?.items.length;

  return (
    <Layout>
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-20">
        <h1 className="font-display font-bold text-4xl mb-10">Review Your Order</h1>

        {isLoading ? (
          <div className="h-64 flex items-center justify-center text-muted-foreground animate-pulse">Loading cart...</div>
        ) : isEmpty ? (
          <div className="text-center py-24 bg-card rounded-3xl border border-border">
            <div className="w-20 h-20 bg-secondary rounded-full flex items-center justify-center mx-auto mb-6">
              <CheckCircle2 className="w-10 h-10 text-muted-foreground" />
            </div>
            <h3 className="font-display font-bold text-2xl mb-4">Your order is empty</h3>
            <button onClick={() => setLocation("/menu")} className="text-primary font-semibold hover:underline">
              Browse the menu to add items
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-12">
            {/* Cart Items */}
            <div className="lg:col-span-7 space-y-6">
              {cart.items.map(item => {
                const anyItem = item as any;
                const effectivePrice: number = anyItem.effectivePrice ?? item.menuItem.price;
                const basePrice: number = item.menuItem.price;
                const minQty: number = (item.menuItem as any).minimumOrderQty ?? 1;
                const hasSavings = effectivePrice < basePrice;
                const tierLabel = (() => {
                  const mi = item.menuItem as any;
                  if (mi.tier3Qty && mi.tier3Price && item.quantity >= mi.tier3Qty) return "Tier 3 price";
                  if (mi.tier2Qty && mi.tier2Price && item.quantity >= mi.tier2Qty) return "Tier 2 price";
                  return null;
                })();

                return (
                  <div key={item.id} className="flex gap-6 bg-card p-4 rounded-2xl border border-border shadow-sm">
                    {item.menuItem.imageUrl && (
                      <img
                        src={item.menuItem.imageUrl}
                        alt=""
                        onClick={() => setLightboxSrc(item.menuItem.imageUrl!)}
                        className="w-24 h-24 rounded-xl object-cover shrink-0 bg-secondary cursor-zoom-in hover:opacity-90 transition-opacity"
                      />
                    )}
                    <div className="flex-1 flex flex-col justify-between py-1">
                      <div className="flex justify-between items-start">
                        <div>
                          <h4 className="font-bold text-lg">{item.menuItem.name}</h4>
                          <div className="flex items-center gap-2 mt-0.5">
                            <p className="text-sm text-muted-foreground">
                              {formatCurrency(effectivePrice)} / {item.menuItem.unit}
                            </p>
                            {hasSavings && tierLabel && (
                              <span className="text-xs font-bold px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded-full">
                                {tierLabel}
                              </span>
                            )}
                          </div>
                          {minQty > 1 && (
                            <p className="text-xs text-amber-600 font-medium mt-0.5">Min. {minQty} {item.menuItem.unit}</p>
                          )}
                        </div>
                        <button
                          onClick={() => removeItem.mutate({ itemId: item.id })}
                          className="p-2 text-muted-foreground hover:text-destructive transition-colors rounded-full hover:bg-destructive/10"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>

                      <div className="flex items-center gap-4 mt-4">
                        <div className="flex items-center bg-secondary rounded-full p-1">
                          <button
                            onClick={() => updateItem.mutate({ itemId: item.id, data: { sessionId, quantity: Math.max(minQty, item.quantity - 1) } })}
                            disabled={item.quantity <= minQty}
                            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          >
                            <Minus className="w-4 h-4" />
                          </button>
                          <span className="w-8 text-center font-semibold text-sm">{item.quantity}</span>
                          <button
                            onClick={() => updateItem.mutate({ itemId: item.id, data: { sessionId, quantity: item.quantity + 1 } })}
                            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-white transition-colors"
                          >
                            <Plus className="w-4 h-4" />
                          </button>
                        </div>
                        <div className="ml-auto text-right">
                          <div className="font-bold text-lg">{formatCurrency(effectivePrice * item.quantity)}</div>
                          {hasSavings && (
                            <div className="text-xs text-emerald-600 font-semibold">
                              Save {formatCurrency((basePrice - effectivePrice) * item.quantity)}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Checkout Form */}
            <div className="lg:col-span-5">
              <div className="bg-card border border-border rounded-3xl p-8 shadow-xl shadow-black/5 sticky top-28">
                <h3 className="font-display font-bold text-2xl mb-6">Event Details</h3>
                
                <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-semibold mb-1">Name <span className="text-destructive">*</span></label>
                      <input {...register("customerName")} className="w-full px-4 py-2.5 bg-background border border-border rounded-xl focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all" />
                      {errors.customerName && <p className="text-destructive text-xs mt-1">{errors.customerName.message}</p>}
                    </div>
                    <div>
                      <label className="block text-sm font-semibold mb-1">Email <span className="text-destructive">*</span></label>
                      <input {...register("customerEmail")} type="email" className="w-full px-4 py-2.5 bg-background border border-border rounded-xl focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all" />
                      {errors.customerEmail && <p className="text-destructive text-xs mt-1">{errors.customerEmail.message}</p>}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-semibold mb-1">Event Date</label>
                      <input {...register("eventDate")} type="date" className="w-full px-4 py-2.5 bg-background border border-border rounded-xl focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all" />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold mb-1">Guests</label>
                      <input {...register("guestCount")} type="number" className="w-full px-4 py-2.5 bg-background border border-border rounded-xl focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all" />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-semibold mb-1">Service Style</label>
                    <select {...register("serviceStyle")} className="w-full px-4 py-2.5 bg-background border border-border rounded-xl focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all">
                      <option value="">Select style...</option>
                      <option value="Buffet">Buffet</option>
                      <option value="Plated">Plated / Sit-down</option>
                      <option value="Drop-off">Drop-off</option>
                      <option value="Food Trailer">Food Trailer On-site</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-semibold mb-1">Notes</label>
                    <textarea {...register("deliveryNotes")} rows={3} className="w-full px-4 py-2.5 bg-background border border-border rounded-xl focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all resize-none" placeholder="Dietary requirements, delivery instructions..." />
                  </div>

                  <div className="pt-6 border-t border-border mt-6">
                    <div className="flex justify-between items-center mb-6">
                      <span className="text-lg font-semibold text-muted-foreground">Estimated Total</span>
                      <span className="font-display font-bold text-3xl text-foreground">{formatCurrency(cart.total)}</span>
                    </div>
                    
                    <button 
                      type="submit" 
                      disabled={createOrder.isPending}
                      className="w-full py-4 bg-primary text-primary-foreground font-bold rounded-xl hover:bg-primary/90 hover:-translate-y-0.5 transition-all shadow-lg shadow-primary/25 flex items-center justify-center gap-2"
                    >
                      {createOrder.isPending ? "Processing..." : "Place Order"}
                      {!createOrder.isPending && <ArrowRight className="w-5 h-5" />}
                    </button>
                    <p className="text-center text-xs text-muted-foreground mt-4">
                      No payment required yet. Our team will contact you to finalize details and deposit.
                    </p>
                  </div>
                </form>
              </div>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
