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
  const esStr = es && es !== en ? es : null;
  if (big) {
    return (
      <span className={`font-bold text-sm text-gray-900 dark:text-gray-100 print:text-gray-900`}>
        {en}
        {esStr && <span className="font-normal italic text-gray-500 dark:text-gray-400 print:text-gray-500"> / {esStr}</span>}
      </span>
    );
  }
  return (
    <span className="font-semibold text-gray-900 dark:text-gray-100 print:text-gray-900">
      {en}
      {esStr && <span className="font-normal italic text-gray-400 dark:text-gray-500 print:text-gray-500 ml-1"> / {esStr}</span>}
    </span>
  );
}

export default function TaskListPrint() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [data, setData] = useState<TaskList | null>(null);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [showBuyList, setShowBuyList] = useState(true);
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
      <div className="print:hidden bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 px-6 py-3 sticky top-0 z-10 flex items-center gap-4">
        <div>
          <h1 className="font-bold text-gray-900 dark:text-gray-100 text-sm">Task &amp; Buy List</h1>
          <p className="text-xs text-gray-600 dark:text-gray-400">{data.clientName}{data.eventDate ? ` — ${fmtDate(data.eventDate)}` : ""}</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={() => setShowBuyList(v => !v)}
            className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${showBuyList ? "border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700" : "border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 line-through hover:bg-gray-200 dark:hover:bg-gray-600"}`}
          >
            Buy List
          </button>
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 px-3 py-1.5 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 font-semibold rounded-lg hover:bg-gray-700 dark:hover:bg-gray-300 transition-colors text-xs"
          >
            <Printer className="w-3.5 h-3.5" /> Print
          </button>
        </div>
      </div>

      {/* ── Printable document ───────────────────────────────────────────── */}
      <div className="print-document bg-white dark:bg-gray-950 print:bg-white p-6 print:p-0 max-w-4xl mx-auto">

        {/* Header */}
        <div className="mb-3 pb-2 border-b-2 border-gray-900 dark:border-gray-100 print:border-gray-900">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-lg font-black tracking-tight text-gray-900 dark:text-gray-100 print:text-gray-900 uppercase leading-tight">
                Task List / Lista de Tareas
              </h1>
              <p className="text-gray-500 dark:text-gray-400 print:text-gray-500 text-xs mt-0.5">dash by Hollywood East Cafe</p>
            </div>
            <div className="text-right text-xs">
              <p className="font-bold text-gray-900 dark:text-gray-100 print:text-gray-900">{data.clientName}</p>
              {data.eventDate && <p className="text-gray-600 dark:text-gray-400 print:text-gray-600">{fmtDate(data.eventDate)}</p>}
              <p className="text-gray-400 dark:text-gray-500 print:text-gray-400 mt-0.5">
                Printed {new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              </p>
            </div>
          </div>
        </div>

        {data.taskItems.length === 0 && (
          <p className="text-gray-500 dark:text-gray-400 italic text-sm">No items selected.</p>
        )}

        <div className="space-y-2">
          {data.taskItems.map((ti, tiIdx) => (
            <div key={ti.lineItemId} className="border border-gray-300 dark:border-gray-700 print:border-gray-300 rounded-md overflow-hidden">
              <div
                className="bg-gray-100 dark:bg-gray-800 print:bg-gray-900 px-3 py-1.5 flex items-center justify-between cursor-pointer print:cursor-default gap-2"
                onClick={() => toggleItem(ti.lineItemId)}
              >
                <div className="flex items-center gap-1.5 flex-1 min-w-0">
                  <span className="print:hidden text-gray-400 dark:text-gray-500 shrink-0">
                    {expandedItems.has(ti.lineItemId) ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  </span>
                  <span className="font-black text-xs uppercase tracking-wide text-gray-900 dark:text-gray-100 print:text-white truncate">
                    {tiIdx + 1}. {ti.name}
                    {ti.nameEs && ti.nameEs !== ti.name && (
                      <span className="ml-1 font-normal normal-case text-gray-500 dark:text-gray-400 print:text-gray-300 italic"> / {ti.nameEs}</span>
                    )}
                  </span>
                </div>
                <span className="text-xs font-bold text-gray-900 dark:text-gray-100 print:text-white shrink-0">
                  {ti.quantity}×{ti.sizeLabel ? ` ${ti.sizeLabel}` : ""}
                  {ti.sizeServings && ti.sizeServings > 1 && !ti.sizeLabel && ` (${ti.sizeServings} serv.)`}
                </span>
              </div>

              <div className={expandedItems.has(ti.lineItemId) ? "block" : "hidden print:block"}>
                {!ti.hasRecipe ? (
                  <div className="px-3 py-2 bg-white dark:bg-gray-900 print:bg-white">
                    {(ti.customText ?? "").trim() ? (
                      <p className="text-xs text-gray-800 dark:text-gray-200 print:text-gray-800 whitespace-pre-wrap">
                        {ti.customText}
                        {ti.customTextEs && ti.customTextEs !== ti.customText && (
                          <span className="italic text-gray-400 dark:text-gray-500 print:text-gray-500"> / {ti.customTextEs}</span>
                        )}
                      </p>
                    ) : (
                      <p className="text-gray-400 dark:text-gray-500 print:text-gray-600 italic text-xs">No recipe — Sin receta</p>
                    )}
                  </div>
                ) : (
                  <div className="px-3 py-2 space-y-2 bg-white dark:bg-gray-900 print:bg-white">
                    {ti.recipePreparations.map(rp => (
                      <div key={rp.preparationId} className="border border-indigo-200 dark:border-indigo-800 print:border-indigo-200 rounded overflow-hidden">
                        <div className="bg-indigo-50 dark:bg-indigo-950 print:bg-indigo-50 px-2.5 py-1 flex justify-between items-center gap-2">
                          <BilingualText en={rp.name} es={rp.nameEs} big />
                          <span className="text-xs font-bold text-indigo-700 dark:text-indigo-300 print:text-indigo-700 shrink-0">
                            {fmtQty(rp.scaledQuantity)} {rp.unit}
                          </span>
                        </div>
                        {rp.processSteps.length > 0 && (
                          <ol className="px-2.5 py-1.5 space-y-0.5 bg-white dark:bg-gray-900 print:bg-white">
                            {rp.processSteps.map((s, si) => (
                              <li key={s.id} className="text-xs flex gap-1.5 text-gray-800 dark:text-gray-200 print:text-gray-800">
                                <span className="font-mono text-gray-400 dark:text-gray-500 print:text-gray-400 shrink-0">{si + 1}.</span>
                                <span>
                                  {s.description}
                                  {s.descriptionEs && <span className="italic text-gray-400 dark:text-gray-500 print:text-gray-500"> / {s.descriptionEs}</span>}
                                </span>
                              </li>
                            ))}
                          </ol>
                        )}
                      </div>
                    ))}

                    {ti.recipeIngredients.length > 0 && (
                      <div className="space-y-1">
                        {ti.recipeIngredients.map((ing, iIdx) => (
                          <div key={`${ing.ingredientId}-${iIdx}`}>
                            <div className="flex justify-between items-baseline gap-2 text-xs">
                              <BilingualText en={ing.name} es={ing.nameEs} />
                              <span className="font-mono shrink-0 text-gray-700 dark:text-gray-300 print:text-gray-700">{fmtQty(ing.scaledQuantity)} {ing.unit}</span>
                            </div>
                            {ing.processSteps.length > 0 && (
                              <ol className="ml-3 space-y-0.5">
                                {ing.processSteps.map((s, si) => (
                                  <li key={s.id} className="text-xs text-gray-600 dark:text-gray-400 print:text-gray-600">
                                    <span className="font-mono text-gray-400 dark:text-gray-500 print:text-gray-400 mr-1">{si + 1}.</span>
                                    {s.description}
                                    {s.descriptionEs && <span className="italic text-gray-400 dark:text-gray-500 print:text-gray-500"> / {s.descriptionEs}</span>}
                                  </li>
                                ))}
                              </ol>
                            )}
                          </div>
                        ))}
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

        {/* ── Buy List ─────────────────────────────────────────────── */}
        {showBuyList && data.buyList.length > 0 && (
          <div className="mt-6 pt-4 border-t-2 border-gray-900 dark:border-gray-100 print:border-gray-900 print:break-before-page">
            <h2 className="text-sm font-black uppercase tracking-wide text-gray-900 dark:text-gray-100 print:text-gray-900 mb-1">
              Buy List / Lista de Compras
            </h2>
            <div className="border border-gray-300 dark:border-gray-700 print:border-gray-300 rounded-md overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-gray-900 dark:bg-gray-700 print:bg-gray-900 text-white">
                  <tr>
                    <th className="text-left px-3 py-1.5 font-bold uppercase tracking-wide">#</th>
                    <th className="text-left px-3 py-1.5 font-bold uppercase tracking-wide">Ingredient / Ingrediente</th>
                    <th className="text-right px-3 py-1.5 font-bold uppercase tracking-wide">Qty / Cant.</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700 print:divide-gray-200">
                  {data.buyList.map((b, idx) => (
                    <tr
                      key={`${b.ingredientId}-${b.unit}`}
                      className={idx % 2 === 0 ? "bg-white dark:bg-gray-900 print:bg-white" : "bg-gray-50 dark:bg-gray-800 print:bg-gray-50"}
                    >
                      <td className="px-3 py-1 text-gray-400 dark:text-gray-500 print:text-gray-400 font-mono">{idx + 1}</td>
                      <td className="px-3 py-1">
                        <span className="font-semibold text-gray-900 dark:text-gray-100 print:text-gray-900">{b.name}</span>
                        {b.nameEs && b.nameEs !== b.name && (
                          <span className="ml-1 text-gray-400 dark:text-gray-500 print:text-gray-500 italic"> / {b.nameEs}</span>
                        )}
                      </td>
                      <td className="px-3 py-1 text-right font-mono font-bold text-gray-900 dark:text-gray-100 print:text-gray-900">
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
        <div className="mt-4 pt-2 border-t border-gray-200 dark:border-gray-700 print:border-gray-200 text-xs text-gray-400 dark:text-gray-500 print:text-gray-400 flex justify-between">
          <span>dash by Hollywood East Cafe — Confidential</span>
          <span>Inquiry #{data.inquiryId}</span>
        </div>
      </div>

      <style>{`
        @media print {
          @page { margin: 0.5in; size: letter; }

          /* Kill any min-height that inflates blank pages */
          html, body { height: auto !important; min-height: 0 !important; }
          #root, [data-reactroot] { height: auto !important; min-height: 0 !important; }

          .print-document { max-width: 100%; padding: 0; }
          .print\\:break-before-page { break-before: page; }
          .print\\:hidden { display: none !important; }
          .print\\:block { display: block !important; }
          .hidden { display: none !important; }
          .truncate { overflow: visible !important; text-overflow: unset !important; white-space: normal !important; }

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
