import { useState, useEffect, useCallback } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import { getAdminToken } from "@/components/AdminGuard";
import {
  Plus, Trash2, Edit2, X, Check, ChevronDown, ChevronRight, Loader2,
  FlaskConical, History, DollarSign, AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authHeaders() {
  const token = getAdminToken();
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

function fmtDate(s: string) {
  try {
    return new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  } catch { return s; }
}

const UNIT_GROUPS = [
  { label: "Weight", units: ["g", "oz", "lb", "kg"] },
  { label: "Volume", units: ["ml", "tsp", "tbsp", "fl_oz", "cup", "pint", "quart", "gallon", "l"] },
  { label: "Count",  units: ["each", "dozen"] },
] as const;

const CANONICAL_UNITS = new Set(UNIT_GROUPS.flatMap(g => g.units as readonly string[]));

function isCanonical(unit: string) {
  return CANONICAL_UNITS.has(unit);
}

type CostEntry = { id: number; costPerUnit: number; effectiveAt: string };
type Ingredient = {
  id: number;
  name: string;
  unit: string;
  notes: string | null;
  currentCost: number | null;
  createdAt: string;
  history: CostEntry[];
};

export default function CostIngredients() {
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formName, setFormName] = useState("");
  const [formUnit, setFormUnit] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [formInitialCost, setFormInitialCost] = useState("");
  const [formSaving, setFormSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const [addCostIngId, setAddCostIngId] = useState<number | null>(null);
  const [newCostValue, setNewCostValue] = useState("");
  const [newCostEffectiveAt, setNewCostEffectiveAt] = useState("");
  const [costSaving, setCostSaving] = useState(false);
  const [costError, setCostError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${BASE}/api/admin/costs/ingredients`, { headers: authHeaders() });
      if (!res.ok) throw new Error();
      setIngredients(await res.json());
    } catch {
      setError("Failed to load ingredients");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function startAdd() {
    setEditingId(null);
    setFormName("");
    setFormUnit("");
    setFormNotes("");
    setFormInitialCost("");
    setFormError("");
    setShowAddForm(true);
  }

  function startEdit(ing: Ingredient) {
    setEditingId(ing.id);
    setFormName(ing.name);
    setFormUnit(ing.unit);
    setFormNotes(ing.notes ?? "");
    setFormInitialCost("");
    setFormError("");
    setShowAddForm(true);
  }

  function cancelForm() {
    setShowAddForm(false);
    setEditingId(null);
    setFormError("");
  }

  async function saveForm() {
    if (!formName.trim()) { setFormError("Name is required"); return; }
    if (!formUnit.trim()) { setFormError("Unit is required"); return; }
    setFormSaving(true);
    setFormError("");
    try {
      const url = editingId
        ? `${BASE}/api/admin/costs/ingredients/${editingId}`
        : `${BASE}/api/admin/costs/ingredients`;
      const method = editingId ? "PUT" : "POST";
      const body = editingId
        ? { name: formName.trim(), unit: formUnit.trim(), notes: formNotes.trim() || null }
        : { name: formName.trim(), unit: formUnit.trim(), notes: formNotes.trim() || null, initialCost: formInitialCost ? parseFloat(formInitialCost) : undefined };

      const res = await fetch(url, { method, headers: authHeaders(), body: JSON.stringify(body) });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as any).error ?? "Failed to save");
      }
      await load();
      cancelForm();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setFormSaving(false);
    }
  }

  async function deleteIngredient(id: number, name: string) {
    if (!confirm(`Delete ingredient "${name}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`${BASE}/api/admin/costs/ingredients/${id}`, { method: "DELETE", headers: authHeaders() });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert((data as any).error ?? "Failed to delete");
        return;
      }
      await load();
    } catch {
      alert("Failed to delete ingredient");
    }
  }

  async function addCostEntry(ingId: number) {
    if (!newCostValue) { setCostError("Cost is required"); return; }
    const cost = parseFloat(newCostValue);
    if (!Number.isFinite(cost) || cost < 0) { setCostError("Enter a valid non-negative cost"); return; }
    setCostSaving(true);
    setCostError("");
    try {
      const body: Record<string, unknown> = { costPerUnit: cost };
      if (newCostEffectiveAt) body.effectiveAt = new Date(newCostEffectiveAt).toISOString();
      const res = await fetch(`${BASE}/api/admin/costs/ingredients/${ingId}/costs`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as any).error ?? "Failed to add cost");
      }
      setAddCostIngId(null);
      setNewCostValue("");
      setNewCostEffectiveAt("");
      await load();
    } catch (err) {
      setCostError(err instanceof Error ? err.message : "Failed to add cost");
    } finally {
      setCostSaving(false);
    }
  }

  function toggleExpanded(id: number) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const nonCanonicalCount = ingredients.filter(i => !isCanonical(i.unit)).length;

  return (
    <AdminLayout>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display font-bold text-2xl sm:text-4xl mb-1 flex items-center gap-3">
            <FlaskConical className="w-8 h-8 text-indigo-600" />
            Ingredient Library
          </h1>
          <p className="text-muted-foreground text-sm">
            Manage ingredients and their costs. Cost changes are recorded with timestamps for accurate historical recipe costing.
          </p>
        </div>
        <button
          onClick={startAdd}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 transition text-sm shrink-0"
        >
          <Plus className="w-4 h-4" /> Add Ingredient
        </button>
      </div>

      {nonCanonicalCount > 0 && (
        <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50 rounded-xl p-4 mb-6 flex items-start gap-3 text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          <span>
            <strong>{nonCanonicalCount} ingredient{nonCanonicalCount !== 1 ? "s have" : " has"} a non-standard unit.</strong>{" "}
            Edit {nonCanonicalCount !== 1 ? "them" : "it"} and select a standard unit so the system can automatically convert between units in recipes.
          </span>
        </div>
      )}

      {showAddForm && (
        <div className="bg-card border border-border rounded-2xl p-5 mb-6 shadow-sm">
          <h2 className="font-display font-bold text-base mb-4">
            {editingId ? "Edit Ingredient" : "New Ingredient"}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Name *</label>
              <input
                value={formName}
                onChange={e => setFormName(e.target.value)}
                placeholder="e.g. Chicken Thighs"
                className="w-full px-3 py-2 border border-border rounded-lg bg-background text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Unit *</label>
              <select
                value={formUnit}
                onChange={e => setFormUnit(e.target.value)}
                className="w-full px-3 py-2 border border-border rounded-lg bg-background text-sm"
              >
                <option value="">Select unit…</option>
                {UNIT_GROUPS.map(g => (
                  <optgroup key={g.label} label={g.label}>
                    {g.units.map(u => (
                      <option key={u} value={u}>{u}</option>
                    ))}
                  </optgroup>
                ))}
                {formUnit && !isCanonical(formUnit) && (
                  <optgroup label="Legacy (non-standard)">
                    <option value={formUnit}>{formUnit} ⚠ non-standard</option>
                  </optgroup>
                )}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Notes</label>
              <input
                value={formNotes}
                onChange={e => setFormNotes(e.target.value)}
                placeholder="Optional notes"
                className="w-full px-3 py-2 border border-border rounded-lg bg-background text-sm"
              />
            </div>
            {!editingId && (
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Starting Cost / Unit</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                  <input
                    type="number"
                    min="0"
                    step="0.0001"
                    value={formInitialCost}
                    onChange={e => setFormInitialCost(e.target.value)}
                    placeholder="0.00"
                    className="w-full pl-7 pr-3 py-2 border border-border rounded-lg bg-background text-sm"
                  />
                </div>
              </div>
            )}
          </div>
          {formError && <p className="text-destructive text-sm mb-3">{formError}</p>}
          <div className="flex gap-2">
            <button
              onClick={saveForm}
              disabled={formSaving}
              className="px-4 py-2 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2 text-sm"
            >
              {formSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              {editingId ? "Save Changes" : "Create Ingredient"}
            </button>
            <button
              onClick={cancelForm}
              className="px-4 py-2 bg-secondary text-foreground font-semibold rounded-xl hover:bg-secondary/70 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <div className="bg-destructive/10 text-destructive border border-destructive/20 rounded-xl p-4 mb-6 text-sm">{error}</div>}

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>
      ) : ingredients.length === 0 ? (
        <div className="bg-card border border-border rounded-2xl p-10 text-center text-muted-foreground">
          <FlaskConical className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="font-semibold">No ingredients yet</p>
          <p className="text-sm mt-1">Add your first ingredient to start building recipes and tracking costs.</p>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-border bg-secondary/30">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{ingredients.length} ingredient{ingredients.length !== 1 ? "s" : ""}</p>
          </div>
          <div className="divide-y divide-border">
            {ingredients.map(ing => (
              <div key={ing.id}>
                <div className="px-5 py-4 flex items-center gap-3">
                  <button
                    onClick={() => toggleExpanded(ing.id)}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    title="Toggle history"
                  >
                    {expanded.has(ing.id) ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold">{ing.name}</span>
                      <span className={cn(
                        "text-xs px-2 py-0.5 rounded-full",
                        isCanonical(ing.unit)
                          ? "text-muted-foreground bg-secondary"
                          : "text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/40 border border-amber-300 dark:border-amber-700/50",
                      )}>
                        {ing.unit}
                        {!isCanonical(ing.unit) && " ⚠"}
                      </span>
                    </div>
                    {ing.notes && <p className="text-xs text-muted-foreground mt-0.5">{ing.notes}</p>}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-bold">
                      <DollarSign className="w-3.5 h-3.5" />
                      {ing.currentCost != null ? ing.currentCost.toFixed(4) : "—"}
                    </div>
                    <p className="text-[10px] text-muted-foreground">per {ing.unit}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => {
                        setAddCostIngId(addCostIngId === ing.id ? null : ing.id);
                        setCostError(""); setNewCostValue(""); setNewCostEffectiveAt("");
                        setExpanded(prev => { const n = new Set(prev); n.add(ing.id); return n; });
                      }}
                      className="p-2 rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                      title="Update cost"
                    >
                      <History className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => startEdit(ing)}
                      className="p-2 rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                      title="Edit"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => deleteIngredient(ing.id, ing.name)}
                      className="p-2 rounded-lg text-muted-foreground hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/40 dark:hover:text-rose-400 transition-colors"
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {addCostIngId === ing.id && (
                  <div className="px-5 pb-3 bg-indigo-50/50 dark:bg-indigo-950/20 border-t border-border">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mt-3 mb-2">Record New Cost</p>
                    <div className="flex flex-wrap gap-3 items-end">
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">Cost per {ing.unit} *</label>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                          <input
                            type="number" min="0" step="0.0001"
                            value={newCostValue}
                            onChange={e => setNewCostValue(e.target.value)}
                            placeholder="0.0000"
                            className="pl-7 pr-3 py-2 border border-border rounded-lg bg-background text-sm w-32"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">Effective date (optional)</label>
                        <input
                          type="date"
                          value={newCostEffectiveAt}
                          onChange={e => setNewCostEffectiveAt(e.target.value)}
                          className="px-3 py-2 border border-border rounded-lg bg-background text-sm"
                        />
                      </div>
                      <button
                        onClick={() => addCostEntry(ing.id)}
                        disabled={costSaving}
                        className="px-4 py-2 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2 text-sm"
                      >
                        {costSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                        Record
                      </button>
                      <button
                        onClick={() => { setAddCostIngId(null); setCostError(""); }}
                        className="px-3 py-2 text-muted-foreground hover:text-foreground text-sm"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    {costError && <p className="text-destructive text-xs mt-2">{costError}</p>}
                  </div>
                )}

                {expanded.has(ing.id) && (
                  <div className="px-5 pb-4 bg-secondary/20">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mt-3 mb-2 flex items-center gap-1.5">
                      <History className="w-3.5 h-3.5" /> Cost History
                    </p>
                    {ing.history.length === 0 ? (
                      <p className="text-xs text-muted-foreground italic">No cost entries yet. Use the history button to record a cost.</p>
                    ) : (
                      <div className="space-y-1">
                        {ing.history.map((h, idx) => (
                          <div key={h.id} className={cn(
                            "flex items-center justify-between text-sm px-3 py-2 rounded-lg",
                            idx === 0
                              ? "bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800"
                              : "bg-background border border-border",
                          )}>
                            <span className="font-mono font-semibold">${h.costPerUnit.toFixed(4)} / {ing.unit}</span>
                            <span className="text-xs text-muted-foreground">{fmtDate(h.effectiveAt)}</span>
                            {idx === 0 && <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-wide">Current</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
