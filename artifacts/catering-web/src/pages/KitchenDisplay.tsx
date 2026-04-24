import { useState, useEffect, useRef, useCallback } from "react";
import { ChefHat, Lock, RefreshCw, Bell, Phone, Check, Undo2, Package, Infinity, Save, Volume2, VolumeX, CalendarDays, Loader2, LogOut, Info, Receipt, Printer, Pause, Play, Ban, ShoppingBag, Users, X, AlertTriangle, Minus, Plus } from "lucide-react";

const SESSION_KEY = "event_auth_password";
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const POLL_INTERVAL = 6000;
const STOCK_POLL_INTERVAL = 15000;
const LS_KEY = "kitchen_item_checks";
const LOW_STOCK_LS_KEY = "kitchen_low_stock_seen";
const DEFAULT_LOW_STOCK_THRESHOLD = 5;
const LOW_STOCK_THRESHOLD_MIN = 1;
const LOW_STOCK_THRESHOLD_MAX = 20;
const LOW_STOCK_TOAST_TTL = 12000;

function loadLowStockSeen(): Set<number> {
  try {
    const raw = JSON.parse(localStorage.getItem(LOW_STOCK_LS_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x): x is number => typeof x === "number") : []);
  } catch {
    return new Set();
  }
}
function saveLowStockSeen(s: Set<number>) {
  localStorage.setItem(LOW_STOCK_LS_KEY, JSON.stringify([...s]));
}

type OrderItem = { itemId: number; name: string; quantity: number; price: number; internalNotes?: string | null };
type StockItem = {
  id: number;
  name: string;
  category: string;
  eventStock: number | null;
  imageUrl: string | null;
  eventActive?: boolean;
  eventTakerVisible?: boolean;
};
// Optional staff plating layout (set in the POS payment modal). When present
// the kitchen renders one ticket with "Fire totals" + per-plate cards.
type PlateGroup = { label: string; items: { itemId: number; quantity: number }[] };

type KitchenProgressLine = { itemId: number; quantity: number; packed: number };
type KitchenProgress = {
  plates: { items: KitchenProgressLine[] }[];
  unassigned: KitchenProgressLine[];
};

type EventOrder = {
  id: number;
  guestName: string;
  tableNumber: string | null;
  phoneNumber: string | null;
  items: OrderItem[];
  status: "pending" | "preparing" | "ready" | "done" | "picked_up";
  createdAt: string;
  orderSource?: "guest" | "staff" | string;
  paymentStatus?: "paid" | "unpaid" | "override" | string;
  subtotal?: number | null;
  taxRate?: number | null;
  taxAmount?: number | null;
  total?: number | null;
  plateGroups?: PlateGroup[] | null;
  kitchenProgress?: KitchenProgress | null;
};

// Local mirror of the server's buildEmptyKitchenProgress — used to derive
// per-plate / per-line packed state when the server hasn't materialized
// kitchen_progress yet (e.g. cook hasn't tapped anything). Keeps the UI
// consistent before the first PATCH round-trip.
function deriveKitchenProgress(order: EventOrder): KitchenProgress | null {
  if (!order.plateGroups || order.plateGroups.length === 0) return null;
  if (order.kitchenProgress) return order.kitchenProgress;
  const plates = order.plateGroups.map(p => ({
    items: p.items.map(i => ({ itemId: i.itemId, quantity: i.quantity, packed: 0 })),
  }));
  const allocByItem = new Map<number, number>();
  for (const p of order.plateGroups) {
    for (const ln of p.items) allocByItem.set(ln.itemId, (allocByItem.get(ln.itemId) ?? 0) + ln.quantity);
  }
  const unassigned: KitchenProgressLine[] = [];
  for (const ci of order.items) {
    const left = ci.quantity - (allocByItem.get(ci.itemId) ?? 0);
    if (left > 0) unassigned.push({ itemId: ci.itemId, quantity: left, packed: 0 });
  }
  return { plates, unassigned };
}

function plateLinePacked(progress: KitchenProgress | null, plateIdx: number | "unassigned", itemId: number): boolean {
  if (!progress) return false;
  const lines = plateIdx === "unassigned" ? progress.unassigned : progress.plates[plateIdx]?.items;
  const line = lines?.find(l => l.itemId === itemId);
  return !!line && line.quantity > 0 && line.packed >= line.quantity;
}

function plateAllPacked(progress: KitchenProgress | null, plateIdx: number): boolean {
  if (!progress) return false;
  const plate = progress.plates[plateIdx];
  if (!plate || plate.items.length === 0) return false;
  return plate.items.every(l => l.packed >= l.quantity);
}

// Build a per-itemId lookup for displaying names in plate cards. Item names
// live on `items[]` (cart) — plate entries only carry `{itemId, quantity}`.
function nameByItemId(order: EventOrder): Map<number, string> {
  const m = new Map<number, string>();
  for (const i of order.items) m.set(i.itemId, i.name);
  return m;
}

// Compute "unassigned" units per item (cart qty minus sum across plates).
// Returned in cart order so the kitchen sees them in the same sequence.
function unassignedItems(order: EventOrder): { itemId: number; name: string; quantity: number }[] {
  if (!order.plateGroups || order.plateGroups.length === 0) return [];
  const allocByItem = new Map<number, number>();
  for (const p of order.plateGroups) {
    for (const ln of p.items) allocByItem.set(ln.itemId, (allocByItem.get(ln.itemId) ?? 0) + ln.quantity);
  }
  const out: { itemId: number; name: string; quantity: number }[] = [];
  for (const ci of order.items) {
    const left = ci.quantity - (allocByItem.get(ci.itemId) ?? 0);
    if (left > 0) out.push({ itemId: ci.itemId, name: ci.name, quantity: left });
  }
  return out;
}

type PrintJob = { order: EventOrder; mode: "receipt" | "kitchen" };

const COMPLETED_STATUSES = new Set(["done", "picked_up"]);

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
  picked_up: { label: "Picked Up", color: "bg-secondary text-muted-foreground border-border", ring: "" },
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

