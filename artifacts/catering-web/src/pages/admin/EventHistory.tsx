import { useState, useEffect, useCallback } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import { getAdminToken } from "@/components/AdminGuard";
import {
  Plus, Archive, Trash2, ChevronDown, ChevronUp, Loader2,
  CheckCircle2, Clock, X, CalendarDays, ShoppingBag, DollarSign,
  Zap, ZapOff,
} from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authHeaders() {
  const token = getAdminToken();
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

const STATUS_LABELS: Record<string, string> = {
  pending: "New",
  preparing: "Preparing",
  ready: "Ready",
  done: "Done",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700",
  preparing: "bg-blue-100 text-blue-700",
  ready: "bg-emerald-100 text-emerald-700",
  done: "bg-secondary text-muted-foreground",
};

function formatCurrency(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDate(d: string | null | undefined) {
  if (!d) return null;
  try { return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
  catch { return d; }
}

type Session = {
  id: number;
  name: string;
  date: string | null;
  status: string;
  notes: string | null;
  createdAt: string;
  archivedAt: string | null;
  orderCount: number;
  totalRevenue: number;
  isActive: boolean;
};

type Order = {
  id: number;
  guestName: string;
  phoneNumber: string | null;
  items: Array<{ name: string; quantity: number; price: number }>;
  status: string;
  createdAt: string;
  orderSource?: "guest" | "staff" | string;
};

function NewSessionModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [notes, setNotes] = useState("");
  const [setActive, setSetActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError("Please enter an event name."); return; }
    setSaving(true);
    try {
      const res = await fetch(`${BASE}/api/admin/event-sessions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ name, date, notes, setActive }),
      });
      if (!res.ok) throw new Error();
      onCreated();
      onClose();
    } catch {
      setError("Failed to create event session.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-card rounded-2xl shadow-2xl border border-border w-full max-w-md">
        <div className="flex items-center justify-between p-6 border-b border-border">
          <h2 className="font-display font-bold text-xl">New Event Session</h2>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-semibold mb-1.5">Event Name *</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Tech Gala June 2026"
              className="w-full px-4 py-2.5 border border-border rounded-xl bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1.5">Event Date</label>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="w-full px-4 py-2.5 border border-border rounded-xl bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1.5">Notes</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={2}
              placeholder="Optional internal notes about this event"
              className="w-full px-4 py-2.5 border border-border rounded-xl bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none resize-none"
            />
          </div>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={setActive}
              onChange={e => setSetActive(e.target.checked)}
              className="w-4 h-4 accent-foreground"
            />
            <span className="text-sm font-medium">Set as active event (new orders will be tagged to this session)</span>
          </label>
          {error && <p className="text-destructive text-sm">{error}</p>}
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2.5 border border-border rounded-xl font-medium hover:bg-secondary transition-colors">
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              {saving ? "Creating…" : "Create Session"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SessionOrders({ sessionId, onClose, onOrdersDeleted }: { sessionId: number; onClose: () => void; onOrdersDeleted: () => void }) {
  const [data, setData] = useState<{ session: Session; orders: Order[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);

  function loadOrders() {
    fetch(`${BASE}/api/admin/event-sessions/${sessionId}/orders`, { headers: authHeaders() })
      .then(r => r.json())
      .then(setData)
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadOrders(); }, [sessionId]);

  async function handleDeleteAllOrders() {
    if (!confirm("Delete ALL orders for this session? This cannot be undone.")) return;
    setDeleting(true);
    try {
      const res = await fetch(`${BASE}/api/admin/event-sessions/${sessionId}/orders`, { method: "DELETE", headers: authHeaders() });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      setData(prev => prev ? { ...prev, orders: [] } : null);
      onOrdersDeleted();
    } catch {
      alert("Failed to delete orders. Please try again.");
    } finally {
      setDeleting(false);
    }
  }

  const orders = data?.orders ?? [];
  const totalRevenue = orders.reduce((sum, o) => sum + o.items.reduce((s, i) => s + i.price * i.quantity, 0), 0);

  // Item breakdown
  const breakdown: Record<string, { quantity: number; revenue: number }> = {};
  orders.forEach(o => o.items.forEach(i => {
    if (!breakdown[i.name]) breakdown[i.name] = { quantity: 0, revenue: 0 };
    breakdown[i.name].quantity += i.quantity;
    breakdown[i.name].revenue += i.price * i.quantity;
  }));

  return (
    <div className="mt-4 bg-secondary/40 border border-border rounded-2xl overflow-hidden">
      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="p-5 space-y-5">
          {/* Summary */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-card border border-border rounded-xl p-3 text-center">
              <p className="text-2xl font-bold">{orders.length}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Orders</p>
            </div>
            <div className="bg-card border border-border rounded-xl p-3 text-center">
              <p className="text-2xl font-bold">{formatCurrency(totalRevenue)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Revenue</p>
            </div>
            <div className="bg-card border border-border rounded-xl p-3 text-center">
              <p className="text-2xl font-bold">
                {orders.reduce((s, o) => s + o.items.reduce((ss, i) => ss + i.quantity, 0), 0)}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">Items Sold</p>
            </div>
          </div>

          {orders.length > 0 && (
            <div className="flex justify-end">
              <button
                onClick={handleDeleteAllOrders}
                disabled={deleting}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-destructive hover:bg-red-50 rounded-xl border border-border hover:border-red-200 transition-colors disabled:opacity-50"
              >
                {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                Delete all orders
              </button>
            </div>
          )}
          {orders.length === 0 ? (
            <p className="text-center text-muted-foreground text-sm py-4">No orders recorded for this event.</p>
          ) : (
            <>
              {/* Item breakdown */}
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Item Breakdown</h4>
                <div className="bg-card border border-border rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="border-b border-border">
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="px-4 py-2.5 font-semibold">Item</th>
                        <th className="px-4 py-2.5 font-semibold text-center">Qty</th>
                        <th className="px-4 py-2.5 font-semibold text-right">Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(breakdown).sort((a, b) => b[1].quantity - a[1].quantity).map(([name, d]) => (
                        <tr key={name} className="border-b border-border/50 last:border-0">
                          <td className="px-4 py-2.5">{name}</td>
                          <td className="px-4 py-2.5 text-center font-medium">{d.quantity}</td>
                          <td className="px-4 py-2.5 text-right text-muted-foreground">{formatCurrency(d.revenue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Order list */}
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">All Orders</h4>
                <div className="space-y-2">
                  {orders.map(order => (
                    <div key={order.id} className="bg-card border border-border rounded-xl px-4 py-3 flex items-start gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-semibold text-sm">{order.guestName}</span>
                          {order.orderSource === "staff" && (
                            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">Staff</span>
                          )}
                          {order.phoneNumber && <span className="text-xs text-muted-foreground">{order.phoneNumber}</span>}
                          <span className={cn("ml-auto text-xs px-2 py-0.5 rounded-full font-medium", STATUS_COLORS[order.status] ?? "bg-secondary text-muted-foreground")}>
                            {STATUS_LABELS[order.status] ?? order.status}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {order.items.map(i => `${i.quantity}× ${i.name}`).join(", ")}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-medium">{formatCurrency(order.items.reduce((s, i) => s + i.price * i.quantity, 0))}</p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(order.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function EventHistory() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [actionLoading, setActionLoading] = useState<Record<number, boolean>>({});

  const load = useCallback(() => {
    setLoading(true);
    fetch(`${BASE}/api/admin/event-sessions`, { headers: authHeaders() })
      .then(r => r.json())
      .then(setSessions)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function activate(id: number) {
    setActionLoading(p => ({ ...p, [id]: true }));
    await fetch(`${BASE}/api/admin/event-sessions/${id}/activate`, { method: "POST", headers: authHeaders() });
    await load();
    setActionLoading(p => ({ ...p, [id]: false }));
  }

  async function deactivate() {
    await fetch(`${BASE}/api/admin/event-sessions/deactivate`, { method: "POST", headers: authHeaders() });
    await load();
  }

  async function archive(id: number) {
    if (!confirm("Archive this event session? It will no longer accept new orders.")) return;
    setActionLoading(p => ({ ...p, [id]: true }));
    await fetch(`${BASE}/api/admin/event-sessions/${id}/archive`, { method: "POST", headers: authHeaders() });
    await load();
    setActionLoading(p => ({ ...p, [id]: false }));
  }

  async function deleteSession(id: number, name: string) {
    if (!confirm(`Delete "${name}"? The session record will be removed. Past orders will remain but will no longer be linked to this event.`)) return;
    setActionLoading(p => ({ ...p, [id]: true }));
    await fetch(`${BASE}/api/admin/event-sessions/${id}`, { method: "DELETE", headers: authHeaders() });
    await load();
    setActionLoading(p => ({ ...p, [id]: false }));
    if (expandedId === id) setExpandedId(null);
  }

  const activeSession = sessions.find(s => s.isActive);

  return (
    <AdminLayout>
      {showNew && <NewSessionModal onClose={() => setShowNew(false)} onCreated={load} />}

      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display font-bold text-4xl mb-2">Event Log</h1>
          <p className="text-muted-foreground">Track orders by event session. Create a session before each event to keep records organized.</p>
        </div>
        <button
          onClick={() => setShowNew(true)}
          className="flex items-center gap-2 px-5 py-2.5 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors shrink-0"
        >
          <Plus className="w-4 h-4" /> New Session
        </button>
      </div>

      {/* Active session banner */}
      {activeSession && (
        <div className="mb-6 bg-emerald-50 border border-emerald-200 rounded-2xl px-5 py-4 flex items-center gap-4">
          <Zap className="w-5 h-5 text-emerald-600 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-emerald-800">Active: {activeSession.name}</p>
            <p className="text-sm text-emerald-600">
              New orders are being tagged to this session.
              {activeSession.date && ` · ${formatDate(activeSession.date)}`}
            </p>
          </div>
          <button
            onClick={deactivate}
            className="flex items-center gap-1.5 text-sm font-medium text-emerald-700 hover:text-emerald-900 transition-colors shrink-0"
          >
            <ZapOff className="w-4 h-4" /> Deactivate
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : sessions.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          <CalendarDays className="w-12 h-12 mx-auto mb-4 opacity-20" />
          <p className="font-medium mb-1">No event sessions yet</p>
          <p className="text-sm">Create a session before your next event to start tracking orders.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {sessions.map(session => {
            const isExpanded = expandedId === session.id;
            const busy = actionLoading[session.id];
            return (
              <div key={session.id} className={cn("bg-card border rounded-2xl shadow-sm overflow-hidden transition-all", session.isActive ? "border-emerald-300" : "border-border")}>
                <div className="p-5">
                  <div className="flex items-start gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <h3 className="font-display font-bold text-lg">{session.name}</h3>
                        {session.isActive && (
                          <span className="text-xs font-medium text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full flex items-center gap-1">
                            <Zap className="w-3 h-3" /> Active
                          </span>
                        )}
                        {session.status === "archived" && (
                          <span className="text-xs font-medium text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">Archived</span>
                        )}
                      </div>
                      <div className="flex items-center gap-4 text-sm text-muted-foreground flex-wrap">
                        {session.date && (
                          <span className="flex items-center gap-1"><CalendarDays className="w-3.5 h-3.5" />{formatDate(session.date)}</span>
                        )}
                        <span className="flex items-center gap-1"><ShoppingBag className="w-3.5 h-3.5" />{session.orderCount} order{session.orderCount !== 1 ? "s" : ""}</span>
                        <span className="flex items-center gap-1"><DollarSign className="w-3.5 h-3.5" />{formatCurrency(session.totalRevenue)}</span>
                        <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" />Created {formatDate(session.createdAt)}</span>
                      </div>
                      {session.notes && <p className="text-sm text-muted-foreground mt-1.5 italic">{session.notes}</p>}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {!session.isActive && session.status !== "archived" && (
                        <button
                          onClick={() => activate(session.id)}
                          disabled={busy}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-emerald-50 text-emerald-700 hover:bg-emerald-100 rounded-lg transition-colors disabled:opacity-50"
                        >
                          <Zap className="w-3.5 h-3.5" /> Set Active
                        </button>
                      )}
                      {session.status !== "archived" && (
                        <button
                          onClick={() => archive(session.id)}
                          disabled={busy}
                          className="p-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors disabled:opacity-50"
                          title="Archive session"
                        >
                          <Archive className="w-4 h-4" />
                        </button>
                      )}
                      <button
                        onClick={() => deleteSession(session.id, session.name)}
                        disabled={busy}
                        className="p-2 text-muted-foreground hover:text-destructive hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                        title="Delete session"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setExpandedId(isExpanded ? null : session.id)}
                        className="p-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors"
                        title={isExpanded ? "Collapse" : "View orders"}
                      >
                        {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                </div>
                {isExpanded && <div className="px-5 pb-5"><SessionOrders sessionId={session.id} onClose={() => setExpandedId(null)} onOrdersDeleted={load} /></div>}
              </div>
            );
          })}
        </div>
      )}
    </AdminLayout>
  );
}
