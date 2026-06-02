import { useState, useEffect, useRef } from "react";
import { Link, useLocation } from "wouter";
import { ShoppingBag, Minus, Plus, Phone, Sparkles, ArrowLeft, PlayCircle } from "lucide-react";
import { ImageLightbox } from "@/components/ImageLightbox";
import { useCategories } from "@/lib/categories";
import { useDemoTour } from "@/lib/demoTour";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type DemoMenuItem = {
  id: number;
  name: string;
  description: string;
  category: string;
  price: number;
  servingSize: number;
  unit: string;
  imageUrl: string | null;
};

type DemoOrderResponse = {
  id: number;
  guestName: string;
  phoneNumber: string;
  items: { itemId: number; name: string; quantity: number; price: number }[];
  trackingUrl: string;
  smsSent: boolean;
};

function DemoBanner({ onReplayTour }: { onReplayTour: () => void }) {
  return (
    <div className="sticky top-0 z-40 bg-amber-500 text-amber-950 border-b-2 border-amber-700">
      <div className="max-w-2xl mx-auto px-4 py-2.5 flex items-center justify-between gap-3 text-sm">
        <div className="flex items-center gap-2 font-semibold min-w-0">
          <Sparkles className="w-4 h-4 flex-shrink-0" />
          <span className="truncate">DEMO MODE — nothing is being charged or fulfilled.</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-950/10 hover:bg-amber-950/20 text-xs font-semibold transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Back to site
          </Link>
          <button
            onClick={onReplayTour}
            aria-label="Show tour"
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-950/10 hover:bg-amber-950/20 text-xs font-semibold transition-colors"
          >
            <PlayCircle className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Show tour</span>
            <span className="sm:hidden">Tour</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DemoOrder() {
  const [, setLocation] = useLocation();
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [menu, setMenu] = useState<DemoMenuItem[] | null>(null);
  const [quantities, setQuantities] = useState<Record<number, number>>({});
  const [guestName, setGuestName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [expandedDescs, setExpandedDescs] = useState<Set<number>>(new Set());
  const { data: categoriesData } = useCategories();

  const categoriesRef = useRef<HTMLHeadingElement | null>(null);
  const itemCardRef = useRef<HTMLButtonElement | null>(null);
  const cartRef = useRef<HTMLDivElement | null>(null);
  const formRef = useRef<HTMLDivElement | null>(null);
  const submitBtnRef = useRef<HTMLButtonElement | null>(null);

  const { run, replay } = useDemoTour({
    categoriesRef,
    itemCardRef,
    cartRef,
    formRef,
    submitBtnRef,
  });

  useEffect(() => {
    fetch(`${BASE}/api/demo/menu`)
      .then((r) => r.json())
      .then((data: DemoMenuItem[]) => {
        setMenu(data);
        const init: Record<number, number> = {};
        data.forEach((item) => { init[item.id] = 0; });
        setQuantities(init);
      })
      .catch(() => setMenu([]));
  }, []);

  useEffect(() => {
    if (!menu || menu.length === 0) return;
    const t = setTimeout(() => run({ phase: "shopping", auto: true }), 400);
    return () => clearTimeout(t);
  }, [menu, run]);

  function setQty(id: number, qty: number) {
    setQuantities((prev) => ({ ...prev, [id]: Math.max(0, qty) }));
  }

  const orderItems = menu?.filter((m) => quantities[m.id] > 0).map((m) => ({
    itemId: m.id,
    name: m.name,
    quantity: quantities[m.id],
  })) ?? [];

  const totalQty = orderItems.reduce((s, i) => s + i.quantity, 0);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!guestName.trim() || !phoneNumber.trim() || orderItems.length === 0) return;
    setSubmitting(true);
    setSubmitErr(null);
    try {
      const res = await fetch(`${BASE}/api/demo/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guestName: guestName.trim(),
          phoneNumber: phoneNumber.trim(),
          items: orderItems.map((i) => ({ itemId: i.itemId, quantity: i.quantity })),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setSubmitErr(data.error ?? "Could not place demo order. Please try again.");
        return;
      }
      const data = (await res.json()) as DemoOrderResponse;
      setLocation(`/demo/order/${data.id}`);
    } catch {
      setSubmitErr("Connection error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const presentCats = menu ? new Set(menu.map((i) => i.category)) : new Set<string>();
  const orderedFromApi = (categoriesData ?? []).filter((c) => presentCats.has(c.name)).map((c) => c.name);
  const categories = orderedFromApi.length > 0
    ? [...orderedFromApi, ...Array.from(presentCats).filter((c) => !orderedFromApi.includes(c))]
    : Array.from(presentCats);

  return (
    <div className="min-h-screen bg-background">
      <DemoBanner onReplayTour={replay} />
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}

      <header className="sticky top-[44px] z-30 bg-card/80 backdrop-blur-md border-b border-border">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="font-display font-bold text-xl">Demo Ordering</h1>
            <p className="text-xs text-muted-foreground">dash by Hollywood East Cafe</p>
          </div>
          {orderItems.length > 0 && (
            <div ref={cartRef} className="flex items-center gap-2 bg-primary/10 text-primary px-3 py-1.5 rounded-full text-sm font-bold">
              <ShoppingBag className="w-4 h-4" />
              {totalQty} item{totalQty !== 1 ? "s" : ""} selected
            </div>
          )}
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-4 py-6">
        {!menu ? (
          <div className="text-center py-20 text-muted-foreground animate-pulse">Loading menu…</div>
        ) : menu.length === 0 ? (
          <div className="text-center py-20 text-muted-foreground">
            The demo menu hasn't been set up yet.
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-8">
            <div>
              {categories.map((cat, catIdx) => (
                <div key={cat} className={catIdx > 0 ? "mt-8" : ""}>
                  <h2
                    ref={catIdx === 0 ? categoriesRef : undefined}
                    className="font-display font-bold text-lg mb-3 pb-2 border-b border-border inline-block"
                  >
                    {cat}
                  </h2>
                  <div className="space-y-3">
                    {menu.filter((i) => i.category === cat).map((item, itemIdx) => {
                      const qty = quantities[item.id] ?? 0;
                      const isFirstItem = catIdx === 0 && itemIdx === 0;
                      return (
                        <div
                          key={item.id}
                          className="flex gap-4 items-center bg-card border border-border rounded-2xl p-4"
                        >
                          {item.imageUrl && (
                            <img
                              src={item.imageUrl}
                              alt={item.name}
                              onClick={() => setLightboxSrc(item.imageUrl!)}
                              className="w-16 h-16 rounded-xl object-cover shrink-0 cursor-zoom-in hover:opacity-90 transition-opacity"
                            />
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="font-bold text-sm">{item.name}</p>
                            {item.description && (
                              <>
                                <p className={`text-xs text-muted-foreground ${expandedDescs.has(item.id) ? "" : "line-clamp-2"}`}>{item.description}</p>
                                {item.description.length > 80 && (
                                  <button
                                    type="button"
                                    onClick={e => { e.stopPropagation(); setExpandedDescs(prev => { const next = new Set(prev); next.has(item.id) ? next.delete(item.id) : next.add(item.id); return next; }); }}
                                    className="text-xs text-primary font-semibold mt-0.5 hover:underline"
                                  >
                                    {expandedDescs.has(item.id) ? "Less" : "More"}
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              onClick={() => setQty(item.id, qty - 1)}
                              disabled={!qty}
                              className="w-8 h-8 flex items-center justify-center rounded-full bg-secondary hover:bg-border transition-colors disabled:opacity-30"
                            >
                              <Minus className="w-4 h-4" />
                            </button>
                            <span className="w-6 text-center font-bold text-sm">{qty}</span>
                            <button
                              ref={isFirstItem ? itemCardRef : undefined}
                              type="button"
                              onClick={() => setQty(item.id, qty + 1)}
                              className="w-8 h-8 flex items-center justify-center rounded-full bg-foreground text-background hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-30"
                            >
                              <Plus className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <div ref={formRef} className="bg-card border border-border rounded-2xl p-6 space-y-4">
              <h2 className="font-display font-bold text-lg">Your Details</h2>
              <div>
                <label className="block text-sm font-semibold mb-1">Your Name <span className="text-destructive">*</span></label>
                <input
                  value={guestName}
                  onChange={(e) => setGuestName(e.target.value)}
                  placeholder="e.g. Jane Smith"
                  required
                  autoComplete="name"
                  className="w-full px-4 py-2.5 border border-border rounded-xl bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold mb-1">
                  <span className="flex items-center gap-1.5">
                    <Phone className="w-3.5 h-3.5" />
                    Phone Number <span className="text-destructive">*</span>
                  </span>
                </label>
                <input
                  type="tel"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  placeholder="e.g. (301) 555-0123"
                  required
                  autoComplete="tel"
                  className="w-full px-4 py-2.5 border border-border rounded-xl bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all"
                />
                <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                  By submitting, you agree to receive one demo text with a sample tracking link. No ads, no spam — that's it.
                </p>
              </div>

              {orderItems.length > 0 && (
                <div className="border-t border-border pt-4 space-y-2">
                  <p className="text-sm font-semibold text-muted-foreground">Order Summary</p>
                  {orderItems.map((i) => (
                    <div key={i.itemId} className="text-sm">
                      {i.quantity}× {i.name}
                    </div>
                  ))}
                </div>
              )}

              {submitErr && (
                <div className="px-3 py-2 rounded-xl bg-red-50 text-red-700 text-sm">{submitErr}</div>
              )}

              <button
                ref={submitBtnRef}
                type="submit"
                disabled={submitting || !orderItems.length || !guestName.trim() || !phoneNumber.trim()}
                className="w-full py-3.5 bg-foreground text-background font-bold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {submitting
                  ? "Placing Order…"
                  : orderItems.length ? "Place Order" : "Select items to order"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
