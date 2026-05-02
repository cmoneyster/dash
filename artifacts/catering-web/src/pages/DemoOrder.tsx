import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { Minus, Plus, Phone, Utensils, ShoppingBag, CheckCircle2, ExternalLink, MessageSquare, Sparkles, ArrowLeft, PlayCircle } from "lucide-react";
import { useDemoTour } from "@/lib/demoTour";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type DemoMenuItem = {
  id: number;
  name: string;
  description: string;
  category: string;
  price: number;
  imageUrl: string | null;
  unit: string;
  servingSize: number;
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
    <div className="sticky top-0 z-30 bg-amber-500 text-amber-950 border-b-2 border-amber-700">
      <div className="max-w-5xl mx-auto px-4 py-2.5 flex items-center justify-between gap-3 text-sm">
        <div className="flex items-center gap-2 font-semibold">
          <Sparkles className="w-4 h-4 flex-shrink-0" />
          <span>DEMO MODE — nothing is being charged or fulfilled.</span>
        </div>
        <button
          onClick={onReplayTour}
          className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-950/10 hover:bg-amber-950/20 text-xs font-semibold transition-colors"
        >
          <PlayCircle className="w-3.5 h-3.5" /> Show tour
        </button>
      </div>
    </div>
  );
}

export default function DemoOrder() {
  const [menu, setMenu] = useState<DemoMenuItem[] | null>(null);
  const [quantities, setQuantities] = useState<Record<number, number>>({});
  const [guestName, setGuestName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [result, setResult] = useState<DemoOrderResponse | null>(null);

  const formRef = useRef<HTMLFormElement | null>(null);
  const itemCardRef = useRef<HTMLDivElement | null>(null);
  const cartRef = useRef<HTMLDivElement | null>(null);
  const submitBtnRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);
  const categoriesRef = useRef<HTMLDivElement | null>(null);

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
        data.forEach((m) => {
          init[m.id] = 0;
        });
        setQuantities(init);
      })
      .catch(() => setMenu([]));
  }, []);

  // Kick off the auto-tour after the menu is rendered.
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

  const grouped = useMemo(() => {
    if (!menu) return [];
    const map = new Map<string, DemoMenuItem[]>();
    for (const m of menu) {
      const arr = map.get(m.category) ?? [];
      arr.push(m);
      map.set(m.category, arr);
    }
    return Array.from(map.entries());
  }, [menu]);

  const orderItems = useMemo(
    () =>
      (menu ?? [])
        .filter((m) => (quantities[m.id] ?? 0) > 0)
        .map((m) => ({ itemId: m.id, name: m.name, quantity: quantities[m.id], price: m.price })),
    [menu, quantities],
  );

  function setQty(id: number, qty: number) {
    setQuantities((prev) => ({ ...prev, [id]: Math.max(0, qty) }));
  }

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

  if (result) {
    return (
      <div className="min-h-screen bg-background">
        <DemoBanner onReplayTour={replay} />
        <div className="max-w-2xl mx-auto px-4 py-12" ref={confirmRef} data-tour="confirmation">
          <div className="bg-card rounded-3xl border border-border p-8 text-center">
            <div className="w-16 h-16 rounded-2xl bg-emerald-100 text-emerald-700 flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="w-9 h-9" />
            </div>
            <h1 className="font-display font-bold text-3xl mb-2">Demo order placed!</h1>
            <p className="text-muted-foreground mb-6">
              {result.smsSent
                ? `We just texted ${result.phoneNumber} a sample tracking link, exactly like a real guest would receive at your event.`
                : `Demo order recorded. We weren't able to send the sample text to ${result.phoneNumber} — your gateway may not be configured.`}
            </p>
            {result.smsSent && (
              <div className="flex items-center gap-3 px-4 py-3 rounded-2xl bg-secondary text-left mb-6">
                <MessageSquare className="w-5 h-5 text-primary flex-shrink-0" />
                <p className="text-sm text-muted-foreground">
                  Check your phone — it should arrive within a few seconds.
                </p>
              </div>
            )}
            <div className="text-left mb-6">
              <p className="text-xs uppercase tracking-widest font-semibold text-muted-foreground mb-2">
                Sample tracking link
              </p>
              <a
                href={result.trackingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary font-medium break-all hover:underline inline-flex items-center gap-1.5"
              >
                {result.trackingUrl} <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
            <div className="flex flex-col sm:flex-row gap-3">
              <Link
                href="/"
                className="flex-1 px-5 py-3 bg-foreground text-background font-bold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors text-center"
              >
                Back to home
              </Link>
              <button
                onClick={() => {
                  setResult(null);
                  setGuestName("");
                  setPhoneNumber("");
                  if (menu) {
                    const init: Record<number, number> = {};
                    menu.forEach((m) => {
                      init[m.id] = 0;
                    });
                    setQuantities(init);
                  }
                }}
                className="flex-1 px-5 py-3 bg-card border border-border font-bold rounded-xl hover:border-primary/50 transition-colors"
              >
                Try another demo order
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <DemoBanner onReplayTour={replay} />

      <div className="max-w-5xl mx-auto px-4 py-8">
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6">
          <ArrowLeft className="w-4 h-4" /> Back to home
        </Link>

        <div className="text-center mb-8">
          <div className="w-14 h-14 bg-foreground rounded-2xl flex items-center justify-center mx-auto mb-3">
            <Utensils className="w-7 h-7 text-background" />
          </div>
          <h1 className="font-display font-bold text-3xl md:text-4xl">Guest Ordering Demo</h1>
          <p className="text-muted-foreground mt-2 max-w-xl mx-auto">
            This is exactly what your guests would see at an event with the on the dash experience. Add items, place
            a sample order, and we'll text you a real preview of the tracking link.
          </p>
        </div>

        {!menu && (
          <p className="text-center text-muted-foreground py-12">Loading demo menu…</p>
        )}
        {menu && menu.length === 0 && (
          <div className="bg-card rounded-2xl border border-border p-8 text-center">
            <p className="text-muted-foreground">
              The demo menu hasn't been set up yet. An admin needs to choose items in <code>/admin/demo-menu</code>.
            </p>
          </div>
        )}

        {menu && menu.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-8">
            <div ref={categoriesRef} data-tour="categories" className="space-y-10">
              {grouped.map(([category, list], catIdx) => (
                <section key={category}>
                  <h2 className="font-display font-bold text-2xl mb-4">{category}</h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {list.map((item, itemIdx) => {
                      const qty = quantities[item.id] ?? 0;
                      const isFirst = catIdx === 0 && itemIdx === 0;
                      return (
                        <div
                          key={item.id}
                          ref={isFirst ? itemCardRef : undefined}
                          data-tour={isFirst ? "item" : undefined}
                          className="bg-card border border-border rounded-2xl overflow-hidden flex flex-col"
                        >
                          {item.imageUrl && (
                            <div className="aspect-[4/3] bg-secondary">
                              <img src={item.imageUrl} alt={item.name} className="w-full h-full object-cover" />
                            </div>
                          )}
                          <div className="p-4 flex-1 flex flex-col">
                            <p className="font-bold">{item.name}</p>
                            {item.description && (
                              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{item.description}</p>
                            )}
                            <p className="text-sm font-semibold mt-2">${item.price.toFixed(2)}</p>
                            <div className="mt-3 flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => setQty(item.id, qty - 1)}
                                disabled={qty === 0}
                                aria-label="Remove one"
                                className="w-9 h-9 rounded-full border border-border flex items-center justify-center disabled:opacity-30 hover:bg-secondary"
                              >
                                <Minus className="w-4 h-4" />
                              </button>
                              <span className="w-8 text-center font-bold">{qty}</span>
                              <button
                                type="button"
                                onClick={() => setQty(item.id, qty + 1)}
                                aria-label="Add one"
                                className="w-9 h-9 rounded-full border border-border flex items-center justify-center hover:bg-secondary"
                              >
                                <Plus className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>

            <div className="lg:sticky lg:top-20 lg:self-start">
              <form ref={formRef} onSubmit={handleSubmit} className="bg-card rounded-3xl border border-border p-6 space-y-4">
                <div className="flex items-center gap-2">
                  <ShoppingBag className="w-5 h-5 text-primary" />
                  <h3 className="font-bold text-lg">Your demo order</h3>
                </div>

                <div ref={cartRef} data-tour="cart" className="space-y-1.5 min-h-[2.5rem]">
                  {orderItems.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Add items from the menu to see them here.</p>
                  ) : (
                    orderItems.map((i) => (
                      <div key={i.itemId} className="flex justify-between text-sm">
                        <span>
                          {i.quantity}× {i.name}
                        </span>
                        <span className="text-muted-foreground">${(i.price * i.quantity).toFixed(2)}</span>
                      </div>
                    ))
                  )}
                </div>

                <div data-tour="form" className="space-y-3 border-t border-border pt-4">
                  <div>
                    <label className="block text-sm font-semibold mb-1">Your name</label>
                    <input
                      type="text"
                      value={guestName}
                      onChange={(e) => setGuestName(e.target.value)}
                      placeholder="e.g. Alex"
                      className="w-full px-4 py-2.5 border border-border rounded-xl bg-background outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold mb-1 flex items-center gap-1.5">
                      <Phone className="w-3.5 h-3.5" /> Phone number
                    </label>
                    <input
                      type="tel"
                      value={phoneNumber}
                      onChange={(e) => setPhoneNumber(e.target.value)}
                      placeholder="(301) 555-0123"
                      autoComplete="tel"
                      className="w-full px-4 py-2.5 border border-border rounded-xl bg-background outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
                    />
                    <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                      For demo purposes only — you will not receive ads or spam. We send one sample tracking text and
                      that's it.
                    </p>
                  </div>
                </div>

                {submitErr && (
                  <div className="px-3 py-2 rounded-xl bg-red-50 text-red-700 text-sm">{submitErr}</div>
                )}

                <button
                  ref={submitBtnRef}
                  type="submit"
                  data-tour="submit"
                  disabled={submitting || orderItems.length === 0 || !guestName.trim() || !phoneNumber.trim()}
                  className="w-full py-3.5 bg-foreground text-background font-bold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {submitting
                    ? "Placing demo order…"
                    : orderItems.length === 0
                      ? "Add an item to continue"
                      : "Place demo order & send sample text"}
                </button>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
