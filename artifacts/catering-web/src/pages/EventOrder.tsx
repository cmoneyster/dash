import { useState, useEffect } from "react";
import { ShoppingBag, CheckCircle2, Minus, Plus, Lock, Utensils } from "lucide-react";

const SESSION_KEY = "event_auth_password";
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type MenuItem = {
  id: number;
  name: string;
  description: string;
  category: string;
  price: number;
  servingSize: number;
  unit: string;
  imageUrl: string | null;
};

function formatCurrency(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function useEventApi(password: string) {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${password}` };
  return {
    verify: () => fetch(`${BASE}/api/event-ordering/verify`, { method: "POST", headers, body: JSON.stringify({ password }) }),
    menu: () => fetch(`${BASE}/api/event-ordering/menu`),
    placeOrder: (body: object) => fetch(`${BASE}/api/event-ordering/orders`, { method: "POST", headers, body: JSON.stringify(body) }),
  };
}

export default function EventOrder() {
  const [password, setPassword] = useState("");
  const [authedPassword, setAuthedPassword] = useState<string | null>(() => sessionStorage.getItem(SESSION_KEY));
  const [loginError, setLoginError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);

  const [menu, setMenu] = useState<MenuItem[] | null>(null);
  const [quantities, setQuantities] = useState<Record<number, number>>({});
  const [guestName, setGuestName] = useState("");
  const [tableNumber, setTableNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

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
        body: JSON.stringify({ password }),
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

  function setQty(id: number, qty: number) {
    setQuantities(prev => ({ ...prev, [id]: Math.max(0, qty) }));
  }

  const orderItems = menu?.filter(m => quantities[m.id] > 0).map(m => ({
    itemId: m.id,
    name: m.name,
    quantity: quantities[m.id],
    price: m.price,
  })) ?? [];

  const total = orderItems.reduce((s, i) => s + i.price * i.quantity, 0);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!guestName.trim() || !orderItems.length || !authedPassword) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${BASE}/api/event-ordering/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authedPassword}` },
        body: JSON.stringify({ guestName: guestName.trim(), tableNumber: tableNumber.trim() || null, items: orderItems }),
      });
      if (res.ok) setSubmitted(true);
    } catch {
      alert("Error placing order. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function placeAnother() {
    setSubmitted(false);
    setGuestName("");
    setTableNumber("");
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
            <h1 className="font-display font-bold text-3xl">Event Ordering</h1>
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

  if (submitted) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="text-center max-w-sm">
          <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <CheckCircle2 className="w-10 h-10 text-emerald-600" />
          </div>
          <h2 className="font-display font-bold text-3xl mb-2">Order Received!</h2>
          <p className="text-muted-foreground mb-6">Your order has been sent to the kitchen. We'll have it ready soon.</p>
          <button onClick={placeAnother} className="px-6 py-3 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors">
            Place Another Order
          </button>
        </div>
      </div>
    );
  }

  const categories = menu ? Array.from(new Set(menu.map(i => i.category))) : [];

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 bg-card/80 backdrop-blur-md border-b border-border">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="font-display font-bold text-xl">Event Ordering</h1>
            <p className="text-xs text-muted-foreground">dash by Hollywood East Cafe</p>
          </div>
          {orderItems.length > 0 && (
            <div className="flex items-center gap-2 bg-primary/10 text-primary px-3 py-1.5 rounded-full text-sm font-bold">
              <ShoppingBag className="w-4 h-4" />
              {orderItems.reduce((s, i) => s + i.quantity, 0)} items · {formatCurrency(total)}
            </div>
          )}
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-4 py-6">
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
                  {menu.filter(i => i.category === cat).map(item => (
                    <div key={item.id} className="flex gap-4 items-center bg-card border border-border rounded-2xl p-4">
                      {item.imageUrl && (
                        <img src={item.imageUrl} alt={item.name} className="w-16 h-16 rounded-xl object-cover shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-sm">{item.name}</p>
                        <p className="text-xs text-muted-foreground">Serves {item.servingSize} · {formatCurrency(item.price)}/{item.unit}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => setQty(item.id, (quantities[item.id] ?? 0) - 1)}
                          disabled={!quantities[item.id]}
                          className="w-8 h-8 flex items-center justify-center rounded-full bg-secondary hover:bg-border transition-colors disabled:opacity-30"
                        >
                          <Minus className="w-4 h-4" />
                        </button>
                        <span className="w-6 text-center font-bold text-sm">{quantities[item.id] ?? 0}</span>
                        <button
                          type="button"
                          onClick={() => setQty(item.id, (quantities[item.id] ?? 0) + 1)}
                          className="w-8 h-8 flex items-center justify-center rounded-full bg-foreground text-background hover:bg-primary hover:text-primary-foreground transition-colors"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
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
                  className="w-full px-4 py-2.5 border border-border rounded-xl bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold mb-1">Table / Seat Number <span className="text-muted-foreground text-xs font-normal">(optional)</span></label>
                <input
                  value={tableNumber}
                  onChange={e => setTableNumber(e.target.value)}
                  placeholder="e.g. Table 4"
                  className="w-full px-4 py-2.5 border border-border rounded-xl bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all"
                />
              </div>

              {orderItems.length > 0 && (
                <div className="border-t border-border pt-4 space-y-2">
                  <p className="text-sm font-semibold text-muted-foreground">Order Summary</p>
                  {orderItems.map(i => (
                    <div key={i.itemId} className="flex justify-between text-sm">
                      <span>{i.quantity}× {i.name}</span>
                      <span className="font-semibold">{formatCurrency(i.price * i.quantity)}</span>
                    </div>
                  ))}
                  <div className="flex justify-between font-bold pt-2 border-t border-border">
                    <span>Total</span>
                    <span>{formatCurrency(total)}</span>
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={submitting || !orderItems.length || !guestName.trim()}
                className="w-full py-3.5 bg-foreground text-background font-bold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {submitting ? "Placing Order…" : orderItems.length ? `Place Order · ${formatCurrency(total)}` : "Select items to order"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
