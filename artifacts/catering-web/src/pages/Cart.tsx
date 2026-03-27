import { useState, useMemo } from "react";
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
import { Minus, Plus, Trash2, ArrowRight, CheckCircle2, Phone, ShieldCheck, Loader2, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ── Category constants (mirrors Plan.tsx) ────────────────────────────────────
const CAT_ORDER = [
  "Small Bites - Savory",
  "Small Bites - Sweet",
  "Entrées - Meat",
  "Entrées - Seafood",
  "Entrées - Noodles & Rice",
];

const CAT_LABELS: Record<string, { label: string; sub?: string }> = {
  "Small Bites - Savory": { label: "Small Bites", sub: "Savory" },
  "Small Bites - Sweet":  { label: "Small Bites", sub: "Sweet"  },
  "Entrées - Meat":       { label: "Entrées",      sub: "Meat"  },
  "Entrées - Seafood":    { label: "Entrées",      sub: "Seafood" },
  "Entrées - Noodles & Rice": { label: "Entrées",  sub: "Noodles & Rice" },
};

const checkoutSchema = z.object({
  customerName: z.string().min(2, "Name is required"),
  customerEmail: z.string().email("Valid email is required"),
  customerPhone: z.string().min(10, "Phone number is required"),
  eventDate: z.string().optional(),
  eventType: z.string().optional(),
  guestCount: z.coerce.number().min(1, "At least 1 guest required").optional(),
  serviceStyle: z.string().optional(),
  deliveryNotes: z.string().optional()
});

type CheckoutForm = z.infer<typeof checkoutSchema>;

// Phone verification states
type VerifyState = "idle" | "sending" | "awaiting_code" | "verifying" | "verified";

export default function Cart() {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const sessionId = getSessionId();
  const queryClient = useQueryClient();

  // Phone verification
  const [verifyState, setVerifyState]   = useState<VerifyState>("idle");
  const [verifiedPhone, setVerifiedPhone] = useState<string>("");
  const [otp, setOtp]                   = useState("");
  const [otpError, setOtpError]         = useState("");

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

  const { register, handleSubmit, watch, formState: { errors } } = useForm<CheckoutForm>({
    resolver: zodResolver(checkoutSchema)
  });

  const phoneValue = watch("customerPhone") ?? "";

  const handleSendCode = async () => {
    const phone = phoneValue.trim();
    if (!phone || phone.replace(/\D/g, "").length < 10) {
      toast({ title: "Invalid phone number", description: "Please enter a valid 10-digit US phone number.", variant: "destructive" });
      return;
    }
    setVerifyState("sending");
    setOtp("");
    setOtpError("");
    try {
      const res = await fetch(`${API_BASE}/api/verify/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error ?? "Failed to send code");
      }
      setVerifyState("awaiting_code");
      toast({ title: "Code sent!", description: "Check your phone for a 6-digit verification code." });
    } catch (err: any) {
      setVerifyState("idle");
      toast({ title: "Couldn't send code", description: err.message, variant: "destructive" });
    }
  };

  const handleVerifyCode = async () => {
    if (otp.trim().length !== 6) { setOtpError("Enter the 6-digit code"); return; }
    setVerifyState("verifying");
    setOtpError("");
    try {
      const res = await fetch(`${API_BASE}/api/verify/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phoneValue.trim(), code: otp.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error ?? "Incorrect code");
      }
      setVerifiedPhone(phoneValue.trim());
      setVerifyState("verified");
      toast({ title: "Phone verified!", description: "Your number has been confirmed." });
    } catch (err: any) {
      setVerifyState("awaiting_code");
      setOtpError(err.message);
    }
  };

  const onSubmit = (data: CheckoutForm) => {
    if (!cart?.items.length) {
      toast({ title: "Cart empty", description: "Add items before checking out.", variant: "destructive" });
      return;
    }
    if (verifyState !== "verified") {
      toast({ title: "Phone not verified", description: "Please verify your phone number before placing an order.", variant: "destructive" });
      return;
    }
    createOrder.mutate({ data: { sessionId, ...data } });
  };

  const isEmpty = !cart?.items.length;

  // Group cart items by category in canonical order
  const groupedItems = useMemo(() => {
    if (!cart?.items.length) return [];
    const map = new Map<string, typeof cart.items>();
    CAT_ORDER.forEach(cat => map.set(cat, []));
    for (const item of cart.items) {
      const cat = (item.menuItem as any).category ?? "Other";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(item);
    }
    return [...map.entries()].filter(([, items]) => items.length > 0);
  }, [cart?.items]);

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
            {/* Cart Items — categorized */}
            <div className="lg:col-span-7 space-y-10">
              {groupedItems.map(([cat, items]) => {
                const catInfo = CAT_LABELS[cat] ?? { label: cat };
                const catSubtotal = items.reduce((s, i) => {
                  const ep: number = (i as any).effectivePrice ?? i.menuItem.price;
                  return s + ep * i.quantity;
                }, 0);

                return (
                  <div key={cat}>
                    {/* Category header */}
                    <div className="flex items-center justify-between mb-4 pb-2 border-b border-border">
                      <div className="flex items-baseline gap-2">
                        <h2 className="font-display font-bold text-xl">{catInfo.label}</h2>
                        {catInfo.sub && (
                          <span className="text-sm font-semibold text-muted-foreground">{catInfo.sub}</span>
                        )}
                      </div>
                      <span className="text-sm font-semibold text-muted-foreground">{formatCurrency(catSubtotal)}</span>
                    </div>

                    {/* Items in this category */}
                    <div className="space-y-4">
                      {items.map(item => {
                        const anyItem = item as any;
                        const sizeLabel: string | null = anyItem.sizeLabel ?? null;
                        const sizePrice: number | null = anyItem.sizePrice != null ? parseFloat(String(anyItem.sizePrice)) : null;
                        const effectivePrice: number = sizePrice ?? anyItem.effectivePrice ?? item.menuItem.price;
                        const basePrice: number = item.menuItem.price;
                        const minQty: number = anyItem.menuItem?.minimumOrderQty ?? (item.menuItem as any).minimumOrderQty ?? 1;
                        const hasSavings = sizePrice == null && effectivePrice < basePrice;
                        const tierLabel = sizePrice == null ? (() => {
                          const mi = item.menuItem as any;
                          if (mi.tier3Qty && mi.tier3Price && item.quantity >= mi.tier3Qty) return "Tier 3 price";
                          if (mi.tier2Qty && mi.tier2Price && item.quantity >= mi.tier2Qty) return "Tier 2 price";
                          return null;
                        })() : null;

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
                                  <h4 className="font-bold text-lg">
                                    {item.menuItem.name}
                                    {sizeLabel && (
                                      <span className="ml-2 text-sm font-normal text-muted-foreground">— {sizeLabel}</span>
                                    )}
                                  </h4>
                                  <div className="flex items-center gap-2 mt-0.5">
                                    <p className="text-sm text-muted-foreground">
                                      {formatCurrency(effectivePrice)} / {sizeLabel ? sizeLabel : item.menuItem.unit}
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

                  {/* ── Phone + SMS Verification ── */}
                  <div>
                    <label className="block text-sm font-semibold mb-1">
                      Phone <span className="text-destructive">*</span>
                    </label>

                    {verifyState === "verified" ? (
                      <div className="flex items-center gap-3 px-4 py-2.5 bg-emerald-50 border border-emerald-200 rounded-xl">
                        <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0" />
                        <span className="text-sm font-semibold text-emerald-700">Verified: {verifiedPhone}</span>
                        <button
                          type="button"
                          onClick={() => { setVerifyState("idle"); setOtp(""); setOtpError(""); setVerifiedPhone(""); }}
                          className="ml-auto text-xs text-emerald-600 hover:underline"
                        >
                          Change
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="flex gap-2">
                          <input
                            {...register("customerPhone")}
                            type="tel"
                            placeholder="(555) 000-0000"
                            disabled={verifyState === "awaiting_code" || verifyState === "sending" || verifyState === "verifying"}
                            className="flex-1 px-4 py-2.5 bg-background border border-border rounded-xl focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all disabled:opacity-60"
                          />
                          <button
                            type="button"
                            onClick={verifyState === "awaiting_code" ? handleSendCode : handleSendCode}
                            disabled={verifyState === "sending" || verifyState === "verifying"}
                            className="shrink-0 flex items-center gap-1.5 px-3 py-2.5 bg-foreground text-background text-sm font-semibold rounded-xl hover:bg-primary transition-colors disabled:opacity-60"
                          >
                            {verifyState === "sending" ? (
                              <><Loader2 className="w-4 h-4 animate-spin" /> Sending…</>
                            ) : verifyState === "awaiting_code" ? (
                              <><RefreshCw className="w-4 h-4" /> Resend</>
                            ) : (
                              <><Phone className="w-4 h-4" /> Send Code</>
                            )}
                          </button>
                        </div>
                        {errors.customerPhone && <p className="text-destructive text-xs mt-1">{errors.customerPhone.message}</p>}

                        {/* OTP entry */}
                        {(verifyState === "awaiting_code" || verifyState === "verifying") && (
                          <div className="mt-3 p-4 bg-secondary/50 border border-border rounded-xl space-y-3">
                            <p className="text-sm text-muted-foreground">Enter the 6-digit code sent to your phone:</p>
                            <div className="flex gap-2">
                              <input
                                type="text"
                                inputMode="numeric"
                                maxLength={6}
                                value={otp}
                                onChange={e => { setOtp(e.target.value.replace(/\D/g, "").slice(0, 6)); setOtpError(""); }}
                                placeholder="000000"
                                className="flex-1 px-4 py-2.5 bg-background border border-border rounded-xl text-center font-mono text-lg tracking-widest focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all"
                              />
                              <button
                                type="button"
                                onClick={handleVerifyCode}
                                disabled={verifyState === "verifying" || otp.length < 6}
                                className="shrink-0 flex items-center gap-1.5 px-4 py-2.5 bg-foreground text-background text-sm font-semibold rounded-xl hover:bg-primary transition-colors disabled:opacity-60"
                              >
                                {verifyState === "verifying"
                                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Verifying…</>
                                  : <><ShieldCheck className="w-4 h-4" /> Verify</>}
                              </button>
                            </div>
                            {otpError && <p className="text-destructive text-xs">{otpError}</p>}
                          </div>
                        )}
                      </>
                    )}
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
                      disabled={createOrder.isPending || verifyState !== "verified"}
                      className="w-full py-4 bg-primary text-primary-foreground font-bold rounded-xl hover:bg-primary/90 hover:-translate-y-0.5 transition-all shadow-lg shadow-primary/25 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:translate-y-0 disabled:shadow-none"
                    >
                      {createOrder.isPending ? "Submitting…" : "Submit Catering Inquiry"}
                      {!createOrder.isPending && <ArrowRight className="w-5 h-5" />}
                    </button>
                    {verifyState !== "verified" && (
                      <p className="text-center text-xs text-amber-600 font-medium mt-3">
                        Verify your phone number above to place your order.
                      </p>
                    )}
                    <p className="text-center text-xs text-muted-foreground mt-2">
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
