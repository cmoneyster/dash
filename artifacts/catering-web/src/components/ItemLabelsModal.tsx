import { useState } from "react";
import { Loader2, Printer, Tag, X, Check, AlertCircle } from "lucide-react";

// Per-order "Print Individual Item Labels" modal used by the Kitchen
// Display. Lists every line item on the order with a Print button per
// item plus a Print All button at the top. Each press POSTs to
// `/api/event-ordering/orders/:id/print-labels` which routes labels
// through the same global print queue as the auto fan-out — so
// labels honor the admin printer settings, the per-surface matrix, and
// the per-printer "suppress plate-line labels" toggle.
//
// Auth uses the kitchen surface password (Bearer). The endpoint returns
// `{ enqueued }` so the modal can surface "queued N labels" feedback.

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type OrderLineLite = {
  itemId: number;
  name: string;
  quantity: number;
};

interface Props {
  open: boolean;
  onClose: () => void;
  orderId: number | null;
  orderNumber: string;
  guestName: string;
  items: OrderLineLite[];
  authToken: string | null;
}

type RowStatus =
  | { kind: "idle" }
  | { kind: "printing" }
  | { kind: "ok"; count: number }
  | { kind: "err"; msg: string };

export function ItemLabelsModal({
  open,
  onClose,
  orderId,
  orderNumber,
  guestName,
  items,
  authToken,
}: Props) {
  // status keyed by itemId, plus a special "all" key for the Print All button
  const [statuses, setStatuses] = useState<Record<string, RowStatus>>({});

  if (!open) return null;

  async function postPrint(itemId: number | undefined): Promise<{ enqueued: number }> {
    if (orderId == null) throw new Error("Order id missing");
    if (!authToken) throw new Error("Not authenticated");
    const r = await fetch(`${BASE}/api/event-ordering/orders/${orderId}/print-labels`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(itemId == null ? {} : { itemId }),
    });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try {
        const j = (await r.json()) as { error?: string };
        if (j?.error) msg = j.error;
      } catch {}
      throw new Error(msg);
    }
    return (await r.json()) as { enqueued: number };
  }

  async function trigger(key: string, itemId: number | undefined) {
    setStatuses((s) => ({ ...s, [key]: { kind: "printing" } }));
    try {
      const { enqueued } = await postPrint(itemId);
      setStatuses((s) => ({ ...s, [key]: { kind: "ok", count: enqueued } }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed";
      setStatuses((s) => ({ ...s, [key]: { kind: "err", msg } }));
    }
  }

  const allStatus: RowStatus = statuses["all"] ?? { kind: "idle" };
  const allBusy = allStatus.kind === "printing";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-card text-card-foreground rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col">
        <header className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-600 text-white flex items-center justify-center">
              <Tag className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-display font-bold text-lg leading-tight">
                Print Item Labels
              </h2>
              <p className="text-xs text-muted-foreground">
                Order #{orderNumber} · {guestName}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close"
            data-testid="button-close-item-labels"
          >
            <X className="w-5 h-5" />
          </button>
        </header>

        <div className="px-5 py-3 border-b border-border bg-secondary/30">
          <button
            type="button"
            disabled={allBusy || items.length === 0}
            onClick={() => void trigger("all", undefined)}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            data-testid="button-print-all-labels"
          >
            {allBusy ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Printer className="w-4 h-4" />
            )}
            <span>Print all items</span>
          </button>
          <StatusLine status={allStatus} />
        </div>

        <ul className="flex-1 overflow-auto divide-y divide-border">
          {items.length === 0 && (
            <li className="px-5 py-8 text-center text-sm text-muted-foreground">
              No items on this order.
            </li>
          )}
          {items.map((it) => {
            const key = String(it.itemId);
            const st = statuses[key] ?? { kind: "idle" };
            const busy = st.kind === "printing";
            return (
              <li key={it.itemId} className="px-5 py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-semibold truncate">{it.name}</div>
                  <div className="text-xs text-muted-foreground">
                    Qty {it.quantity}
                  </div>
                  <StatusLine status={st} />
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void trigger(key, it.itemId)}
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold bg-secondary hover:bg-secondary/80 text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  data-testid={`button-print-label-${it.itemId}`}
                >
                  {busy ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Printer className="w-4 h-4" />
                  )}
                  <span>Print</span>
                </button>
              </li>
            );
          })}
        </ul>

        <footer className="px-5 py-3 border-t border-border text-xs text-muted-foreground">
          Labels route through the global print queue using the printers
          configured in admin. Plate-attached units are skipped on printers
          with that toggle on.
        </footer>
      </div>
    </div>
  );
}

function StatusLine({ status }: { status: RowStatus }) {
  if (status.kind === "idle") return null;
  if (status.kind === "printing") {
    return (
      <p className="mt-1 text-xs text-muted-foreground flex items-center gap-1">
        <Loader2 className="w-3 h-3 animate-spin" /> Queueing…
      </p>
    );
  }
  if (status.kind === "ok") {
    return (
      <p className="mt-1 text-xs text-emerald-600 flex items-center gap-1">
        <Check className="w-3 h-3" />
        {status.count > 0
          ? `Queued ${status.count} label${status.count === 1 ? "" : "s"}`
          : "Nothing to print (no enabled label printer or fully plated)"}
      </p>
    );
  }
  return (
    <p className="mt-1 text-xs text-red-600 flex items-center gap-1">
      <AlertCircle className="w-3 h-3" /> {status.msg}
    </p>
  );
}
