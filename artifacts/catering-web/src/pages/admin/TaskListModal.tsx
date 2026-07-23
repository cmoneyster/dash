import { useState, useEffect } from "react";
import { Loader2, X, ChevronDown, ChevronRight } from "lucide-react";
import { getAdminToken } from "@/components/AdminGuard";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authHeaders() {
  const token = getAdminToken();
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

type RecipeLine = {
  kind: "ingredient" | "preparation";
  ingredientId?: number | null;
  ingredientName?: string | null;
  preparationId?: number | null;
  preparationName?: string | null;
};

type LineItem = {
  id: string;
  menuItemId: number | null;
  name: string;
  quantity: number;
  sizeLabel?: string | null;
  sizeServings?: number | null;
};

type ItemSelState = {
  include: boolean;
  ingredientIds: Set<number>;
  preparationIds: Set<number>;
  customText: string;
};

type SavedSel = {
  include: boolean;
  ingredientIds: number[];
  preparationIds: number[];
  customText: string;
};

type Props = {
  inquiryId: number;
  clientName: string;
  eventDate: string | null;
  lineItems: LineItem[];
  onClose: () => void;
  onGenerated?: () => void;
};

function selectionsKey(id: number) { return `task-list-selections-${id}`; }
export function taskListDataKey(id: number) { return `task-list-data-${id}`; }

export default function TaskListModal({ inquiryId, clientName, eventDate, lineItems, onClose, onGenerated }: Props) {
  const [recipeLines, setRecipeLines] = useState<Map<number, RecipeLine[]>>(new Map());
  const [loadingRecipes, setLoadingRecipes] = useState(true);
  const [selections, setSelections] = useState<Map<string, ItemSelState>>(new Map());
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set(lineItems.map(li => li.id)));

  useEffect(() => {
    const menuItemIds = [...new Set(
      lineItems.map(li => li.menuItemId).filter((id): id is number => id != null)
    )];

    if (menuItemIds.length === 0) {
      const initSel = new Map<string, ItemSelState>();
      for (const li of lineItems) {
        initSel.set(li.id, { include: true, ingredientIds: new Set(), preparationIds: new Set(), customText: "" });
      }
      overlaySaved(initSel);
      setSelections(initSel);
      setLoadingRecipes(false);
      return;
    }

    Promise.all(
      menuItemIds.map(id =>
        fetch(`${BASE}/api/admin/menu/${id}/recipe`, { headers: authHeaders() })
          .then(r => r.ok ? r.json() : null)
          .then((data: { lines?: RecipeLine[] } | null) => ({
            menuItemId: id,
            lines: (data?.lines ?? []) as RecipeLine[],
          }))
          .catch(() => ({ menuItemId: id, lines: [] as RecipeLine[] }))
      )
    ).then(results => {
      const rlMap = new Map<number, RecipeLine[]>();
      for (const r of results) rlMap.set(r.menuItemId, r.lines);
      setRecipeLines(rlMap);

      const initSel = new Map<string, ItemSelState>();
      for (const li of lineItems) {
        const lines = li.menuItemId ? (rlMap.get(li.menuItemId) ?? []) : [];
        const ingredientIds = new Set(
          lines.filter(l => l.kind === "ingredient" && l.ingredientId != null).map(l => l.ingredientId!)
        );
        const preparationIds = new Set(
          lines.filter(l => l.kind === "preparation" && l.preparationId != null).map(l => l.preparationId!)
        );
        initSel.set(li.id, { include: true, ingredientIds, preparationIds, customText: "" });
      }
      overlaySaved(initSel);
      setSelections(initSel);
      setLoadingRecipes(false);
    });
  }, []);

  function overlaySaved(initSel: Map<string, ItemSelState>) {
    try {
      const raw = localStorage.getItem(selectionsKey(inquiryId));
      if (!raw) return;
      const saved = JSON.parse(raw) as Record<string, SavedSel>;
      for (const [liId, savedSel] of Object.entries(saved)) {
        if (!initSel.has(liId)) continue;
        const cur = initSel.get(liId)!;
        initSel.set(liId, {
          include: savedSel.include,
          ingredientIds: new Set(savedSel.ingredientIds.filter(id => cur.ingredientIds.has(id))),
          preparationIds: new Set(savedSel.preparationIds.filter(id => cur.preparationIds.has(id))),
          customText: savedSel.customText,
        });
      }
    } catch {}
  }

  useEffect(() => {
    if (loadingRecipes || selections.size === 0) return;
    try {
      const toSave: Record<string, SavedSel> = {};
      for (const [id, sel] of selections) {
        toSave[id] = {
          include: sel.include,
          ingredientIds: [...sel.ingredientIds],
          preparationIds: [...sel.preparationIds],
          customText: sel.customText,
        };
      }
      localStorage.setItem(selectionsKey(inquiryId), JSON.stringify(toSave));
    } catch {}
  }, [selections, loadingRecipes]);

  function toggleItem(liId: string) {
    setSelections(prev => {
      const next = new Map(prev);
      const cur = next.get(liId)!;
      next.set(liId, { ...cur, include: !cur.include });
      return next;
    });
  }

  function toggleIngredient(liId: string, ingId: number) {
    setSelections(prev => {
      const next = new Map(prev);
      const cur = next.get(liId)!;
      const ids = new Set(cur.ingredientIds);
      if (ids.has(ingId)) ids.delete(ingId); else ids.add(ingId);
      next.set(liId, { ...cur, ingredientIds: ids });
      return next;
    });
  }

  function togglePreparation(liId: string, prepId: number) {
    setSelections(prev => {
      const next = new Map(prev);
      const cur = next.get(liId)!;
      const ids = new Set(cur.preparationIds);
      if (ids.has(prepId)) ids.delete(prepId); else ids.add(prepId);
      next.set(liId, { ...cur, preparationIds: ids });
      return next;
    });
  }

  function setCustomText(liId: string, text: string) {
    setSelections(prev => {
      const next = new Map(prev);
      const cur = next.get(liId)!;
      next.set(liId, { ...cur, customText: text });
      return next;
    });
  }

  function toggleExpanded(liId: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(liId)) next.delete(liId); else next.add(liId);
      return next;
    });
  }

  async function handleGenerate() {
    setGenerating(true);
    setError("");
    try {
      const selectionsArr = lineItems.map(li => {
        const sel = selections.get(li.id);
        if (!sel) return { lineItemId: li.id, include: true };
        const lines = li.menuItemId ? (recipeLines.get(li.menuItemId) ?? []) : [];
        const allIngredientIds = lines
          .filter(l => l.kind === "ingredient" && l.ingredientId != null)
          .map(l => l.ingredientId!);
        const allPreparationIds = lines
          .filter(l => l.kind === "preparation" && l.preparationId != null)
          .map(l => l.preparationId!);
        return {
          lineItemId: li.id,
          include: sel.include,
          ingredientIds: allIngredientIds.length > 0 ? [...sel.ingredientIds] : undefined,
          preparationIds: allPreparationIds.length > 0 ? [...sel.preparationIds] : undefined,
          customText: sel.customText || undefined,
        };
      });

      const r = await fetch(`${BASE}/api/admin/catering/${inquiryId}/task-list`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ selections: selectionsArr }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error((d as any).error ?? `HTTP ${r.status}`);
      }
      const data = await r.json();
      const key = taskListDataKey(inquiryId);
      localStorage.setItem(key, JSON.stringify(data));
      window.open(`${BASE}/admin/catering/${inquiryId}/task-list-print?key=${encodeURIComponent(key)}`, "_blank");
      onGenerated?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate task list");
      setGenerating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-background border border-border rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between px-5 py-4 border-b border-border shrink-0">
          <div>
            <h2 className="font-bold text-base">Generate Task &amp; Buy List</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {clientName}{eventDate ? ` — ${eventDate}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-muted transition-colors ml-4 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-5 py-4">
          {loadingRecipes ? (
            <div className="flex items-center justify-center py-12 gap-3">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Loading recipe details…</span>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground mb-3">
                Select which items, ingredients, and preparations to include.
                Add notes for items without a recipe — they appear in the printed task list.
              </p>
              {lineItems.map(li => {
                const sel = selections.get(li.id);
                const lines = li.menuItemId ? (recipeLines.get(li.menuItemId) ?? []) : [];
                const ingredientLines = lines.filter(l => l.kind === "ingredient" && l.ingredientId != null);
                const preparationLines = lines.filter(l => l.kind === "preparation" && l.preparationId != null);
                const hasRecipe = li.menuItemId != null && lines.length > 0;
                const noRecipe = !hasRecipe;
                const included = sel?.include ?? true;
                const isExpanded = expanded.has(li.id);
                const hasContent = ingredientLines.length > 0 || preparationLines.length > 0 || noRecipe;

                return (
                  <div
                    key={li.id}
                    className={`border rounded-xl transition-colors ${included ? "border-border" : "border-border/40 opacity-60"}`}
                  >
                    <div className="flex items-center gap-3 px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={included}
                        onChange={() => toggleItem(li.id)}
                        className="w-4 h-4 accent-emerald-600 shrink-0 cursor-pointer"
                      />
                      <span className="flex-1 text-sm font-semibold truncate">
                        {li.quantity}× {li.name}{li.sizeLabel ? ` (${li.sizeLabel})` : ""}
                      </span>
                      {noRecipe && included && (
                        <span className="text-xs bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 px-1.5 py-0.5 rounded font-medium shrink-0">
                          No recipe
                        </span>
                      )}
                      {included && hasContent && (
                        <button
                          type="button"
                          onClick={() => toggleExpanded(li.id)}
                          className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                        </button>
                      )}
                    </div>

                    {included && isExpanded && hasContent && (
                      <div className="border-t border-border/60 px-3 py-3 space-y-3">
                        {noRecipe && (
                          <div>
                            <label className="block text-xs font-semibold text-muted-foreground mb-1.5">
                              Custom instructions / notes
                            </label>
                            <textarea
                              value={sel?.customText ?? ""}
                              onChange={e => setCustomText(li.id, e.target.value)}
                              placeholder="E.g. Slice thin, season with salt and pepper, cook until golden…"
                              rows={2}
                              className="w-full px-3 py-2 border border-border rounded-lg text-sm bg-background resize-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none"
                            />
                          </div>
                        )}

                        {ingredientLines.length > 0 && (
                          <div>
                            <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-1.5">
                              Ingredients
                            </p>
                            <div className="space-y-1">
                              {ingredientLines.map(l => {
                                const ingId = l.ingredientId!;
                                const checked = sel?.ingredientIds.has(ingId) ?? true;
                                return (
                                  <label key={ingId} className="flex items-center gap-2 cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() => toggleIngredient(li.id, ingId)}
                                      className="w-3.5 h-3.5 accent-emerald-600"
                                    />
                                    <span className="text-sm">{l.ingredientName ?? `Ingredient #${ingId}`}</span>
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {preparationLines.length > 0 && (
                          <div>
                            <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-1.5">
                              Preparations
                            </p>
                            <div className="space-y-1">
                              {preparationLines.map(l => {
                                const prepId = l.preparationId!;
                                const checked = sel?.preparationIds.has(prepId) ?? true;
                                return (
                                  <label key={prepId} className="flex items-center gap-2 cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() => togglePreparation(li.id, prepId)}
                                      className="w-3.5 h-3.5 accent-emerald-600"
                                    />
                                    <span className="text-sm">{l.preparationName ?? `Preparation #${prepId}`}</span>
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {lineItems.length === 0 && (
                <p className="text-sm text-muted-foreground italic text-center py-8">
                  No line items on this inquiry.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-border shrink-0 flex items-center gap-4">
          {error ? (
            <p className="text-sm text-destructive flex-1">{error}</p>
          ) : (
            <span className="text-xs text-muted-foreground flex-1">
              AI translation may take a few seconds.
            </span>
          )}
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium rounded-xl border border-border hover:bg-muted transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={generating || loadingRecipes}
              className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-sm font-semibold rounded-xl hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {generating && <Loader2 className="w-4 h-4 animate-spin" />}
              {generating ? "Generating…" : "Generate Task List"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
