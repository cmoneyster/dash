import { useState, useEffect, useRef } from "react";
import { useParams } from "wouter";
import { getAdminToken } from "@/components/AdminGuard";
import { Loader2, Printer, AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authHeaders() {
  const token = getAdminToken();
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

type ProcessStep = { id: number; stepOrder: number; description: string; descriptionEs: string | null };
type TaskIngredient = {
  ingredientId: number; name: string; nameEs: string | null;
  scaledQuantity: number; unit: string; processSteps: ProcessStep[];
};
type TaskPrep = {
  preparationId: number; name: string; nameEs: string | null;
  scaledQuantity: number; unit: string;
  processSteps: ProcessStep[];
  ingredientLines: TaskIngredient[];
};
type TaskItem = {
  lineItemId: string; menuItemId: number | null; name: string; nameEs: string | null;
  quantity: number; sizeLabel: string | null; sizeServings: number | null;
  hasRecipe: boolean;
  recipeIngredients: TaskIngredient[];
  recipePreparations: TaskPrep[];
};
type BuyItem = { ingredientId: number; name: string; nameEs: string | null; totalQuantity: number; unit: string };
type TaskList = {
  inquiryId: number; clientName: string; eventDate: string | null;
  taskItems: TaskItem[];
  buyList: BuyItem[];
};

function fmtQty(q: number): string {
  if (Number.isInteger(q)) return String(q);
  return q.toFixed(q < 0.1 ? 4 : q < 1 ? 3 : 2);
}

function fmtDate(d: string | null): string {
  if (!d) return "";
  try { return new Date(d).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }); }
  catch { return d; }
}

function BilingualText({ en, es, big }: { en: string; es: string | null; big?: boolean }) {
  return (
    <div>
      <span className={big ? "font-bold text-base" : "font-semibold"}>{en}</span>
      {es && es !== en && (
        <span className={big ? "block text-sm font-normal text-gray-600 italic" : "ml-2 text-xs text-gray-500 italic"}>
          {es}
        </span>
      )}
    </div>
  );
}

