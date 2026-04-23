import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, Minus, Trash2, ShoppingCart, Receipt, Check, AlertCircle, LogOut, ChefHat, Printer, PrinterCheck, DollarSign, CreditCard, Smartphone, ArrowLeft, Clock, X as XIcon, AlertTriangle } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const PASSWORD_KEY = "event_taker_password";
const AUTO_PRINT_KEY = "event_taker_auto_print";

function getStoredAutoPrint(): boolean {
  try { return localStorage.getItem(AUTO_PRINT_KEY) === "1"; } catch { return false; }
}
function setStoredAutoPrint(v: boolean) {
  try { localStorage.setItem(AUTO_PRINT_KEY, v ? "1" : "0"); } catch {}
}

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
  venmoHandle: string | null;
  venmoQrImageUrl: string | null;
}

type PaymentMethod = "cash" | "card" | "venmo";

interface PendingOrderItem {
  itemId: number;
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

interface PendingOrder {
  id: number;
  guestName: string;
  phoneNumber: string | null;
  items: PendingOrderItem[];
  subtotal: number | null;
  taxRate: number | null;
  taxAmount: number | null;
  total: number | null;
  createdAt: string;
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

  // ── Payment-gating state ──────────────────────────────────────────
  // `paymentOrder` is the unpaid order currently being charged in the modal.
  // While this is non-null, the cart is hidden and the payment modal is shown.
  const [paymentOrder, setPaymentOrder] = useState<PendingOrder | null>(null);
  const [pendingOrders, setPendingOrders] = useState<PendingOrder[]>([]);
  const [showPendingPanel, setShowPendingPanel] = useState(false);
  const [printMode, setPrintMode] = useState<"receipt" | "kitchen">("receipt");
  const [autoPrint, setAutoPrint] = useState<boolean>(getStoredAutoPrint());
  const autoPrintedFor = useRef<string | null>(null);

  function toggleAutoPrint() {
    setAutoPrint(prev => {
      const next = !prev;
      setStoredAutoPrint(next);
      return next;
    });
  }

  function handlePrint(mode: "receipt" | "kitchen") {
    setPrintMode(mode);
    // Wait for the DOM to update so the right ticket is in the printable layer.
    setTimeout(() => window.print(), 50);
  }

  // Print kitchen ticket first, then receipt — used by auto-print and the manual button.
  function printBoth() {
    setPrintMode("kitchen");
    setTimeout(() => {
      let receiptPrinted = false;
      const printReceipt = () => {
        if (receiptPrinted) return;
        receiptPrinted = true;
        window.removeEventListener("afterprint", afterKitchen);
        setPrintMode("receipt");
        setTimeout(() => window.print(), 150);
      };
      const afterKitchen = () => printReceipt();
      window.addEventListener("afterprint", afterKitchen);
      window.print();
      // Fallback: if `afterprint` never fires (some browsers/printers/dialog cancels),
      // still proceed to the receipt print so staff aren't left with only the kitchen ticket.
      // The `receiptPrinted` guard makes this idempotent with the event handler above.
      setTimeout(printReceipt, 4000);
    }, 100);
  }

  // Auto-print: when a fresh confirmation appears and the toggle is on, fire both prints.
  useEffect(() => {
    if (!autoPrint) return;
    if (!confirmation || !lastReceipt) return;
    if (autoPrintedFor.current === lastReceipt.id) return;
    autoPrintedFor.current = lastReceipt.id;
    // Tiny delay so the confirmation screen has rendered the printable nodes.
    const t = setTimeout(() => printBoth(), 200);
    return () => clearTimeout(t);
  }, [autoPrint, confirmation, lastReceipt]);

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