// For staff (POS) orders, replace the generic "Complete" with explicit pickup tracking.
function nextStatusFor(order: EventOrder): string | undefined {
  if (order.status === "ready" && order.orderSource === "staff") return "picked_up";
  return NEXT_STATUS[order.status];
}
function nextLabelFor(order: EventOrder): string | undefined {
  if (order.status === "ready" && order.orderSource === "staff") return "Mark Picked Up";
  return NEXT_LABEL[order.status];
}

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

  // Kitchen-controlled ordering toggles. Two independent channels: guest + staff taker.
  type ChState = { state: "accepting" | "paused" | "closed"; pausedUntil: string | null; remainingSec: number | null; pausedMessage?: string | null };
  const [channels, setChannels] = useState<{ guest: ChState; taker: ChState } | null>(null);
  const [tickNow, setTickNow] = useState(Date.now());
  const [chBusy, setChBusy] = useState<"guest" | "taker" | null>(null);
  const [chError, setChError] = useState("");
  const [pauseModal, setPauseModal] = useState<"guest" | "taker" | null>(null);
  const [controlsModal, setControlsModal] = useState<"guest" | "taker" | null>(null);

  const fetchChannels = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/event-ordering/ordering-state`);
      if (res.ok) setChannels(await res.json());
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    if (!authedPassword) return;
    fetchChannels();
    const id = setInterval(fetchChannels, 10000);
    return () => clearInterval(id);
  }, [authedPassword, fetchChannels]);

  // Tick once a second so paused countdowns visually decrement between polls.
  useEffect(() => {
    const id = setInterval(() => setTickNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // When a paused timer expires locally, flip the channel to accepting in state
  // immediately (server already auto-resumes via resolveChannelState). Avoids a
  // false-disabled gap until the next 10s poll. Re-fetch to confirm.
  useEffect(() => {
    if (!channels) return;
    let didFlip = false;
    const next = (["guest", "taker"] as const).reduce((acc, k) => {
      const c = channels[k];
      if (c.state === "paused" && c.pausedUntil && new Date(c.pausedUntil).getTime() <= tickNow) {
        didFlip = true;
        acc[k] = { state: "accepting", pausedUntil: null, remainingSec: null };
      } else {
        acc[k] = c;
      }
      return acc;
    }, {} as { guest: ChState; taker: ChState });
    if (didFlip) {
      setChannels(next);
      fetchChannels();
    }
  }, [tickNow, channels, fetchChannels]);

  async function setChannelState(channel: "guest" | "taker", state: "accepting" | "paused" | "closed", pauseMinutes?: number, pausedMessage?: string) {
    if (!authedPassword) return;
    setChBusy(channel);
    setChError("");
    try {
      const res = await fetch(`${BASE}/api/event-ordering/ordering-state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authedPassword}` },
        body: JSON.stringify({ channel, state, pauseMinutes, pausedMessage }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setChError(data.error ?? "Could not update ordering state");
      } else {
        setChannels(await res.json());
        setPauseModal(null);
        setControlsModal(null);
      }
    } catch {
      setChError("Network error");
    } finally {
      setChBusy(null);
    }
  }

  const [view, setView] = useState<"orders" | "stock">("orders");
  const [stockItems, setStockItems] = useState<StockItem[]>([]);
  const [stockEdits, setStockEdits] = useState<Record<number, string>>({});
  const [stockSaving, setStockSaving] = useState<Set<number>>(new Set());

  // Low-stock alerts — toasts shown when an item with limited event_stock
  // crosses the configurable low-stock threshold (default 5). Each item alerts
  // only once per crossing; the "seen low" set persists across reloads so a
  // refresh doesn't re-fire alerts, and an item must climb back above the
  // threshold (or be set to unlimited) before its next dip alerts again.
  type LowStockToast = { id: string; itemId: number; name: string; eventStock: number; createdAt: number };
  const [lowStockToasts, setLowStockToasts] = useState<LowStockToast[]>([]);
  const lowStockSeenRef = useRef<Set<number>>(loadLowStockSeen());
  const stockPollCountRef = useRef(0);

  // Server-side low-stock threshold (shared with the SMS alert + admin UI).
  // Defaults to 5; fetched once after auth. The ref mirrors state so the
  // stable-identity fetchStock callback can read the latest value on each poll
  // without re-creating + restarting the polling interval.
  const [lowStockThreshold, setLowStockThreshold] = useState<number>(DEFAULT_LOW_STOCK_THRESHOLD);
  const lowStockThresholdRef = useRef<number>(DEFAULT_LOW_STOCK_THRESHOLD);
  useEffect(() => { lowStockThresholdRef.current = lowStockThreshold; }, [lowStockThreshold]);
  // Until the server-side threshold has been fetched at least once, skip
  // the low-stock detection in fetchStock — otherwise a poll using the
  // default 5 could mis-seed lowStockSeenRef and make a real persisted
  // value of, say, 8 fire spurious toasts on the next poll for items
  // already in the 6–8 band.
  const lowStockThresholdLoadedRef = useRef(false);
  const [thresholdSaving, setThresholdSaving] = useState(false);
  const [thresholdError, setThresholdError] = useState("");

  const dismissLowStockToast = useCallback((id: string) => {
    setLowStockToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  // Auto-dismiss toasts after their TTL
  useEffect(() => {
    if (lowStockToasts.length === 0) return;
    const timers = lowStockToasts.map(t => {
      const remaining = Math.max(0, LOW_STOCK_TOAST_TTL - (Date.now() - t.createdAt));
      return setTimeout(() => dismissLowStockToast(t.id), remaining);
    });
    return () => { timers.forEach(clearTimeout); };
  }, [lowStockToasts, dismissLowStockToast]);

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

        // Low-stock detection. Skip alerts on the very first poll after page
        // load — we only seed the "seen" set so a fresh-loaded display doesn't
        // dump a wall of toasts for items that were already low.
        // Also skip entirely until the server-side threshold has loaded; using
        // the default 5 here would mis-seed the "seen" set and cause spurious
        // toasts on the next poll if the persisted value is higher.
        if (!lowStockThresholdLoadedRef.current) return;
        const threshold = lowStockThresholdRef.current;
        const seen = new Set(lowStockSeenRef.current);
        const newToasts: LowStockToast[] = [];
        const isFirstPoll = stockPollCountRef.current === 0;
        for (const item of data) {
          const stock = item.eventStock;
          const isLow = stock !== null && stock > 0 && stock <= threshold;
          if (isLow) {
            if (!seen.has(item.id)) {
              seen.add(item.id);
              if (!isFirstPoll) {
                newToasts.push({
                  id: `${item.id}-${Date.now()}`,
                  itemId: item.id,
                  name: item.name,
                  eventStock: stock,
                  createdAt: Date.now(),
                });
              }
            }
          } else if (seen.has(item.id)) {
            // Restocked above threshold, set to unlimited, or sold out — clear
            // so a future dip will re-alert.
            seen.delete(item.id);
          }
        }
        // Only persist + update ref if something actually changed
        const changed = seen.size !== lowStockSeenRef.current.size
          || [...seen].some(id => !lowStockSeenRef.current.has(id));
        if (changed) {
          lowStockSeenRef.current = seen;
          saveLowStockSeen(seen);
        }
        if (newToasts.length > 0) {
          setLowStockToasts(prev => {
            // Replace any existing toast for the same item (so it shows latest count)
            const filtered = prev.filter(t => !newToasts.some(n => n.itemId === t.itemId));
            return [...filtered, ...newToasts];
          });
          if (soundEnabledRef.current) playChime();
          if ("vibrate" in navigator) navigator.vibrate([100, 60, 100]);
        }
        stockPollCountRef.current += 1;
      }
    } catch {}
  }, []);

  // Always poll stock while authenticated so we can detect low-stock crossings
  // even when the kitchen is on the Orders view. The Stock view itself just
  // reads from the same `stockItems` state.
  useEffect(() => {
    if (!authedPassword) return;
    fetchStock(authedPassword);
    const id = setInterval(() => fetchStock(authedPassword), STOCK_POLL_INTERVAL);
    return () => clearInterval(id);
  }, [authedPassword, fetchStock]);

  // Pull the kitchen-controlled low-stock threshold once after auth. Falls
  // back to DEFAULT_LOW_STOCK_THRESHOLD if the request fails so the UI keeps
  // working offline.
  useEffect(() => {
    if (!authedPassword) return;
    let cancelled = false;
    fetch(`${BASE}/api/event-ordering/low-stock-threshold`, {
      headers: { Authorization: `Bearer ${authedPassword}` },
    })
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (cancelled) return;
        if (data) {
          const n = Number(data.threshold);
          if (Number.isFinite(n) && n >= LOW_STOCK_THRESHOLD_MIN && n <= 1000) {
            setLowStockThreshold(n);
          }
        }
        // Mark loaded even on a failed/empty response so we fall back to the
        // default and stop blocking low-stock detection in fetchStock.
        lowStockThresholdLoadedRef.current = true;
      })
      .catch(() => {
        if (cancelled) return;
        lowStockThresholdLoadedRef.current = true;
      });
    return () => { cancelled = true; };
  }, [authedPassword]);

  const updateLowStockThreshold = useCallback(async (next: number) => {
    if (!authedPassword) return;
    const clamped = Math.max(LOW_STOCK_THRESHOLD_MIN, Math.min(LOW_STOCK_THRESHOLD_MAX, Math.round(next)));
    if (clamped === lowStockThreshold) return;
    setThresholdSaving(true);
    setThresholdError("");
    try {
      const res = await fetch(`${BASE}/api/event-ordering/low-stock-threshold`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authedPassword}` },
        body: JSON.stringify({ threshold: clamped }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setThresholdError(err.error ?? "Could not update threshold");
        return;
      }
      const data = await res.json();
      const saved = Number(data.threshold);
      const finalThreshold = Number.isFinite(saved) ? saved : clamped;
      setLowStockThreshold(finalThreshold);
      // Re-seed the "seen" set so changing the threshold doesn't dump a wall
      // of toasts for items that were already at-or-below the new value.
      // Items currently low under the new threshold are added (suppressing a
      // toast on the next poll); items above are removed so a future dip will
      // alert again.
      const newSeen = new Set<number>();
      for (const item of stockItems) {
        const stock = item.eventStock;
        if (stock !== null && stock > 0 && stock <= finalThreshold) {
          newSeen.add(item.id);
        }
      }
      lowStockSeenRef.current = newSeen;
      saveLowStockSeen(newSeen);
    } catch {
      setThresholdError("Network error");
    } finally {
      setThresholdSaving(false);
    }
  }, [authedPassword, lowStockThreshold, stockItems]);

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
    // Allowed transitions:
    //   preparing → pending  (Undo on Preparing card; clears Fire totals)
    //   ready → preparing    (Undo on plated Ready card; clears packing)
    if (!authedPassword) return;
    let next: "pending" | "preparing";
    if (order.status === "preparing") next = "pending";
    else if (order.status === "ready" && order.plateGroups && order.plateGroups.length > 0) next = "preparing";
    else return;
    setUpdating(s => new Set([...s, order.id]));
    try {
      const res = await fetch(`${BASE}/api/event-ordering/orders/${order.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authedPassword}` },
        body: JSON.stringify({ status: next }),
      });
      if (res.ok) {
        const updated: EventOrder = await res.json();
        setOrders(prev => prev.map(o => o.id === updated.id ? updated : o));
        // Reset Fire-totals checks so staff can re-mark from scratch
        // (server already wiped kitchen_progress in the same transaction)
        setCheckedItems(prev => ({ ...prev, [order.id]: new Set() }));
      }
    } finally {
      setUpdating(s => { const n = new Set(s); n.delete(order.id); return n; });
    }
  }

  // Per-plate / per-line tap. Optimistic update + rollback. Server is the
  // source of truth for auto-advancing preparing→ready once everything is
  // packed (so two devices can't race-double-advance).
  async function patchKitchenProgress(
    order: EventOrder,
    body: { plateIdx: number | "unassigned"; itemId: number; packed: boolean } | { plateIdx: number; allPacked: boolean },
  ) {
    if (!authedPassword) return;
    if (order.status !== "preparing" && order.status !== "pending") return;
    const prevSnapshot = order;
    // Optimistic: apply the same mutation locally so the tap feels instant.
    const optimistic = (() => {
      const progress = deriveKitchenProgress(order);
      if (!progress) return order;
      const cloned: KitchenProgress = {
        plates: progress.plates.map(p => ({ items: p.items.map(l => ({ ...l })) })),
        unassigned: progress.unassigned.map(l => ({ ...l })),
      };
      if ("allPacked" in body) {
        const plate = cloned.plates[body.plateIdx];
        if (plate) plate.items = plate.items.map(l => ({ ...l, packed: body.allPacked ? l.quantity : 0 }));
      } else {
        const lines = body.plateIdx === "unassigned" ? cloned.unassigned : cloned.plates[body.plateIdx]?.items;
        const line = lines?.find(l => l.itemId === body.itemId);
        if (line) line.packed = body.packed ? line.quantity : 0;
      }
      return { ...order, kitchenProgress: cloned };
    })();
    setOrders(prev => prev.map(o => o.id === order.id ? optimistic : o));
    try {
      const res = await fetch(`${BASE}/api/event-ordering/orders/${order.id}/kitchen-progress`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authedPassword}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setOrders(prev => prev.map(o => o.id === order.id ? prevSnapshot : o));
        return;
      }
      const updated: EventOrder = await res.json();
      setOrders(prev => prev.map(o => o.id === updated.id ? { ...o, ...updated } : o));
    } catch {
      setOrders(prev => prev.map(o => o.id === order.id ? prevSnapshot : o));
    }
  }

  async function advanceStatus(order: EventOrder) {
    const next = nextStatusFor(order);
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

  // ── Print receipts / kitchen tickets ─────────────────────────────
  const [printJob, setPrintJob] = useState<PrintJob | null>(null);

  useEffect(() => {
    if (!printJob) return;
    const clear = () => setPrintJob(null);
    window.addEventListener("afterprint", clear);
    // Wait one tick so the print region renders before invoking print()
    const t = setTimeout(() => window.print(), 80);
    return () => {
      clearTimeout(t);
      window.removeEventListener("afterprint", clear);
    };
  }, [printJob]);

  function printOrder(order: EventOrder, mode: "receipt" | "kitchen") {
    setPrintJob({ order, mode });
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

  const activeOrders = orders.filter(o => !COMPLETED_STATUSES.has(o.status));
  const doneOrders = orders.filter(o => COMPLETED_STATUSES.has(o.status));
  const displayed = showDone ? orders : activeOrders;

  const grouped: Record<string, EventOrder[]> = { pending: [], preparing: [], ready: [] };
  displayed.filter(o => !COMPLETED_STATUSES.has(o.status)).forEach(o => grouped[o.status]?.push(o));

  return (
    <div className="min-h-screen bg-[#111] text-white">

      {/* Print stylesheet — only mounted while a print job is active so a manual
          Cmd/Ctrl+P (with no job) prints the dashboard normally instead of blank. */}
      {printJob && (
        <>
          <style>{`
            @media print {
              @page { size: 80mm auto; margin: 4mm; }
              html, body { background: #fff !important; }
              body * { visibility: hidden !important; }
              #print-region, #print-region * { visibility: visible !important; opacity: 1 !important; }
              #print-region { position: absolute !important; left: 0; top: 0; width: 100%; color: #000 !important; }
            }
          `}</style>
          <div id="print-region" className="fixed left-0 top-0 w-full opacity-0 pointer-events-none">
            <PrintableTicket order={printJob.order} mode={printJob.mode} eventName={eventName} />
          </div>
        </>
      )}

      {controlsModal && channels && (
        <ChannelControlsModal
          channel={controlsModal}
          state={channels[controlsModal]}
          tickNow={tickNow}
          busy={chBusy === controlsModal}
          error={chError}
          onCancel={() => { setChError(""); setControlsModal(null); }}
          onAccept={() => setChannelState(controlsModal, "accepting")}
          onPause={() => { setControlsModal(null); setPauseModal(controlsModal); }}
          onStop={() => setChannelState(controlsModal, "closed")}
        />
      )}
      {pauseModal && (
        <PauseDurationModal
          channel={pauseModal}
          currentMessage={channels?.[pauseModal]?.pausedMessage ?? null}
          busy={chBusy === pauseModal}
          error={chError}
          onCancel={() => { setChError(""); setPauseModal(null); }}
          onConfirm={(m, msg) => setChannelState(pauseModal, "paused", m, msg)}
        />
      )}

      {/* Low-stock alert toasts — fire when an item with limited event_stock
          dips to ≤ threshold (default 5). Auto-dismiss after a few seconds. */}
      {lowStockToasts.length > 0 && (
        <>
          <style>{`
            @keyframes kitchenLowStockSlideIn {
              from { opacity: 0; transform: translateX(24px); }
              to   { opacity: 1; transform: translateX(0); }
            }
          `}</style>
          <div className="fixed top-4 right-4 z-40 flex flex-col gap-2 w-full max-w-sm pointer-events-none">
            {lowStockToasts.map(toast => (
              <LowStockToastCard
                key={toast.id}
                name={toast.name}
                eventStock={toast.eventStock}
                onDismiss={() => dismissLowStockToast(toast.id)}
                onView={() => { dismissLowStockToast(toast.id); setView("stock"); }}
              />
            ))}
          </div>
        </>
      )}

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
            {channels && (
              <div className="flex items-center gap-2">
                <ChannelStatusPill
                  label="Guest"
                  icon={<ShoppingBag className="w-3.5 h-3.5" />}
                  state={channels.guest}
                  tickNow={tickNow}
                  onClick={() => { setChError(""); setControlsModal("guest"); }}
                />
                <ChannelStatusPill
                  label="Staff"
                  icon={<Users className="w-3.5 h-3.5" />}
                  state={channels.taker}
                  tickNow={tickNow}
                  onClick={() => { setChError(""); setControlsModal("taker"); }}
                />
              </div>
            )}
            <div className="hidden md:flex items-center gap-2 text-sm text-white/50">
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
            <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
              <p className="text-white/40 text-sm flex-1 min-w-[16rem]">Set stock to a number to limit how many can be ordered. Leave blank (∞) for unlimited.</p>
              <LowStockThresholdControl
                value={lowStockThreshold}
                onChange={updateLowStockThreshold}
                saving={thresholdSaving}
                error={thresholdError}
              />
            </div>
            {stockItems.length === 0 ? (
              <div className="text-center py-16 text-white/30">
                <Package className="w-10 h-10 mx-auto mb-3 opacity-40" />
                <p className="font-semibold">No items enabled for event ordering</p>
                <p className="text-xs mt-1">Enable items for the Guest Event page or Staff Order Taker in the admin menu</p>
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
                      const threshold = lowStockThreshold;
                      const isLow = item.eventStock !== null && item.eventStock > 0 && item.eventStock <= threshold;
                      return (
                        <div
                          key={item.id}
                          className={`flex items-center gap-3 rounded-2xl px-4 py-3 border ${
                            isLow ? "bg-amber-500/10 border-amber-500/40" : "bg-white/5 border-white/10"
                          }`}
                        >
                          {item.imageUrl && (
                            <img src={item.imageUrl} alt={item.name} className="w-10 h-10 rounded-lg object-cover shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <p className="text-sm font-semibold text-white truncate flex-1 min-w-0">{item.name}</p>
                              {isLow && (
                                <span className="shrink-0 inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/30 text-amber-200" title={`At or below low-stock threshold (${threshold})`}>
                                  <AlertTriangle className="w-2.5 h-2.5" /> Low
                                </span>
                              )}
                              {item.eventActive && (
                                <span className="shrink-0 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300" title="Sold on the Guest Event ordering page">
                                  Guest
                                </span>
                              )}
                              {item.eventTakerVisible && (
                                <span className="shrink-0 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300" title="Sold on the Staff Order Taker">
                                  Staff
                                </span>
                              )}
                            </div>
                            <p className={`text-xs font-medium mt-0.5 ${isSoldOut ? "text-red-400" : isUnlimited ? "text-emerald-400" : isLow ? "text-amber-400" : "text-white/40"}`}>
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
                          onPrint={(mode) => printOrder(order, mode)}
                          onTogglePlateLine={(plateIdx, itemId, packed) => patchKitchenProgress(order, { plateIdx, itemId, packed })}
                          onTogglePlate={(plateIdx, allPacked) => patchKitchenProgress(order, { plateIdx, allPacked })}
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
                    <OrderCard key={order.id} order={order} isNew={false} isUpdating={false} checkedItemIds={new Set()} onToggleItem={() => {}} onAdvance={() => {}} onRevert={() => {}} onPrint={(mode) => printOrder(order, mode)} onTogglePlateLine={() => {}} onTogglePlate={() => {}} />
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

function OrderCard({ order, isNew, isUpdating, checkedItemIds, onToggleItem, onAdvance, onRevert, onPrint, onTogglePlateLine, onTogglePlate }: {
  order: EventOrder;
  isNew: boolean;
  isUpdating: boolean;
  checkedItemIds: Set<number>;
  onToggleItem: (itemId: number) => void;
  onAdvance: () => void;
  onRevert: () => void;
  onPrint: (mode: "receipt" | "kitchen") => void;
  onTogglePlateLine: (plateIdx: number | "unassigned", itemId: number, packed: boolean) => void;
  onTogglePlate: (plateIdx: number, allPacked: boolean) => void;
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
  const nextLabel = nextLabelFor(order);
  const hasPlating = !!(order.plateGroups && order.plateGroups.length > 0);
  const progress = hasPlating ? deriveKitchenProgress(order) : null;
  // Auto-collapse Fire totals once all are checked, but let the cook expand
  // again with one tap. Resets implicitly via local state when checks change.
  const [fireExpanded, setFireExpanded] = useState(false);
  // Auto-collapse the Fire-totals list once every line is checked so the
  // cook's eye snaps to whatever's left (plate cards on plated orders,
  // or a clean "all fired" header on non-plated tickets). Tap the
  // collapsed header to expand again.
  const fireCollapsed = isTrackable && allChecked && !fireExpanded && order.items.length > 0;

  return (
    <div className={`bg-[#1a1a1a] border rounded-2xl overflow-hidden transition-all ${
      order.orderSource === "staff" && order.paymentStatus !== "paid"
        ? "ring-2 ring-red-500 border-red-500/60 animate-pulse"
        : isNew ? "ring-2 ring-red-400 border-red-400/50" : "border-white/10"
    }`}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/10 flex justify-between items-start">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-bold">{order.guestName}</p>
            {order.orderSource === "staff" ? (
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-400/30">
                Staff
              </span>
            ) : (
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-400/30">
                Guest
              </span>
            )}
            {order.orderSource === "staff" && order.paymentStatus !== "paid" && (
              <span className="text-xs font-extrabold uppercase tracking-widest px-2.5 py-1 rounded-md bg-red-600 text-white border border-red-300 shadow-lg shadow-red-900/50 animate-pulse">
                ⚠ Unpaid
              </span>
            )}
          </div>
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

      {/* Items — tappable when pending or preparing. On plated orders we
          collapse the Fire-totals list once everything is checked so the
          plate cards below stay the focus; tap the header to expand. */}
      <div className="px-4 py-3 space-y-1">
        {isTrackable && (
          fireCollapsed ? (
            <button
              type="button"
              onClick={() => setFireExpanded(true)}
              className="w-full flex items-center justify-between text-left text-xs font-semibold uppercase tracking-wider px-1 py-1 rounded-md text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 transition-colors"
              data-testid={`order-${order.id}-fire-collapsed`}
            >
              <span>✓ All fired · {checkedCount}/{order.items.length}</span>
              <span className="text-[10px] text-white/40 font-medium normal-case">Tap to expand</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => allChecked && setFireExpanded(false)}
              className={`w-full text-left text-xs text-white/30 font-semibold uppercase tracking-wider pb-1.5 ${allChecked ? "cursor-pointer hover:text-white/50" : "cursor-default"}`}
            >
              {hasPlating ? "Fire totals · " : ""}
              Tap each item to mark · {checkedCount}/{order.items.length}
              {allChecked && <span className="ml-2 text-[10px] text-white/30 normal-case">(tap to collapse)</span>}
            </button>
          )
        )}
        {!fireCollapsed && order.items.map(item => {
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
                  <div className="mt-1 mb-1 ml-3 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-300 leading-snug whitespace-pre-wrap">
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
                <div className="mt-1 ml-6 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-300 leading-snug whitespace-pre-wrap">
                  {item.internalNotes}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Plating layout — when staff configured plate cards, show them after
          the fire totals so the line cooks see how to plate up. Unassigned
          units render as a fallback section so nothing silently disappears. */}
      {order.plateGroups && order.plateGroups.length > 0 && (() => {
        const names = nameByItemId(order);
        const unassigned = unassignedItems(order);
        return (
          <div className="px-4 pb-3 space-y-2 border-t border-white/10 pt-3">
            <p className="text-xs text-violet-300 font-semibold uppercase tracking-wider">
              Plating · {order.plateGroups.length} plate{order.plateGroups.length === 1 ? "" : "s"}
            </p>
            <div className="grid gap-2">
              {order.plateGroups.map((plate, idx) => {
                // Derive packed/done visuals from kitchenProgress *regardless* of
                // isTrackable so a Ready / Done card visually freezes its packed
                // state instead of reverting to "nothing checked" once it leaves
                // the active queue. Interactivity (taps) is still gated.
                const allDone = plateAllPacked(progress, idx);
                const packedCount = progress?.plates[idx]?.items.filter(l => l.packed >= l.quantity).length ?? 0;
                const totalLines = plate.items.length;
                return (
                  <div
                    key={idx}
                    className={`rounded-xl border px-3 py-2 transition-colors ${
                      allDone
                        ? "border-emerald-400/40 bg-emerald-500/10"
                        : "border-violet-400/30 bg-violet-500/10"
                    }`}
                    data-testid={`order-${order.id}-plate-${idx}`}
                  >
                    {isTrackable ? (
                      <button
                        type="button"
                        onClick={() => onTogglePlate(idx, !allDone)}
                        className={`w-full flex items-center justify-between text-xs font-bold uppercase tracking-wider mb-1 ${
                          allDone ? "text-emerald-300" : "text-violet-200"
                        } hover:opacity-80 active:scale-[0.99] transition-all`}
                        data-testid={`order-${order.id}-plate-${idx}-toggle`}
                      >
                        <span>{plate.label || `Plate ${idx + 1}`}</span>
                        <span className="text-[10px] font-semibold normal-case opacity-80">
                          {packedCount}/{totalLines} {allDone ? "✓" : "— tap to mark plate"}
                        </span>
                      </button>
                    ) : (
                      <div className={`flex items-center justify-between text-xs font-bold uppercase tracking-wider mb-1 ${allDone ? "text-emerald-300" : "text-violet-200"}`}>
                        <span>{plate.label || `Plate ${idx + 1}`}</span>
                        {progress && (
                          <span className="text-[10px] font-semibold normal-case opacity-80">
                            {packedCount}/{totalLines} {allDone ? "✓" : ""}
                          </span>
                        )}
                      </div>
                    )}
                    <ul className="text-sm text-white/85 space-y-0.5">
                      {plate.items.map(ln => {
                        const packed = plateLinePacked(progress, idx, ln.itemId);
                        const label = (
                          <>
                            <span className="font-bold tabular-nums">{ln.quantity}×</span>{" "}
                            {names.get(ln.itemId) ?? `Item #${ln.itemId}`}
                          </>
                        );
                        if (!isTrackable) {
                          // Frozen presentation: same packed styling as the
                          // active version, just non-interactive.
                          return (
                            <li
                              key={ln.itemId}
                              className={`flex items-center justify-between rounded-md px-2 py-1.5 ${
                                packed
                                  ? "bg-emerald-500/15 text-emerald-300 line-through decoration-emerald-500/60"
                                  : "text-white/85"
                              }`}
                            >
                              <span>{label}</span>
                              {packed && (
                                <span className="w-5 h-5 shrink-0 rounded-full flex items-center justify-center bg-emerald-500 text-black">
                                  <Check className="w-3 h-3" strokeWidth={3} />
                                </span>
                              )}
                            </li>
                          );
                        }
                        return (
                          <li key={ln.itemId}>
                            <button
                              type="button"
                              onClick={() => onTogglePlateLine(idx, ln.itemId, !packed)}
                              className={`w-full flex items-center justify-between text-left rounded-md px-2 py-1.5 transition-all active:scale-[0.99] ${
                                packed
                                  ? "bg-emerald-500/15 text-emerald-300 line-through decoration-emerald-500/60"
                                  : "hover:bg-white/5 text-white/85"
                              }`}
                              data-testid={`order-${order.id}-plate-${idx}-item-${ln.itemId}`}
                            >
                              <span>{label}</span>
                              <span className={`w-5 h-5 shrink-0 rounded-full flex items-center justify-center transition-colors ${
                                packed ? "bg-emerald-500 text-black" : "bg-white/10"
                              }`}>
                                {packed && <Check className="w-3 h-3" strokeWidth={3} />}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
              {unassigned.length > 0 && (() => {
                // Same freeze rule as plates above: packed visuals come from
                // kitchenProgress, taps are gated on isTrackable.
                const allDone = unassigned.every(ln => plateLinePacked(progress, "unassigned", ln.itemId));
                return (
                  <div className={`rounded-xl border px-3 py-2 transition-colors ${
                    allDone ? "border-emerald-400/40 bg-emerald-500/10" : "border-amber-400/30 bg-amber-500/10"
                  }`}>
                    <p className={`text-xs font-bold uppercase tracking-wider mb-1 ${allDone ? "text-emerald-300" : "text-amber-200"}`}>
                      Unassigned · pack however
                    </p>
                    <ul className="text-sm text-white/85 space-y-0.5">
                      {unassigned.map(ln => {
                        const packed = plateLinePacked(progress, "unassigned", ln.itemId);
                        const label = (
                          <>
                            <span className="font-bold tabular-nums">{ln.quantity}×</span> {ln.name}
                          </>
                        );
                        if (!isTrackable) {
                          return (
                            <li
                              key={ln.itemId}
                              className={`flex items-center justify-between rounded-md px-2 py-1.5 ${
                                packed
                                  ? "bg-emerald-500/15 text-emerald-300 line-through decoration-emerald-500/60"
                                  : "text-white/85"
                              }`}
                            >
                              <span>{label}</span>
                              {packed && (
                                <span className="w-5 h-5 shrink-0 rounded-full flex items-center justify-center bg-emerald-500 text-black">
                                  <Check className="w-3 h-3" strokeWidth={3} />
                                </span>
                              )}
                            </li>
                          );
                        }
                        return (
                          <li key={ln.itemId}>
                            <button
                              type="button"
                              onClick={() => onTogglePlateLine("unassigned", ln.itemId, !packed)}
                              className={`w-full flex items-center justify-between text-left rounded-md px-2 py-1.5 transition-all active:scale-[0.99] ${
                                packed
                                  ? "bg-emerald-500/15 text-emerald-300 line-through decoration-emerald-500/60"
                                  : "hover:bg-white/5 text-white/85"
                              }`}
                              data-testid={`order-${order.id}-unassigned-item-${ln.itemId}`}
                            >
                              <span>{label}</span>
                              <span className={`w-5 h-5 shrink-0 rounded-full flex items-center justify-center transition-colors ${
                                packed ? "bg-emerald-500 text-black" : "bg-white/10"
                              }`}>
                                {packed && <Check className="w-3 h-3" strokeWidth={3} />}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })()}
            </div>
          </div>
        );
      })()}

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

      {/* Action button for preparing / ready. Plated preparing orders
          advance via per-plate packing (auto-flips to Ready when every
          line is checked), so we hide the manual Mark-Ready button to
          avoid the cook bypassing the checklist. */}
      {nextLabel && !isPending && (
        <div className="px-4 pb-4 space-y-2">
          {!(order.status === "preparing" && hasPlating) && (
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
          )}
          {order.status === "preparing" && hasPlating && (
            <p className="w-full py-2 rounded-xl text-xs font-semibold text-center text-violet-300/80 bg-violet-500/10 border border-violet-400/20">
              Tap each plate as you pack — auto-marks Ready when complete
            </p>
          )}
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
          {order.status === "ready" && hasPlating && (
            <button
              onClick={onRevert}
              disabled={isUpdating}
              className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-xl text-xs font-medium text-white/40 hover:text-white/70 hover:bg-white/5 transition-colors disabled:opacity-30"
              data-testid={`order-${order.id}-undo-ready`}
            >
              <Undo2 size={12} />
              Undo — back to Preparing
            </button>
          )}
        </div>
      )}

      {COMPLETED_STATUSES.has(order.status) && (
        <div className="px-4 pb-3 text-center text-xs text-white/20 font-semibold">
          {order.status === "picked_up" ? "Picked Up" : "Completed"}
        </div>
      )}

      {/* Reprint actions — available for any status */}
      <div className="px-4 pb-3 grid grid-cols-2 gap-2 border-t border-white/5 pt-3">
        <button
          onClick={() => onPrint("kitchen")}
          className="flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-colors"
          title="Print kitchen ticket (no prices)"
        >
          <Printer size={12} /> Print ticket
        </button>
        <button
          onClick={() => onPrint("receipt")}
          className="flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-colors"
          title="Print customer receipt (with prices)"
        >
          <Receipt size={12} /> Print receipt
        </button>
      </div>
    </div>
  );
}

function LowStockThresholdControl({
  value, onChange, saving, error,
}: {
  value: number;
  onChange: (n: number) => void;
  saving: boolean;
  error: string;
}) {
  const canDec = !saving && value > LOW_STOCK_THRESHOLD_MIN;
  const canInc = !saving && value < LOW_STOCK_THRESHOLD_MAX;
  return (
    <div className="flex flex-col items-end gap-1 shrink-0">
      <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-1.5">
        <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
        <span className="text-xs font-semibold text-amber-300 whitespace-nowrap hidden sm:inline">Low-stock alert at</span>
        <span className="text-xs font-semibold text-amber-300 whitespace-nowrap sm:hidden">Alert at</span>
        <button
          type="button"
          onClick={() => onChange(value - 1)}
          disabled={!canDec}
          aria-label="Decrease low-stock threshold"
          title="Decrease"
          className="w-7 h-7 flex items-center justify-center rounded-md bg-white/10 hover:bg-white/20 text-white text-sm font-bold disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        <span className="min-w-[1.75rem] text-center text-sm font-extrabold tabular-nums text-amber-200">{value}</span>
        <button
          type="button"
          onClick={() => onChange(value + 1)}
          disabled={!canInc}
          aria-label="Increase low-stock threshold"
          title="Increase"
          className="w-7 h-7 flex items-center justify-center rounded-md bg-white/10 hover:bg-white/20 text-white text-sm font-bold disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
        <span className="text-xs font-semibold text-amber-300 whitespace-nowrap">or fewer</span>
        {saving && <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-300 ml-1" />}
      </div>
      {error
        ? <p className="text-rose-400 text-xs">{error}</p>
        : <p className="text-white/30 text-[10px] uppercase tracking-wider">Saved for everyone</p>
      }
    </div>
  );
}

function LowStockToastCard({
  name, eventStock, onDismiss, onView,
}: {
  name: string;
  eventStock: number;
  onDismiss: () => void;
  onView: () => void;
}) {
  const isCritical = eventStock <= 2;
  return (
    <div
      role="alert"
      aria-live="polite"
      className={`pointer-events-auto rounded-2xl shadow-2xl border p-4 backdrop-blur-md ${
        isCritical
          ? "bg-rose-500/95 border-rose-300/60 text-white"
          : "bg-amber-500/95 border-amber-300/60 text-black"
      }`}
      style={{ animation: "kitchenLowStockSlideIn 0.28s ease-out" }}
    >
      <div className="flex items-start gap-3">
        <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${isCritical ? "bg-white/20" : "bg-black/15"}`}>
          <AlertTriangle className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-sm uppercase tracking-wider">
            {isCritical ? "Almost out" : "Running low"}
          </p>
          <p className="font-semibold mt-0.5 leading-tight">
            <span className="truncate inline-block max-w-full align-bottom">{name}</span>
          </p>
          <p className="text-sm mt-0.5 font-medium opacity-90">
            Only {eventStock} {eventStock === 1 ? "unit" : "units"} left · prep more or pull the item.
          </p>
          <div className="flex items-center gap-2 mt-2">
            <button
              type="button"
              onClick={onView}
              className={`px-3 py-1 rounded-lg text-xs font-bold transition-colors ${
                isCritical
                  ? "bg-white/20 hover:bg-white/30 text-white"
                  : "bg-black/15 hover:bg-black/25 text-black"
              }`}
            >
              Open Stock
            </button>
            <button
              type="button"
              onClick={onDismiss}
              className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
                isCritical
                  ? "text-white/80 hover:text-white hover:bg-white/10"
                  : "text-black/70 hover:text-black hover:bg-black/10"
              }`}
            >
              Dismiss
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss alert"
          className={`p-1 rounded-lg transition-colors shrink-0 ${
            isCritical ? "text-white/70 hover:text-white hover:bg-white/10" : "text-black/60 hover:text-black hover:bg-black/10"
          }`}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function PrintableTicket({ order, mode, eventName }: { order: EventOrder; mode: "receipt" | "kitchen"; eventName: string }) {
  const placedAt = new Date(order.createdAt).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
  // Compute display totals with snapshot fallback for older orders.
  const computedSubtotal = order.items.reduce((s, l) => s + (Number(l.price) || 0) * l.quantity, 0);
  const subtotal = order.subtotal != null ? order.subtotal : computedSubtotal;
  const taxRate = order.taxRate ?? 0;
  const taxAmount = order.taxAmount ?? 0;
  const total = order.total != null ? order.total : subtotal + taxAmount;
  const totalQty = order.items.reduce((s, l) => s + l.quantity, 0);

  if (mode === "kitchen") {
    const hasPlating = !!(order.plateGroups && order.plateGroups.length > 0);
    const names = nameByItemId(order);
    const unassigned = hasPlating ? unassignedItems(order) : [];
    return (
      <div className="font-mono text-base bg-white text-black p-3">
        <div className="text-center mb-3">
          <p className="font-bold text-lg uppercase tracking-wider">Kitchen Ticket</p>
          <p className="text-xs">{eventName || "dash by Hollywood East Cafe"}</p>
          <p className="text-xs">{placedAt}</p>
          <p className="text-base font-bold mt-1">Order #{order.id}</p>
          {order.orderSource && (
            <p className="text-xs uppercase tracking-wider mt-0.5">{order.orderSource} order</p>
          )}
          {order.orderSource === "staff" && order.paymentStatus !== "paid" && (
            <p className="text-base font-extrabold uppercase tracking-widest mt-1 border-2 border-black px-2 py-0.5 inline-block">
              ** UNPAID **
            </p>
          )}
        </div>
        <div className="border-t border-b border-dashed border-black py-2 mb-2">
          <p className="font-bold text-lg">{order.guestName}</p>
          {order.tableNumber && <p className="text-sm">{order.tableNumber}</p>}
        </div>
        {hasPlating && (
          <p className="text-xs font-bold uppercase tracking-wider mb-1">Fire totals</p>
        )}
        <table className="w-full mb-2">
          <tbody>
            {order.items.map(l => (
              <tr key={l.itemId}>
                <td className="py-1 align-top w-10 font-bold text-xl">{l.quantity}×</td>
                <td className="py-1 align-top font-semibold">
                  {l.name}
                  {l.internalNotes && (
                    <div className="text-xs font-normal italic mt-0.5">↳ {l.internalNotes}</div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {hasPlating && (
          <div className="border-t border-dashed border-black pt-2 mt-2 space-y-2">
            <p className="text-xs font-bold uppercase tracking-wider">
              Plating · {order.plateGroups!.length} plate{order.plateGroups!.length === 1 ? "" : "s"}
            </p>
            {order.plateGroups!.map((plate, idx) => (
              <div key={idx} className="border border-black rounded-sm p-2">
                <p className="font-bold uppercase tracking-wider text-sm mb-1">
                  {plate.label || `Plate ${idx + 1}`}
                </p>
                <ul className="text-sm">
                  {plate.items.map(ln => (
                    <li key={ln.itemId}>
                      <span className="font-bold">{ln.quantity}×</span>{" "}
                      {names.get(ln.itemId) ?? `Item #${ln.itemId}`}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {unassigned.length > 0 && (
              <div className="border border-dashed border-black rounded-sm p-2">
                <p className="font-bold uppercase tracking-wider text-sm mb-1">Unassigned · pack however</p>
                <ul className="text-sm">
                  {unassigned.map(ln => (
                    <li key={ln.itemId}>
                      <span className="font-bold">{ln.quantity}×</span> {ln.name}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        <p className="text-center text-xs border-t border-dashed border-black pt-2 mt-2">
          {totalQty} item(s) total
        </p>
      </div>
    );
  }

  // receipt
  const ratePretty = (taxRate || 0).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return (
    <div className="font-mono text-sm bg-white text-black p-3">
      <div className="text-center mb-3">
        <p className="font-bold text-base">{eventName || "dash by Hollywood East Cafe"}</p>
        <p className="text-xs">{placedAt}</p>
        <p className="text-xs">Order #{order.id}</p>
      </div>
      <div className="border-t border-b border-dashed border-black py-2 mb-2 space-y-0.5">
        <p>Customer: {order.guestName}</p>
        {order.tableNumber && <p>Table: {order.tableNumber}</p>}
        {order.phoneNumber && <p>Phone: {order.phoneNumber}</p>}
      </div>
      <table className="w-full text-xs mb-2">
        <tbody>
          {order.items.map(l => (
            <tr key={l.itemId}>
              <td className="py-0.5">{l.quantity}× {l.name}</td>
              <td className="py-0.5 text-right">${((Number(l.price) || 0) * l.quantity).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-dashed border-black pt-2 space-y-0.5 text-xs">
        <div className="flex justify-between"><span>Subtotal</span><span>${subtotal.toFixed(2)}</span></div>
        {taxRate > 0 && (
          <div className="flex justify-between"><span>Tax ({ratePretty}%)</span><span>${taxAmount.toFixed(2)}</span></div>
        )}
        <div className="flex justify-between font-bold text-sm pt-1 border-t border-dashed border-black mt-1">
          <span>TOTAL</span><span>${total.toFixed(2)}</span>
        </div>
      </div>
      <p className="text-center text-xs mt-3">Thank you!</p>
    </div>
  );
}

type ChannelState = { state: "accepting" | "paused" | "closed"; pausedUntil: string | null; remainingSec: number | null; pausedMessage?: string | null };

function formatRemaining(pausedUntil: string | null, tickNow: number): string {
  if (!pausedUntil) return "";
  const ms = new Date(pausedUntil).getTime() - tickNow;
  if (ms <= 0) return "resuming…";
  const sec = Math.ceil(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function ChannelStatusPill({
  label, icon, state, tickNow, onClick,
}: {
  label: string;
  icon: React.ReactNode;
  state: ChannelState;
  tickNow: number;
  onClick: () => void;
}) {
  const styleByState = {
    accepting: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/25",
    paused: "bg-amber-500/15 text-amber-300 border-amber-500/30 hover:bg-amber-500/25",
    closed: "bg-rose-500/15 text-rose-300 border-rose-500/30 hover:bg-rose-500/25",
  } as const;
  const dotByState = {
    accepting: "bg-emerald-400 animate-pulse",
    paused: "bg-amber-400",
    closed: "bg-rose-400",
  } as const;
  const titleByState = {
    accepting: `${label} ordering: accepting orders. Tap to change.`,
    paused: `${label} ordering: paused. Tap to resume or change.`,
    closed: `${label} ordering: not accepting. Tap to change.`,
  } as const;
  return (
    <button
      onClick={onClick}
      title={titleByState[state.state]}
      aria-label={titleByState[state.state]}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-xs font-semibold transition-colors ${styleByState[state.state]}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotByState[state.state]}`} />
      <span className="shrink-0">{icon}</span>
      <span className="hidden sm:inline">{label}</span>
      {state.state === "paused" && (
        <span className="hidden md:inline tabular-nums">· {formatRemaining(state.pausedUntil, tickNow)}</span>
      )}
    </button>
  );
}

function ChannelControlsModal({
  channel, state, tickNow, busy, error, onCancel, onAccept, onPause, onStop,
}: {
  channel: "guest" | "taker";
  state: ChannelState;
  tickNow: number;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onAccept: () => void;
  onPause: () => void;
  onStop: () => void;
}) {
  const Icon = channel === "guest" ? ShoppingBag : Users;
  const title = channel === "guest" ? "Guest Ordering" : "Staff Order Taker";
  const accentByState = {
    accepting: { ring: "bg-emerald-500/20", icon: "text-emerald-400", label: "Currently accepting orders" },
    paused: { ring: "bg-amber-500/20", icon: "text-amber-400", label: `Paused · ${formatRemaining(state.pausedUntil, tickNow)}` },
    closed: { ring: "bg-rose-500/20", icon: "text-rose-400", label: "Currently not accepting orders" },
  } as const;
  const accent = accentByState[state.state];
  const titleId = `channel-controls-title-${channel}`;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel, busy]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={() => { if (!busy) onCancel(); }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-[#1e1e1e] border border-white/10 rounded-2xl shadow-2xl w-full max-w-sm p-6"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-5">
          <div className={`w-10 h-10 rounded-xl ${accent.ring} flex items-center justify-center shrink-0`}>
            <Icon className={`w-5 h-5 ${accent.icon}`} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 id={titleId} className="font-bold text-base">{title}</h2>
            <p className="text-xs text-white/60 mt-0.5">{accent.label}</p>
          </div>
          <button
            onClick={onCancel}
            disabled={busy}
            aria-label="Close"
            className="p-1 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="grid grid-cols-3 gap-2 mb-3">
          <button
            onClick={onAccept}
            disabled={busy || state.state === "accepting"}
            className={`flex flex-col items-center justify-center gap-1 px-2 py-3 rounded-xl text-xs font-semibold transition-colors ${state.state === "accepting" ? "bg-emerald-500 text-white" : "bg-white/10 text-white/80 hover:bg-emerald-500/30 hover:text-white"} disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {state.state === "paused" ? <Play className="w-4 h-4" /> : <Check className="w-4 h-4" />}
            {state.state === "paused" ? "Resume" : "Accept"}
          </button>
          <button
            onClick={onPause}
            disabled={busy}
            className={`flex flex-col items-center justify-center gap-1 px-2 py-3 rounded-xl text-xs font-semibold transition-colors ${state.state === "paused" ? "bg-amber-500 text-white" : "bg-white/10 text-white/80 hover:bg-amber-500/30 hover:text-white"} disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            <Pause className="w-4 h-4" /> Pause
          </button>
          <button
            onClick={onStop}
            disabled={busy || state.state === "closed"}
            className={`flex flex-col items-center justify-center gap-1 px-2 py-3 rounded-xl text-xs font-semibold transition-colors ${state.state === "closed" ? "bg-rose-500 text-white" : "bg-white/10 text-white/80 hover:bg-rose-500/30 hover:text-white"} disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            <Ban className="w-4 h-4" /> Stop
          </button>
        </div>
        {error && <p className="text-rose-400 text-xs mb-3">{error}</p>}
        {busy && (
          <div className="flex items-center justify-center gap-2 text-xs text-white/50 py-1">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Updating…
          </div>
        )}
      </div>
    </div>
  );
}

export function PauseDurationModal({
  channel, currentMessage, busy = false, error = "", onCancel, onConfirm,
}: {
  channel: "guest" | "taker";
  currentMessage?: string | null;
  busy?: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: (minutes: number, message: string) => void;
}) {
  const [custom, setCustom] = useState("");
  const [note, setNote] = useState(currentMessage ?? "");
  const presets = [5, 10, 15, 30];
  const title = channel === "guest" ? "Pause Guest Ordering" : "Pause Staff Order Taker";
  const audience = channel === "guest" ? "guests" : "staff";
  const titleId = `pause-duration-title-${channel}`;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel, busy]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={() => { if (!busy) onCancel(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="bg-[#1e1e1e] border border-white/10 rounded-2xl shadow-2xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center shrink-0">
            <Pause className="w-5 h-5 text-amber-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 id={titleId} className="font-bold text-base">{title}</h2>
            <p className="text-xs text-white/50">Auto-resumes when the timer ends</p>
          </div>
          <button
            onClick={onCancel}
            disabled={busy}
            aria-label="Close"
            className="p-1 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="mb-4">
          <label className="block text-xs font-semibold text-white/70 mb-1.5">
            Message for {audience} <span className="font-normal text-white/40">(optional)</span>
          </label>
          <textarea
            value={note}
            onChange={e => setNote(e.target.value.slice(0, 200))}
            placeholder="e.g. Catching up on the rush — back in 10!"
            rows={2}
            className="w-full px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-white text-sm placeholder:text-white/30 focus:outline-none focus:border-amber-400 resize-none"
          />
          <p className="text-[10px] text-white/40 mt-1 text-right">{note.length}/200 · leave blank for the default note</p>
        </div>
        <div className="grid grid-cols-4 gap-2 mb-4">
          {presets.map(m => (
            <button
              key={m}
              onClick={() => onConfirm(m, note)}
              disabled={busy}
              className="py-2.5 rounded-xl bg-white/10 hover:bg-amber-500/30 text-white font-semibold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? "…" : `${m}m`}
            </button>
          ))}
        </div>
        <div className="flex gap-2 mb-3">
          <input
            type="number"
            min={1}
            max={1440}
            value={custom}
            onChange={e => setCustom(e.target.value)}
            placeholder="Custom minutes"
            disabled={busy}
            className="flex-1 px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-white text-sm placeholder:text-white/30 focus:outline-none focus:border-amber-400 disabled:opacity-40"
          />
          <button
            onClick={() => {
              const n = Number(custom);
              if (Number.isFinite(n) && n > 0) onConfirm(n, note);
            }}
            disabled={busy || !custom || Number(custom) <= 0}
            className="px-4 py-2 rounded-xl bg-amber-500 text-white text-sm font-semibold disabled:opacity-40"
          >
            {busy ? "Pausing…" : "Pause"}
          </button>
        </div>
        {error && (
          <div role="alert" className="mb-3 px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
            {error}
          </div>
        )}
        <button
          onClick={onCancel}
          disabled={busy}
          className="w-full px-4 py-2.5 rounded-xl border border-white/10 text-white/60 hover:bg-white/5 hover:text-white transition-colors text-sm font-medium disabled:opacity-40"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
