import { useState, useEffect, useRef, useCallback } from "react";
import { ChefHat, Lock, RefreshCw, Bell, Phone, Check, Undo2, Package, Infinity, Save, Volume2, VolumeX, CalendarDays, Loader2, LogOut, Info } from "lucide-react";

const SESSION_KEY = "event_auth_password";
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const POLL_INTERVAL = 6000;
const LS_KEY = "kitchen_item_checks";

type OrderItem = { itemId: number; name: string; quantity: number; price: number; internalNotes?: string | null };
type StockItem = { id: number; name: string; category: string; eventStock: number | null; imageUrl: string | null };
type EventOrder = {
  id: number;
  guestName: string;
  tableNumber: string | null;
  phoneNumber: string | null;
  items: OrderItem[];
  status: "pending" | "preparing" | "ready" | "done";
  createdAt: string;
};

// localStorage helpers — persist checked item sets across polls
function loadChecked(): Record<number, number[]> {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? "{}"); } catch { return {}; }
}
function saveChecked(data: Record<number, number[]>) {
  localStorage.setItem(LS_KEY, JSON.stringify(data));
}

const STATUS_CONFIG = {
  pending:   { label: "New",       color: "bg-red-100 text-red-700 border-red-200",     ring: "ring-2 ring-red-300"  },
  preparing: { label: "Preparing", color: "bg-amber-100 text-amber-700 border-amber-200", ring: "ring-2 ring-amber-300" },
  ready:     { label: "Ready",     color: "bg-emerald-100 text-emerald-700 border-emerald-200", ring: "ring-2 ring-emerald-300" },
  done:      { label: "Done",      color: "bg-secondary text-muted-foreground border-border", ring: "" },
};

const NEXT_STATUS: Record<string, string> = {
  pending: "preparing",
  preparing: "ready",
  ready: "done",
};

const NEXT_LABEL: Record<string, string> = {
  preparing: "Mark Ready",
  ready: "Complete",
};

function playChime() {
  try {
    const ctx = new AudioContext();
    // Three-note ascending chime: C5 → E5 → G5
    const notes = [523.25, 659.25, 783.99];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.18;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.28, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
      osc.start(t);
      osc.stop(t + 0.7);
    });
  } catch { /* AudioContext blocked — silently skip */ }
}

function timeAgo(dateStr: string) {
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}


