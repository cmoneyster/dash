import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Minus, Trash2, ShoppingCart, Receipt, Check, AlertCircle, LogOut, ChefHat } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const PASSWORD_KEY = "event_taker_password";

interface MenuItem {
  id: number;
  name: string;
  description: string;
  category: string;
  price: number;
  eventTakerPrice: number | null;
  effectivePrice: number;
  unit: string;
  servingSize: number;
  imageUrl?: string | null;
  eventStock: number | null;
  internalNotes?: string | null;
}

interface CartLine {
  itemId: number;
  name: string;
  unitPrice: number;
  quantity: number;
}

interface TakerSettings {
  eventName: string;
  taxEnabled: boolean;
  taxRate: number | null;
}

function getStoredPassword(): string | null {
  try { return sessionStorage.getItem(PASSWORD_KEY); } catch { return null; }
}
function setStoredPassword(v: string | null) {
  try { v ? sessionStorage.setItem(PASSWORD_KEY, v) : sessionStorage.removeItem(PASSWORD_KEY); } catch {}
}

export default function EventTakerOrder() {
  const [password, setPassword] = useState<string | null>(getStoredPassword());
  const [pwInput, setPwInput] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwSubmitting, setPwSubmitting] = useState(false);

  const [settings, setSettings] = useState<TakerSettings | null>(null);
  const [menu, setMenu] = useState<MenuItem[] | null>(null);
  const [menuError, setMenuError] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [guestName, setGuestName] = useState("");
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmation, setConfirmation] = useState<null | { id: string; total: number; phoneSent: boolean }>(null);
  const [submitError, setSubmitError] = useState("");
  const [lastReceipt, setLastReceipt] = useState<null | {
    id: string; guestName: string; phone: string; items: CartLine[];
    subtotal: number; taxRate: number; taxAmount: number; total: number; placedAt: string;
  }>(null);
  const [printMode, setPrintMode] = useState<"receipt" | "kitchen">("receipt");

  function handlePrint(mode: "receipt" | "kitchen") {
    setPrintMode(mode);
    // Wait for the DOM to update so the right ticket is in the printable layer.
    setTimeout(() => window.print(), 50);
  }

  // Public settings (always available)
  useEffect(() => {
    fetch(`${BASE}/api/event-taker/settings`)
      .then(r => r.json())
      .then(setSettings)
      .catch(() => {});
  }, []);

  async function loadMenu(token: string) {
    setMenuError("");
    try {
      const res = await fetch(`${BASE}/api/event-taker/menu`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) { handleLogout(); return; }
      if (!res.ok) throw new Error("Failed to load menu");
      setMenu(await res.json());
    } catch {
      setMenuError("Failed to load menu");
    }
  }

  useEffect(() => {
    if (password) loadMenu(password);
  }, [password]);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setPwSubmitting(true);
    setPwError("");
    try {
      const res = await fetch(`${BASE}/api/event-taker/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pwInput }),
      });
      if (!res.ok) {
        setPwError("Incorrect password");
      } else {
        setStoredPassword(pwInput);
        setPassword(pwInput);
        setPwInput("");
      }
    } catch {
      setPwError("Could not verify password");
    } finally {
      setPwSubmitting(false);
    }
  }

  function handleLogout() {
    setStoredPassword(null);
    setPassword(null);
    setMenu(null);
    setCart([]);
  }

  function addToCart(item: MenuItem) {
    setCart(prev => {
      const existing = prev.find(l => l.itemId === item.id);
      if (existing) {
        return prev.map(l => l.itemId === item.id ? { ...l, quantity: l.quantity + 1 } : l);
      }
      return [...prev, { itemId: item.id, name: item.name, unitPrice: item.effectivePrice, quantity: 1 }];
    });
  }

  function changeQty(itemId: number, delta: number) {
    setCart(prev => prev
      .map(l => l.itemId === itemId ? { ...l, quantity: l.quantity + delta } : l)
      .filter(l => l.quantity > 0));
  }

  function removeLine(itemId: number) {
    setCart(prev => prev.filter(l => l.itemId !== itemId));
  }

  const subtotal = useMemo(
    () => cart.reduce((s, l) => s + l.unitPrice * l.quantity, 0),
    [cart],
  );
  const taxRate = settings?.taxEnabled && settings.taxRate ? settings.taxRate : 0;
  const taxAmount = useMemo(() => Math.round(subtotal * (taxRate / 100) * 100) / 100, [subtotal, taxRate]);
  const total = Math.round((subtotal + taxAmount) * 100) / 100;

  const categories = useMemo(() => {
    if (!menu) return [];
    const cats = new Set<string>();
    for (const m of menu) cats.add(m.category);
    return Array.from(cats).sort();
  }, [menu]);

  async function submitOrder(e: React.FormEvent) {
    e.preventDefault();
    if (!guestName.trim() || cart.length === 0 || !password) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const res = await fetch(`${BASE}/api/event-taker/orders`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${password}`,
        },
        body: JSON.stringify({
          guestName: guestName.trim(),
          phoneNumber: phone.trim() || null,
          items: cart.map(l => ({ itemId: l.itemId, quantity: l.quantity })),
          statusUrlBase: window.location.origin + BASE,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setSubmitError(err.error ?? "Failed to place order");
        return;
      }
      const data = await res.json();
      setLastReceipt({
        id: String(data.id),
        guestName: guestName.trim(),
        phone: phone.trim(),
        items: cart,
        subtotal, taxRate, taxAmount, total,
        placedAt: new Date().toLocaleString(),
      });
      setConfirmation({ id: data.id, total: data.total ?? total, phoneSent: !!phone.trim() });
      setCart([]);
      setGuestName("");
      setPhone("");
      // Refresh menu so new stock counts are visible
      loadMenu(password);
    } catch {
      setSubmitError("Could not reach the server");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Password gate ────────────────────────────────────────────────
  if (!password) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-background to-amber-50 flex items-center justify-center p-4">
        <div className="bg-card border border-border rounded-3xl shadow-xl p-8 w-full max-w-md">
          <div className="text-center mb-6">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-indigo-100 text-indigo-600 mb-4">
              <ShoppingCart className="w-7 h-7" />
            </div>
            <h1 className="font-display font-bold text-2xl">Staff Order Taker</h1>
            <p className="text-sm text-muted-foreground mt-1">Enter the staff password to continue</p>
            {settings?.eventName && (
              <p className="text-xs text-muted-foreground mt-2">{settings.eventName}</p>
            )}
          </div>
          <form onSubmit={handleVerify} className="space-y-3">
            <input
              type="password"
              autoFocus
              value={pwInput}
              onChange={e => setPwInput(e.target.value)}
              placeholder="Password"
              className="w-full px-4 py-3 border border-border rounded-xl bg-background focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none"
            />
            {pwError && (
              <p className="text-sm text-destructive flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4" />{pwError}
              </p>
            )}
            <button
              type="submit"
              disabled={pwSubmitting || !pwInput}
              className="w-full px-5 py-3 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {pwSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Sign in
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ── Confirmation / printable receipt screen ─────────────────────
  if (confirmation && lastReceipt) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-emerald-50 via-background to-emerald-100 flex items-center justify-center p-4 print:bg-white print:p-0">
        <div className="bg-card border border-border rounded-3xl shadow-xl p-6 max-w-md w-full print:shadow-none print:border-0 print:rounded-none">
          <div className="text-center mb-4 print:hidden">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-emerald-100 text-emerald-600 mb-2">
              <Check className="w-7 h-7" />
            </div>
            <h2 className="font-display font-bold text-2xl">Order placed!</h2>
            {confirmation.phoneSent && (
              <p className="text-xs text-muted-foreground mt-1">SMS confirmation sent.</p>
            )}
          </div>

          {/* Print page sizing — narrow for thermal/ESC-POS, A4 fallback otherwise */}
          <style>{`
            @media print {
              @page { size: 80mm auto; margin: 4mm; }
              body { background: #fff !important; }
            }
          `}</style>

          {/* Customer receipt — visible on screen as preview, printed only in receipt mode */}
          <div
            id="receipt"
            className={`font-mono text-sm bg-white border border-dashed border-border rounded-xl p-4 print:border-0 print:p-0 ${printMode === "kitchen" ? "print:hidden" : ""}`}
          >
            <div className="text-center mb-3">
              <p className="font-bold text-base">{settings?.eventName || "dash by Hollywood East Cafe"}</p>
              <p className="text-xs">{lastReceipt.placedAt}</p>
              <p className="text-xs">Order #{lastReceipt.id.slice(0, 8)}</p>
            </div>
            <div className="border-t border-b border-dashed py-2 mb-2 space-y-1">
              <p>Customer: {lastReceipt.guestName}</p>
              {lastReceipt.phone && <p>Phone: {lastReceipt.phone}</p>}
            </div>
            <table className="w-full text-xs mb-2">
              <tbody>
                {lastReceipt.items.map(l => (
                  <tr key={l.itemId}>
                    <td className="py-0.5">{l.quantity}× {l.name}</td>
                    <td className="py-0.5 text-right">${(l.unitPrice * l.quantity).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="border-t border-dashed pt-2 space-y-0.5 text-xs">
              <div className="flex justify-between"><span>Subtotal</span><span>${lastReceipt.subtotal.toFixed(2)}</span></div>
              {lastReceipt.taxRate > 0 && (
                <div className="flex justify-between"><span>Tax ({lastReceipt.taxRate.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%)</span><span>${lastReceipt.taxAmount.toFixed(2)}</span></div>
              )}
              <div className="flex justify-between font-bold text-sm pt-1 border-t border-dashed mt-1"><span>TOTAL</span><span>${lastReceipt.total.toFixed(2)}</span></div>
            </div>
            <p className="text-center text-xs mt-3">Thank you!</p>
          </div>

          {/* Kitchen ticket — hidden on screen, only printed when in kitchen mode */}
          <div
            id="kitchen-ticket"
            className={`hidden ${printMode === "kitchen" ? "print:block" : ""} font-mono text-base bg-white text-black print:border-0 print:p-0`}
          >
            <div className="text-center mb-3">
              <p className="font-bold text-lg uppercase tracking-wider">Kitchen Ticket</p>
              <p className="text-xs">{settings?.eventName || "dash by Hollywood East Cafe"}</p>
              <p className="text-xs">{lastReceipt.placedAt}</p>
              <p className="text-base font-bold mt-1">Order #{lastReceipt.id.slice(0, 8)}</p>
            </div>
            <div className="border-t border-b border-dashed border-black py-2 mb-2">
              <p className="font-bold text-lg">{lastReceipt.guestName}</p>
            </div>
            <table className="w-full mb-2">
              <tbody>
                {lastReceipt.items.map(l => (
                  <tr key={l.itemId}>
                    <td className="py-1 align-top w-10 font-bold text-xl">{l.quantity}×</td>
                    <td className="py-1 align-top font-semibold">{l.name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-center text-xs border-t border-dashed border-black pt-2 mt-2">
              {lastReceipt.items.reduce((s, l) => s + l.quantity, 0)} item(s) total
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2 mt-4 print:hidden">
            <button
              onClick={() => handlePrint("receipt")}
              className="px-3 py-3 bg-secondary text-foreground font-semibold rounded-xl hover:bg-secondary/70 flex items-center justify-center gap-1.5 text-sm"
            >
              <Receipt className="w-4 h-4" /> Print Receipt
            </button>
            <button
              onClick={() => handlePrint("kitchen")}
              className="px-3 py-3 bg-amber-500 text-white font-semibold rounded-xl hover:bg-amber-600 flex items-center justify-center gap-1.5 text-sm"
            >
              <ChefHat className="w-4 h-4" /> Print Kitchen
            </button>
            <button
              onClick={() => { setConfirmation(null); setLastReceipt(null); setPrintMode("receipt"); }}
              className="px-3 py-3 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 text-sm"
            >
              Next order
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Main POS layout ──────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-secondary/30">
      <header className="bg-card border-b border-border sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-600 text-white flex items-center justify-center">
              <ShoppingCart className="w-5 h-5" />
            </div>
            <div>
              <h1 className="font-display font-bold text-lg leading-tight">Staff Order Taker</h1>
              <p className="text-xs text-muted-foreground leading-tight">{settings?.eventName || "dash by Hollywood East Cafe"}</p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="p-2 text-muted-foreground hover:text-foreground rounded-lg hover:bg-secondary transition-colors"
            title="Sign out"
          >
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </header>

      <div className="max-w-7xl mx-auto p-4 grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-4">
        {/* Menu */}
        <section>
          {menuError && (
            <div className="bg-destructive/10 text-destructive border border-destructive/20 rounded-xl p-4 mb-4 text-sm">{menuError}</div>
          )}
          {!menu && (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          )}
          {menu && menu.length === 0 && (
            <div className="bg-card border border-border rounded-2xl p-12 text-center text-muted-foreground">
              <p className="font-semibold">No items available on the staff order taker.</p>
              <p className="text-sm mt-2">Toggle items on in Menu Manager → "Taker" column.</p>
            </div>
          )}
          {menu && menu.length > 0 && categories.map(cat => (
            <div key={cat} className="mb-6">
              <h2 className="font-display font-bold text-lg mb-2 px-1">{cat}</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {menu.filter(m => m.category === cat).map(item => {
                  const outOfStock = item.eventStock !== null && item.eventStock <= 0;
                  const inCart = cart.find(l => l.itemId === item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      disabled={outOfStock}
                      onClick={() => addToCart(item)}
                      className={`relative bg-card border rounded-2xl overflow-hidden text-left transition-all ${
                        outOfStock
                          ? "opacity-50 cursor-not-allowed border-border"
                          : inCart
                            ? "border-indigo-500 ring-2 ring-indigo-500/20 hover:shadow-md"
                            : "border-border hover:border-indigo-400 hover:shadow-md active:scale-[0.98]"
                      }`}
                    >
                      {item.imageUrl && (
                        <div className="aspect-[4/3] bg-secondary">
                          <img src={item.imageUrl} alt="" className="w-full h-full object-cover" />
                        </div>
                      )}
                      <div className="p-3">
                        <p className="font-semibold text-sm leading-tight">{item.name}</p>
                        <div className="flex items-end justify-between mt-1.5">
                          <span className="font-bold text-base text-indigo-600">${item.effectivePrice.toFixed(2)}</span>
                          {item.eventStock !== null && (
                            <span className={`text-[10px] font-semibold uppercase tracking-wider ${outOfStock ? "text-destructive" : "text-muted-foreground"}`}>
                              {outOfStock ? "Out" : `${item.eventStock} left`}
                            </span>
                          )}
                        </div>
                      </div>
                      {outOfStock && (
                        <div className="absolute inset-0 bg-foreground/5 flex items-center justify-center">
                          <span className="bg-destructive text-destructive-foreground text-xs font-bold uppercase tracking-wider px-3 py-1 rounded-full">Sold out</span>
                        </div>
                      )}
                      {inCart && !outOfStock && (
                        <div
                          className="absolute top-2 right-2 flex items-center gap-1 bg-indigo-600 text-white rounded-full pl-1 pr-1 py-0.5 shadow-md"
                          onClick={e => e.stopPropagation()}
                        >
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={e => { e.stopPropagation(); changeQty(item.id, -1); }}
                            className="w-6 h-6 rounded-full hover:bg-indigo-700 flex items-center justify-center cursor-pointer"
                          >
                            <Minus className="w-3 h-3" />
                          </span>
                          <span className="text-xs font-bold min-w-[16px] text-center">{inCart.quantity}</span>
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={e => { e.stopPropagation(); changeQty(item.id, 1); }}
                            className="w-6 h-6 rounded-full hover:bg-indigo-700 flex items-center justify-center cursor-pointer"
                          >
                            <Plus className="w-3 h-3" />
                          </span>
                        </div>
                      )}
                      {inCart && (
                        <div className="px-3 pb-2 -mt-1 text-[11px] text-indigo-700 font-semibold">
                          Line: ${(inCart.unitPrice * inCart.quantity).toFixed(2)}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </section>

        {/* Cart */}
        <aside className="lg:sticky lg:top-[68px] lg:self-start lg:max-h-[calc(100vh-84px)] flex flex-col bg-card border border-border rounded-2xl shadow-sm">
          <div className="px-5 py-4 border-b border-border flex items-center gap-2">
            <Receipt className="w-5 h-5 text-indigo-600" />
            <h2 className="font-display font-bold text-lg">Current Order</h2>
            <span className="ml-auto text-xs text-muted-foreground">{cart.reduce((s, l) => s + l.quantity, 0)} item(s)</span>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
            {cart.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-10">Tap items on the left to start an order.</p>
            )}
            {cart.map(line => (
              <div key={line.itemId} className="flex items-center gap-2 py-2 border-b border-border/40 last:border-0">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate">{line.name}</p>
                  <p className="text-xs text-muted-foreground">${line.unitPrice.toFixed(2)} × {line.quantity} = ${(line.unitPrice * line.quantity).toFixed(2)}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => changeQty(line.itemId, -1)} className="w-7 h-7 rounded-md bg-secondary hover:bg-secondary/70 flex items-center justify-center"><Minus className="w-3.5 h-3.5" /></button>
                  <span className="w-6 text-center font-semibold text-sm">{line.quantity}</span>
                  <button onClick={() => changeQty(line.itemId, 1)} className="w-7 h-7 rounded-md bg-secondary hover:bg-secondary/70 flex items-center justify-center"><Plus className="w-3.5 h-3.5" /></button>
                  <button onClick={() => removeLine(line.itemId)} className="w-7 h-7 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 flex items-center justify-center ml-1"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              </div>
            ))}
          </div>

          {cart.length > 0 && (
            <form onSubmit={submitOrder} className="px-5 py-4 border-t border-border space-y-3 bg-secondary/20 rounded-b-2xl">
              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="font-semibold">${subtotal.toFixed(2)}</span></div>
                {settings?.taxEnabled && taxRate > 0 && (
                  <div className="flex justify-between"><span className="text-muted-foreground">Tax ({taxRate.toFixed(2)}%)</span><span className="font-semibold">${taxAmount.toFixed(2)}</span></div>
                )}
                <div className="flex justify-between text-base pt-1 border-t border-border/60 mt-1.5"><span className="font-bold">Total</span><span className="font-bold text-indigo-600">${total.toFixed(2)}</span></div>
              </div>
              <input
                value={guestName}
                onChange={e => setGuestName(e.target.value)}
                required
                placeholder="Customer name"
                className="w-full px-3 py-2 border border-border rounded-lg bg-background text-sm"
              />
              <input
                value={phone}
                onChange={e => setPhone(e.target.value)}
                type="tel"
                placeholder="Phone (optional — for SMS)"
                className="w-full px-3 py-2 border border-border rounded-lg bg-background text-sm"
              />
              {submitError && (
                <p className="text-sm text-destructive flex items-start gap-1.5"><AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />{submitError}</p>
              )}
              <button
                type="submit"
                disabled={submitting || !guestName.trim()}
                className="w-full px-5 py-3 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                Place Order ${total.toFixed(2)}
              </button>
            </form>
          )}
        </aside>
      </div>
    </div>
  );
}
