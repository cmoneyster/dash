import { useState, useEffect, useRef } from "react";
import { useParams } from "wouter";
import { Printer, AlertTriangle, Loader2 } from "lucide-react";
import { getAdminToken } from "@/components/AdminGuard";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authHeaders() {
  const token = getAdminToken();
  return { Authorization: `Bearer ${token}` };
}

type BuyItem = { ingredientId: number; name: string; nameEs: string | null; totalQuantity: number; unit: string };
type TaskListData = {
  inquiryId: number; clientName: string; eventDate: string | null;
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

export default function BuyListPrint() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [data, setData] = useState<TaskListData | null>(null);
  const didLoad = useRef(false);

  useEffect(() => {
    if (didLoad.current) return;
    didLoad.current = true;

    fetch(`${BASE}/api/admin/catering/${id}/task-list/saved`, { headers: authHeaders() })
      .then(r => {
        if (!r.ok) throw new Error("not found");
        return r.json();
      })
      .then((saved: { data: TaskListData }) => {
        setData(saved.data);
      })
      .catch(() => {
        setError("No saved task list found for this inquiry. Generate a task list first from the catering inquiry detail.");
      })
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white dark:bg-gray-950">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading buy list…</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white dark:bg-gray-950">
        <div className="text-center max-w-sm">
          <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto mb-3" />
          <p className="font-bold text-gray-800 dark:text-gray-100 mb-1">Could not load buy list</p>
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
          <h1 className="font-bold text-gray-900 dark:text-gray-100 text-sm">Buy List</h1>
          <p className="text-xs text-gray-600 dark:text-gray-400">
            {data.clientName}{data.eventDate ? ` — ${fmtDate(data.eventDate)}` : ""}
          </p>
        </div>
        <div className="ml-auto">
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 px-3 py-1.5 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 font-semibold rounded-lg hover:bg-gray-700 dark:hover:bg-gray-300 transition-colors text-xs"
          >
            <Printer className="w-3.5 h-3.5" /> Print
          </button>
        </div>
      </div>

      {/* ── Printable document ───────────────────────────────────────────── */}
      <div className="print-document bg-white dark:bg-gray-950 print:bg-white p-6 print:p-0 max-w-3xl mx-auto">

        {/* Header */}
        <div className="mb-4 pb-2 border-b-2 border-gray-900 dark:border-gray-100 print:border-gray-900">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-lg font-black tracking-tight text-gray-900 dark:text-gray-100 print:text-gray-900 uppercase leading-tight">
                Buy List / Lista de Compras
              </h1>
              <p className="text-gray-500 dark:text-gray-400 print:text-gray-500 text-xs mt-0.5">dash by Hollywood East Cafe</p>
            </div>
            <div className="text-right text-xs">
              <p className="font-bold text-gray-900 dark:text-gray-100 print:text-gray-900">{data.clientName}</p>
              {data.eventDate && (
                <p className="text-gray-600 dark:text-gray-400 print:text-gray-600">{fmtDate(data.eventDate)}</p>
              )}
              <p className="text-gray-400 dark:text-gray-500 print:text-gray-400 mt-0.5">
                Printed {new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              </p>
            </div>
          </div>
        </div>

        {data.buyList.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 italic text-sm">No ingredients on the buy list.</p>
        ) : (
          <div className="border border-gray-300 dark:border-gray-700 print:border-gray-300 rounded-md overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-gray-900 dark:bg-gray-700 print:bg-gray-900 text-white">
                <tr>
                  <th className="text-left px-3 py-2 font-bold uppercase tracking-wide w-8">#</th>
                  <th className="text-left px-3 py-2 font-bold uppercase tracking-wide w-[38%]">Ingredient</th>
                  <th className="text-left px-3 py-2 font-bold uppercase tracking-wide w-[38%]">Ingrediente</th>
                  <th className="text-right px-3 py-2 font-bold uppercase tracking-wide">Qty / Cant.</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700 print:divide-gray-200">
                {data.buyList.map((b, idx) => (
                  <tr
                    key={`${b.ingredientId}-${b.unit}`}
                    className={idx % 2 === 0
                      ? "bg-white dark:bg-gray-900 print:bg-white"
                      : "bg-gray-50 dark:bg-gray-800 print:bg-gray-50"}
                  >
                    <td className="px-3 py-1.5 text-gray-400 dark:text-gray-500 print:text-gray-400 font-mono">
                      {idx + 1}
                    </td>
                    <td className="px-3 py-1.5 font-semibold text-gray-900 dark:text-gray-100 print:text-gray-900">
                      {b.name}
                    </td>
                    <td className="px-3 py-1.5 text-gray-500 dark:text-gray-400 print:text-gray-500 italic">
                      {b.nameEs && b.nameEs !== b.name ? b.nameEs : ""}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono font-bold text-gray-900 dark:text-gray-100 print:text-gray-900 whitespace-nowrap">
                      {fmtQty(b.totalQuantity)}{" "}
                      <span className="font-normal text-gray-500 dark:text-gray-400 print:text-gray-500">{b.unit}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Footer */}
        <div className="mt-4 pt-2 border-t border-gray-200 dark:border-gray-700 print:border-gray-200 text-xs text-gray-400 dark:text-gray-500 print:text-gray-400 flex justify-between">
          <span>dash by Hollywood East Cafe — Confidential</span>
          <span>Inquiry #{data.inquiryId}</span>
        </div>
      </div>

      <style>{`
        @media print {
          @page { margin: 0.5in; size: letter; }

          html, body { height: auto !important; min-height: 0 !important; }
          #root, [data-reactroot] { height: auto !important; min-height: 0 !important; }

          .print-document { max-width: 100%; padding: 0; }
          .print\\:hidden { display: none !important; }
          .print\\:block { display: block !important; }

          /* ── Override dark-mode colors for paper output ── */
          .dark .dark\\:bg-gray-950 { background-color: #ffffff !important; }
          .dark .dark\\:bg-gray-900 { background-color: #ffffff !important; }
          .dark .dark\\:bg-gray-800 { background-color: #f9fafb !important; }
          .dark .dark\\:bg-gray-700 { background-color: #111827 !important; }
          .dark .dark\\:text-gray-100 { color: #111827 !important; }
          .dark .dark\\:text-gray-400 { color: #6b7280 !important; }
          .dark .dark\\:text-gray-500 { color: #6b7280 !important; }
          .dark .dark\\:border-gray-100 { border-color: #111827 !important; }
          .dark .dark\\:border-gray-700 { border-color: #d1d5db !important; }
          .dark .dark\\:divide-gray-700 > * + * { border-color: #e5e7eb !important; }

          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        }
      `}</style>
    </>
  );
}
