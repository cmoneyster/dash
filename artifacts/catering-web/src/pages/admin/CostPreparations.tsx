import { useState, useEffect, useCallback } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import { getAdminToken } from "@/components/AdminGuard";
import {
  Plus, Trash2, Edit2, X, Check, ChevronDown, ChevronRight, Loader2,
  Layers, DollarSign, ListOrdered,
} from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authHeaders() {
  const token = getAdminToken();
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

const UNIT_GROUPS = [
  { label: "Weight", units: ["g", "oz", "lb", "kg"] },
  { label: "Volume", units: ["ml", "tsp", "tbsp", "fl_oz", "cup", "pint", "quart", "gallon", "l"] },
  { label: "Count",  units: ["each", "dozen"] },
] as const;

type Ingredient = { id: number; name: string; unit: string; currentCost: number | null };

type PrepLine = {
  id: number;
  ingredientId: number;
  ingredientName: string;
  ingredientUnit: string;
  quantityPerYield: number;
  recipeUnit: string | null;
  costContribution: number | null;
};

type Preparation = {
  id: number;
  name: string;
  yieldServings: number;
  yieldUnit: string;
  notes: string | null;
  costPerYieldUnit: number | null;
  lines?: PrepLine[];
};

type DraftLine = { _key: string; ingredientId: number; quantityPerYield: string; recipeUnit: string };
type ProcessStep = { id: number; preparationId: number; stepOrder: number; description: string; descriptionEs: string | null };
type DraftStep = { _key: string; description: string };

let _keyCounter = 0;
function newKey() { return String(++_keyCounter); }
function blankLine(): DraftLine { return { _key: newKey(), ingredientId: 0, quantityPerYield: "", recipeUnit: "" }; }
let _stepKey = 0;
function newSK() { return `sk-${++_stepKey}`; }
function blankStep(): DraftStep { return { _key: newSK(), description: "" }; }

export default function CostPreparations() {
  const [preparations, setPreparations] = useState<Preparation[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [expandLoaded, setExpandLoaded] = useState<Set<number>>(new Set());

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formName, setFormName] = useState("");
  const [formYieldServings, setFormYieldServings] = useState("1");
  const [formYieldUnit, setFormYieldUnit] = useState("g");
  const [formNotes, setFormNotes] = useState("");
  const [formLines, setFormLines] = useState<DraftLine[]>([blankLine()]);
  const [formSaving, setFormSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const [stepsMap, setStepsMap] = useState<Map<number, ProcessStep[]>>(new Map());
  const [stepsLoaded, setStepsLoaded] = useState<Set<number>>(new Set());
  const [editingStepsId, setEditingStepsId] = useState<number | null>(null);
  const [draftSteps, setDraftSteps] = useState<DraftStep[]>([]);
  const [stepsSaving, setStepsSaving] = useState(false);
  const [stepsError, setStepsError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [prepsRes, ingsRes] = await Promise.all([
        fetch(`${BASE}/api/admin/costs/preparations`, { headers: authHeaders() }),
        fetch(`${BASE}/api/admin/costs/ingredients`, { headers: authHeaders() }),
      ]);
      if (!prepsRes.ok || !ingsRes.ok) throw new Error();
      const [preps, ings] = await Promise.all([prepsRes.json(), ingsRes.json()]);
      setPreparations(Array.isArray(preps) ? preps : []);
      setIngredients(Array.isArray(ings) ? ings : []);
    } catch { setError("Failed to load preparations"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function loadDetail(id: number) {
    if (expandLoaded.has(id)) return;
    try {
      const res = await fetch(`${BASE}/api/admin/costs/preparations/${id}`, { headers: authHeaders() });
      if (!res.ok) return;
      const detail: Preparation = await res.json();
      setPreparations(prev => prev.map(p => p.id === id ? { ...p, lines: detail.lines } : p));
      setExpandLoaded(prev => new Set([...prev, id]));
    } catch { /* silent */ }
  }

  async function loadSteps(id: number) {
    if (stepsLoaded.has(id)) return;
    try {
      const res = await fetch(`${BASE}/api/admin/costs/preparations/${id}/steps`, { headers: authHeaders() });
      if (!res.ok) return;
      const steps: ProcessStep[] = await res.json();
      setStepsMap(prev => new Map(prev).set(id, steps));
      setStepsLoaded(prev => new Set([...prev, id]));
    } catch { /* silent */ }
  }

  function toggleExpanded(id: number) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); }
      else { next.add(id); loadDetail(id); loadSteps(id); }
      return next;
    });
  }

  function startEditSteps(id: number) {
    const existing = stepsMap.get(id) ?? [];
    setDraftSteps(existing.length > 0
      ? existing.map(s => ({ _key: newSK(), description: s.description }))
      : [blankStep()]);
    setStepsError("");
    setEditingStepsId(id);
  }

  async function saveSteps(prepId: number) {
    const valid = draftSteps.filter(s => s.description.trim());
    setStepsSaving(true); setStepsError("");
    try {
      const res = await fetch(`${BASE}/api/admin/costs/preparations/${prepId}/steps`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ steps: valid.map((s, i) => ({ description: s.description.trim(), stepOrder: i })) }),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error((d as any).error ?? "Failed"); }
      const saved: ProcessStep[] = await res.json();
      setStepsMap(prev => new Map(prev).set(prepId, saved));
      setEditingStepsId(null);
    } catch (err) { setStepsError(err instanceof Error ? err.message : "Failed to save steps"); }
    finally { setStepsSaving(false); }
  }

  function startAdd() {
    setEditingId(null); setFormName(""); setFormYieldServings("1"); setFormYieldUnit("g");
    setFormNotes(""); setFormLines([blankLine()]); setFormError(""); setShowForm(true);
  }

  async function startEdit(prep: Preparation) {
    setEditingId(prep.id); setFormName(prep.name); setFormYieldServings(String(prep.yieldServings));
    setFormYieldUnit(prep.yieldUnit); setFormNotes(prep.notes ?? ""); setFormError(""); setShowForm(true);
    try {
      const res = await fetch(`${BASE}/api/admin/costs/preparations/${prep.id}`, { headers: authHeaders() });
      if (res.ok) {
        const detail: Preparation = await res.json();
        setFormLines((detail.lines ?? []).length > 0
          ? detail.lines!.map(l => ({ _key: newKey(), ingredientId: l.ingredientId, quantityPerYield: String(l.quantityPerYield), recipeUnit: l.recipeUnit ?? l.ingredientUnit }))
          : [blankLine()]);
      }
    } catch { /* use empty */ }
  }

  function cancelForm() { setShowForm(false); setEditingId(null); setFormError(""); }

  function addFormLine() { setFormLines(prev => [...prev, blankLine()]); }
  function removeFormLine(key: string) { setFormLines(prev => prev.filter(l => l._key !== key)); }
  function updateFormLine(key: string, field: keyof Omit<DraftLine, "_key">, val: string | number) {
    setFormLines(prev => prev.map(l => {
      if (l._key !== key) return l;
      if (field === "ingredientId") {
        const ing = ingredients.find(i => i.id === Number(val));
        return { ...l, ingredientId: Number(val), recipeUnit: ing?.unit ?? l.recipeUnit };
      }
      return { ...l, [field]: val };
    }));
  }

  async function saveForm() {
    if (!formName.trim()) { setFormError("Name is required"); return; }
    if (!formYieldUnit.trim()) { setFormError("Yield unit is required"); return; }
    const yieldServings = Math.max(1, parseInt(formYieldServings) || 1);
    const validLines = formLines.filter(l => l.ingredientId > 0 && l.quantityPerYield !== "");
    setFormSaving(true); setFormError("");
    try {
      const url = editingId ? `${BASE}/api/admin/costs/preparations/${editingId}` : `${BASE}/api/admin/costs/preparations`;
      const method = editingId ? "PUT" : "POST";
      const body = {
        name: formName.trim(), yieldServings, yieldUnit: formYieldUnit.trim(),
        notes: formNotes.trim() || null,
        lines: validLines.map(l => ({ ingredientId: l.ingredientId, quantityPerYield: parseFloat(l.quantityPerYield), recipeUnit: l.recipeUnit || null })),
      };
      const res = await fetch(url, { method, headers: authHeaders(), body: JSON.stringify(body) });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error((d as any).error ?? "Failed"); }
      if (editingId) { setExpandLoaded(prev => { const n = new Set(prev); n.delete(editingId); return n; }); }
      await load(); cancelForm();
    } catch (err) { setFormError(err instanceof Error ? err.message : "Failed to save"); }
    finally { setFormSaving(false); }
  }

  async function deletePrep(id: number, name: string) {
    if (!confirm(`Delete preparation "${name}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`${BASE}/api/admin/costs/preparations/${id}`, { method: "DELETE", headers: authHeaders() });
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert((d as any).error ?? "Failed"); return; }
      await load();
    } catch { alert("Failed to delete preparation"); }
  }

  const compatibleUnits = (unit: string): string[] => {
    const family = UNIT_GROUPS.find(g => (g.units as readonly string[]).includes(unit));
    return family ? [...family.units] : [unit];
  };

  return (
    <AdminLayout>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display font-bold text-2xl sm:text-4xl mb-1 flex items-center gap-3">
            <Layers className="w-8 h-8 text-violet-600" />
            Preparations
          </h1>
          <p className="text-muted-foreground text-sm">
            Manage base preparations and their process steps. Expand a preparation to edit its ingredient lines or add step-by-step instructions.
          </p>
        </div>
        <button onClick={startAdd} className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white font-semibold rounded-xl hover:bg-violet-700 transition text-sm shrink-0">
          <Plus className="w-4 h-4" /> Add Preparation
        </button>
      </div>

      {showForm && (
        <div className="bg-card border border-border rounded-2xl p-5 mb-6 shadow-sm">
          <h2 className="font-display font-bold text-base mb-4">{editingId ? "Edit Preparation" : "New Preparation"}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
            <div className="sm:col-span-1">
              <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Name *</label>
              <input value={formName} onChange={e => setFormName(e.target.value)} placeholder="e.g. Chicken Stock" className="w-full px-3 py-2 border border-border rounded-lg bg-background text-sm" />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Yield Servings *</label>
              <input type="number" min="1" value={formYieldServings} onChange={e => setFormYieldServings(e.target.value)} className="w-full px-3 py-2 border border-border rounded-lg bg-background text-sm" />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Yield Unit *</label>
              <select value={formYieldUnit} onChange={e => setFormYieldUnit(e.target.value)} className="w-full px-3 py-2 border border-border rounded-lg bg-background text-sm">
                {UNIT_GROUPS.map(g => (
                  <optgroup key={g.label} label={g.label}>
                    {g.units.map(u => <option key={u} value={u}>{u}</option>)}
                  </optgroup>
                ))}
              </select>
            </div>
          </div>
          <div className="mb-4">
            <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Notes</label>
            <input value={formNotes} onChange={e => setFormNotes(e.target.value)} placeholder="Optional notes" className="w-full px-3 py-2 border border-border rounded-lg bg-background text-sm" />
          </div>
          <div className="mb-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Ingredient Lines</p>
            <div className="space-y-2">
              {formLines.map(line => {
                const ing = ingredients.find(i => i.id === line.ingredientId);
                const compat = ing ? compatibleUnits(ing.unit) : [];
                return (
                  <div key={line._key} className="flex items-center gap-2">
                    <select value={line.ingredientId || ""} onChange={e => updateFormLine(line._key, "ingredientId", parseInt(e.target.value) || 0)} className="flex-1 px-3 py-2 border border-border rounded-lg text-sm bg-background">
                      <option value="">Select ingredient…</option>
                      {ingredients.map(i => (
                        <option key={i.id} value={i.id}>{i.name} ({i.unit}){i.currentCost != null ? ` — $${i.currentCost.toFixed(4)}/${i.unit}` : ""}</option>
                      ))}
                    </select>
                    <input type="number" min="0" step="0.001" value={line.quantityPerYield} onChange={e => updateFormLine(line._key, "quantityPerYield", e.target.value)} placeholder="Qty" className="w-24 px-3 py-2 border border-border rounded-lg text-sm bg-background text-right" />
                    {ing && compat.length > 1 ? (
                      <select value={line.recipeUnit || ing.unit} onChange={e => updateFormLine(line._key, "recipeUnit", e.target.value)} className="w-24 px-2 py-2 border border-border rounded-lg text-sm bg-background">
                        {compat.map(u => <option key={u} value={u}>{u}</option>)}
                      </select>
                    ) : ing ? (
                      <span className="text-xs text-muted-foreground w-12 shrink-0">{ing.unit}</span>
                    ) : <span className="w-12" />}
                    <button type="button" onClick={() => removeFormLine(line._key)} className="p-2 text-muted-foreground hover:text-destructive"><X className="w-4 h-4" /></button>
                  </div>
                );
              })}
            </div>
            <button type="button" onClick={addFormLine} className="mt-2 text-xs text-indigo-600 dark:text-indigo-400 font-semibold flex items-center gap-1 hover:underline">
              <Plus className="w-3.5 h-3.5" /> Add ingredient
            </button>
          </div>
          {formError && <p className="text-destructive text-sm mb-3">{formError}</p>}
          <div className="flex gap-2">
            <button onClick={saveForm} disabled={formSaving} className="px-4 py-2 bg-violet-600 text-white font-semibold rounded-xl hover:bg-violet-700 disabled:opacity-50 flex items-center gap-2 text-sm">
              {formSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              {editingId ? "Save Changes" : "Create Preparation"}
            </button>
            <button onClick={cancelForm} className="px-4 py-2 bg-secondary text-foreground font-semibold rounded-xl hover:bg-secondary/70 text-sm">Cancel</button>
          </div>
        </div>
      )}

      {error && <div className="bg-destructive/10 text-destructive border border-destructive/20 rounded-xl p-4 mb-6 text-sm">{error}</div>}

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>
      ) : preparations.length === 0 ? (
        <div className="bg-card border border-border rounded-2xl p-10 text-center text-muted-foreground">
          <Layers className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="font-semibold">No preparations yet</p>
          <p className="text-sm mt-1">Add a preparation to use as a component in menu item recipes.</p>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-border bg-secondary/30">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{preparations.length} preparation{preparations.length !== 1 ? "s" : ""}</p>
          </div>
          <div className="divide-y divide-border">
            {preparations.map(prep => {
              const steps = stepsMap.get(prep.id) ?? [];
              return (
                <div key={prep.id}>
                  <div className="px-5 py-4 flex items-center gap-3">
                    <button onClick={() => toggleExpanded(prep.id)} className="text-muted-foreground hover:text-foreground transition-colors" title="Toggle ingredient lines">
                      {expanded.has(prep.id) ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold">{prep.name}</span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-violet-100 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300">
                          {prep.yieldServings} {prep.yieldUnit}
                        </span>
                        {stepsLoaded.has(prep.id) && steps.length > 0 && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-400">
                            {steps.length} step{steps.length !== 1 ? "s" : ""}
                          </span>
                        )}
                      </div>
                      {prep.notes && <p className="text-xs text-muted-foreground mt-0.5">{prep.notes}</p>}
                    </div>
                    <div className="text-right shrink-0">
                      <div className={cn("flex items-center gap-1 font-bold", prep.costPerYieldUnit != null ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
                        <DollarSign className="w-3.5 h-3.5" />
                        {prep.costPerYieldUnit != null ? prep.costPerYieldUnit.toFixed(4) : "—"}
                      </div>
                      <p className="text-[10px] text-muted-foreground">per {prep.yieldUnit}</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => startEdit(prep)} className="p-2 rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors" title="Edit"><Edit2 className="w-4 h-4" /></button>
                      <button onClick={() => deletePrep(prep.id, prep.name)} className="p-2 rounded-lg text-muted-foreground hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/40 dark:hover:text-rose-400 transition-colors" title="Delete"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </div>

                  {expanded.has(prep.id) && (
                    <div className="px-5 pb-5 bg-secondary/20 space-y-4">
                      {/* Ingredient lines */}
                      <div className="pt-3">
                        {prep.lines == null ? (
                          <div className="py-3 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading lines…</div>
                        ) : prep.lines.length === 0 ? (
                          <p className="text-xs text-muted-foreground italic py-1">No ingredient lines defined.</p>
                        ) : (
                          <div className="overflow-x-auto rounded-lg border border-border">
                            <table className="w-full text-sm">
                              <thead className="border-b border-border bg-secondary/30">
                                <tr>
                                  <th className="text-left px-4 py-2 text-xs font-semibold text-muted-foreground">Ingredient</th>
                                  <th className="text-right px-4 py-2 text-xs font-semibold text-muted-foreground">Qty / Yield</th>
                                  <th className="text-right px-4 py-2 text-xs font-semibold text-muted-foreground">Cost Contrib.</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-border">
                                {prep.lines.map(l => (
                                  <tr key={l.id}>
                                    <td className="px-4 py-2.5">{l.ingredientName}<span className="text-xs text-muted-foreground ml-1">({l.ingredientUnit})</span></td>
                                    <td className="px-4 py-2.5 text-right tabular-nums">{l.quantityPerYield} {l.recipeUnit ?? l.ingredientUnit}</td>
                                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground text-xs">{l.costContribution != null ? `$${l.costContribution.toFixed(4)}` : "—"}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>

                      {/* Process Steps */}
                      <div className="border-t border-border/50 pt-4">
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                            <ListOrdered className="w-3.5 h-3.5" /> Process Steps
                          </p>
                          {editingStepsId !== prep.id && (
                            <button onClick={() => startEditSteps(prep.id)} className="text-xs text-violet-600 dark:text-violet-400 font-semibold hover:underline flex items-center gap-1">
                              <Edit2 className="w-3 h-3" /> {steps.length > 0 ? "Edit Steps" : "Add Steps"}
                            </button>
                          )}
                        </div>

                        {editingStepsId === prep.id ? (
                          <div className="space-y-2">
                            {draftSteps.map((step, idx) => (
                              <div key={step._key} className="flex items-start gap-2">
                                <span className="text-xs text-muted-foreground font-mono mt-2.5 w-5 text-right shrink-0">{idx + 1}.</span>
                                <textarea
                                  value={step.description}
                                  onChange={e => setDraftSteps(prev => prev.map(s => s._key === step._key ? { ...s, description: e.target.value } : s))}
                                  placeholder="Describe this step…"
                                  rows={2}
                                  className="flex-1 px-3 py-2 border border-border rounded-lg bg-background text-sm resize-none"
                                />
                                <div className="flex flex-col gap-0.5 shrink-0 mt-1">
                                  <button type="button" onClick={() => setDraftSteps(prev => { if (idx === 0) return prev; const n = [...prev]; [n[idx-1], n[idx]] = [n[idx], n[idx-1]]; return n; })} disabled={idx === 0} className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30 text-xs">↑</button>
                                  <button type="button" onClick={() => setDraftSteps(prev => { if (idx === prev.length - 1) return prev; const n = [...prev]; [n[idx], n[idx+1]] = [n[idx+1], n[idx]]; return n; })} disabled={idx === draftSteps.length - 1} className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30 text-xs">↓</button>
                                  <button type="button" onClick={() => setDraftSteps(prev => prev.filter(s => s._key !== step._key))} className="p-1 text-muted-foreground hover:text-destructive"><X className="w-3.5 h-3.5" /></button>
                                </div>
                              </div>
                            ))}
                            <button type="button" onClick={() => setDraftSteps(prev => [...prev, blankStep()])} className="text-xs text-violet-600 dark:text-violet-400 font-semibold flex items-center gap-1 hover:underline">
                              <Plus className="w-3.5 h-3.5" /> Add step
                            </button>
                            {stepsError && <p className="text-destructive text-xs">{stepsError}</p>}
                            <div className="flex gap-2 mt-1">
                              <button onClick={() => saveSteps(prep.id)} disabled={stepsSaving} className="px-3 py-1.5 bg-violet-600 text-white font-semibold rounded-lg hover:bg-violet-700 disabled:opacity-50 flex items-center gap-1.5 text-xs">
                                {stepsSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Save Steps
                              </button>
                              <button onClick={() => { setEditingStepsId(null); setStepsError(""); }} className="px-3 py-1.5 bg-secondary text-foreground font-semibold rounded-lg text-xs">Cancel</button>
                            </div>
                          </div>
                        ) : !stepsLoaded.has(prep.id) ? (
                          <p className="text-xs text-muted-foreground italic flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Loading…</p>
                        ) : steps.length === 0 ? (
                          <p className="text-xs text-muted-foreground italic">No process steps yet. Click "Add Steps" to add cooking instructions for the task list.</p>
                        ) : (
                          <ol className="space-y-1.5">
                            {steps.map((s, idx) => (
                              <li key={s.id} className="flex gap-2 text-sm">
                                <span className="text-xs text-muted-foreground font-mono mt-0.5 w-5 text-right shrink-0">{idx + 1}.</span>
                                <div>
                                  <p>{s.description}</p>
                                  {s.descriptionEs && <p className="text-xs text-muted-foreground italic">{s.descriptionEs}</p>}
                                </div>
                              </li>
                            ))}
                          </ol>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
