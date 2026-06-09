import { useState, useEffect, useCallback } from "react";
import { getAdminToken } from "@/components/AdminGuard";
import {
  Plus, Trash2, Edit2, X, Check, Loader2, Users,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authHeaders() {
  const token = getAdminToken();
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

type LaborEntry = {
  id: number;
  referenceType: string;
  referenceId: number;
  employeeName: string;
  hours: number | null;
  hourlyRate: number | null;
  flatCost: number | null;
  subtotal: number | null;
  notes: string | null;
  createdAt: string;
};

function computeSubtotal(e: LaborEntry): number | null {
  if (e.flatCost != null) return e.flatCost;
  if (e.hours != null && e.hourlyRate != null) return e.hours * e.hourlyRate;
  return null;
}

function EntryForm({
  referenceType,
  referenceId,
  initial,
  onSave,
  onCancel,
}: {
  referenceType: string;
  referenceId: number;
  initial?: LaborEntry;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.employeeName ?? "");
  const [mode, setMode] = useState<"hourly" | "flat">(initial?.flatCost != null ? "flat" : "hourly");
  const [hours, setHours] = useState(initial?.hours != null ? String(initial.hours) : "");
  const [rate, setRate] = useState(initial?.hourlyRate != null ? String(initial.hourlyRate) : "");
  const [flat, setFlat] = useState(initial?.flatCost != null ? String(initial.flatCost) : "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  async function submit() {
    if (!name.trim()) { setErr("Employee name required"); return; }
    if (mode === "hourly" && (!hours || !rate)) { setErr("Both hours and rate required for hourly"); return; }
    if (mode === "flat" && !flat) { setErr("Flat cost required"); return; }
    setSaving(true);
    setErr("");
    try {
      const body: Record<string, unknown> = {
        referenceType,
        referenceId,
        employeeName: name.trim(),
        notes: notes.trim() || null,
      };
      if (mode === "hourly") {
        body.hours = parseFloat(hours);
        body.hourlyRate = parseFloat(rate);
        body.flatCost = null;
      } else {
        body.flatCost = parseFloat(flat);
        body.hours = null;
        body.hourlyRate = null;
      }

      const url = initial ? `${BASE}/api/admin/costs/labor/${initial.id}` : `${BASE}/api/admin/costs/labor`;
      const method = initial ? "PATCH" : "POST";
      const res = await fetch(url, { method, headers: authHeaders(), body: JSON.stringify(body) });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as any).error ?? "Failed to save");
      }
      onSave();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border border-border rounded-xl p-4 bg-card space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Employee Name *</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Maria" className="w-full px-3 py-2 border border-border rounded-lg text-sm bg-background" />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Cost type</label>
          <div className="flex gap-2">
            <button onClick={() => setMode("hourly")} className={`px-3 py-2 rounded-lg text-xs font-semibold border transition ${mode === "hourly" ? "bg-indigo-600 text-white border-transparent" : "border-border bg-background text-foreground hover:bg-secondary"}`}>Hourly</button>
            <button onClick={() => setMode("flat")} className={`px-3 py-2 rounded-lg text-xs font-semibold border transition ${mode === "flat" ? "bg-indigo-600 text-white border-transparent" : "border-border bg-background text-foreground hover:bg-secondary"}`}>Flat</button>
          </div>
        </div>
      </div>
      {mode === "hourly" ? (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Hours</label>
            <input type="number" min="0" step="0.25" value={hours} onChange={e => setHours(e.target.value)} placeholder="8.5" className="w-full px-3 py-2 border border-border rounded-lg text-sm bg-background" />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Hourly rate ($)</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
              <input type="number" min="0" step="0.01" value={rate} onChange={e => setRate(e.target.value)} placeholder="18.00" className="w-full pl-7 px-3 py-2 border border-border rounded-lg text-sm bg-background" />
            </div>
          </div>
        </div>
      ) : (
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Total labor cost ($)</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
            <input type="number" min="0" step="0.01" value={flat} onChange={e => setFlat(e.target.value)} placeholder="150.00" className="w-full pl-7 px-3 py-2 border border-border rounded-lg text-sm bg-background" />
          </div>
        </div>
      )}
      <div>
        <label className="block text-xs text-muted-foreground mb-1">Notes (optional)</label>
        <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. Setup + breakdown" className="w-full px-3 py-2 border border-border rounded-lg text-sm bg-background" />
      </div>
      {mode === "hourly" && hours && rate && (
        <p className="text-xs text-muted-foreground">
          Subtotal: <strong className="text-foreground">${(parseFloat(hours) * parseFloat(rate)).toFixed(2)}</strong>
        </p>
      )}
      {err && <p className="text-destructive text-xs">{err}</p>}
      <div className="flex gap-2 pt-1">
        <button onClick={submit} disabled={saving} className="px-4 py-2 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2 text-sm">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          {initial ? "Save Changes" : "Add Entry"}
        </button>
        <button onClick={onCancel} className="px-4 py-2 bg-secondary text-foreground font-semibold rounded-xl hover:bg-secondary/70 text-sm">Cancel</button>
      </div>
    </div>
  );
}

