import { useState, useEffect, useRef, useCallback } from "react";
import { ChefHat, Lock, RefreshCw, Bell, Phone, Check } from "lucide-react";

const SESSION_KEY = "event_auth_password";
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const POLL_INTERVAL = 6000;
const LS_KEY = "kitchen_item_checks";

type OrderItem = { itemId: number; name: string; quantity: number; price: number };
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

function timeAgo(dateStr: string) {
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
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

  // Clean up checked state for orders that have moved out of pending
  useEffect(() => {
    const pendingIds = new Set(orders.filter(o => o.status === "pending").map(o => o.id));
    setCheckedItems(prev => {
      const cleaned: Record<number, Set<number>> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (pendingIds.has(Number(k))) cleaned[Number(k)] = v;
      }
      return cleaned;
    });
  }, [orders]);

  const fetchOrders = useCallback(async (pwd: string) => {
    try {
      const res = await fetch(`${BASE}/api/event-ordering/orders`, {
        headers: { Authorization: `Bearer ${pwd}` },
      });
      if (!res.ok) return;
      const data: EventOrder[] = await res.json();
      const incoming = new Set(data.map(o => o.id));
      const fresh = new Set([...incoming].filter(id => !prevOrderIds.current.has(id)));
      if (fresh.size > 0 && prevOrderIds.current.size > 0) {
        setNewOrderIds(s => new Set([...s, ...fresh]));
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
        body: JSON.stringify({ password }),
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
            <button onClick={() => fetchOrders(authedPassword!)} className="p-2 hover:bg-white/10 rounded-lg transition-colors">
              <RefreshCw className="w-4 h-4 text-white/50" />
            </button>
            <button
              onClick={() => setShowDone(s => !s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${showDone ? "bg-white/20 text-white" : "bg-white/10 text-white/60 hover:bg-white/15"}`}
            >
              {showDone ? "Hide done" : `Show done (${doneOrders.length})`}
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 py-6">
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
                <OrderCard key={order.id} order={order} isNew={false} isUpdating={false} checkedItemIds={new Set()} onToggleItem={() => {}} onAdvance={() => {}} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function OrderCard({ order, isNew, isUpdating, checkedItemIds, onToggleItem, onAdvance }: {
  order: EventOrder;
  isNew: boolean;
  isUpdating: boolean;
  checkedItemIds: Set<number>;
  onToggleItem: (itemId: number) => void;
  onAdvance: () => void;
}) {
  const total = order.items.reduce((s, i) => s + i.price * i.quantity, 0);
  const isPending = order.status === "pending";
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

      {/* Items — tappable when pending */}
      <div className="px-4 py-3 space-y-1">
        {isPending && (
          <p className="text-xs text-white/30 font-semibold uppercase tracking-wider pb-1.5">
            Tap each item to mark · {checkedCount}/{order.items.length}
          </p>
        )}
        {order.items.map(item => {
          const isChecked = checkedItemIds.has(item.itemId);
          if (isPending) {
            return (
              <button
                key={item.itemId}
                type="button"
                onClick={() => onToggleItem(item.itemId)}
                className={`w-full flex items-center justify-between rounded-xl px-3 py-2.5 transition-all text-left ${
                  isChecked
                    ? "bg-emerald-500/15 border border-emerald-500/30"
                    : "bg-white/5 border border-white/10 hover:bg-white/10 active:scale-[0.98]"
                }`}
              >
                <span className={`text-sm font-medium transition-all ${isChecked ? "text-emerald-400 line-through decoration-emerald-500/60" : "text-white/80"}`}>
                  {item.quantity}× {item.name}
                </span>
                <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ml-3 transition-all ${
                  isChecked ? "bg-emerald-500 text-black" : "bg-white/10"
                }`}>
                  {isChecked && <Check className="w-3.5 h-3.5" strokeWidth={3} />}
                </div>
              </button>
            );
          }
          return (
            <div key={item.itemId} className="flex justify-between text-sm px-1">
              <span className="text-white/80">{item.quantity}× {item.name}</span>
              <span className="text-white/40 text-xs">{formatCurrency(item.price * item.quantity)}</span>
            </div>
          );
        })}

        {/* Total — only shown when not pending (pending items take up more space) */}
        {!isPending && (
          <div className="flex justify-between pt-2 border-t border-white/10 text-xs font-bold text-white/50 px-1">
            <span>Total</span>
            <span>{formatCurrency(total)}</span>
          </div>
        )}
      </div>

      {/* Progress bar for pending orders */}
      {isPending && (
        <div className="px-4 pb-3">
          <div className="h-1 bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all duration-300"
              style={{ width: order.items.length > 0 ? `${(checkedCount / order.items.length) * 100}%` : "0%" }}
            />
          </div>
          {isUpdating && (
            <p className="text-xs text-amber-400 text-center mt-2 font-semibold">Moving to Preparing…</p>
          )}
        </div>
      )}

      {/* Action button for preparing / ready */}
      {nextLabel && !isPending && (
        <div className="px-4 pb-4">
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
        </div>
      )}

      {order.status === "done" && (
        <div className="px-4 pb-3 text-center text-xs text-white/20 font-semibold">Completed</div>
      )}
    </div>
  );
}