export default function KitchenDisplay() {
  const [eventName, setEventName] = useState("");

  const [password, setPassword] = useState("");
  const [authedPassword, setAuthedPassword] = useState<string | null>(() => sessionStorage.getItem(SESSION_KEY));
  const [loginError, setLoginError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);

  useEffect(() => {
    fetch(`${BASE}/api/event-ordering/settings`)
      .then(r => r.json())
      .then(data => setEventName(data.eventName ?? ""))
      .catch(() => {});
  }, []);

  const [orders, setOrders] = useState<EventOrder[]>([]);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);
  const [newOrderIds, setNewOrderIds] = useState<Set<number>>(new Set());
  const [updating, setUpdating] = useState<Set<number>>(new Set());
  const prevOrderIds = useRef<Set<number>>(new Set());
  const [showDone, setShowDone] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(() => localStorage.getItem("kitchen_sound") !== "off");
  const soundEnabledRef = useRef(soundEnabled);
  useEffect(() => { soundEnabledRef.current = soundEnabled; }, [soundEnabled]);
  function toggleSound() {
    setSoundEnabled(prev => {
      const next = !prev;
      localStorage.setItem("kitchen_sound", next ? "on" : "off");
      return next;
    });
  }

  function signOut() {
    sessionStorage.removeItem(SESSION_KEY);
    setAuthedPassword(null);
    setOrders([]);
    setLastFetch(null);
  }

  // Session prompt — shown when event name has changed since last visit
  const [sessionPrompt, setSessionPrompt] = useState<{ prevName: string } | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);
  const hasCheckedPrompt = useRef(false);

  useEffect(() => {
    if (!authedPassword || !eventName || hasCheckedPrompt.current) return;
    hasCheckedPrompt.current = true;
    const stored = localStorage.getItem("kitchen_known_event_name");
    if (stored !== null && stored !== eventName) {
      setSessionPrompt({ prevName: stored });
    } else {
      localStorage.setItem("kitchen_known_event_name", eventName);
    }
  }, [authedPassword, eventName]);

  async function handleCreateSession() {
    if (!authedPassword) return;
    setCreatingSession(true);
    try {
      const res = await fetch(`${BASE}/api/event-ordering/create-session`, {
        method: "POST",
        headers: { Authorization: `Bearer ${authedPassword}` },
      });
      if (res.ok) {
        localStorage.setItem("kitchen_known_event_name", eventName);
        setSessionPrompt(null);
      }
    } catch { /* silent */ } finally {
      setCreatingSession(false);
    }
  }

  function dismissSessionPrompt() {
    localStorage.setItem("kitchen_known_event_name", eventName);
    setSessionPrompt(null);
  }

  const [view, setView] = useState<"orders" | "stock">("orders");
  const [stockItems, setStockItems] = useState<StockItem[]>([]);
  const [stockEdits, setStockEdits] = useState<Record<number, string>>({});
  const [stockSaving, setStockSaving] = useState<Set<number>>(new Set());

  const fetchStock = useCallback(async (pwd: string) => {
    try {
      const res = await fetch(`${BASE}/api/event-ordering/stock`, {
        headers: { Authorization: `Bearer ${pwd}` },
      });
      if (res.ok) {
        const data: StockItem[] = await res.json();
        setStockItems(data);
        setStockEdits(prev => {
          const next = { ...prev };
          data.forEach(item => {
            if (!(item.id in next)) {
              next[item.id] = item.eventStock === null ? "" : String(item.eventStock);
            }
          });
          return next;
        });
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (authedPassword && view === "stock") fetchStock(authedPassword);
  }, [authedPassword, view, fetchStock]);

  async function saveStockItem(itemId: number, value: string | null) {
    if (!authedPassword) return;
    const stock = value === null || value.trim() === "" ? null : parseInt(value);
    if (value !== null && value.trim() !== "" && (isNaN(stock!) || stock! < 0)) return;
    setStockSaving(s => new Set([...s, itemId]));
    try {
      const res = await fetch(`${BASE}/api/event-ordering/stock/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authedPassword}` },
        body: JSON.stringify({ eventStock: stock ?? null }),
      });
      if (res.ok) {
        const updated = await res.json();
        setStockItems(prev => prev.map(i => i.id === itemId ? { ...i, eventStock: updated.eventStock } : i));
        setStockEdits(prev => ({ ...prev, [itemId]: updated.eventStock === null ? "" : String(updated.eventStock) }));
      }
    } finally {
      setStockSaving(s => { const n = new Set(s); n.delete(itemId); return n; });
    }
  }

  // checkedItems: orderId → Set of itemIds that have been individually marked
  const [checkedItems, setCheckedItems] = useState<Record<number, Set<number>>>(() => {
    const raw = loadChecked();
    const result: Record<number, Set<number>> = {};
    for (const [k, v] of Object.entries(raw)) result[Number(k)] = new Set(v);
    return result;
  });

  // Sync checkedItems to localStorage whenever it changes
  useEffect(() => {
    const serializable: Record<number, number[]> = {};
    for (const [k, v] of Object.entries(checkedItems)) serializable[Number(k)] = [...v];
    saveChecked(serializable);
  }, [checkedItems]);

  // Clean up checked state for orders that have moved past preparing (ready/done)
  useEffect(() => {
    const activeIds = new Set(orders.filter(o => o.status === "pending" || o.status === "preparing").map(o => o.id));
    setCheckedItems(prev => {
      const cleaned: Record<number, Set<number>> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (activeIds.has(Number(k))) cleaned[Number(k)] = v;
      }
      return cleaned;
    });
  }, [orders]);

  const fetchOrders = useCallback(async (pwd: string) => {
    try {
      const res = await fetch(`${BASE}/api/event-ordering/orders`, {
        headers: { Authorization: `Bearer ${pwd}` },
        cache: "no-store",
      });
      // 304 means no change — update timestamp but don't parse body
      if (res.status === 304) { setLastFetch(new Date()); return; }
      // 401 means the stored password is invalid — clear session and return to login
      if (res.status === 401) {
        sessionStorage.removeItem(SESSION_KEY);
        setAuthedPassword(null);
        return;
      }
      if (!res.ok) return;
      const data: EventOrder[] = await res.json();
      const incoming = new Set(data.map(o => o.id));
      const fresh = new Set([...incoming].filter(id => !prevOrderIds.current.has(id)));
      if (fresh.size > 0 && prevOrderIds.current.size > 0) {
        setNewOrderIds(s => new Set([...s, ...fresh]));
        if (soundEnabledRef.current) playChime();
        if ("vibrate" in navigator) navigator.vibrate([200, 100, 200]);
      }
      prevOrderIds.current = incoming;
      setOrders(data);
      setLastFetch(new Date());
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    if (!authedPassword) return;
    fetchOrders(authedPassword);
    const id = setInterval(() => fetchOrders(authedPassword), POLL_INTERVAL);
    return () => clearInterval(id);
  }, [authedPassword, fetchOrders]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginLoading(true);
    setLoginError("");
    try {
      const res = await fetch(`${BASE}/api/event-ordering/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, role: "kitchen" }),
      });
      if (res.ok) {
        sessionStorage.setItem(SESSION_KEY, password);
        setAuthedPassword(password);
      } else {
        setLoginError("Incorrect password.");
      }
    } catch {
      setLoginError("Connection error.");
    } finally {
      setLoginLoading(false);
    }
  }

  async function revertStatus(order: EventOrder) {
    if (order.status !== "preparing" || !authedPassword) return;
    setUpdating(s => new Set([...s, order.id]));
    try {
      const res = await fetch(`${BASE}/api/event-ordering/orders/${order.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authedPassword}` },
        body: JSON.stringify({ status: "pending" }),
      });
      if (res.ok) {
        const updated: EventOrder = await res.json();
        setOrders(prev => prev.map(o => o.id === updated.id ? updated : o));
        // Reset item checks so staff can re-mark from scratch
        setCheckedItems(prev => ({ ...prev, [order.id]: new Set() }));
      }
    } finally {
      setUpdating(s => { const n = new Set(s); n.delete(order.id); return n; });
    }
  }

  async function advanceStatus(order: EventOrder) {
    const next = NEXT_STATUS[order.status];
    if (!next || !authedPassword) return;
    setUpdating(s => new Set([...s, order.id]));
    setNewOrderIds(s => { const n = new Set(s); n.delete(order.id); return n; });
    try {
      const res = await fetch(`${BASE}/api/event-ordering/orders/${order.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authedPassword}` },
        body: JSON.stringify({ status: next }),
      });
      if (res.ok) {
        const updated: EventOrder = await res.json();
        setOrders(prev => prev.map(o => o.id === updated.id ? updated : o));
        // Clear checked state once order has advanced past pending
        if (order.status === "pending") {
          setCheckedItems(prev => {
            const next = { ...prev };
            delete next[order.id];
            return next;
          });
        }
      }
    } finally {
      setUpdating(s => { const n = new Set(s); n.delete(order.id); return n; });
    }
  }

  function toggleItemCheck(orderId: number, itemId: number, allItemIds: number[]) {
    setCheckedItems(prev => {
      const current = new Set(prev[orderId] ?? []);
      if (current.has(itemId)) {
        current.delete(itemId);
      } else {
        current.add(itemId);
      }
      const updated = { ...prev, [orderId]: current };

      // Auto-advance when all items are checked
      if (current.size === allItemIds.length) {
        const order = orders.find(o => o.id === orderId);
        if (order && order.status === "pending") {
          // Small delay so the last checkmark is visible before advancing
          setTimeout(() => advanceStatus(order), 500);
        }
      }

      return updated;
    });
  }

  if (!authedPassword) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-foreground rounded-2xl flex items-center justify-center mx-auto mb-4">
              <ChefHat className="w-8 h-8 text-background" />
            </div>
            <h1 className="font-display font-bold text-3xl">Kitchen Display</h1>
            <p className="text-muted-foreground mt-2 text-sm">{eventName ? `${eventName} · dash by Hollywood East Cafe` : "dash by Hollywood East Cafe"}</p>
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
            <button type="submit" disabled={loginLoading} className="w-full py-3 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-50">
              {loginLoading ? "Checking…" : "Open Kitchen Display"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const activeOrders = orders.filter(o => o.status !== "done");
  const doneOrders = orders.filter(o => o.status === "done");
  const displayed = showDone ? orders : activeOrders;

  const grouped: Record<string, EventOrder[]> = { pending: [], preparing: [], ready: [] };
  displayed.filter(o => o.status !== "done").forEach(o => grouped[o.status]?.push(o));

  return (
    <div className="min-h-screen bg-[#111] text-white">

      {/* New session prompt */}
      {sessionPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="bg-[#1e1e1e] border border-white/10 rounded-2xl shadow-2xl w-full max-w-sm">
            <div className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center shrink-0">
                  <CalendarDays className="w-5 h-5 text-amber-400" />
                </div>
                <div>
                  <h2 className="font-bold text-base">New event detected</h2>
                  <p className="text-xs text-white/50">The event name has changed</p>
                </div>
              </div>
              <div className="bg-white/5 rounded-xl p-4 mb-5 space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-white/40 w-16 shrink-0">Before</span>
                  <span className="text-white/60 line-through">{sessionPrompt.prevName}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-white/40 w-16 shrink-0">Now</span>
                  <span className="text-amber-300 font-semibold">{eventName}</span>
                </div>
              </div>
              <p className="text-sm text-white/60 mb-5">
                Start a new event session so orders are tracked separately for <span className="text-white font-medium">"{eventName}"</span>?
              </p>
              <div className="flex gap-3">
                <button
                  onClick={dismissSessionPrompt}
                  className="flex-1 px-4 py-2.5 rounded-xl border border-white/10 text-white/60 hover:bg-white/5 hover:text-white transition-colors text-sm font-medium"
                >
                  Continue without
                </button>
                <button
                  onClick={handleCreateSession}
                  disabled={creatingSession}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-black font-bold transition-colors text-sm disabled:opacity-50"
                >
                  {creatingSession ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarDays className="w-4 h-4" />}
                  {creatingSession ? "Creating…" : "Start session"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <header className="sticky top-0 z-30 bg-[#1a1a1a] border-b border-white/10 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ChefHat className="w-6 h-6 text-amber-400" />
            <div>
              <h1 className="font-display font-bold text-xl">{eventName || "Kitchen Display"}</h1>
              <p className="text-xs text-white/50">{lastFetch ? `Updated ${timeAgo(lastFetch.toISOString())}` : "Loading…"}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {newOrderIds.size > 0 && (
              <div className="flex items-center gap-2 bg-red-500 text-white px-3 py-1.5 rounded-full text-sm font-bold animate-pulse">
                <Bell className="w-4 h-4" />
                {newOrderIds.size} new
              </div>
            )}
            <div className="flex items-center gap-2 text-sm text-white/50">
              <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              Live · {activeOrders.length} active
            </div>
            <button
              onClick={toggleSound}
              title={soundEnabled ? "Mute chime" : "Unmute chime"}
              className={`p-2 rounded-lg transition-colors ${soundEnabled ? "hover:bg-white/10 text-white/60 hover:text-white" : "bg-red-500/20 text-red-400 hover:bg-red-500/30"}`}
            >
              {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
            </button>
            <button
              onClick={signOut}
              title="Sign out of kitchen display"
              className="p-2 rounded-lg hover:bg-white/10 text-white/30 hover:text-white/70 transition-colors"
            >
              <LogOut className="w-4 h-4" />
            </button>
            <div className="flex items-center gap-1 bg-white/10 rounded-lg p-1">
              <button
                onClick={() => setView("orders")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${view === "orders" ? "bg-white text-black" : "text-white/60 hover:text-white"}`}
              >
                <ChefHat className="w-3.5 h-3.5" /> Orders
              </button>
              <button
                onClick={() => setView("stock")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${view === "stock" ? "bg-white text-black" : "text-white/60 hover:text-white"}`}
              >
                <Package className="w-3.5 h-3.5" /> Stock
              </button>
            </div>
            {view === "orders" && (
              <>
                <button onClick={() => fetchOrders(authedPassword!)} className="p-2 hover:bg-white/10 rounded-lg transition-colors">
                  <RefreshCw className="w-4 h-4 text-white/50" />
                </button>
                <button
                  onClick={() => setShowDone(s => !s)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${showDone ? "bg-white/20 text-white" : "bg-white/10 text-white/60 hover:bg-white/15"}`}
                >
                  {showDone ? "Hide done" : `Show done (${doneOrders.length})`}
                </button>
              </>
            )}
            {view === "stock" && (
              <button onClick={() => authedPassword && fetchStock(authedPassword)} className="p-2 hover:bg-white/10 rounded-lg transition-colors">
                <RefreshCw className="w-4 h-4 text-white/50" />
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 py-6">
        {view === "stock" && (
          <div className="max-w-2xl mx-auto">
            <p className="text-white/40 text-sm mb-6">Set stock to a number to limit how many can be ordered. Leave blank (∞) for unlimited.</p>
            {stockItems.length === 0 ? (
              <div className="text-center py-16 text-white/30">
                <Package className="w-10 h-10 mx-auto mb-3 opacity-40" />
                <p className="font-semibold">No event-active items</p>
                <p className="text-xs mt-1">Enable items for event ordering in the admin menu</p>
              </div>
            ) : (
              <div className="space-y-2">
                {Array.from(new Set(stockItems.map(i => i.category))).map(cat => (
                  <div key={cat}>
                    <p className="text-white/30 text-xs font-bold uppercase tracking-wider mt-4 mb-2">{cat}</p>
                    {stockItems.filter(i => i.category === cat).map(item => {
                      const edit = stockEdits[item.id] ?? (item.eventStock === null ? "" : String(item.eventStock));
                      const saving = stockSaving.has(item.id);
                      const isUnlimited = item.eventStock === null;
                      const isSoldOut = item.eventStock === 0;
                      return (
                        <div key={item.id} className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-2xl px-4 py-3">
                          {item.imageUrl && (
                            <img src={item.imageUrl} alt={item.name} className="w-10 h-10 rounded-lg object-cover shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-white truncate">{item.name}</p>
                            <p className={`text-xs font-medium mt-0.5 ${isSoldOut ? "text-red-400" : isUnlimited ? "text-emerald-400" : item.eventStock! <= 5 ? "text-amber-400" : "text-white/40"}`}>
                              {isSoldOut ? "Sold out" : isUnlimited ? "Unlimited" : `${item.eventStock} remaining`}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              onClick={() => saveStockItem(item.id, String(Math.max(0, (item.eventStock ?? 0) - 1)))}
                              disabled={saving || isUnlimited}
                              className="w-8 h-8 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white text-sm font-bold disabled:opacity-30 transition-colors"
                            >−</button>
                            <input
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              value={edit}
                              placeholder="∞"
                              onChange={e => {
                                const v = e.target.value.replace(/[^0-9]/g, "");
                                setStockEdits(prev => ({ ...prev, [item.id]: v }));
                              }}
                              onBlur={() => saveStockItem(item.id, edit || null)}
                              onKeyDown={e => { if (e.key === "Enter") saveStockItem(item.id, edit || null); }}
                              className="w-16 text-center bg-white/10 border border-white/20 rounded-lg px-2 py-1.5 text-sm font-bold text-white placeholder:text-white/30 outline-none focus:border-white/40"
                            />
                            <button
                              onClick={() => saveStockItem(item.id, String((item.eventStock ?? 0) + 1))}
                              disabled={saving}
                              className="w-8 h-8 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white text-sm font-bold disabled:opacity-30 transition-colors"
                            >+</button>
                            <button
                              onClick={() => saveStockItem(item.id, null)}
                              disabled={saving}
                              title="Set unlimited"
                              className={`w-8 h-8 flex items-center justify-center rounded-full transition-colors ${isUnlimited ? "bg-emerald-500/30 text-emerald-400" : "bg-white/10 hover:bg-white/20 text-white/50"}`}
                            >
                              <Infinity className="w-4 h-4" />
                            </button>
                            {saving && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {view === "orders" && (
          <>
            {orders.length === 0 ? (
              <div className="text-center py-24 text-white/30">
                <ChefHat className="w-12 h-12 mx-auto mb-4 opacity-30" />
                <p className="text-xl font-semibold">No orders yet</p>
                <p className="text-sm mt-1">Orders placed at the event will appear here in real-time</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {(["pending", "preparing", "ready"] as const).map(status => (
                  <div key={status}>
                    <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider mb-4 border ${STATUS_CONFIG[status].color}`}>
                      <span className={`w-2 h-2 rounded-full ${status === "pending" ? "bg-red-500 animate-pulse" : status === "preparing" ? "bg-amber-500" : "bg-emerald-500"}`} />
                      {STATUS_CONFIG[status].label} ({grouped[status]?.length ?? 0})
                    </div>
                    <div className="space-y-4">
                      {grouped[status]?.map(order => (
                        <OrderCard
                          key={order.id}
                          order={order}
                          isNew={newOrderIds.has(order.id)}
                          isUpdating={updating.has(order.id)}
                          checkedItemIds={checkedItems[order.id] ?? new Set()}
                          onToggleItem={(itemId) => toggleItemCheck(order.id, itemId, order.items.map(i => i.itemId))}
                          onAdvance={() => advanceStatus(order)}
                          onRevert={() => revertStatus(order)}
                        />
                      ))}
                      {!grouped[status]?.length && (
                        <div className="text-center py-8 text-white/20 text-sm border border-white/5 rounded-2xl">Empty</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {showDone && doneOrders.length > 0 && (
              <div className="mt-8">
                <h3 className="text-white/40 text-sm font-semibold uppercase tracking-wider mb-3">Completed</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {doneOrders.map(order => (
                    <OrderCard key={order.id} order={order} isNew={false} isUpdating={false} checkedItemIds={new Set()} onToggleItem={() => {}} onAdvance={() => {}} onRevert={() => {}} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function OrderCard({ order, isNew, isUpdating, checkedItemIds, onToggleItem, onAdvance, onRevert }: {
  order: EventOrder;
  isNew: boolean;
  isUpdating: boolean;
  checkedItemIds: Set<number>;
  onToggleItem: (itemId: number) => void;
  onAdvance: () => void;
  onRevert: () => void;
}) {
  const [expandedNotes, setExpandedNotes] = useState<Set<number>>(new Set());
  const toggleNote = (itemId: number) => setExpandedNotes(prev => {
    const next = new Set(prev);
    if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
    return next;
  });

  const isPending = order.status === "pending";
  const isPreparing = order.status === "preparing";
  const isTrackable = isPending || isPreparing;
  const checkedCount = order.items.filter(i => checkedItemIds.has(i.itemId)).length;
  const allChecked = checkedCount === order.items.length;
  const nextLabel = NEXT_LABEL[order.status];

  return (
    <div className={`bg-[#1a1a1a] border rounded-2xl overflow-hidden transition-all ${isNew ? "ring-2 ring-red-400 border-red-400/50" : "border-white/10"}`}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/10 flex justify-between items-start">
        <div>
          <p className="font-bold">{order.guestName}</p>
          <div className="flex items-center gap-2 mt-0.5">
            {order.tableNumber && <p className="text-xs text-white/50">{order.tableNumber}</p>}
            {order.phoneNumber && (
              <span className="flex items-center gap-1 text-xs text-emerald-400/80">
                <Phone className="w-3 h-3" />
                SMS
              </span>
            )}
          </div>
        </div>
        <div className="text-right">
          <p className="text-xs text-white/40">{timeAgo(order.createdAt)}</p>
          <p className="text-xs font-semibold text-white/60">#{order.id}</p>
        </div>
      </div>

      {/* Items — tappable when pending or preparing */}
      <div className="px-4 py-3 space-y-1">
        {isTrackable && (
          <p className="text-xs text-white/30 font-semibold uppercase tracking-wider pb-1.5">
            Tap each item to mark · {checkedCount}/{order.items.length}
          </p>
        )}
        {order.items.map(item => {
          const isChecked = checkedItemIds.has(item.itemId);
          const hasNotes = Boolean(item.internalNotes);
          const notesOpen = expandedNotes.has(item.itemId);
          if (isTrackable) {
            return (
              <div key={item.itemId}>
                <div className={`w-full flex items-center justify-between rounded-xl px-3 py-2.5 transition-all ${
                  isChecked
                    ? "bg-emerald-500/15 border border-emerald-500/30"
                    : "bg-white/5 border border-white/10"
                }`}>
                  <button
                    type="button"
                    onClick={() => onToggleItem(item.itemId)}
                    className="flex-1 text-left active:scale-[0.98]"
                  >
                    <span className={`text-sm font-medium transition-all ${isChecked ? "text-emerald-400 line-through decoration-emerald-500/60" : "text-white/80"}`}>
                      {item.quantity}× {item.name}
                    </span>
                  </button>
                  <div className="flex items-center gap-1.5 shrink-0 ml-3">
                    {hasNotes && (
                      <button
                        type="button"
                        onClick={() => toggleNote(item.itemId)}
                        className={`w-6 h-6 rounded-full flex items-center justify-center transition-colors ${notesOpen ? "bg-amber-500/30 text-amber-400" : "bg-white/10 text-white/40 hover:text-amber-400 hover:bg-amber-500/20"}`}
                        title="Kitchen note"
                      >
                        <Info className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center transition-all ${
                      isChecked ? "bg-emerald-500 text-black" : "bg-white/10"
                    }`}>
                      {isChecked && <Check className="w-3.5 h-3.5" strokeWidth={3} />}
                    </div>
                  </div>
                </div>
                {hasNotes && notesOpen && (
                  <div className="mt-1 mb-1 ml-3 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-300 leading-snug">
                    {item.internalNotes}
                  </div>
                )}
              </div>
            );
          }
          return (
            <div key={item.itemId}>
              <div className="flex items-center gap-2 px-1">
                <span className="text-sm text-white/80">{item.quantity}× {item.name}</span>
                {hasNotes && (
                  <button
                    type="button"
                    onClick={() => toggleNote(item.itemId)}
                    className={`w-5 h-5 rounded-full flex items-center justify-center transition-colors shrink-0 ${notesOpen ? "bg-amber-500/30 text-amber-400" : "bg-white/10 text-white/30 hover:text-amber-400"}`}
                    title="Kitchen note"
                  >
                    <Info className="w-3 h-3" />
                  </button>
                )}
              </div>
              {hasNotes && notesOpen && (
                <div className="mt-1 ml-6 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-300 leading-snug">
                  {item.internalNotes}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Progress bar for pending and preparing orders */}
      {isTrackable && (
        <div className="px-4 pb-3">
          <div className="h-1 bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all duration-300"
              style={{ width: order.items.length > 0 ? `${(checkedCount / order.items.length) * 100}%` : "0%" }}
            />
          </div>
          {isUpdating && (
            <p className="text-xs text-amber-400 text-center mt-2 font-semibold">{isPending ? "Moving to Preparing…" : "Marking Ready…"}</p>
          )}
        </div>
      )}

      {/* Action button for preparing / ready */}
      {nextLabel && !isPending && (
        <div className="px-4 pb-4 space-y-2">
          <button
            onClick={onAdvance}
            disabled={isUpdating}
            className={`w-full py-2.5 rounded-xl text-sm font-bold transition-colors disabled:opacity-50 ${
              order.status === "preparing" ? "bg-emerald-500 hover:bg-emerald-400 text-black" :
              "bg-white/10 hover:bg-white/20 text-white"
            }`}
          >
            {isUpdating ? "Updating…" : nextLabel}
          </button>
          {order.status === "preparing" && (
            <button
              onClick={onRevert}
              disabled={isUpdating}
              className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-xl text-xs font-medium text-white/40 hover:text-white/70 hover:bg-white/5 transition-colors disabled:opacity-30"
            >
              <Undo2 size={12} />
              Undo — move back to New
            </button>
          )}
        </div>
      )}

      {order.status === "done" && (
        <div className="px-4 pb-3 text-center text-xs text-white/20 font-semibold">Completed</div>
      )}
    </div>
  );
}
