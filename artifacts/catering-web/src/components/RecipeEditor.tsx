import { useState, useEffect, useCallback } from "react";
import { getAdminToken } from "@/components/AdminGuard";
import {
  Plus, Trash2, Check, Loader2, FlaskConical, DollarSign, AlertCircle, ChevronDown, ChevronRight, ArrowRight,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authHeaders() {
  const token = getAdminToken();
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

// Canonical unit groups — kept in sync with server-side units.ts
const UNIT_GROUPS = [
  { label: "Weight", units: ["g", "oz", "lb", "kg"] },
  { label: "Volume", units: ["ml", "tsp", "tbsp", "fl_oz", "cup", "pint", "quart", "gallon", "l"] },
  { label: "Count",  units: ["each", "dozen"] },
] as const;

const UNIT_FAMILY: Record<string, string> = {
  g: "weight", oz: "weight", lb: "weight", kg: "weight",
  ml: "volume", tsp: "volume", tbsp: "volume", fl_oz: "volume",
  cup: "volume", pint: "volume", quart: "volume", gallon: "volume", l: "volume",
  each: "count", dozen: "count",
};

const UNIT_TO_BASE: Record<string, number> = {
  g: 1, oz: 28.3495, lb: 453.592, kg: 1000,
  ml: 1, tsp: 4.92892, tbsp: 14.7868, fl_oz: 29.5735,
  cup: 236.588, pint: 473.176, quart: 946.353, gallon: 3785.41, l: 1000,
  each: 1, dozen: 12,
};

function conversionFactor(recipeUnit: string, ingredientUnit: string): number | null {
  if (recipeUnit === ingredientUnit) return 1;
  const rf = UNIT_FAMILY[recipeUnit];
  const intf = UNIT_FAMILY[ingredientUnit];
  if (!rf || !intf || rf !== intf) return null;
  return UNIT_TO_BASE[recipeUnit] / UNIT_TO_BASE[ingredientUnit];
}

function compatibleUnits(ingredientUnit: string): readonly string[] {
  const family = UNIT_FAMILY[ingredientUnit];
  if (!family) return [ingredientUnit];
  return UNIT_GROUPS.find(g => g.label.toLowerCase() === family)?.units ?? [ingredientUnit];
}

type Ingredient = { id: number; name: string; unit: string; currentCost: number | null };
type RecipeLine = {
  ingredientId: number;
  ingredientName: string;
  ingredientUnit: string;
  quantityPerYield: number;
  recipeUnit: string | null;
  conversionError?: boolean | null;
};
type RecipeDetail = {
  id: number;
  menuItemId: number;
  yieldServings: number;
  notes: string | null;
  lines: RecipeLine[];
  costPerServing: number | null;
  costPerUnit: number | null;
  missingCosts: number;
  panSizeCosts?: Array<{ label: string; servings: number; costPerPan: number }> | null;
  isInherited?: boolean;
  inheritedFrom?: { id: number; name: string } | null;
};

type DraftLine = {
  _key: string;
  ingredientId: number;
  ingredientName: string;
  ingredientUnit: string;
  quantityPerYield: string;
  recipeUnit: string;
};

let _keyCounter = 0;
function newKey() { return String(++_keyCounter); }

export function RecipeEditor({ menuItemId, menuItemName, onViewSource }: {
  menuItemId: number;
  menuItemName: string;
  onViewSource?: (sourceItemId: number, sourceItemName: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [recipe, setRecipe] = useState<RecipeDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [editing, setEditing] = useState(false);
  const [draftLines, setDraftLines] = useState<DraftLine[]>([]);
  const [draftYield, setDraftYield] = useState("1");
  const [draftNotes, setDraftNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);

  const loadRecipe = useCallback(async () => {
    if (loaded) return;
    setLoading(true);
    setError("");
    try {
      const [recipeRes, ingredientsRes] = await Promise.all([
        fetch(`${BASE}/api/admin/menu/${menuItemId}/recipe`, { headers: authHeaders() }),
        fetch(`${BASE}/api/admin/costs/ingredients`, { headers: authHeaders() }),
      ]);
      const [recipeData, ingsData] = await Promise.all([
        recipeRes.json(),
        ingredientsRes.json(),
      ]);
      setRecipe(recipeRes.ok ? recipeData : null);
      setIngredients(Array.isArray(ingsData) ? ingsData : []);
      setLoaded(true);
    } catch {
      setError("Failed to load recipe data");
    } finally {
      setLoading(false);
    }
  }, [menuItemId, loaded]);

  function handleExpand() {
    setExpanded(v => !v);
    if (!loaded) loadRecipe();
  }

  function startEdit() {
    if (recipe) {
      setDraftLines(recipe.lines.map(l => ({
        _key: newKey(),
        ingredientId: l.ingredientId,
        ingredientName: l.ingredientName,
        ingredientUnit: l.ingredientUnit,
        quantityPerYield: String(l.quantityPerYield),
        recipeUnit: l.recipeUnit ?? l.ingredientUnit,
      })));
      setDraftYield(String(recipe.yieldServings));
      setDraftNotes(recipe.notes ?? "");
    } else {
      setDraftLines([{ _key: newKey(), ingredientId: 0, ingredientName: "", ingredientUnit: "", quantityPerYield: "", recipeUnit: "" }]);
      setDraftYield("1");
      setDraftNotes("");
    }
    setEditing(true);
    setError("");
  }

  function cancelEdit() {
    setEditing(false);
    setError("");
  }

  function addLine() {
    setDraftLines(prev => [...prev, { _key: newKey(), ingredientId: 0, ingredientName: "", ingredientUnit: "", quantityPerYield: "", recipeUnit: "" }]);
  }

  function removeLine(key: string) {
    setDraftLines(prev => prev.filter(l => l._key !== key));
  }

  function updateLine(key: string, ingredientId: number) {
    const ing = ingredients.find(i => i.id === ingredientId);
    setDraftLines(prev => prev.map(l => l._key === key ? {
      ...l,
      ingredientId,
      ingredientName: ing?.name ?? "",
      ingredientUnit: ing?.unit ?? "",
      recipeUnit: ing?.unit ?? "",
    } : l));
  }

  function updateQty(key: string, val: string) {
    setDraftLines(prev => prev.map(l => l._key === key ? { ...l, quantityPerYield: val } : l));
  }

  function updateRecipeUnit(key: string, unit: string) {
    setDraftLines(prev => prev.map(l => l._key === key ? { ...l, recipeUnit: unit } : l));
  }

  async function saveRecipe() {
    const lines = draftLines.filter(l => l.ingredientId > 0 && l.quantityPerYield);
    if (lines.length === 0) { setError("Add at least one ingredient line"); return; }
    const yieldSrv = parseInt(draftYield);
    if (!yieldSrv || yieldSrv < 1) { setError("Yield servings must be ≥ 1"); return; }
    setSaving(true);
    setError("");
    try {
      const body = {
        yieldServings: yieldSrv,
        notes: draftNotes.trim() || null,
        lines: lines.map(l => ({
          ingredientId: l.ingredientId,
          quantityPerYield: parseFloat(l.quantityPerYield),
          recipeUnit: l.recipeUnit && l.recipeUnit !== l.ingredientUnit ? l.recipeUnit : null,
        })),
      };
      const res = await fetch(`${BASE}/api/admin/menu/${menuItemId}/recipe`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as any).error ?? "Failed to save");
      }
      setRecipe(await res.json());
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function deleteRecipe() {
    if (!confirm("Delete this recipe? Cost data for this item will no longer be tracked.")) return;
    setDeleting(true);
    try {
      await fetch(`${BASE}/api/admin/menu/${menuItemId}/recipe`, { method: "DELETE", headers: authHeaders() });
      setRecipe(null);
      setEditing(false);
    } catch {
      alert("Failed to delete recipe");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="border border-indigo-200 dark:border-indigo-800/50 rounded-xl overflow-hidden bg-indigo-50/30 dark:bg-indigo-950/10">
      <button
        type="button"
        onClick={handleExpand}
        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-indigo-50 dark:hover:bg-indigo-950/20 transition-colors"
      >
        <FlaskConical className="w-5 h-5 text-indigo-600 dark:text-indigo-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <span className="font-semibold text-sm">Recipe & Cost</span>
          {recipe && !loading && (
            <span className="ml-3 text-xs text-indigo-600 dark:text-indigo-400 font-medium">
              {recipe.lines.length} ingredient{recipe.lines.length !== 1 ? "s" : ""}
              {recipe.costPerServing != null && ` · $${recipe.costPerServing.toFixed(4)}/serving`}
              {recipe.missingCosts > 0 && ` · ${recipe.missingCosts} missing cost${recipe.missingCosts > 1 ? "s" : ""}`}
            </span>
          )}
          {!recipe && loaded && !loading && (
            <span className="ml-3 text-xs text-muted-foreground">No recipe</span>
          )}
        </div>
        {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
      </button>

      {expanded && (
        <div className="px-5 pb-5 space-y-4 border-t border-indigo-200 dark:border-indigo-800/50 pt-4">
          {loading && <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>}

          {error && (
            <div className="flex items-start gap-2 text-destructive text-xs">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {!loading && !editing && (
            <>
              {recipe ? (
                <div className="space-y-3">
                  {recipe.isInherited && recipe.inheritedFrom && (
                    <div className="bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800/60 rounded-lg p-3 text-xs text-indigo-800 dark:text-indigo-300">
                      <div className="flex items-start gap-2">
                        <FlaskConical className="w-4 h-4 shrink-0 mt-0.5 text-indigo-500" />
                        <span>
                          Recipe inherited from <strong>{recipe.inheritedFrom.name}</strong>.
                          To use a custom recipe for this item, remove the recipe source link first (edit the item and clear the Recipe Source field).
                        </span>
                      </div>
                      {onViewSource && recipe.inheritedFrom && (
                        <button
                          type="button"
                          onClick={() => onViewSource(recipe.inheritedFrom!.id, recipe.inheritedFrom!.name)}
                          className="mt-2 ml-6 flex items-center gap-1.5 text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-200 font-medium transition-colors"
                        >
                          <ArrowRight className="w-3.5 h-3.5" />
                          Go to {recipe.inheritedFrom.name}
                        </button>
                      )}
                    </div>
                  )}
                  {!recipe.isInherited && recipe.missingCosts > 0 && (
                    <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50 rounded-lg p-3 flex items-start gap-2 text-xs text-amber-800 dark:text-amber-300">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                      {recipe.missingCosts} ingredient{recipe.missingCosts > 1 ? "s are" : " is"} missing a cost entry. Cost estimates may be incomplete.
                    </div>
                  )}
                  {recipe.isInherited && recipe.missingCosts > 0 && (
                    <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50 rounded-lg p-3 flex items-start gap-2 text-xs text-amber-800 dark:text-amber-300">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                      {recipe.missingCosts} ingredient{recipe.missingCosts > 1 ? "s are" : " is"} missing a cost entry. Cost estimates may be incomplete.
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2">
                    {recipe.costPerServing != null && (
                      <div className="bg-card border border-border rounded-xl p-3 text-center">
                        <p className="text-xs text-muted-foreground mb-1">Cost / Serving</p>
                        <p className="text-lg font-bold flex items-center justify-center gap-1">
                          <DollarSign className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                          {recipe.costPerServing.toFixed(4)}
                        </p>
                      </div>
                    )}
                    {recipe.costPerUnit != null && (
                      <div className="bg-card border border-border rounded-xl p-3 text-center">
                        <p className="text-xs text-muted-foreground mb-1">Cost / Unit</p>
                        <p className="text-lg font-bold">${recipe.costPerUnit.toFixed(4)}</p>
                      </div>
                    )}
                    <div className="bg-card border border-border rounded-xl p-3 text-center">
                      <p className="text-xs text-muted-foreground mb-1">Yield</p>
                      <p className="text-lg font-bold">{recipe.yieldServings}</p>
                      <p className="text-[10px] text-muted-foreground">servings</p>
                    </div>
                  </div>

                  {recipe.panSizeCosts && recipe.panSizeCosts.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Cost by Pan Size</p>
                      <div className="space-y-1">
                        {recipe.panSizeCosts.map((ps, i) => (
                          <div key={i} className="flex items-center justify-between bg-card border border-border rounded-lg px-4 py-2.5 text-sm">
                            <span className="font-medium">{ps.label}</span>
                            <span className="text-xs text-muted-foreground">{ps.servings} servings</span>
                            <span className="font-bold text-indigo-600 dark:text-indigo-400">${ps.costPerPan.toFixed(2)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Ingredients</p>
                    <div className="bg-card border border-border rounded-xl overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="border-b border-border bg-secondary/30">
                          <tr>
                            <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground">Ingredient</th>
                            <th className="text-right px-4 py-2.5 text-xs font-semibold text-muted-foreground">Qty / Yield</th>
                            <th className="text-right px-4 py-2.5 text-xs font-semibold text-muted-foreground">Cost</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {recipe.lines.map((line, i) => {
                            const ing = ingredients.find(x => x.id === line.ingredientId);
                            const ru = line.recipeUnit ?? line.ingredientUnit;
                            const factor = line.conversionError ? null : (conversionFactor(ru, line.ingredientUnit) ?? 1);
                            const lineCost = !line.conversionError && ing?.currentCost != null && factor != null
                              ? ing.currentCost * line.quantityPerYield * factor
                              : null;
                            const showConversion = !line.conversionError && line.recipeUnit && line.recipeUnit !== line.ingredientUnit;
                            return (
                              <tr key={i}>
                                <td className="px-4 py-2.5">
                                  {line.ingredientName}
                                  <span className="text-xs text-muted-foreground ml-1">({line.ingredientUnit})</span>
                                </td>
                                <td className="px-4 py-2.5 text-right tabular-nums">
                                  {line.quantityPerYield} {ru !== line.ingredientUnit ? ru : line.ingredientUnit}
                                  {line.conversionError && (
                                    <span className="inline-flex items-center gap-0.5 ml-2 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-destructive/15 text-destructive">
                                      <AlertCircle className="w-2.5 h-2.5" />
                                      unit mismatch
                                    </span>
                                  )}
                                  {showConversion && factor != null && (
                                    <span className="text-[10px] text-indigo-500 dark:text-indigo-400 ml-1">
                                      = {(line.quantityPerYield * factor).toFixed(4)} {line.ingredientUnit}
                                    </span>
                                  )}
                                </td>
                                <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground text-xs">
                                  {lineCost != null ? `$${lineCost.toFixed(4)}` : "—"}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {recipe.notes && (
                    <p className="text-xs text-muted-foreground italic">Note: {recipe.notes}</p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No recipe defined for {menuItemName} yet.</p>
              )}

              {!recipe?.isInherited && (
                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={startEdit}
                    className="px-4 py-2 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 text-sm"
                  >
                    {recipe ? "Edit Recipe" : "Add Recipe"}
                  </button>
                  {recipe && (
                    <button
                      type="button"
                      onClick={deleteRecipe}
                      disabled={deleting}
                      className="px-4 py-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 font-semibold rounded-xl text-sm transition"
                    >
                      {deleting ? "Deleting…" : "Delete Recipe"}
                    </button>
                  )}
                </div>
              )}
            </>
          )}

          {!loading && editing && (
            <div className="space-y-4">
              {ingredients.length === 0 && (
                <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50 rounded-lg p-3 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  No ingredients found in the library. Go to Costs → Ingredient Library to add ingredients first.
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">Yield (servings) *</label>
                  <input
                    type="number"
                    min="1"
                    value={draftYield}
                    onChange={e => setDraftYield(e.target.value)}
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm bg-background"
                  />
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">Notes</label>
                  <input
                    value={draftNotes}
                    onChange={e => setDraftNotes(e.target.value)}
                    placeholder="Optional notes"
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm bg-background"
                  />
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Ingredient Lines</p>
                <div className="space-y-2">
                  {draftLines.map(line => {
                    const compatUnits = line.ingredientUnit ? compatibleUnits(line.ingredientUnit) : [];
                    const factor = line.recipeUnit && line.ingredientUnit
                      ? conversionFactor(line.recipeUnit, line.ingredientUnit)
                      : null;
                    const showHint = factor != null && factor !== 1 && line.quantityPerYield;
                    const convertedQty = showHint
                      ? parseFloat(line.quantityPerYield) * factor!
                      : null;
                    return (
                      <div key={line._key} className="space-y-1">
                        <div className="flex items-center gap-2">
                          <select
                            value={line.ingredientId || ""}
                            onChange={e => updateLine(line._key, parseInt(e.target.value) || 0)}
                            className="flex-1 px-3 py-2 border border-border rounded-lg text-sm bg-background"
                          >
                            <option value="">Select ingredient…</option>
                            {ingredients.map(ing => (
                              <option key={ing.id} value={ing.id}>
                                {ing.name} ({ing.unit}){ing.currentCost != null ? ` — $${ing.currentCost.toFixed(4)}/${ing.unit}` : " — no cost"}
                              </option>
                            ))}
                          </select>
                          <input
                            type="number"
                            min="0"
                            step="0.001"
                            value={line.quantityPerYield}
                            onChange={e => updateQty(line._key, e.target.value)}
                            placeholder="Qty"
                            className="w-24 px-3 py-2 border border-border rounded-lg text-sm bg-background text-right"
                          />
                          {line.ingredientUnit && compatUnits.length > 1 ? (
                            <select
                              value={line.recipeUnit || line.ingredientUnit}
                              onChange={e => updateRecipeUnit(line._key, e.target.value)}
                              className="w-24 px-2 py-2 border border-border rounded-lg text-sm bg-background"
                              title="Unit used in recipe"
                            >
                              {compatUnits.map(u => (
                                <option key={u} value={u}>{u}</option>
                              ))}
                            </select>
                          ) : (
                            line.ingredientUnit && (
                              <span className="text-xs text-muted-foreground w-10 shrink-0">{line.ingredientUnit}</span>
                            )
                          )}
                          <button type="button" onClick={() => removeLine(line._key)} className="p-2 text-muted-foreground hover:text-destructive">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                        {showHint && convertedQty != null && (
                          <p className="text-[11px] text-indigo-500 dark:text-indigo-400 pl-1">
                            {line.quantityPerYield} {line.recipeUnit} = {convertedQty.toFixed(4)} {line.ingredientUnit}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
                <button
                  type="button"
                  onClick={addLine}
                  className="mt-2 text-xs text-indigo-600 dark:text-indigo-400 font-semibold flex items-center gap-1 hover:underline"
                >
                  <Plus className="w-3.5 h-3.5" /> Add ingredient
                </button>
              </div>

              {error && <p className="text-destructive text-xs">{error}</p>}

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={saveRecipe}
                  disabled={saving}
                  className="px-4 py-2 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2 text-sm"
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  Save Recipe
                </button>
                <button type="button" onClick={cancelEdit} className="px-4 py-2 bg-secondary text-foreground font-semibold rounded-xl hover:bg-secondary/70 text-sm">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