export function LaborPanel({
  referenceType,
  referenceId,
}: {
  referenceType: "event_session" | "catering_inquiry";
  referenceId: number;
}) {
  const [entries, setEntries] = useState<LaborEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ referenceType, referenceId: String(referenceId) });
      const res = await fetch(`${BASE}/api/admin/costs/labor?${params}`, { headers: authHeaders() });
      if (!res.ok) throw new Error();
      setEntries(await res.json());
    } catch {
      setError("Failed to load labor entries");
    } finally {
      setLoading(false);
    }
  }, [referenceType, referenceId]);

  useEffect(() => { load(); }, [load]);

  async function deleteEntry(id: number) {
    if (!confirm("Delete this labor entry?")) return;
    try {
      const res = await fetch(`${BASE}/api/admin/costs/labor/${id}`, { method: "DELETE", headers: authHeaders() });
      if (!res.ok) throw new Error();
      setEntries(prev => prev.filter(e => e.id !== id));
    } catch {
      alert("Failed to delete labor entry");
    }
  }

  const totalLabor = entries.reduce((s, e) => s + (computeSubtotal(e) ?? 0), 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <Users className="w-3.5 h-3.5" /> Labor Costs
          {entries.length > 0 && (
            <span className="ml-2 font-bold text-sky-600 dark:text-sky-400 text-sm">
              ${totalLabor.toFixed(2)} total
            </span>
          )}
        </h4>
        {!showAdd && (
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            <Plus className="w-3.5 h-3.5" /> Add
          </button>
        )}
      </div>

      {showAdd && (
        <div className="mb-3">
          <EntryForm
            referenceType={referenceType}
            referenceId={referenceId}
            onSave={() => { setShowAdd(false); load(); }}
            onCancel={() => setShowAdd(false)}
          />
        </div>
      )}

      {error && <p className="text-destructive text-xs mb-2">{error}</p>}

      {loading ? (
        <div className="flex justify-center py-3"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
      ) : entries.length === 0 && !showAdd ? (
        <p className="text-xs text-muted-foreground italic py-1">No labor entries yet. Track staff hours or flat labor costs here.</p>
      ) : (
        <div className="space-y-2">
          {entries.map(entry => {
            const sub = computeSubtotal(entry);
            if (editingId === entry.id) {
              return (
                <EntryForm
                  key={entry.id}
                  referenceType={referenceType}
                  referenceId={referenceId}
                  initial={entry}
                  onSave={() => { setEditingId(null); load(); }}
                  onCancel={() => setEditingId(null)}
                />
              );
            }
            return (
              <div key={entry.id} className="flex items-center gap-3 bg-card border border-border rounded-xl px-4 py-3">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm">{entry.employeeName}</p>
                  {entry.hours != null && entry.hourlyRate != null && (
                    <p className="text-xs text-muted-foreground">{entry.hours}h × ${entry.hourlyRate}/hr</p>
                  )}
                  {entry.flatCost != null && (
                    <p className="text-xs text-muted-foreground">Flat cost</p>
                  )}
                  {entry.notes && <p className="text-xs text-muted-foreground truncate">{entry.notes}</p>}
                </div>
                {sub != null && (
                  <p className="font-bold text-sky-600 dark:text-sky-400 text-sm shrink-0">${sub.toFixed(2)}</p>
                )}
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => setEditingId(entry.id)} className="p-1.5 rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors">
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => deleteEntry(entry.id)} className="p-1.5 rounded-lg text-muted-foreground hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/40 dark:hover:text-rose-400 transition-colors">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