  async function loadPending(token: string) {
    try {
      const res = await fetch(`${BASE}/api/event-taker/orders/pending`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      setPendingOrders(Array.isArray(data) ? data : []);
    } catch {}
  }

  // Poll the pending queue periodically so multiple devices stay in sync.
  useEffect(() => {
    if (!password) return;
    loadPending(password);
    const t = setInterval(() => loadPending(password), 8000);
    return () => clearInterval(t);
  }, [password]);

  // Build the receipt-screen payload from a server order row, used after
  // a successful payment / override so we can show + auto-print the receipt.
  function receiptFromOrder(o: PendingOrder, paidAt = new Date()): typeof lastReceipt {
    const sub = o.subtotal ?? o.items.reduce((s, i) => s + i.lineTotal, 0);
    const tx = o.taxAmount ?? 0;
    const tot = o.total ?? (sub + tx);
    return {
      id: String(o.id),
      guestName: o.guestName,
      phone: o.phoneNumber ?? "",
      items: o.items.map(i => ({ itemId: i.itemId, name: i.name, unitPrice: i.unitPrice, quantity: i.quantity })),
      subtotal: sub,
      taxRate: o.taxRate ?? 0,
      taxAmount: tx,
      total: tot,
      placedAt: paidAt.toLocaleString(),
    };
  }

  // Step 1 of the gated flow: create the order as 'unpaid' and open the
  // payment modal. The cart is cleared so the cashier can immediately start
  // the next order if they hit "Hold for later".
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
      // Open payment modal with a synthesized PendingOrder shape so the modal
      // and the eventual receipt screen can share one data type.
      const order: PendingOrder = {
        id: data.id,
        guestName: guestName.trim(),
        phoneNumber: phone.trim() || null,
        items: cart.map(l => ({
          itemId: l.itemId, name: l.name, quantity: l.quantity,
          unitPrice: l.unitPrice, lineTotal: Math.round(l.unitPrice * l.quantity * 100) / 100,
        })),
        subtotal: data.subtotal ?? subtotal,
        taxRate: data.taxRate ?? (taxRate || null),
        taxAmount: data.taxAmount ?? taxAmount,
        total: data.total ?? total,
        createdAt: data.createdAt ?? new Date().toISOString(),
      };
      setPaymentOrder(order);
      // Clear the cart now so the cashier can start a new order while the
      // current one waits for payment ("Hold for later").
      setCart([]);
      setGuestName("");
      setPhone("");
      // Refresh menu (stock changed) and the pending queue.
      loadMenu(password);
      loadPending(password);
    } catch {
      setSubmitError("Could not reach the server");
    } finally {
      setSubmitting(false);
    }
  }

  // Step 2: payment confirmed. Promotes the order to "paid" or "override",
  // then shows the receipt screen which triggers auto-print as before.
  async function handlePaymentComplete(updated: PendingOrder) {
    setPaymentOrder(null);
    setLastReceipt(receiptFromOrder(updated));
    setConfirmation({
      id: String(updated.id),
      total: updated.total ?? 0,
      phoneSent: !!updated.phoneNumber,
    });
    if (password) loadPending(password);
  }

  // Override directly from the pending panel — same effect as the modal's
  // override button: sends to kitchen unpaid, fires SMS, shows + prints receipt.
  async function handleOverrideFromPanel(order: PendingOrder, reason: string) {
    if (!password) return;
    try {
      const res = await fetch(`${BASE}/api/event-taker/orders/${order.id}/override`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${password}` },
        body: JSON.stringify({
          reason: reason.trim() || null,
          statusUrlBase: window.location.origin + BASE,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error ?? "Failed to override");
        return;
      }
      const data = await res.json();
      // Close the panel and reuse the standard completion flow so the
      // receipt screen + auto-print fire just like a modal payment.
      setShowPendingPanel(false);
      handlePaymentComplete({ ...order, ...data });
    } catch {
      alert("Could not reach the server");
    }
  }

  async function handleCancelOrder(orderId: number) {
    if (!password) return;
    if (!confirm("Cancel this order? Stock will be restored.")) return;
    try {
      const res = await fetch(`${BASE}/api/event-taker/orders/${orderId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${password}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error ?? "Failed to cancel order");
        return;
      }
      if (paymentOrder?.id === orderId) setPaymentOrder(null);
      loadPending(password);
      loadMenu(password);
    } catch {
      alert("Could not reach the server");
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
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowPendingPanel(true)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                pendingOrders.length > 0
                  ? "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100"
                  : "bg-secondary text-muted-foreground border-transparent hover:text-foreground"
              }`}
              title="Orders awaiting payment"
            >
              <Clock className="w-4 h-4" />
              <span className="hidden sm:inline">Pending payments:</span>
              <span className="font-bold">{pendingOrders.length}</span>
            </button>
            <button
              onClick={toggleAutoPrint}
              title={autoPrint ? "Auto-print is ON — orders print kitchen + receipt automatically" : "Auto-print is OFF — print manually after each order"}
              aria-pressed={autoPrint}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold transition-colors border ${
                autoPrint
                  ? "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100"
                  : "bg-secondary text-muted-foreground border-transparent hover:text-foreground"
              }`}
            >
              {autoPrint ? <PrinterCheck className="w-4 h-4" /> : <Printer className="w-4 h-4" />}
              <span className="hidden sm:inline">Auto-print: {autoPrint ? "On" : "Off"}</span>
              <span className="sm:hidden">{autoPrint ? "On" : "Off"}</span>
            </button>
            <button
              onClick={handleLogout}
              className="p-2 text-muted-foreground hover:text-foreground rounded-lg hover:bg-secondary transition-colors"
              title="Sign out"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
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
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <DollarSign className="w-4 h-4" />}
                Charge ${total.toFixed(2)}
              </button>
            </form>
          )}
        </aside>
      </div>

      {paymentOrder && password && (
        <PaymentModal
          order={paymentOrder}
          password={password}
          venmoHandle={settings?.venmoHandle ?? null}
          venmoQrImageUrl={settings?.venmoQrImageUrl ?? null}
          onHold={() => { setPaymentOrder(null); if (password) loadPending(password); }}
          onCancel={() => handleCancelOrder(paymentOrder.id)}
          onComplete={handlePaymentComplete}
        />
      )}

      {showPendingPanel && (
        <PendingPanel
          orders={pendingOrders}
          onClose={() => setShowPendingPanel(false)}
          onResume={(o) => { setShowPendingPanel(false); setPaymentOrder(o); }}
          onCancel={(id) => handleCancelOrder(id)}
          onOverride={(o, reason) => handleOverrideFromPanel(o, reason)}
        />
      )}
    </div>
  );
}

