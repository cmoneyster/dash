import { useState, useEffect, useRef } from "react";
import { useParams } from "wouter";
import { Printer, AlertTriangle, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { getAdminToken } from "@/components/AdminGuard";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authHeaders() {
  const token = getAdminToken();
  return { Authorization: `Bearer ${token}` };
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
  customText: string | null;
  customTextEs: string | null;
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
  try {
    const [year, month, day] = d.slice(0, 10).split("-").map(Number);
    return new Date(year, month - 1, day).toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    });
  } catch { return d; }
}

function BilingualText({ en, es, big }: { en: string; es: string | null; big?: boolean }) {
  return (
    <div>
      <span className={big ? "font-bold text-base text-gray-900 dark:text-gray-100 print:text-gray-900" : "font-semibold text-gray-900 dark:text-gray-100 print:text-gray-900"}>{en}</span>
      {es && es !== en && (
        <span className={big ? "block text-sm font-normal text-gray-500 dark:text-gray-400 italic print:text-gray-600" : "ml-2 text-xs text-gray-500 dark:text-gray-400 italic print:text-gray-500"}>
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
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const didLoad = useRef(false);

  useEffect(() => {
    if (didLoad.current) return;
    didLoad.current = true;

    const key = new URLSearchParams(window.location.search).get("key");

    if (key) {
      const stored = localStorage.getItem(key);
      if (stored) {
        try {
          const d = JSON.parse(stored) as TaskList;
          setData(d);
          setExpandedItems(new Set(d.taskItems.map(ti => ti.lineItemId)));
          setLoading(false);
          return;
        } catch {}
      }
    }

    fetch(`${BASE}/api/admin/catering/${id}/task-list/saved`, { headers: authHeaders() })
      .then(r => {
        if (!r.ok) throw new Error("not found");
        return r.json();
      })
      .then((saved: { data: TaskList }) => {
        const d = saved.data;
        setData(d);
        setExpandedItems(new Set(d.taskItems.map(ti => ti.lineItemId)));
        if (key) {
          try { localStorage.setItem(key, JSON.stringify(d)); } catch {}
        }
      })
      .catch(() => {
        setError("No saved task list found for this inquiry. Generate one from the catering inquiry detail.");
      })
      .finally(() => setLoading(false));
  }, [id]);

  function toggleItem(liId: string) {
    setExpandedItems(prev => {
      const next = new Set(prev);
      if (next.has(liId)) next.delete(liId); else next.add(liId);
      return next;
    });
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white dark:bg-gray-950">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading task list…</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white dark:bg-gray-950">
        <div className="text-center max-w-sm">
          <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto mb-3" />
          <p className="font-bold text-gray-800 dark:text-gray-100 mb-1">Could not load task list</p>
          <p className="text-gray-600 dark:text-gray-400 text-sm">{error || "Unknown error"}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* ── Screen controls (hidden on print) ───────────────────────────── */}
      <div className="print:hidden bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 px-6 py-4 sticky top-0 z-10 flex items-center gap-4">
        <div>
          <h1 className="font-bold text-gray-900 dark:text-gray-100">Task &amp; Buy List</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">{data.clientName} {data.eventDate ? `— ${fmtDate(data.eventDate)}` : ""}</p>
        </div>
        <div className="ml-auto">
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 font-semibold rounded-lg hover:bg-gray-700 dark:hover:bg-gray-300 transition-colors text-sm"
          >
            <Printer className="w-4 h-4" /> Print
          </button>
        </div>
      </div>

      {/* ── Printable document ───────────────────────────────────────────── */}
      <div className="print-document bg-white dark:bg-gray-950 print:bg-white p-8 print:p-0 max-w-4xl mx-auto">

        {/* Header */}
        <div className="mb-8 pb-4 border-b-2 border-gray-900 dark:border-gray-100 print:border-gray-900">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-black tracking-tight text-gray-900 dark:text-gray-100 print:text-gray-900 uppercase">
                Task List / Lista de Tareas
              </h1>
              <p className="text-gray-600 dark:text-gray-400 print:text-gray-600 mt-0.5">Hollywood East Cafe Catering</p>
            </div>
            <div className="text-right text-sm">
              <p className="font-bold text-gray-900 dark:text-gray-100 print:text-gray-900">{data.clientName}</p>
              {data.eventDate && <p className="text-gray-600 dark:text-gray-400 print:text-gray-600">{fmtDate(data.eventDate)}</p>}
              <p className="text-gray-400 dark:text-gray-500 print:text-gray-400 text-xs mt-1">
                Printed: {new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              </p>
            </div>
          </div>
        </div>

        {/* ── Page 1: Task List ─────────────────────────────────────────── */}
        <h2 className="text-lg font-black uppercase tracking-wide text-gray-900 dark:text-gray-100 print:text-gray-900 mb-4">
          Task List / Lista de Tareas
        </h2>

        {data.taskItems.length === 0 && (
          <p className="text-gray-500 dark:text-gray-400 italic text-sm">No items selected.</p>
        )}

        <div className="space-y-6">
          {data.taskItems.map((ti, tiIdx) => (
            <div key={ti.lineItemId} className="border border-gray-300 dark:border-gray-700 print:border-gray-300 rounded-lg overflow-hidden">
              <div
                className="bg-gray-100 dark:bg-gray-800 print:bg-gray-900 px-4 py-2.5 flex items-start justify-between cursor-pointer print:cursor-default gap-2"
                onClick={() => toggleItem(ti.lineItemId)}
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="print:hidden text-gray-400 dark:text-gray-500">
                      {expandedItems.has(ti.lineItemId) ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </span>
                    <span className="font-black text-sm uppercase tracking-wide text-gray-900 dark:text-gray-100 print:text-white">
                      {tiIdx + 1}. {ti.name}
                      {ti.nameEs && ti.nameEs !== ti.name && (
                        <span className="ml-2 font-normal normal-case text-gray-500 dark:text-gray-400 print:text-gray-300 italic text-xs">{ti.nameEs}</span>
                      )}
                    </span>
                  </div>
                </div>
                <div className="text-right text-sm font-bold text-gray-900 dark:text-gray-100 print:text-white shrink-0">
                  {ti.quantity}×{ti.sizeLabel ? ` ${ti.sizeLabel}` : ""}
                  {ti.sizeServings && ti.sizeServings > 1 && !ti.sizeLabel && ` (${ti.sizeServings} serv.)`}
                </div>
              </div>

              <div className={expandedItems.has(ti.lineItemId) ? "block" : "hidden print:block"}>
                {!ti.hasRecipe ? (
                  <div className="px-4 py-3 bg-white dark:bg-gray-900 print:bg-white">
                    {(ti.customText ?? "").trim() ? (
                      <div>
                        <div className="text-sm whitespace-pre-wrap text-gray-800 dark:text-gray-200 print:text-gray-800">{ti.customText}</div>
                        {ti.customTextEs && ti.customTextEs !== ti.customText && (
                          <div className="text-sm whitespace-pre-wrap text-gray-500 dark:text-gray-400 print:text-gray-500 italic mt-1">{ti.customTextEs}</div>
                        )}
                      </div>
                    ) : (
                      <p className="text-gray-400 dark:text-gray-500 print:text-gray-600 italic text-xs">No recipe — Sin receta</p>
                    )}
                  </div>
                ) : (
                  <div className="px-4 py-3 space-y-4 bg-white dark:bg-gray-900 print:bg-white">
                    {ti.recipePreparations.map(rp => (
                      <div key={rp.preparationId} className="border border-indigo-200 dark:border-indigo-800 print:border-indigo-200 rounded-lg overflow-hidden">
                        <div className="bg-indigo-50 dark:bg-indigo-950 print:bg-indigo-50 px-3 py-2 flex justify-between items-center">
                          <BilingualText en={rp.name} es={rp.nameEs} big />
                          <span className="text-sm font-bold text-indigo-700 dark:text-indigo-300 print:text-indigo-700">
                            {fmtQty(rp.scaledQuantity)} {rp.unit}
                          </span>
                        </div>
                        <div className="px-3 py-2 space-y-3 bg-white dark:bg-gray-900 print:bg-white">
                          {rp.processSteps.length > 0 && (
                            <div>
                              <p className="text-xs font-bold uppercase text-gray-500 dark:text-gray-400 print:text-gray-500 mb-1.5">Process / Proceso</p>
                              <ol className="space-y-1">
                                {rp.processSteps.map((s, si) => (
                                  <li key={s.id} className="text-sm flex gap-2 text-gray-800 dark:text-gray-200 print:text-gray-800">
                                    <span className="text-xs font-mono text-gray-400 dark:text-gray-500 print:text-gray-400 mt-0.5 shrink-0">{si + 1}.</span>
                                    <div>
                                      {s.description}
                                      {s.descriptionEs && <span className="block text-xs italic text-gray-500 dark:text-gray-400 print:text-gray-500">{s.descriptionEs}</span>}
                                    </div>
                                  </li>
                                ))}
                              </ol>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}

                    {ti.recipeIngredients.length > 0 && (
                      <div>
                        <p className="text-xs font-bold uppercase text-gray-500 dark:text-gray-400 print:text-gray-500 mb-1.5">Ingredients / Ingredientes</p>
                        <div className="space-y-2">
                          {ti.recipeIngredients.map((ing, iIdx) => (
                            <div key={`${ing.ingredientId}-${iIdx}`} className="text-sm">
                              <div className="flex justify-between items-baseline gap-2">
                                <BilingualText en={ing.name} es={ing.nameEs} />
                                <span className="font-mono text-xs shrink-0 text-gray-700 dark:text-gray-300 print:text-gray-700">{fmtQty(ing.scaledQuantity)} {ing.unit}</span>
                              </div>
                              {ing.processSteps.length > 0 && (
                                <ol className="ml-4 mt-0.5 space-y-0.5">
                                  {ing.processSteps.map((s, si) => (
                                    <li key={s.id} className="text-xs text-gray-600 dark:text-gray-400 print:text-gray-600">
                                      <span className="font-mono text-gray-400 dark:text-gray-500 print:text-gray-400 mr-1">{si + 1}.</span>
                                      {s.description}
                                      {s.descriptionEs && <span className="ml-1 italic text-gray-400 dark:text-gray-500 print:text-gray-400"> / {s.descriptionEs}</span>}
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
                      <p className="text-xs text-gray-400 dark:text-gray-500 print:text-gray-400 italic">Recipe has no ingredient lines.</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* ── Page 2: Buy List ─────────────────────────────────────────────── */}
        {data.buyList.length > 0 && (
          <div className="mt-10 pt-8 border-t-2 border-gray-900 dark:border-gray-100 print:border-gray-900 print:break-before-page">
            <h2 className="text-lg font-black uppercase tracking-wide text-gray-900 dark:text-gray-100 print:text-gray-900 mb-1">
              Buy List / Lista de Compras
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 print:text-gray-500 mb-5">
              Consolidated shopping list for all selected items with recipes
            </p>
            <div className="border border-gray-300 dark:border-gray-700 print:border-gray-300 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-900 dark:bg-gray-700 print:bg-gray-900 text-white">
                  <tr>
                    <th className="text-left px-4 py-2 font-bold uppercase text-xs tracking-wide">#</th>
                    <th className="text-left px-4 py-2 font-bold uppercase text-xs tracking-wide">Ingredient / Ingrediente</th>
                    <th className="text-right px-4 py-2 font-bold uppercase text-xs tracking-wide">Quantity / Cantidad</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700 print:divide-gray-200">
                  {data.buyList.map((b, idx) => (
                    <tr
                      key={`${b.ingredientId}-${b.unit}`}
                      className={idx % 2 === 0 ? "bg-white dark:bg-gray-900 print:bg-white" : "bg-gray-50 dark:bg-gray-800 print:bg-gray-50"}
                    >
                      <td className="px-4 py-2.5 text-gray-400 dark:text-gray-500 print:text-gray-400 text-xs font-mono">{idx + 1}</td>
                      <td className="px-4 py-2.5">
                        <span className="font-semibold text-gray-900 dark:text-gray-100 print:text-gray-900">{b.name}</span>
                        {b.nameEs && b.nameEs !== b.name && (
                          <span className="ml-2 text-xs text-gray-400 dark:text-gray-500 print:text-gray-400 italic">{b.nameEs}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono font-bold text-gray-900 dark:text-gray-100 print:text-gray-900">
                        {fmtQty(b.totalQuantity)} <span className="font-normal text-gray-500 dark:text-gray-400 print:text-gray-500">{b.unit}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Footer ────────────────────────────────────────────────────────── */}
        <div className="mt-8 pt-4 border-t border-gray-200 dark:border-gray-700 print:border-gray-200 text-xs text-gray-400 dark:text-gray-500 print:text-gray-400 flex justify-between">
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

          /* ── Override dark-mode colors for paper output ── */
          .dark .dark\\:bg-gray-950 { background-color: #ffffff !important; }
          .dark .dark\\:bg-gray-900 { background-color: #ffffff !important; }
          .dark .dark\\:bg-gray-800 { background-color: #f9fafb !important; }
          .dark .dark\\:bg-gray-700 { background-color: #111827 !important; }
          .dark .dark\\:bg-indigo-950 { background-color: #eef2ff !important; }
          .dark .dark\\:text-gray-100 { color: #111827 !important; }
          .dark .dark\\:text-gray-200 { color: #1f2937 !important; }
          .dark .dark\\:text-gray-300 { color: #374151 !important; }
          .dark .dark\\:text-gray-400 { color: #6b7280 !important; }
          .dark .dark\\:text-gray-500 { color: #6b7280 !important; }
          .dark .dark\\:text-indigo-300 { color: #4338ca !important; }
          .dark .dark\\:border-gray-100 { border-color: #111827 !important; }
          .dark .dark\\:border-gray-700 { border-color: #d1d5db !important; }
          .dark .dark\\:border-indigo-800 { border-color: #c7d2fe !important; }
          .dark .dark\\:divide-gray-700 > * + * { border-color: #e5e7eb !important; }

          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        }
      `}</style>
    </>
  );
}
