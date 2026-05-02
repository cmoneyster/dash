import { useState, useEffect, useRef } from "react";
import { Link } from "wouter";
import { ShoppingBag, CheckCircle2, Minus, Plus, Utensils, Phone, ExternalLink, Sparkles, ArrowLeft, PlayCircle, MessageSquare } from "lucide-react";
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

// Sticky amber DEMO banner that sits above the EventOrder-shaped header.
// Keeps the "Back to site" link and the "Show tour" replay button so the
// tour is always reachable, regardless of localStorage state.
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
            className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-950/10 hover:bg-amber-950/20 text-xs font-semibold transition-colors"
          >
            <PlayCircle className="w-3.5 h-3.5" /> Show tour
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DemoOrder() {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [menu, setMenu] = useState<DemoMenuItem[] | null>(null);
  const [quantities, setQuantities] = useState<Record<number, number>>({});
  const [guestName, setGuestName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [result, setResult] = useState<DemoOrderResponse | null>(null);
  const { data: categoriesData } = useCategories();

  // Tour anchors. categoriesRef wraps the first category section so the
  // spotlight covers the heading; itemCardRef points at the first item
  // row's quantity controls; cartRef anchors the header cart-count pill.
  const categoriesRef = useRef<HTMLDivElement | null>(null);
  const itemCardRef = useRef<HTMLDivElement | null>(null);
  const cartRef = useRef<HTMLDivElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const submitBtnRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);

  const { run, replay } = useDemoTour({
    categoriesRef,
    itemCardRef,
    cartRef,
    formRef,
    submitBtnRef,
    confirmRef,
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

  // Kick off the auto-tour after the menu renders.
  useEffect(() => {
    if (!menu || menu.length === 0) return;
    const t = setTimeout(() => run({ phase: "shopping", auto: true }), 400);
    return () => clearTimeout(t);
  }, [menu, run]);

  // After submit, advance the tour to the confirmation step.
  useEffect(() => {
    if (!result) return;
    const t = setTimeout(() => run({ phase: "confirmation", auto: true }), 300);
    return () => clearTimeout(t);
  }, [result, run]);

  function setQty(id: number, qty: number) {
    setQuantities((prev) => ({ ...prev, [id]: Math.max(0, qty) }));
  }

  const orderItems = menu?.filter((m) => quantities[m.id] > 0).map((m) => ({
    itemId: m.id,
    name: m.name,
    quantity: quantities[m.id],
    price: m.price,
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
      setResult(data);
    } catch {
      setSubmitErr("Connection error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function placeAnother() {
    setResult(null);
    setGuestName("");
    setPhoneNumber("");
    if (menu) {
      const init: Record<number, number> = {};
      menu.forEach((item) => { init[item.id] = 0; });
      setQuantities(init);
    }
  }

  // ── Confirmation state ──────────────────────────────────────────────
  // Mirrors EventOrder's centered confirmation card so the demo's last
  // screen looks like the real guest experience. The demo-only bits
  // (sample tracking link, "this was a demo" copy) live inside the
  // same card layout.
  if (result) {
    return (
      <div className="min-h-screen bg-background">
        <DemoBanner onReplayTour={replay} />
        <div className="flex items-center justify-center p-4 pt-12">
          <div ref={confirmRef} className="text-center max-w-sm w-full">
            <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <CheckCircle2 className="w-10 h-10 text-emerald-600" />
            </div>
            <h2 className="font-display font-bold text-3xl mb-2">Order Received!</h2>
            <p className="text-muted-foreground mb-1">
              {result.smsSent
                ? `We just texted ${result.phoneNumber} a sample tracking link, exactly like a real guest would receive at your event.`
                : `Demo order recorded. We weren't able to send the sample text to ${result.phoneNumber} — your gateway may not be configured.`}
            </p>
            {result.smsSent && (
              <div className="flex items-center gap-2 justify-center text-muted-foreground text-sm mb-4 mt-2">
                <MessageSquare className="w-4 h-4" />
                <span>Check your phone — should arrive within seconds.</span>
              </div>
            )}

            <a
              href={result.trackingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-secondary text-foreground font-semibold rounded-xl hover:bg-border transition-colors text-sm mb-4 w-full justify-center"
            >
              <ExternalLink className="w-4 h-4" />
              Track Order #{result.id}
            </a>

            <button
              onClick={placeAnother}
              className="w-full px-6 py-3 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors"
            >
              Place Another Order
            </button>
          </div>
        </div>
      </div>
    );
  }

  // The /api/demo/menu endpoint already filters out hidden items by joining
  // through the live menu. Order categories the same way EventOrder does:
  // use the categories API ordering, then append any present-but-unlisted
  // categories at the end so nothing silently vanishes.
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
        {/* cartRef anchors the tour's "Review the order" spotlight. We
            attach it to the entire header row so the highlight is visible
            both before and after items are added (driver.js can't spotlight
            a zero-size element). */}
        <div ref={cartRef} className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 bg-foreground rounded-xl flex items-center justify-center flex-shrink-0">
              <Utensils className="w-5 h-5 text-background" />
            </div>
            <div className="min-w-0">
              <h1 className="font-display font-bold text-xl truncate">Demo Ordering</h1>
              <p className="text-xs text-muted-foreground">dash by Hollywood East Cafe</p>
            </div>
          </div>
          {orderItems.length > 0 && (
            <div className="flex items-center gap-2 bg-primary/10 text-primary px-3 py-1.5 rounded-full text-sm font-bold flex-shrink-0">
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
          <form ref={formRef} onSubmit={handleSubmit} className="space-y-8">
            <div ref={categoriesRef}>
              {categories.map((cat, catIdx) => (
                <div key={cat} className={catIdx > 0 ? "mt-8" : ""}>
                  <h2 className="font-display font-bold text-lg mb-3 pb-2 border-b border-border">{cat}</h2>
                  <div className="space-y-3">
                    {menu.filter((i) => i.category === cat).map((item, itemIdx) => {
                      const qty = quantities[item.id] ?? 0;
                      const isFirstItem = catIdx === 0 && itemIdx === 0;
                      return (
                        <div
                          key={item.id}
                          ref={isFirstItem ? itemCardRef : undefined}
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
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-bold text-sm">{item.name}</p>
                            </div>
                            {item.description && (
                              <p className="text-xs text-muted-foreground line-clamp-2">{item.description}</p>
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

            <div className="bg-card border border-border rounded-2xl p-6 space-y-4">
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
                  For demo purposes only — you will not receive ads or spam. We send one sample tracking text and that's it.
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