export default function TaskListPrint() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [data, setData] = useState<TaskList | null>(null);
  const [customNotes, setCustomNotes] = useState<Record<string, string>>({});
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const didLoad = useRef(false);

  useEffect(() => {
    if (didLoad.current) return;
    didLoad.current = true;
    setLoading(true);
    fetch(`${BASE}/api/admin/catering/${id}/task-list`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({}),
    })
      .then(async r => {
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          throw new Error((d as any).error ?? `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((d: TaskList) => {
        setData(d);
        setExpandedItems(new Set(d.taskItems.map(ti => ti.lineItemId)));
      })
      .catch(err => setError(err instanceof Error ? err.message : "Failed to load task list"))
      .finally(() => setLoading(false));
  }, [id]);

  function toggleItem(id: string) {
    setExpandedItems(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const noRecipeItems = data?.taskItems.filter(ti => !ti.hasRecipe) ?? [];
  const recipeItems = data?.taskItems.filter(ti => ti.hasRecipe) ?? [];

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="text-center">
          <Loader2 className="w-10 h-10 animate-spin text-gray-400 mx-auto mb-3" />
          <p className="text-gray-600 font-medium">Generating task list…</p>
          <p className="text-gray-400 text-sm mt-1">Translating with AI — this may take a few seconds</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="text-center max-w-sm">
          <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto mb-3" />
          <p className="font-bold text-gray-800 mb-1">Could not load task list</p>
          <p className="text-gray-600 text-sm">{error || "Unknown error"}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* ── Screen controls (hidden on print) ───────────────────────────── */}
      <div className="print:hidden bg-gray-50 border-b border-gray-200 px-6 py-4 sticky top-0 z-10 flex items-center gap-4">
        <div>
          <h1 className="font-bold text-gray-900">Task &amp; Buy List</h1>
          <p className="text-sm text-gray-600">{data.clientName} {data.eventDate ? `— ${fmtDate(data.eventDate)}` : ""}</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-gray-500">Add notes for items below, then print</span>
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 px-4 py-2 bg-gray-900 text-white font-semibold rounded-lg hover:bg-gray-700 transition-colors text-sm"
          >
            <Printer className="w-4 h-4" /> Print
          </button>
        </div>
      </div>

      {/* ── Custom notes form (screen only) ─────────────────────────────── */}
      {noRecipeItems.length > 0 && (
        <div className="print:hidden bg-amber-50 border-b border-amber-200 px-6 py-4">
          <p className="text-xs font-bold uppercase tracking-wide text-amber-700 mb-3">Items without a recipe — add custom notes</p>
          <div className="space-y-2">
            {noRecipeItems.map(ti => (
              <div key={ti.lineItemId}>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  {ti.quantity}× {ti.name}{ti.sizeLabel ? ` (${ti.sizeLabel})` : ""}
                </label>
                <textarea
                  value={customNotes[ti.lineItemId] ?? ""}
                  onChange={e => setCustomNotes(prev => ({ ...prev, [ti.lineItemId]: e.target.value }))}
                  placeholder="Add preparation notes, instructions, or tasks for this item…"
                  rows={2}
                  className="w-full px-3 py-2 border border-amber-300 rounded-lg text-sm bg-white resize-none focus:ring-2 focus:ring-amber-400 focus:border-transparent outline-none"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Printable document ───────────────────────────────────────────── */}
      <div className="print-document bg-white p-8 print:p-0 max-w-4xl mx-auto">

        {/* Header */}
        <div className="mb-8 pb-4 border-b-2 border-gray-900">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-black tracking-tight text-gray-900 uppercase">
                Task List / Lista de Tareas
              </h1>
              <p className="text-gray-600 mt-0.5">Hollywood East Cafe Catering</p>
            </div>
            <div className="text-right text-sm">
              <p className="font-bold text-gray-900">{data.clientName}</p>
              {data.eventDate && <p className="text-gray-600">{fmtDate(data.eventDate)}</p>}
              <p className="text-gray-400 text-xs mt-1">Printed: {new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</p>
            </div>
          </div>
        </div>

        {/* ── Page 1: Task List ─────────────────────────────────────────── */}
        <h2 className="text-lg font-black uppercase tracking-wide text-gray-900 mb-4">
          Task List / Lista de Tareas
        </h2>

        {data.taskItems.length === 0 && (
          <p className="text-gray-500 italic text-sm">No line items on this inquiry.</p>
        )}

        <div className="space-y-6">
          {data.taskItems.map((ti, tiIdx) => (
            <div key={ti.lineItemId} className="border border-gray-300 rounded-lg overflow-hidden">
              {/* Item header */}
              <div
                className="bg-gray-100 px-4 py-2.5 flex items-start justify-between cursor-pointer print:cursor-default print:bg-gray-900 print:text-white gap-2"
                onClick={() => toggleItem(ti.lineItemId)}
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="print:hidden text-gray-400">
                      {expandedItems.has(ti.lineItemId) ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </span>
                    <span className="font-black text-sm uppercase tracking-wide print:text-white">
                      {tiIdx + 1}. {ti.name}
                      {ti.nameEs && ti.nameEs !== ti.name && (
                        <span className="ml-2 font-normal normal-case text-gray-400 print:text-gray-300 italic text-xs">{ti.nameEs}</span>
                      )}
                    </span>
                  </div>
                </div>
                <div className="text-right text-sm font-bold print:text-white shrink-0">
                  {ti.quantity}×{ti.sizeLabel ? ` ${ti.sizeLabel}` : ""}
                  {ti.sizeServings && ti.sizeServings > 1 && !ti.sizeLabel && ` (${ti.sizeServings} serv.)`}
                </div>
              </div>

              {/* Item body */}
              <div className={expandedItems.has(ti.lineItemId) ? "block" : "hidden print:block"}>
                {!ti.hasRecipe ? (
                  /* No-recipe item */
                  <div className="px-4 py-3">
                    {(customNotes[ti.lineItemId] ?? "").trim() ? (
                      <div className="text-sm whitespace-pre-wrap">{customNotes[ti.lineItemId]}</div>
                    ) : (
                      <p className="text-gray-400 italic text-xs print:text-gray-600">No recipe — see notes above / Sin receta</p>
                    )}
                  </div>
                ) : (
                  <div className="px-4 py-3 space-y-4">
                    {/* Preparations */}
                    {ti.recipePreparations.map(rp => (
                      <div key={rp.preparationId} className="border border-indigo-200 rounded-lg overflow-hidden">
                        <div className="bg-indigo-50 px-3 py-2 flex justify-between items-center">
                          <BilingualText en={rp.name} es={rp.nameEs} big />
                          <span className="text-sm font-bold text-indigo-700">{fmtQty(rp.scaledQuantity)} {rp.unit}</span>
                        </div>
                        <div className="px-3 py-2 space-y-3">
                          {/* Prep ingredients */}
                          {rp.ingredientLines.length > 0 && (
                            <div>
                              <p className="text-xs font-bold uppercase text-gray-500 mb-1.5">Ingredients / Ingredientes</p>
                              <div className="space-y-1">
                                {rp.ingredientLines.map((ing, iIdx) => (
                                  <div key={`${ing.ingredientId}-${iIdx}`} className="text-sm">
                                    <div className="flex justify-between items-baseline gap-2">
                                      <BilingualText en={ing.name} es={ing.nameEs} />
                                      <span className="font-mono text-xs shrink-0">{fmtQty(ing.scaledQuantity)} {ing.unit}</span>
                                    </div>
                                    {ing.processSteps.length > 0 && (
                                      <ol className="ml-4 mt-0.5 space-y-0.5">
                                        {ing.processSteps.map((s, si) => (
                                          <li key={s.id} className="text-xs text-gray-600">
                                            <span className="font-mono text-gray-400 mr-1">{si + 1}.</span>
                                            {s.description}
                                            {s.descriptionEs && <span className="ml-1 italic text-gray-400"> / {s.descriptionEs}</span>}
                                          </li>
                                        ))}
                                      </ol>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {/* Prep process steps */}
                          {rp.processSteps.length > 0 && (
                            <div>
                              <p className="text-xs font-bold uppercase text-gray-500 mb-1.5">Process / Proceso</p>
                              <ol className="space-y-1">
                                {rp.processSteps.map((s, si) => (
                                  <li key={s.id} className="text-sm flex gap-2">
                                    <span className="text-xs font-mono text-gray-400 mt-0.5 shrink-0">{si + 1}.</span>
                                    <div>
                                      {s.description}
                                      {s.descriptionEs && <span className="block text-xs italic text-gray-500">{s.descriptionEs}</span>}
                                    </div>
                                  </li>
                                ))}
                              </ol>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}

                    {/* Direct ingredients */}
                    {ti.recipeIngredients.length > 0 && (
                      <div>
                        <p className="text-xs font-bold uppercase text-gray-500 mb-1.5">Ingredients / Ingredientes</p>
                        <div className="space-y-2">
                          {ti.recipeIngredients.map((ing, iIdx) => (
                            <div key={`${ing.ingredientId}-${iIdx}`} className="text-sm">
                              <div className="flex justify-between items-baseline gap-2">
                                <BilingualText en={ing.name} es={ing.nameEs} />
                                <span className="font-mono text-xs shrink-0">{fmtQty(ing.scaledQuantity)} {ing.unit}</span>
                              </div>
                              {ing.processSteps.length > 0 && (
                                <ol className="ml-4 mt-0.5 space-y-0.5">
                                  {ing.processSteps.map((s, si) => (
                                    <li key={s.id} className="text-xs text-gray-600">
                                      <span className="font-mono text-gray-400 mr-1">{si + 1}.</span>
                                      {s.description}
                                      {s.descriptionEs && <span className="ml-1 italic text-gray-400"> / {s.descriptionEs}</span>}
                                    </li>
                                  ))}
                                </ol>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {ti.recipePreparations.length === 0 && ti.recipeIngredients.length === 0 && (
                      <p className="text-xs text-gray-400 italic">Recipe has no ingredient lines.</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* ── Page 2: Buy List ─────────────────────────────────────────────── */}
        {data.buyList.length > 0 && (
          <div className="mt-10 pt-8 border-t-2 border-gray-900 print:break-before-page">
            <h2 className="text-lg font-black uppercase tracking-wide text-gray-900 mb-1">
              Buy List / Lista de Compras
            </h2>
            <p className="text-xs text-gray-500 mb-5">Consolidated shopping list for all menu items with recipes</p>
            <div className="border border-gray-300 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-900 text-white">
                  <tr>
                    <th className="text-left px-4 py-2 font-bold uppercase text-xs tracking-wide">#</th>
                    <th className="text-left px-4 py-2 font-bold uppercase text-xs tracking-wide">Ingredient / Ingrediente</th>
                    <th className="text-right px-4 py-2 font-bold uppercase text-xs tracking-wide">Quantity / Cantidad</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {data.buyList.map((b, idx) => (
                    <tr key={`${b.ingredientId}-${b.unit}`} className={idx % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                      <td className="px-4 py-2.5 text-gray-400 text-xs font-mono">{idx + 1}</td>
                      <td className="px-4 py-2.5">
                        <span className="font-semibold">{b.name}</span>
                        {b.nameEs && b.nameEs !== b.name && (
                          <span className="ml-2 text-xs text-gray-400 italic">{b.nameEs}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono font-bold">
                        {fmtQty(b.totalQuantity)} <span className="font-normal text-gray-500">{b.unit}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Footer ────────────────────────────────────────────────────────── */}
        <div className="mt-8 pt-4 border-t border-gray-200 text-xs text-gray-400 flex justify-between">
          <span>Hollywood East Cafe Catering — Confidential</span>
          <span>Inquiry #{data.inquiryId}</span>
        </div>
      </div>

      <style>{`
        @media print {
          @page { margin: 0.75in; size: letter; }
          .print-document { max-width: 100%; padding: 0; }
          .print\\:break-before-page { break-before: page; }
          .print\\:hidden { display: none !important; }
          .print\\:block { display: block !important; }
          .hidden { display: none !important; }
          .print\\:bg-gray-900 { background-color: #111827 !important; color: white !important; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
          .print\\:text-white { color: white !important; }
          .print\\:text-gray-300 { color: #d1d5db !important; }
          .print\\:cursor-default { cursor: default; }
          .bg-indigo-50 { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
          .bg-gray-50 { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        }
      `}</style>
    </>
  );
}
