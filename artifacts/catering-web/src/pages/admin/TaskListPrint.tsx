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

function Checkbox() {
  return (
    <span style={{
      display: "inline-block",
      width: "13px",
      height: "13px",
      minWidth: "13px",
      border: "1.5px solid #9ca3af",
      borderRadius: "2px",
      flexShrink: 0,
    }} />
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
      <div className="print:hidden bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 px-6 py-3 sticky top-0 z-10 flex items-center gap-4">
        <div>
          <h1 className="font-bold text-gray-900 dark:text-gray-100 text-sm">Task List</h1>
          <p className="text-xs text-gray-600 dark:text-gray-400">{data.clientName}{data.eventDate ? ` — ${fmtDate(data.eventDate)}` : ""}</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
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
            <div key={ti.lineItemId} className="item-card border border-gray-300 dark:border-gray-700 print:border-gray-300 rounded-md overflow-hidden">

              {/* ── Item header bar — three columns: EN name | ES name | qty ── */}
              <div
                className="item-header bg-gray-900 dark:bg-gray-800 print:bg-gray-100 px-3 py-1.5 grid items-center cursor-pointer print:cursor-default gap-x-2"
                style={{ gridTemplateColumns: "1fr 1fr auto" }}
                onClick={() => toggleItem(ti.lineItemId)}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="print:hidden text-gray-500 shrink-0">
                    {expandedItems.has(ti.lineItemId) ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  </span>
                  <span className="font-black text-xs uppercase tracking-wide text-white print:text-gray-900 truncate">
                    {tiIdx + 1}. {ti.name}
                  </span>
                </div>
                <span className="font-black text-xs uppercase tracking-wide text-gray-400 print:text-gray-700 truncate">
                  {ti.nameEs && ti.nameEs !== ti.name ? ti.nameEs : ""}
                </span>
                <span className="text-xs font-bold text-white print:text-gray-900 shrink-0">
                  {ti.quantity}×{ti.sizeLabel ? ` ${ti.sizeLabel}` : ""}
                  {ti.sizeServings && ti.sizeServings > 1 && !ti.sizeLabel && ` (${ti.sizeServings} serv.)`}
                </span>
              </div>

              {/* ── Body — shown/collapsed on screen, always visible on print ── */}
              <div className={expandedItems.has(ti.lineItemId) ? "block" : "hidden print:block"}>

                {/* Column labels */}
                <div
                  className="grid text-[10px] font-bold uppercase tracking-widest border-b border-gray-200 dark:border-gray-700 print:border-gray-200 bg-gray-50 dark:bg-gray-900 print:bg-gray-50"
                  style={{ gridTemplateColumns: "1fr 1fr" }}
                >
                  <div className="px-2 py-0.5 text-gray-400 dark:text-gray-500">English</div>
                  <div className="px-2 py-0.5 text-gray-400 dark:text-gray-500 border-l border-gray-200 dark:border-gray-700 print:border-gray-200">Español</div>
                </div>

                {/* ── No recipe ─────────────────────────────────────────────── */}
                {!ti.hasRecipe && (
                  <div
                    className="grid bg-white dark:bg-gray-900 print:bg-white"
                    style={{ gridTemplateColumns: "1fr 1fr" }}
                  >
                    <div className="px-2 py-2 text-sm text-gray-800 dark:text-gray-200 print:text-gray-800 whitespace-pre-wrap flex gap-2 items-start">
                      <Checkbox />
                      <span>{(ti.customText ?? "").trim() || <em className="text-gray-400 not-italic">No recipe</em>}</span>
                    </div>
                    <div className="px-2 py-2 text-sm text-gray-600 dark:text-gray-400 print:text-gray-700 whitespace-pre-wrap border-l border-gray-200 dark:border-gray-700 print:border-gray-200">
                      {(ti.customTextEs ?? "").trim() || <em className="not-italic text-gray-400">Sin receta</em>}
                    </div>
                  </div>
                )}

                {/* ── Recipe ────────────────────────────────────────────────── */}
                {ti.hasRecipe && (
                  <div className="bg-white dark:bg-gray-900 print:bg-white">

                    {/* Preparations */}
                    {ti.recipePreparations.map(rp => (
                      <div key={rp.preparationId} className="border-b border-gray-100 dark:border-gray-800 print:border-gray-100 last:border-b-0">

                        {/* Prep header — full width, two-column inner */}
                        <div
                          className="grid items-center bg-indigo-50 dark:bg-indigo-950 print:bg-indigo-50 border-b border-indigo-100 dark:border-indigo-900 print:border-indigo-100"
                          style={{ gridTemplateColumns: "1fr 1fr" }}
                        >
                          <div className="px-2 py-1 flex items-baseline gap-2">
                            <span className="font-bold text-xs text-indigo-800 dark:text-indigo-200 print:text-indigo-800">{rp.name}</span>
                            <span className="text-xs font-mono text-indigo-600 dark:text-indigo-300 print:text-indigo-600 shrink-0">
                              {fmtQty(rp.scaledQuantity)} {rp.unit}
                            </span>
                          </div>
                          <div className="px-2 py-1 text-xs italic text-indigo-600 dark:text-indigo-400 print:text-indigo-600 border-l border-indigo-100 dark:border-indigo-900 print:border-indigo-100">
                            {rp.nameEs && rp.nameEs !== rp.name ? rp.nameEs : ""}
                          </div>
                        </div>

                        {/* Prep steps */}
                        {rp.processSteps.map((s, si) => (
                          <div
                            key={s.id}
                            className="grid border-b border-gray-100 dark:border-gray-800 print:border-gray-100 last:border-b-0"
                            style={{ gridTemplateColumns: "1fr 1fr" }}
                          >
                            <div className="px-2 py-1 text-sm text-gray-800 dark:text-gray-200 print:text-gray-800 flex gap-1.5 items-start">
                              <Checkbox />
                              <span className="font-mono text-gray-400 shrink-0">{si + 1}.</span>
                              <span>{s.description}</span>
                            </div>
                            <div className="px-2 py-1 text-sm text-gray-600 dark:text-gray-400 print:text-gray-700 flex gap-1.5 border-l border-gray-200 dark:border-gray-700 print:border-gray-200">
                              <span className="font-mono not-italic text-gray-400 shrink-0">{si + 1}.</span>
                              <span>{s.descriptionEs ?? ""}</span>
                            </div>
                          </div>
                        ))}

                        {/* Prep ingredient lines */}
                        {rp.ingredientLines.map((ing, iIdx) => (
                          <div key={`${ing.ingredientId}-${iIdx}`}>
                            <div
                              className="grid border-b border-gray-100 dark:border-gray-800 print:border-gray-100 last:border-b-0"
                              style={{ gridTemplateColumns: "1fr 1fr" }}
                            >
                              <div className="px-2 py-1 text-sm text-gray-800 dark:text-gray-200 print:text-gray-800 flex items-center gap-1.5">
                                <Checkbox />
                                <span className="font-semibold flex-1 min-w-0">{ing.name}</span>
                                <span className="font-mono text-gray-500 dark:text-gray-400 print:text-gray-500 shrink-0">{fmtQty(ing.scaledQuantity)} {ing.unit}</span>
                              </div>
                              <div className="px-2 py-1 text-sm text-gray-600 dark:text-gray-400 print:text-gray-700 border-l border-gray-200 dark:border-gray-700 print:border-gray-200">
                                {ing.nameEs && ing.nameEs !== ing.name ? ing.nameEs : ""}
                              </div>
                            </div>
                            {ing.processSteps.map((s, si) => (
                              <div
                                key={s.id}
                                className="grid border-b border-gray-100 dark:border-gray-800 print:border-gray-100 last:border-b-0"
                                style={{ gridTemplateColumns: "1fr 1fr" }}
                              >
                                <div className="pl-5 pr-2 py-0.5 text-sm text-gray-700 dark:text-gray-300 print:text-gray-700 flex gap-1.5 items-start">
                                  <Checkbox />
                                  <span className="font-mono text-gray-400 shrink-0">{si + 1}.</span>
                                  <span>{s.description}</span>
                                </div>
                                <div className="pl-5 pr-2 py-0.5 text-sm text-gray-500 dark:text-gray-500 print:text-gray-700 flex gap-1.5 border-l border-gray-200 dark:border-gray-700 print:border-gray-200">
                                  <span className="font-mono not-italic text-gray-400 shrink-0">{si + 1}.</span>
                                  <span>{s.descriptionEs ?? ""}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    ))}

                    {/* Direct (top-level) ingredients */}
                    {ti.recipeIngredients.length > 0 && (
                      <div>
                        {ti.recipeIngredients.map((ing, iIdx) => (
                          <div key={`${ing.ingredientId}-${iIdx}`}>
                            <div
                              className="grid border-b border-gray-100 dark:border-gray-800 print:border-gray-100 last:border-b-0"
                              style={{ gridTemplateColumns: "1fr 1fr" }}
                            >
                              <div className="px-2 py-1 text-sm text-gray-800 dark:text-gray-200 print:text-gray-800 flex items-center gap-1.5">
                                <Checkbox />
                                <span className="font-semibold flex-1 min-w-0">{ing.name}</span>
                                <span className="font-mono text-gray-500 dark:text-gray-400 print:text-gray-500 shrink-0">{fmtQty(ing.scaledQuantity)} {ing.unit}</span>
                              </div>
                              <div className="px-2 py-1 text-sm text-gray-600 dark:text-gray-400 print:text-gray-700 border-l border-gray-200 dark:border-gray-700 print:border-gray-200">
                                {ing.nameEs && ing.nameEs !== ing.name ? ing.nameEs : ""}
                              </div>
                            </div>
                            {ing.processSteps.map((s, si) => (
                              <div
                                key={s.id}
                                className="grid border-b border-gray-100 dark:border-gray-800 print:border-gray-100 last:border-b-0"
                                style={{ gridTemplateColumns: "1fr 1fr" }}
                              >
                                <div className="pl-5 pr-2 py-0.5 text-sm text-gray-700 dark:text-gray-300 print:text-gray-700 flex gap-1.5 items-start">
                                  <Checkbox />
                                  <span className="font-mono text-gray-400 shrink-0">{si + 1}.</span>
                                  <span>{s.description}</span>
                                </div>
                                <div className="pl-5 pr-2 py-0.5 text-sm text-gray-500 dark:text-gray-500 print:text-gray-700 flex gap-1.5 border-l border-gray-200 dark:border-gray-700 print:border-gray-200">
                                  <span className="font-mono not-italic text-gray-400 shrink-0">{si + 1}.</span>
                                  <span>{s.descriptionEs ?? ""}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}

                    {ti.recipePreparations.length === 0 && ti.recipeIngredients.length === 0 && (
                      <div
                        className="grid"
                        style={{ gridTemplateColumns: "1fr 1fr" }}
                      >
                        <div className="px-2 py-2 text-sm text-gray-400 dark:text-gray-500 print:text-gray-400 italic">Recipe has no ingredient lines.</div>
                        <div className="border-l border-gray-200 dark:border-gray-700 print:border-gray-200" />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

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
          .print\\:hidden { display: none !important; }
          .print\\:block { display: block !important; }
          .hidden { display: none !important; }
          .truncate { overflow: visible !important; text-overflow: unset !important; white-space: normal !important; }

          /* ── Dark-block fix: keep cards together; if they must break, prevent
                background bleed by clearing overflow and radius ── */
          .item-card {
            break-inside: avoid;
            overflow: visible !important;
            border-radius: 0 !important;
          }
          /* Keep the dark header bar always on the same page as its body;
             force a light background and dark text so nothing is invisible on paper */
          .item-header {
            break-after: avoid;
            background-color: #f3f4f6 !important; /* gray-100 */
            border-bottom: 1px solid #d1d5db;
          }
          .item-header * {
            color: #111827 !important; /* gray-900 */
          }

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
          .dark .dark\\:text-indigo-200 { color: #4338ca !important; }
          .dark .dark\\:text-indigo-300 { color: #4338ca !important; }
          .dark .dark\\:text-indigo-400 { color: #6366f1 !important; }
          .dark .dark\\:border-gray-100 { border-color: #111827 !important; }
          .dark .dark\\:border-gray-700 { border-color: #d1d5db !important; }
          .dark .dark\\:border-gray-800 { border-color: #f3f4f6 !important; }
          .dark .dark\\:border-indigo-900 { border-color: #c7d2fe !important; }
          .dark .dark\\:divide-gray-700 > * + * { border-color: #e5e7eb !important; }
          .dark .dark\\:divide-gray-800 > * + * { border-color: #f3f4f6 !important; }

          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        }
      `}</style>
    </>
  );
}
