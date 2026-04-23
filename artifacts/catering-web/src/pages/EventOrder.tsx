import { useState, useEffect } from "react";
import { ShoppingBag, CheckCircle2, Minus, Plus, Lock, Utensils, Phone, ExternalLink } from "lucide-react";
import { ImageLightbox } from "@/components/ImageLightbox";
import { useCategories } from "@/lib/categories";

const SESSION_KEY = "event_auth_password";
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function formatBannerTime(pausedUntil: string | null, now: number): string {
  if (!pausedUntil) return "a moment";
  const ms = new Date(pausedUntil).getTime() - now;
  if (ms <= 0) return "a moment";
  const sec = Math.ceil(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

type MenuItem = {
  id: number;
  name: string;
  description: string;
  category: string;
  price: number;
  servingSize: number;
  unit: string;
  imageUrl: string | null;
  eventStock: number | null;
};

export default function EventOrder() {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [eventName, setEventName] = useState("");

  const [password, setPassword] = useState("");
  const [authedPassword, setAuthedPassword] = useState<string | null>(() => sessionStorage.getItem(SESSION_KEY));
  const [loginError, setLoginError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);

  const [menu, setMenu] = useState<MenuItem[] | null>(null);
  const [quantities, setQuantities] = useState<Record<number, number>>({});
  const [guestName, setGuestName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submittedOrderId, setSubmittedOrderId] = useState<number | null>(null);
  const { data: categoriesData } = useCategories();

  type ChState = { state: "accepting" | "paused" | "closed"; pausedUntil: string | null; remainingSec: number | null };
  const [orderingState, setOrderingState] = useState<ChState | null>(null);
  const [tickNow, setTickNow] = useState(Date.now());

  useEffect(() => {
    function load() {
      fetch(`${BASE}/api/event-ordering/settings`)
        .then(r => r.json())
        .then(data => {
          setEventName(data.eventName ?? "");
          if (data.orderingState) {
            setOrderingState({
              state: data.orderingState,
              pausedUntil: data.orderingPausedUntil ?? null,
              remainingSec: data.orderingRemainingSec ?? null,
            });
          }
        })
        .catch(() => {});
    }
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, []);

  // Tick once a second so the paused countdown banner animates between polls.
  useEffect(() => {
    if (orderingState?.state !== "paused") return;
    const id = setInterval(() => setTickNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [orderingState?.state]);

  // When the local countdown hits zero, optimistically flip to accepting so the
  // submit button isn't false-disabled until the next 30s settings poll. The
  // server has already auto-resumed via resolveChannelState.
  useEffect(() => {
    if (orderingState?.state === "paused" && orderingState.pausedUntil
        && new Date(orderingState.pausedUntil).getTime() <= tickNow) {
      setOrderingState({ state: "accepting", pausedUntil: null, remainingSec: null });
    }
  }, [tickNow, orderingState]);

  useEffect(() => {
    if (!authedPassword) return;
    fetch(`${BASE}/api/event-ordering/menu`)
      .then(r => r.json())
      .then(data => {
        setMenu(data);
        const init: Record<number, number> = {};
        data.forEach((item: MenuItem) => { init[item.id] = 0; });
        setQuantities(init);
      })
      .catch(() => setMenu([]));
  }, [authedPassword]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginLoading(true);
    setLoginError("");
    try {
      const res = await fetch(`${BASE}/api/event-ordering/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, role: "order" }),
      });
      if (res.ok) {
        sessionStorage.setItem(SESSION_KEY, password);
        setAuthedPassword(password);
      } else {
        setLoginError("Incorrect password. Please try again.");
      }
    } catch {
      setLoginError("Connection error. Please try again.");
    } finally {
      setLoginLoading(false);
    }
  }

  function setQty(id: number, qty: number, stock?: number | null) {
    const max = (stock != null) ? stock : Infinity;
    setQuantities(prev => ({ ...prev, [id]: Math.max(0, Math.min(qty, max)) }));
  }

  const orderItems = menu?.filter(m => quantities[m.id] > 0).map(m => ({
    itemId: m.id,
    name: m.name,
    quantity: quantities[m.id],
    price: m.price,
  })) ?? [];

  const totalQty = orderItems.reduce((s, i) => s + i.quantity, 0);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!guestName.trim() || !orderItems.length || !authedPassword) return;
    setSubmitting(true);
    try {
      const statusUrlBase = `${window.location.origin}${BASE}`;
      const res = await fetch(`${BASE}/api/event-ordering/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authedPassword}` },
        body: JSON.stringify({
          guestName: guestName.trim(),
          phoneNumber: phoneNumber.trim() || null,
          items: orderItems,
          statusUrlBase,
        }),
      });
      if (res.ok) {
        const order = await res.json();
        setSubmittedOrderId(order.id);
        fetch(`${BASE}/api/event-ordering/menu`)
          .then(r => r.json())
          .then(data => setMenu(data))
          .catch(() => {});
      } else if (res.status === 409) {
        const data = await res.json();
        alert(data.error ?? "An item ran out of stock. Please adjust your order.");
        fetch(`${BASE}/api/event-ordering/menu`)
          .then(r => r.json())
          .then(data => setMenu(data))
          .catch(() => {});
      } else if (res.status === 423) {
        const data = await res.json().catch(() => ({}));
        setOrderingState({
          state: data.state ?? "paused",
          pausedUntil: data.pausedUntil ?? null,
          remainingSec: data.remainingSec ?? null,
        });
        alert(data.error ?? "Ordering is paused right now. Please try again shortly.");
      } else {
        alert("Error placing order. Please try again.");
      }
    } catch {
      alert("Error placing order. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function placeAnother() {
    setSubmittedOrderId(null);
    setGuestName("");
    setPhoneNumber("");
    if (menu) {
      const init: Record<number, number> = {};
      menu.forEach(item => { init[item.id] = 0; });
      setQuantities(init);
    }
  }

  if (!authedPassword) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-foreground rounded-2xl flex items-center justify-center mx-auto mb-4">
              <Utensils className="w-8 h-8 text-background" />
            </div>
            <h1 className="font-display font-bold text-3xl">{eventName || "Event Ordering"}</h1>
            <p className="text-muted-foreground mt-2 text-sm">dash by Hollywood East Cafe</p>
          </div>
          <form onSubmit={handleLogin} className="bg-card border border-border rounded-2xl p-6 shadow-sm space-y-4">
            <div>
              <label className="block text-sm font-semibold mb-1.5">Event Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Enter event password"
                  className="w-full pl-10 pr-4 py-3 border border-border rounded-xl bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all"
                  required
                />
              </div>
              {loginError && <p className="text-destructive text-xs mt-1.5">{loginError}</p>}
            </div>
            <button
              type="submit"
              disabled={loginLoading}
              className="w-full py-3 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-50"
            >
              {loginLoading ? "Checking…" : "Continue"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (submittedOrderId !== null) {
    const statusPath = `${BASE}/event/order/${submittedOrderId}`;
    const statusUrl = `${window.location.origin}${statusPath}`;
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="text-center max-w-sm w-full">
          <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <CheckCircle2 className="w-10 h-10 text-emerald-600" />
          </div>
          <h2 className="font-display font-bold text-3xl mb-2">Order Received!</h2>
          <p className="text-muted-foreground mb-1">
            Your order has been sent to the kitchen.
          </p>
          {phoneNumber.trim() && (
            <p className="text-muted-foreground text-sm mb-4">
              We'll text you at {phoneNumber.trim()} when it's ready.
            </p>
          )}

          <a
            href={statusUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-secondary text-foreground font-semibold rounded-xl hover:bg-border transition-colors text-sm mb-4 w-full justify-center"
          >
            <ExternalLink className="w-4 h-4" />
            Track Order #{submittedOrderId}
          </a>

          <button
            onClick={placeAnother}
            className="w-full px-6 py-3 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors"
          >
            Place Another Order
          </button>
        </div>
      </div>
    );
  }

  // The /api/event-ordering/menu endpoint already filters out items in hidden categories.
  // Only show category headings for categories that are visible AND have items present.
  // If the categories API failed/returned empty, fall back to deriving headings from
  // the menu payload itself so items still render.
  const presentCats = menu ? new Set(menu.map(i => i.category)) : new Set<string>();
  const orderedFromApi = (categoriesData ?? []).filter(c => presentCats.has(c.name)).map(c => c.name);
  const categories = orderedFromApi.length > 0
    ? [...orderedFromApi, ...Array.from(presentCats).filter(c => !orderedFromApi.includes(c))]
    : Array.from(presentCats);

  return (
    <div className="min-h-screen bg-background">
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
      <header className="sticky top-0 z-30 bg-card/80 backdrop-blur-md border-b border-border">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="font-display font-bold text-xl">{eventName || "Event Ordering"}</h1>
            <p className="text-xs text-muted-foreground">dash by Hollywood East Cafe</p>
          </div>
          {orderItems.length > 0 && (
            <div className="flex items-center gap-2 bg-primary/10 text-primary px-3 py-1.5 rounded-full text-sm font-bold">
              <ShoppingBag className="w-4 h-4" />
              {totalQty} item{totalQty !== 1 ? "s" : ""} selected
            </div>
          )}
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-4 py-6">
        {orderingState && orderingState.state !== "accepting" && (
          <div className={`mb-5 rounded-2xl border p-4 ${orderingState.state === "paused" ? "bg-amber-50 border-amber-200 text-amber-900" : "bg-rose-50 border-rose-200 text-rose-900"}`}>
            <p className="font-bold text-sm">
              {orderingState.state === "paused"
                ? `Ordering is paused — back in ${formatBannerTime(orderingState.pausedUntil, tickNow)}`
                : "We're not accepting new orders right now."}
            </p>
            <p className="text-xs mt-1 opacity-80">
              {orderingState.state === "paused"
                ? "The kitchen is catching up. You can build your order, but submission is disabled until ordering resumes."
                : "Please check back later or ask a staff member."}
            </p>
          </div>
        )}
        {!menu ? (
          <div className="text-center py-20 text-muted-foreground animate-pulse">Loading menu…</div>
        ) : menu.length === 0 ? (
          <div className="text-center py-20 text-muted-foreground">No items available for this event.</div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-8">
            {categories.map(cat => (
              <div key={cat}>
                <h2 className="font-display font-bold text-lg mb-3 pb-2 border-b border-border">{cat}</h2>
                <div className="space-y-3">
                  {menu.filter(i => i.category === cat).map(item => {
                    const stock = item.eventStock;
                    const soldOut = stock !== null && stock === 0;
                    const qty = quantities[item.id] ?? 0;
                    const atMax = stock !== null && qty >= stock;
                    const low = stock !== null && stock > 0 && stock <= 5;
                    return (
                      <div key={item.id} className={`flex gap-4 items-center bg-card border rounded-2xl p-4 transition-opacity ${soldOut ? "opacity-50 border-border" : "border-border"}`}>
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
                            {soldOut && (
                              <span className="text-[10px] font-bold bg-destructive/10 text-destructive px-1.5 py-0.5 rounded-full">Sold Out</span>
                            )}
                            {low && !soldOut && (
                              <span className="text-[10px] font-bold bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">{stock} left</span>
                            )}
                          </div>
                          {item.description && <p className="text-xs text-muted-foreground line-clamp-2">{item.description}</p>}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => setQty(item.id, qty - 1, stock)}
                            disabled={!qty || soldOut}
                            className="w-8 h-8 flex items-center justify-center rounded-full bg-secondary hover:bg-border transition-colors disabled:opacity-30"
                          >
                            <Minus className="w-4 h-4" />
                          </button>
                          <span className="w-6 text-center font-bold text-sm">{qty}</span>
                          <button
                            type="button"
                            onClick={() => setQty(item.id, qty + 1, stock)}
                            disabled={soldOut || atMax}
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

            <div className="bg-card border border-border rounded-2xl p-6 space-y-4">
              <h2 className="font-display font-bold text-lg">Your Details</h2>
              <div>
                <label className="block text-sm font-semibold mb-1">Your Name <span className="text-destructive">*</span></label>
                <input
                  value={guestName}
                  onChange={e => setGuestName(e.target.value)}
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
                    Phone Number <span className="text-muted-foreground text-xs font-normal">(optional)</span>
                  </span>
                </label>
                <input
                  type="tel"
                  value={phoneNumber}
                  onChange={e => setPhoneNumber(e.target.value)}
                  placeholder="e.g. (301) 555-0123"
                  autoComplete="tel"
                  className="w-full px-4 py-2.5 border border-border rounded-xl bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all"
                />
                <p className="text-xs text-muted-foreground mt-1.5">We'll text you a confirmation and when your order is ready.</p>
              </div>

              {orderItems.length > 0 && (
                <div className="border-t border-border pt-4 space-y-2">
                  <p className="text-sm font-semibold text-muted-foreground">Order Summary</p>
                  {orderItems.map(i => (
                    <div key={i.itemId} className="text-sm">
                      {i.quantity}× {i.name}
                    </div>
                  ))}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting || !orderItems.length || !guestName.trim() || (orderingState != null && orderingState.state !== "accepting")}
                className="w-full py-3.5 bg-foreground text-background font-bold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {submitting
                  ? "Placing Order…"
                  : orderingState?.state === "paused"
                    ? "Ordering paused — try again soon"
                    : orderingState?.state === "closed"
                      ? "Not accepting orders"
                      : orderItems.length ? "Place Order" : "Select items to order"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
