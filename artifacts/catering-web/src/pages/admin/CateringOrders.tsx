import { useState, useEffect, useCallback } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import { getAdminToken } from "@/components/AdminGuard";
import {
  Plus, Loader2, X, Save, Trash2, ChevronRight, CalendarDays,
  User, Mail, Phone, Building2, MapPin, Users, FileText, StickyNote, Check,
} from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authHeaders() {
  const token = getAdminToken();
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

const STATUSES = [
  { key: "inquiry", label: "Inquiry", color: "bg-blue-100 text-blue-700" },
  { key: "quoted", label: "Quoted", color: "bg-violet-100 text-violet-700" },
  { key: "confirmed", label: "Confirmed", color: "bg-emerald-100 text-emerald-700" },
  { key: "completed", label: "Completed", color: "bg-secondary text-muted-foreground" },
  { key: "cancelled", label: "Cancelled", color: "bg-red-100 text-red-600" },
];

function getStatusMeta(key: string) {
  return STATUSES.find(s => s.key === key) ?? { key, label: key, color: "bg-secondary text-muted-foreground" };
}

type Inquiry = {
  id: number;
  clientName: string;
  clientEmail: string | null;
  clientPhone: string | null;
  organization: string | null;
  eventDate: string | null;
  guestCount: number | null;
  venueAddress: string | null;
  menuNotes: string | null;
  adminNotes: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

function emptyForm(): Partial<Inquiry> {
  return {
    clientName: "", clientEmail: "", clientPhone: "", organization: "",
    eventDate: "", guestCount: undefined, venueAddress: "", menuNotes: "", adminNotes: "", status: "inquiry",
  };
}

function formatDate(d: string | null | undefined) {
  if (!d) return null;
  try {
    const date = new Date(d);
    if (isNaN(date.getTime())) return d;
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch { return d; }
}

function Field({ icon: Icon, label, children }: { icon: any; label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
        <Icon className="w-3.5 h-3.5" /> {label}
      </label>
      {children}
    </div>
  );
}

function DetailPanel({
  inquiry,
  onClose,
  onSaved,
  onDeleted,
  isNew,
}: {
  inquiry: Partial<Inquiry>;
  onClose: () => void;
  onSaved: (saved: Inquiry) => void;
  onDeleted?: () => void;
  isNew: boolean;
}) {
  const [form, setForm] = useState<Partial<Inquiry>>(inquiry);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  function set(key: keyof Inquiry, value: any) {
    setForm(p => ({ ...p, [key]: value }));
    setSaved(false);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!form.clientName?.trim()) { setError("Client name is required."); return; }
    setSaving(true);
    setError("");
    try {
      const url = isNew ? `${BASE}/api/admin/catering` : `${BASE}/api/admin/catering/${(inquiry as Inquiry).id}`;
      const method = isNew ? "POST" : "PUT";
      const res = await fetch(url, { method, headers: authHeaders(), body: JSON.stringify(form) });
      if (!res.ok) throw new Error();
      const saved = await res.json();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      onSaved(saved);
    } catch {
      setError("Failed to save. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete inquiry for "${form.clientName}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await fetch(`${BASE}/api/admin/catering/${(inquiry as Inquiry).id}`, { method: "DELETE", headers: authHeaders() });
      onDeleted?.();
    } catch {
      setError("Failed to delete.");
    } finally {
      setDeleting(false);
    }
  }

  const inputCls = "w-full px-3 py-2 border border-border rounded-xl bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all text-sm";
  const textareaCls = `${inputCls} resize-none`;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <h2 className="font-display font-bold text-lg">{isNew ? "New Inquiry" : form.clientName || "Edit Inquiry"}</h2>
        <button onClick={onClose} className="p-2 rounded-xl hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      <form onSubmit={handleSave} className="flex-1 overflow-y-auto">
        <div className="p-6 space-y-4">
          {/* Status pipeline */}
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground block mb-2">Status</label>
            <div className="flex flex-wrap gap-2">
              {STATUSES.map(s => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => set("status", s.key)}
                  className={cn(
                    "px-3 py-1.5 rounded-lg text-sm font-medium transition-all",
                    form.status === s.key
                      ? `${s.color} ring-2 ring-offset-1 ring-current`
                      : "bg-secondary text-muted-foreground hover:bg-secondary/80"
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div className="border-t border-border pt-4 grid gap-4">
            <Field icon={User} label="Client Name">
              <input value={form.clientName ?? ""} onChange={e => set("clientName", e.target.value)} placeholder="Full name" className={inputCls} />
            </Field>

            <Field icon={Building2} label="Organization">
              <input value={form.organization ?? ""} onChange={e => set("organization", e.target.value)} placeholder="Company or group name" className={inputCls} />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field icon={Mail} label="Email">
                <input type="email" value={form.clientEmail ?? ""} onChange={e => set("clientEmail", e.target.value)} placeholder="client@example.com" className={inputCls} />
              </Field>
              <Field icon={Phone} label="Phone">
                <input type="tel" value={form.clientPhone ?? ""} onChange={e => set("clientPhone", e.target.value)} placeholder="(555) 000-0000" className={inputCls} />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field icon={CalendarDays} label="Event Date">
                <input type="date" value={form.eventDate ?? ""} onChange={e => set("eventDate", e.target.value)} className={inputCls} />
              </Field>
              <Field icon={Users} label="Guest Count">
                <input
                  type="number"
                  min={1}
                  value={form.guestCount ?? ""}
                  onChange={e => set("guestCount", e.target.value === "" ? null : parseInt(e.target.value))}
                  placeholder="50"
                  className={inputCls}
                />
              </Field>
            </div>

            <Field icon={MapPin} label="Venue / Address">
              <input value={form.venueAddress ?? ""} onChange={e => set("venueAddress", e.target.value)} placeholder="Event location" className={inputCls} />
            </Field>

            <Field icon={FileText} label="Menu Notes">
              <textarea
                value={form.menuNotes ?? ""}
                onChange={e => set("menuNotes", e.target.value)}
                rows={3}
                placeholder="Dietary restrictions, preferred items, special requests…"
                className={textareaCls}
              />
            </Field>

            <Field icon={StickyNote} label="Admin Notes">
              <textarea
                value={form.adminNotes ?? ""}
                onChange={e => set("adminNotes", e.target.value)}
                rows={3}
                placeholder="Internal notes — quotes sent, follow-ups needed, etc."
                className={textareaCls}
              />
            </Field>
          </div>

          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>
      </form>

      <div className="px-6 py-4 border-t border-border flex items-center gap-3 shrink-0">
        {!isNew && (
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-muted-foreground hover:text-destructive hover:bg-red-50 rounded-xl transition-colors"
          >
            {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            Delete
          </button>
        )}
        <button
          onClick={handleSave}
          disabled={saving}
          className="ml-auto flex items-center gap-2 px-5 py-2.5 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4 text-emerald-400" /> : <Save className="w-4 h-4" />}
          {saving ? "Saving…" : saved ? "Saved!" : "Save"}
        </button>
      </div>
    </div>
  );
}

export default function CateringOrders() {
  const [inquiries, setInquiries] = useState<Inquiry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Partial<Inquiry> | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");

  const load = useCallback(() => {
    fetch(`${BASE}/api/admin/catering`, { headers: authHeaders() })
      .then(r => r.json())
      .then(setInquiries)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  function openNew() {
    setSelected(emptyForm());
    setIsNew(true);
  }

  function closePanel() {
    setSelected(null);
    setIsNew(false);
  }

  function handleSaved(saved: Inquiry) {
    setInquiries(prev => {
      const idx = prev.findIndex(i => i.id === saved.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = saved;
        return next;
      }
      return [saved, ...prev];
    });
    setSelected(saved);
    setIsNew(false);
  }

  function handleDeleted() {
    if (selected && "id" in selected) {
      setInquiries(prev => prev.filter(i => i.id !== (selected as Inquiry).id));
    }
    closePanel();
  }

  const filtered = statusFilter === "all" ? inquiries : inquiries.filter(i => i.status === statusFilter);

  const counts: Record<string, number> = {};
  inquiries.forEach(i => { counts[i.status] = (counts[i.status] ?? 0) + 1; });

  return (
    <AdminLayout>
      <div className="flex h-[calc(100vh-8rem)] -m-4 md:-m-8 overflow-hidden">
        {/* Left panel — list */}
        <div className={cn("flex flex-col border-r border-border bg-background transition-all", selected ? "hidden md:flex md:w-80 lg:w-96 shrink-0" : "flex-1")}>
          {/* Header */}
          <div className="px-6 py-5 border-b border-border shrink-0">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h1 className="font-display font-bold text-2xl">Catering Orders</h1>
                <p className="text-sm text-muted-foreground">{inquiries.length} total inquir{inquiries.length !== 1 ? "ies" : "y"}</p>
              </div>
              <button
                onClick={openNew}
                className="flex items-center gap-2 px-4 py-2 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors text-sm"
              >
                <Plus className="w-4 h-4" /> New
              </button>
            </div>

            {/* Status filter */}
            <div className="flex gap-1.5 flex-wrap">
              <button
                onClick={() => setStatusFilter("all")}
                className={cn("px-3 py-1 rounded-lg text-sm font-medium transition-colors", statusFilter === "all" ? "bg-foreground text-background" : "hover:bg-secondary text-muted-foreground")}
              >
                All {inquiries.length > 0 && `(${inquiries.length})`}
              </button>
              {STATUSES.map(s => (
                counts[s.key] ? (
                  <button
                    key={s.key}
                    onClick={() => setStatusFilter(s.key)}
                    className={cn("px-3 py-1 rounded-lg text-sm font-medium transition-colors", statusFilter === s.key ? "bg-foreground text-background" : "hover:bg-secondary text-muted-foreground")}
                  >
                    {s.label} ({counts[s.key]})
                  </button>
                ) : null
              ))}
            </div>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-20 text-muted-foreground px-6">
                <FileText className="w-12 h-12 mx-auto mb-4 opacity-20" />
                <p className="font-medium mb-1">{statusFilter === "all" ? "No catering inquiries yet" : `No ${statusFilter} inquiries`}</p>
                {statusFilter === "all" && <p className="text-sm">Click "New" to add a catering inquiry.</p>}
              </div>
            ) : (
              <div className="divide-y divide-border">
                {filtered.map(inquiry => {
                  const status = getStatusMeta(inquiry.status);
                  const isSelected = selected && "id" in selected && (selected as Inquiry).id === inquiry.id;
                  return (
                    <button
                      key={inquiry.id}
                      onClick={() => { setSelected(inquiry); setIsNew(false); }}
                      className={cn(
                        "w-full text-left px-6 py-4 flex items-center gap-4 hover:bg-secondary/50 transition-colors",
                        isSelected && "bg-secondary"
                      )}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="font-semibold text-sm truncate">{inquiry.clientName}</span>
                          <span className={cn("shrink-0 text-xs px-2 py-0.5 rounded-full font-medium", status.color)}>{status.label}</span>
                        </div>
                        {inquiry.organization && <p className="text-xs text-muted-foreground truncate">{inquiry.organization}</p>}
                        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                          {inquiry.eventDate && <span>{formatDate(inquiry.eventDate)}</span>}
                          {inquiry.guestCount && <span>{inquiry.guestCount} guests</span>}
                          {!inquiry.eventDate && !inquiry.guestCount && <span>Added {formatDate(inquiry.createdAt)}</span>}
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right panel — detail */}
        {selected ? (
          <div className="flex-1 flex flex-col bg-card min-w-0">
            <DetailPanel
              inquiry={selected}
              onClose={closePanel}
              onSaved={handleSaved}
              onDeleted={handleDeleted}
              isNew={isNew}
            />
          </div>
        ) : (
          <div className="flex-1 hidden md:flex items-center justify-center text-muted-foreground flex-col gap-3">
            <FileText className="w-16 h-16 opacity-10" />
            <p className="font-medium">Select an inquiry to view details</p>
            <p className="text-sm">or click New to create one</p>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
