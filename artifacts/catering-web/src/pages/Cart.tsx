import { useState, useMemo, useEffect, useRef } from "react";
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
import { computeEffectivePriceDetail } from "@workspace/pricing";
import { formatCurrency } from "@/lib/utils";
import { TAX_DISCLOSURE } from "@/lib/tax";
import { parseDateLocal } from "@/lib/date";
import { useCategories, splitCategoryName } from "@/lib/categories";
import { Minus, Plus, Trash2, ArrowRight, CheckCircle2, Phone, ShieldCheck, Loader2, RefreshCw, CalendarDays, Clock, X as XIcon, Truck, Flame, AlertTriangle } from "lucide-react";
import {
  SERVICE_MODE_KEY,
  type ServiceMode,
  loadServiceMode,
  saveServiceMode,
  computeOtdSetupFee,
  type OtdConfig,
} from "@/lib/serviceMode";
import { useToast } from "@/hooks/use-toast";
import { VenueAutocomplete } from "@/components/VenueAutocomplete";
import { DayPicker } from "react-day-picker";
import "react-day-picker/dist/style.css";
import { format } from "date-fns";

type BlackoutDate = { id: number; date: string; reason: string | null };

function DatePickerField({
  value,
  onChange,
  blackoutDates,
}: {
  value: string;
  onChange: (val: string) => void;
  blackoutDates: BlackoutDate[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  const blockedDates = blackoutDates.map(b => parseDateLocal(b.date));
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const selected = value ? parseDateLocal(value) : undefined;

  const displayValue = value
    ? parseDateLocal(value).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })
    : "";

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(p => !p)}
        className="w-full flex items-center gap-2 px-4 py-2.5 bg-background border border-border rounded-xl focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all text-left text-sm"
      >
        <CalendarDays className="w-4 h-4 text-muted-foreground shrink-0" />
        {displayValue
          ? <span className="flex-1 truncate">{displayValue}</span>
          : <span className="flex-1 text-muted-foreground">Select a date…</span>
        }
        {value && (
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onChange(""); }}
            className="text-muted-foreground hover:text-foreground"
          >
            <XIcon className="w-3.5 h-3.5" />
          </button>
        )}
      </button>

      {open && (
        <div className="absolute top-full left-0 z-50 mt-1 bg-card border border-border rounded-2xl shadow-2xl p-3">
          <DayPicker
            mode="single"
            selected={selected}
            onSelect={day => {
              if (!day) return;
              onChange(format(day, "yyyy-MM-dd"));
              setOpen(false);
            }}
            disabled={[
              { before: today },
              ...blockedDates,
            ]}
            modifiers={{ blocked: blockedDates }}
            modifiersStyles={{
              blocked: {
                color: "hsl(var(--destructive))",
                textDecoration: "line-through",
                fontWeight: "700",
              },
            }}
            defaultMonth={selected ?? today}
          />
          <p className="text-xs text-muted-foreground text-center px-2 pb-1">
            <span className="text-destructive font-bold">Red</span> dates are unavailable.
          </p>
        </div>
      )}
    </div>
  );
}

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const checkoutSchema = z.object({
  customerName: z.string().min(2, "Name is required"),
  customerEmail: z.string().email("Valid email is required"),
  customerPhone: z.string().min(10, "Phone number is required"),
  eventDate: z.string().optional(),
  eventType: z.string().optional(),
  guestCount: z.coerce.number().min(1, "At least 1 guest required").optional(),
  // Legacy free-text "service style" is kept in the schema for back-compat
  // but no longer surfaced in the UI — it's overwritten on submit with a
  // human label derived from the structured `serviceMode` toggle.
  serviceStyle: z.string().optional(),
  venueAddress: z.string().optional(),
  deliveryNotes: z.string().optional(),
  eventTime: z.string().optional(),
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

  // Blackout dates for the event date picker
  const [blackoutDates, setBlackoutDates] = useState<BlackoutDate[]>([]);
  useEffect(() => {
    fetch(`${API_BASE}/api/blackout-dates`)
      .then(r => r.ok ? r.json() : [])
      .then(setBlackoutDates)
      .catch(() => {});
  }, []);
  // TODO(delivery-time): Once the delivery-time picker task is merged, fetch
  // blocked time windows for the selected event date via
  //   GET /api/blackout-time-windows?date=<eventDate>
  // and pass the resulting windows to the delivery-time picker component so it
  // can grey out or skip those slots. Full-day blackout dates (above) already
  // prevent the entire day from being selected, so time windows only need to be
  // applied when a date is selected but not fully blocked.

  // Phone verification
  const [verifyState, setVerifyState]   = useState<VerifyState>("idle");
  const [verifiedPhone, setVerifiedPhone] = useState<string>("");
  const [otp, setOtp]                   = useState("");
  const [otpError, setOtpError]         = useState("");

  const [clearConfirm, setClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);

  // ── Service mode (Drop-Off vs On the Dash Experience) ────────────────────
  // Persisted in localStorage so the choice survives navigation between
  // Menu / Plan / Cart. The structured value is sent to the server on
  // submit; the legacy `serviceStyle` text field keeps a human label so
  // existing admin views render without code changes.
  const [serviceMode, setServiceMode] = useState<ServiceMode>(() => loadServiceMode());
  useEffect(() => { saveServiceMode(serviceMode); }, [serviceMode]);

  // Live OTD pricing config — admins can edit per event in
  // /admin/event-settings. Falls back to the schema defaults so the
  // checkout still works on a fresh database.
  const [otdConfig, setOtdConfig] = useState<OtdConfig>({
    setupFee: 500,
    feeWaiverThreshold: 2000,
    includedHours: 2,
    additionalHourRate: 100,
    maxAdditionalHours: 3,
  });
  useEffect(() => {
    fetch(`${API_BASE}/api/event-settings/otd-config`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setOtdConfig(d); })
      .catch(() => {});
  }, []);

  const { data: cart, isLoading: cartLoading } = useGetCart({ sessionId });
  
  const handleClearCart = async () => {
    setClearing(true);
    try {
      await fetch(`${API_BASE}/api/cart`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      queryClient.invalidateQueries({ queryKey: getGetCartQueryKey({ sessionId }) });
      setClearConfirm(false);
      toast({ title: "Cart cleared", description: "All items have been removed." });
    } catch {
      toast({ title: "Error", description: "Could not clear cart. Please try again.", variant: "destructive" });
    } finally {
      setClearing(false);
    }
  };

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

  const { register, handleSubmit, watch, setValue, formState: { errors } } = useForm<CheckoutForm>({
    resolver: zodResolver(checkoutSchema)
  });

  const phoneValue = watch("customerPhone") ?? "";
  const eventDateValue = watch("eventDate") ?? "";
  const venueAddressValue = watch("venueAddress") ?? "";

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

  // Items in the cart that are NOT eligible for the on-site food trailer.
  // Used to render the warning banner on the OTD toggle and to block
  // submission until the customer either switches modes or removes them.
  const ineligibleItems = useMemo(() => {
    if (!cart?.items.length) return [] as { id: number; name: string }[];
    return cart.items
      .filter(i => !i.menuItem.otdEligible)
      .map(i => ({ id: i.id, name: i.menuItem.name }));
  }, [cart?.items]);
  const hasIneligible = ineligibleItems.length > 0;
  const otdBlocked = serviceMode === "on_the_dash" && hasIneligible;

  // Live fee preview — mirrors orders.ts on the server. When the cart
  // subtotal hits the waiver threshold the setup fee disappears.
  const subtotal = cart?.total ?? 0;
  const otdSetupFee = serviceMode === "on_the_dash" ? computeOtdSetupFee(subtotal, otdConfig) : 0;
  const previewedTotal = subtotal + otdSetupFee;
  const isWaiverApplied = serviceMode === "on_the_dash" && subtotal >= otdConfig.feeWaiverThreshold;

  const onSubmit = (data: CheckoutForm) => {
    if (!cart?.items.length) {
      toast({ title: "Cart empty", description: "Add items before checking out.", variant: "destructive" });
      return;
    }
    if (verifyState !== "verified") {
      toast({ title: "Phone not verified", description: "Please verify your phone number before placing an order.", variant: "destructive" });
      return;
    }
    if (otdBlocked) {
      toast({
        title: "Some items aren't On the Dash–eligible",
        description: "Switch to Standard Drop-Off or remove the flagged items below before submitting.",
        variant: "destructive",
      });
      return;
    }
    // Stamp the legacy free-text serviceStyle field with a derived label
    // so admin views that key off it keep displaying something sensible.
    const styleLabel = serviceMode === "on_the_dash" ? "On the Dash Experience" : "Standard Drop-Off";
    createOrder.mutate({
      data: {
        sessionId,
        ...data,
        venueAddress: data.venueAddress?.trim() || null,
        serviceStyle: styleLabel,
        serviceMode,
      },
    });
  };

  const isEmpty = !cart?.items.length;

  // Categories drive both the header label/subtitle split and the row order on
  // the cart. Including hidden categories means an item whose category was
  // hidden after it was added still groups under its real header rather than
  // collapsing into the "Other" fallback bucket. Loading is folded into the
  // page-level spinner so the rows never render in the wrong order.
  const { data: categoryRows, isLoading: categoriesLoading } = useCategories({ includeHidden: true });
  const isLoading = cartLoading || categoriesLoading;

  // Group cart items by category in the order returned by the API, pan sizes
  // sorted by slot index. Items whose category is no longer in the API list
  // (deleted, etc.) appear at the end in insertion order.
  const groupedItems = useMemo(() => {
    if (!cart?.items.length) return [];
    const known = new Set((categoryRows ?? []).map(c => c.name));
    const map = new Map<string, typeof cart.items>();
    (categoryRows ?? []).forEach(c => map.set(c.name, []));
    const otherBucket: typeof cart.items = [];
    for (const item of cart.items) {
      const rawCat = (item.menuItem as any).category ?? "";
      if (rawCat && known.has(rawCat)) {
        map.get(rawCat)!.push(item);
      } else {
        otherBucket.push(item);
      }
    }
    const ordered: [string, typeof cart.items][] = [...map.entries()]
      .filter(([, items]) => items.length > 0)
      .map(([cat, items]) => [
        cat,
        [...items].sort((a, b) => {
          if (a.menuItemId !== b.menuItemId) return a.menuItemId - b.menuItemId;
          const sa = (a as any).sizeSlot ?? Infinity;
          const sb = (b as any).sizeSlot ?? Infinity;
          return sa - sb;
        }),
      ]);
    if (otherBucket.length > 0) {
      ordered.push([
        "Other",
        [...otherBucket].sort((a, b) => {
          if (a.menuItemId !== b.menuItemId) return a.menuItemId - b.menuItemId;
          const sa = (a as any).sizeSlot ?? Infinity;
          const sb = (b as any).sizeSlot ?? Infinity;
          return sa - sb;
        }),
      ]);
    }
    return ordered;
  }, [cart?.items, categoryRows]);

  return (
    <Layout>
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-20">
        <div className="flex items-center justify-between gap-4 mb-10">
          <h1 className="font-display font-bold text-2xl sm:text-4xl">Review Your Order</h1>
          {!isEmpty && !isLoading && (
            clearConfirm ? (
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-sm text-muted-foreground">Clear all items?</span>
                <button
                  onClick={handleClearCart}
                  disabled={clearing}
                  className="px-3 py-1.5 text-sm font-semibold bg-destructive text-white rounded-lg hover:bg-destructive/90 transition-colors disabled:opacity-60 flex items-center gap-1.5"
                >
                  {clearing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                  Yes, clear
                </button>
                <button
                  onClick={() => setClearConfirm(false)}
                  className="px-3 py-1.5 text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setClearConfirm(true)}
                className="shrink-0 text-sm font-semibold text-muted-foreground hover:text-destructive transition-colors flex items-center gap-1.5"
              >
                <Trash2 className="w-4 h-4" /> Clear cart
              </button>
            )
          )}
        </div>

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
                const catInfo = splitCategoryName(cat);
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
                        // Tier label inference is routed through the shared
                        // pricing helper so the badge can never claim a tier
                        // the server didn't actually apply (see lib/pricing).
                        const tierLabel = sizePrice == null ? (() => {
                          const mi = item.menuItem as any;
                          const { tier } = computeEffectivePriceDetail(mi, item.quantity, null);
                          if (tier === "tier3") return "Tier 3 price";
                          if (tier === "tier2") return "Tier 2 price";
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
                      <DatePickerField
                        value={eventDateValue}
                        onChange={val => setValue("eventDate", val)}
                        blackoutDates={blackoutDates}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold mb-1">Guests</label>
                      <input {...register("guestCount")} type="number" className="w-full px-4 py-2.5 bg-background border border-border rounded-xl focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all" />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-semibold mb-1 flex items-center gap-1.5">
                      <Clock className="w-4 h-4 text-muted-foreground" />
                      Delivery Time
                      <span className="text-muted-foreground font-normal">(optional)</span>
                    </label>
                    <input
                      type="time"
                      {...register("eventTime")}
                      className="w-full px-4 py-2.5 bg-background border border-border rounded-xl focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all"
                    />
                    <p className="text-xs text-muted-foreground mt-1">We'll arrive within a 30-minute window of this time.</p>
                  </div>

                  <div>
                    <label className="block text-sm font-semibold mb-1">Event Location</label>
                    <VenueAutocomplete
                      value={venueAddressValue}
                      onChange={(val) => setValue("venueAddress", val)}
                      placeholder="Search a venue or type an address…"
                      className="relative"
                    />
                  </div>

                  {/* Service Mode toggle — replaces the legacy free-text dropdown */}
                  <div>
                    <label className="block text-sm font-semibold mb-2">How should we serve your event?</label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <button
                        type="button"
                        onClick={() => setServiceMode("drop_off")}
                        aria-pressed={serviceMode === "drop_off"}
                        className={`flex items-start gap-3 p-4 rounded-xl border-2 text-left transition-all ${
                          serviceMode === "drop_off"
                            ? "border-primary bg-primary/5"
                            : "border-border bg-background hover:border-primary/40"
                        }`}
                      >
                        <Truck className={`w-5 h-5 shrink-0 mt-0.5 ${serviceMode === "drop_off" ? "text-primary" : "text-muted-foreground"}`} />
                        <div>
                          <div className="font-bold text-sm">Standard Drop-Off</div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            We deliver everything ready-to-serve at your scheduled time.
                          </div>
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => setServiceMode("on_the_dash")}
                        aria-pressed={serviceMode === "on_the_dash"}
                        className={`flex items-start gap-3 p-4 rounded-xl border-2 text-left transition-all ${
                          serviceMode === "on_the_dash"
                            ? "border-orange-600 bg-orange-50"
                            : "border-border bg-background hover:border-orange-400"
                        }`}
                      >
                        <Flame className={`w-5 h-5 shrink-0 mt-0.5 ${serviceMode === "on_the_dash" ? "text-orange-600" : "text-muted-foreground"}`} />
                        <div>
                          <div className="font-bold text-sm flex items-center gap-1.5">
                            On the Dash Experience
                            <span className="text-[10px] uppercase tracking-wider bg-orange-600 text-white px-1.5 py-0.5 rounded-full">New</span>
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            Our food trailer rolls up and cooks fresh on-site for your guests.
                          </div>
                        </div>
                      </button>
                    </div>

                    {/* OTD explainer + fee preview */}
                    {serviceMode === "on_the_dash" && (
                      <div className="mt-3 p-4 rounded-xl border border-orange-200 bg-orange-50/50 space-y-2">
                        <div className="flex justify-between items-baseline text-sm">
                          <span className="font-semibold text-orange-900 flex items-center gap-1">
                            <Flame className="w-3.5 h-3.5 shrink-0" />
                            <span>On the Dash</span>
                            <span className="font-normal"> on-site setup fee</span>
                          </span>
                          {isWaiverApplied ? (
                            <span className="flex items-baseline gap-2">
                              <span className="text-muted-foreground line-through text-xs">{formatCurrency(otdConfig.setupFee)}</span>
                              <span className="font-bold text-emerald-600">Waived</span>
                            </span>
                          ) : (
                            <span className="font-bold text-orange-900">{formatCurrency(otdConfig.setupFee)}</span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Includes {otdConfig.includedHours} {otdConfig.includedHours === 1 ? "hour" : "hours"} of on-site service.
                          Additional hours are {formatCurrency(otdConfig.additionalHourRate)}/hr (up to {otdConfig.maxAdditionalHours} extra),
                          billed by our team after the event.
                        </p>
                        {!isWaiverApplied && otdConfig.feeWaiverThreshold > 0 && (
                          <p className="text-xs text-orange-700">
                            Add {formatCurrency(Math.max(0, otdConfig.feeWaiverThreshold - subtotal))} more to your order to waive the setup fee
                            (waived at {formatCurrency(otdConfig.feeWaiverThreshold)}+).
                          </p>
                        )}
                        {isWaiverApplied && (
                          <p className="text-xs text-emerald-700">
                            Setup fee waived because your order is over {formatCurrency(otdConfig.feeWaiverThreshold)}.
                          </p>
                        )}
                      </div>
                    )}

                    {/* Ineligibility warning (shown only when OTD selected and cart contains drop-off-only items) */}
                    {serviceMode === "on_the_dash" && hasIneligible && (
                      <div className="mt-3 p-4 rounded-xl border border-destructive/40 bg-destructive/5 space-y-3">
                        <div className="flex items-start gap-2 text-sm font-semibold text-destructive">
                          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                          <span>These items aren't On the Dash–eligible and can't be cooked on-site:</span>
                        </div>
                        <ul className="space-y-1.5">
                          {ineligibleItems.map(it => (
                            <li key={it.id} className="flex items-center justify-between gap-3 px-3 py-2 bg-white dark:bg-destructive/10 rounded-lg border border-destructive/20">
                              <span className="text-sm font-medium text-destructive/90 truncate">{it.name}</span>
                              <button
                                type="button"
                                onClick={() => removeItem.mutate({ itemId: it.id })}
                                disabled={removeItem.isPending}
                                className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-destructive border border-destructive/40 rounded-lg hover:bg-destructive hover:text-white disabled:opacity-50 transition-colors"
                                title="Remove this item from your order"
                              >
                                <Trash2 className="w-3 h-3" />
                                Remove
                              </button>
                            </li>
                          ))}
                        </ul>
                        <div className="flex flex-col sm:flex-row gap-2 pt-1">
                          <button
                            type="button"
                            onClick={() => setServiceMode("drop_off")}
                            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground text-sm font-semibold rounded-xl hover:bg-primary/90 transition-colors"
                          >
                            <Truck className="w-4 h-4" />
                            Switch to Standard Drop-Off
                          </button>
                          <p className="flex-1 text-xs text-muted-foreground self-center sm:px-2">
                            …or remove the flagged items above to keep On the Dash.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="block text-sm font-semibold mb-1">Notes</label>
                    <textarea {...register("deliveryNotes")} rows={3} className="w-full px-4 py-2.5 bg-background border border-border rounded-xl focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all resize-none" placeholder="Dietary requirements, special instructions, etc." />
                  </div>

                  <div className="pt-6 border-t border-border mt-6">
                    {/* Fee breakdown — only shows the OTD line when relevant. */}
                    <div className="space-y-1.5 mb-4">
                      <div className="flex justify-between items-center text-sm text-muted-foreground">
                        <span>Food subtotal</span>
                        <span>{formatCurrency(subtotal)}</span>
                      </div>
                      {serviceMode === "on_the_dash" && (
                        <div className="flex justify-between items-center text-sm text-muted-foreground">
                          <span>On the Dash on-site setup fee</span>
                          <span>{otdSetupFee === 0 ? "Waived" : formatCurrency(otdSetupFee)}</span>
                        </div>
                      )}
                    </div>
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-lg font-semibold text-muted-foreground">Estimated Total</span>
                      <span className="font-display font-bold text-3xl text-foreground">{formatCurrency(previewedTotal)}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mb-6">{TAX_DISCLOSURE}</p>

                    <button
                      type="submit"
                      disabled={createOrder.isPending || verifyState !== "verified" || otdBlocked}
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
                    {otdBlocked && verifyState === "verified" && (
                      <p className="text-center text-xs text-destructive font-medium mt-3">
                        Resolve the On the Dash item warnings above to submit.
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