// ── Payment confirmation modal ─────────────────────────────────────────
// Renders the method picker (cash/card/venmo) and the per-method screen.
// Each per-method screen has Back to method picker, plus the method's
// confirm action. "Hold for later" leaves the order in the pending queue.
function PaymentModal({
  order, password, venmoHandle, venmoQrImageUrl,
  onHold, onCancel, onComplete,
}: {
  order: PendingOrder;
  password: string;
  venmoHandle: string | null;
  venmoQrImageUrl: string | null;
  onHold: () => void;
  onCancel: () => void;
  onComplete: (updated: PendingOrder) => void;
}) {
  const [step, setStep] = useState<"method" | "cash" | "card" | "venmo">("method");
  const [cashStr, setCashStr] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  // Shortcut: jump back to the method picker and immediately reveal the
  // override form. Exposed on every method step to match the spec.
  function gotoOverride() { setStep("method"); setOverrideOpen(true); setError(""); }

  const total = order.total ?? 0;
  const cashNum = Number(cashStr);
  const change = Number.isFinite(cashNum) ? Math.round((cashNum - total) * 100) / 100 : 0;
  const cashOk = Number.isFinite(cashNum) && cashNum >= total;

  async function confirm(method: PaymentMethod) {
    setSubmitting(true);
    setError("");
    try {
      const body: Record<string, unknown> = { method, statusUrlBase: window.location.origin + BASE };
      if (method === "cash") body.cashReceived = cashNum;
      const res = await fetch(`${BASE}/api/event-taker/orders/${order.id}/payment`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${password}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error ?? "Failed to record payment");
        return;
      }
      const data = await res.json();
      onComplete({ ...order, ...data });
    } catch {
      setError("Could not reach the server");
    } finally {
      setSubmitting(false);
    }
  }

  async function sendOverride() {
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`${BASE}/api/event-taker/orders/${order.id}/override`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${password}` },
        body: JSON.stringify({
          reason: overrideReason.trim() || null,
          statusUrlBase: window.location.origin + BASE,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error ?? "Failed to override");
        return;
      }
      const data = await res.json();
      onComplete({ ...order, ...data });
    } catch {
      setError("Could not reach the server");
    } finally {
      setSubmitting(false);
    }
  }

  // Quick-cash buttons rounded up from the total
  const quickCash = useMemo(() => {
    const t = Math.max(0, total);
    const exact = Math.round(t * 100) / 100;
    const next5 = Math.ceil(t / 5) * 5;
    const next10 = Math.ceil(t / 10) * 10;
    const next20 = Math.ceil(t / 20) * 20;
    return Array.from(new Set([exact, next5, next10, next20])).slice(0, 4);
  }, [total]);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-foreground/40 backdrop-blur-sm print:hidden">
      <div className="bg-card border border-border rounded-3xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="px-6 py-4 border-b border-border bg-secondary/30 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Order #{order.id}</p>
            <h2 className="font-display font-bold text-xl mt-0.5">{order.guestName}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{order.items.reduce((s, i) => s + i.quantity, 0)} item(s) · ${total.toFixed(2)}</p>
          </div>
          <button onClick={onHold} className="p-1.5 hover:bg-secondary rounded-lg" title="Hold for later (close)">
            <XIcon className="w-5 h-5" />
          </button>
        </div>

        {step === "method" && (
          <div className="p-6 space-y-3">
            <p className="text-center text-3xl font-display font-bold">${total.toFixed(2)}</p>
            <p className="text-center text-sm text-muted-foreground">Choose payment method</p>
            <div className="grid gap-2.5 mt-4">
              <button
                onClick={() => { setStep("cash"); setCashStr(total.toFixed(2)); setError(""); }}
                className="flex items-center gap-3 px-4 py-4 border border-border rounded-2xl hover:border-emerald-400 hover:bg-emerald-50 transition-colors"
              >
                <DollarSign className="w-6 h-6 text-emerald-600" />
                <span className="font-bold text-lg">Cash</span>
                <span className="ml-auto text-xs text-muted-foreground">Calculate change</span>
              </button>
              <button
                onClick={() => { setStep("card"); setError(""); }}
                className="flex items-center gap-3 px-4 py-4 border border-border rounded-2xl hover:border-indigo-400 hover:bg-indigo-50 transition-colors"
              >
                <CreditCard className="w-6 h-6 text-indigo-600" />
                <span className="font-bold text-lg">Credit Card</span>
                <span className="ml-auto text-xs text-muted-foreground">Process on terminal</span>
              </button>
              {(() => {
                const venmoConfigured = !!(venmoHandle || venmoQrImageUrl);
                return (
                  <button
                    onClick={() => venmoConfigured && (setStep("venmo"), setError(""))}
                    disabled={!venmoConfigured}
                    title={venmoConfigured ? undefined : "Set the Venmo handle / QR in Admin → Event Settings"}
                    className={`flex items-center gap-3 px-4 py-4 border border-border rounded-2xl transition-colors ${
                      venmoConfigured
                        ? "hover:border-sky-400 hover:bg-sky-50"
                        : "opacity-50 cursor-not-allowed"
                    }`}
                  >
                    <Smartphone className="w-6 h-6 text-sky-600" />
                    <span className="font-bold text-lg">Venmo</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {venmoConfigured ? "Show QR / handle" : "Not configured"}
                    </span>
                  </button>
                );
              })()}
            </div>

            <div className="pt-4 mt-2 border-t border-border space-y-2.5">
              <button
                onClick={onHold}
                className="w-full px-4 py-2.5 text-sm font-semibold border border-border rounded-xl hover:bg-secondary"
              >
                Hold for later
              </button>
              {!overrideOpen ? (
                <button
                  onClick={() => setOverrideOpen(true)}
                  className="w-full text-xs text-muted-foreground hover:text-amber-700 underline"
                >
                  Override — send to kitchen unpaid
                </button>
              ) : (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-2">
                  <div className="flex items-start gap-2 text-amber-800">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                    <p className="text-xs">This will send the order to the kitchen <strong>without</strong> recording payment. Use only when you've verified payment by other means.</p>
                  </div>
                  <input
                    value={overrideReason}
                    onChange={e => setOverrideReason(e.target.value)}
                    placeholder="Reason (optional)"
                    className="w-full px-3 py-2 text-sm border border-amber-300 rounded-lg bg-white"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => { setOverrideOpen(false); setOverrideReason(""); }}
                      className="flex-1 px-3 py-2 text-sm font-semibold border border-border rounded-lg hover:bg-white"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={sendOverride}
                      disabled={submitting}
                      className="flex-1 px-3 py-2 text-sm font-bold bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 flex items-center justify-center gap-1.5"
                    >
                      {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                      Send unpaid
                    </button>
                  </div>
                </div>
              )}
              <button
                onClick={onCancel}
                className="w-full text-xs text-destructive hover:underline"
              >
                Cancel order (restore stock)
              </button>
            </div>

            {error && <p className="text-sm text-destructive flex items-center gap-1.5"><AlertCircle className="w-4 h-4" />{error}</p>}
          </div>
        )}

        {step === "cash" && (
          <div className="p-6 space-y-4">
            <button onClick={() => { setStep("method"); setError(""); }} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
              <ArrowLeft className="w-4 h-4" /> Back
            </button>
            <div className="text-center">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Total Due</p>
              <p className="text-3xl font-display font-bold text-emerald-600">${total.toFixed(2)}</p>
            </div>
            <div>
              <label className="block text-sm font-semibold mb-1.5">Cash received</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-lg text-muted-foreground">$</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  value={cashStr}
                  onChange={e => setCashStr(e.target.value)}
                  autoFocus
                  className="w-full pl-8 pr-4 py-3 text-2xl font-bold border border-border rounded-xl bg-background focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none"
                />
              </div>
              <div className="flex flex-wrap gap-2 mt-2">
                {quickCash.map(v => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setCashStr(v.toFixed(2))}
                    className="px-3 py-1.5 text-sm font-semibold border border-border rounded-lg hover:bg-secondary"
                  >
                    ${v.toFixed(2)}
                  </button>
                ))}
              </div>
            </div>
            <div className="bg-secondary/40 rounded-xl p-3 text-sm">
              <div className="flex justify-between"><span>Change due</span>
                <span className={`font-bold text-lg ${cashOk ? "text-emerald-600" : "text-muted-foreground"}`}>
                  ${cashOk ? change.toFixed(2) : "—"}
                </span>
              </div>
              {!cashOk && cashStr !== "" && (
                <p className="text-xs text-amber-700 mt-1">Need at least ${total.toFixed(2)}</p>
              )}
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <button
              onClick={() => confirm("cash")}
              disabled={!cashOk || submitting}
              className="w-full px-5 py-3 bg-emerald-600 text-white font-bold rounded-xl hover:bg-emerald-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Confirm cash payment
            </button>
            <button onClick={gotoOverride} className="w-full text-xs text-muted-foreground hover:text-amber-700 underline">
              Override — send to kitchen unpaid
            </button>
          </div>
        )}

        {step === "card" && (
          <div className="p-6 space-y-4">
            <button onClick={() => { setStep("method"); setError(""); }} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
              <ArrowLeft className="w-4 h-4" /> Back
            </button>
            <div className="text-center">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Charge on terminal</p>
              <p className="text-3xl font-display font-bold text-indigo-600">${total.toFixed(2)}</p>
            </div>
            <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4 text-sm text-indigo-900 space-y-1">
              <p className="font-semibold">Process this amount on your card terminal.</p>
              <p>When the terminal confirms approval, tap <strong>Approved</strong> below to send the order to the kitchen. If the card is declined, tap <strong>Declined</strong> to return.</p>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => { setStep("method"); setError(""); }}
                disabled={submitting}
                className="px-4 py-3 font-bold border border-border rounded-xl hover:bg-secondary"
              >
                Declined
              </button>
              <button
                onClick={() => confirm("card")}
                disabled={submitting}
                className="px-4 py-3 font-bold bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                Approved
              </button>
            </div>
            <button onClick={gotoOverride} className="w-full text-xs text-muted-foreground hover:text-amber-700 underline">
              Override — send to kitchen unpaid
            </button>
          </div>
        )}

        {step === "venmo" && (
          <div className="p-6 space-y-4">
            <button onClick={() => { setStep("method"); setError(""); }} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
              <ArrowLeft className="w-4 h-4" /> Back
            </button>
            <div className="text-center">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Pay via Venmo</p>
              <p className="text-3xl font-display font-bold text-sky-600">${total.toFixed(2)}</p>
            </div>
            {venmoQrImageUrl && (
              <div className="flex justify-center">
                <div className="w-56 h-56 rounded-2xl border border-border overflow-hidden bg-secondary">
                  <img src={venmoQrImageUrl} alt="Venmo QR" className="w-full h-full object-contain bg-white" />
                </div>
              </div>
            )}
            {venmoHandle && (
              <div className="text-center bg-sky-50 border border-sky-200 rounded-xl p-3">
                <p className="text-xs uppercase tracking-wider text-sky-700 font-semibold">Venmo handle</p>
                <p className="font-mono text-xl font-bold text-sky-900 mt-0.5">@{venmoHandle}</p>
              </div>
            )}
            <p className="text-xs text-muted-foreground text-center">Wait for the customer to send the payment, then tap below.</p>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <button
              onClick={() => confirm("venmo")}
              disabled={submitting}
              className="w-full px-5 py-3 bg-sky-600 text-white font-bold rounded-xl hover:bg-sky-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Mark Venmo received
            </button>
            <button onClick={gotoOverride} className="w-full text-xs text-muted-foreground hover:text-amber-700 underline">
              Override — send to kitchen unpaid
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Pending payments side panel ────────────────────────────────────────
function PendingPanel({
  orders, onClose, onResume, onCancel, onOverride,
}: {
  orders: PendingOrder[];
  onClose: () => void;
  onResume: (o: PendingOrder) => void;
  onCancel: (id: number) => void;
  onOverride: (o: PendingOrder, reason: string) => void;
}) {
  // Per-row reason capture for the inline Override-and-send action.
  const [overrideForId, setOverrideForId] = useState<number | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  return (
    <div className="fixed inset-0 z-[65] flex justify-end bg-foreground/30 backdrop-blur-sm print:hidden" onClick={onClose}>
      <div
        className="bg-card w-full max-w-md h-full shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-border flex items-center gap-2">
          <Clock className="w-5 h-5 text-amber-600" />
          <h2 className="font-display font-bold text-lg">Pending payments</h2>
          <span className="ml-auto text-sm text-muted-foreground">{orders.length}</span>
          <button onClick={onClose} className="p-1.5 hover:bg-secondary rounded-lg ml-2">
            <XIcon className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {orders.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-12">No orders waiting for payment.</p>
          )}
          {orders.map(o => {
            const total = o.total ?? 0;
            const ageMin = Math.max(0, Math.round((Date.now() - new Date(o.createdAt).getTime()) / 60000));
            return (
              <div key={o.id} className="border border-border rounded-2xl p-3 bg-secondary/20">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    <p className="font-bold text-sm truncate">{o.guestName}</p>
                    <p className="text-xs text-muted-foreground">#{o.id} · {ageMin}m ago{o.phoneNumber ? ` · ${o.phoneNumber}` : ""}</p>
                  </div>
                  <p className="font-bold text-base text-amber-700 shrink-0">${total.toFixed(2)}</p>
                </div>
                <ul className="text-xs text-muted-foreground space-y-0.5 mb-3">
                  {o.items.slice(0, 4).map(i => (
                    <li key={i.itemId}>{i.quantity}× {i.name}</li>
                  ))}
                  {o.items.length > 4 && <li>+ {o.items.length - 4} more…</li>}
                </ul>
                <div className="flex gap-2">
                  <button
                    onClick={() => onResume(o)}
                    className="flex-1 px-3 py-2 text-sm font-bold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
                  >
                    Resume
                  </button>
                  <button
                    onClick={() => {
                      setOverrideForId(overrideForId === o.id ? null : o.id);
                      setOverrideReason("");
                    }}
                    className={`px-3 py-2 text-sm font-semibold rounded-lg border ${
                      overrideForId === o.id
                        ? "bg-amber-100 border-amber-300 text-amber-800"
                        : "border-amber-300 text-amber-700 hover:bg-amber-50"
                    }`}
                    title="Send to kitchen unpaid"
                  >
                    <AlertTriangle className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => onCancel(o.id)}
                    className="px-3 py-2 text-sm font-semibold text-destructive border border-destructive/30 rounded-lg hover:bg-destructive/10"
                    title="Cancel & restore stock"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                {overrideForId === o.id && (
                  <div className="mt-2 bg-amber-50 border border-amber-200 rounded-lg p-2.5 space-y-2">
                    <div className="flex items-start gap-1.5 text-amber-800 text-xs">
                      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <p>Send to kitchen <strong>without</strong> recording payment.</p>
                    </div>
                    <input
                      value={overrideReason}
                      onChange={e => setOverrideReason(e.target.value)}
                      placeholder="Reason (optional)"
                      className="w-full px-2.5 py-1.5 text-xs border border-amber-300 rounded bg-white"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => { setOverrideForId(null); setOverrideReason(""); }}
                        className="flex-1 px-2.5 py-1.5 text-xs font-semibold border border-border rounded hover:bg-white"
                      >
                        Back
                      </button>
                      <button
                        onClick={() => {
                          const reason = overrideReason;
                          setOverrideForId(null);
                          setOverrideReason("");
                          onOverride(o, reason);
                        }}
                        className="flex-1 px-2.5 py-1.5 text-xs font-bold bg-amber-600 text-white rounded hover:bg-amber-700"
                      >
                        Send unpaid
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
