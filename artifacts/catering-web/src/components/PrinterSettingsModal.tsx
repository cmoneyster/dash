import { useEffect, useState } from "react";
import { Loader2, Printer, X } from "lucide-react";

// Shared printer-settings modal used by both the Staff Order Taker
// and the Kitchen Display. Each surface scopes which per-printer
// toggles are visible/editable via the `surface` prop. The list and
// PATCH calls hit the surface-scoped endpoints (`/event-taker/...`
// or `/event-ordering/...`) which are backed by the same `printers`
// table /admin/printers writes to — so admin remains the source of
// truth and all three views stay in sync automatically.

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export type PrinterSettingsSurface = "taker" | "kitchen";

type PrinterRow = {
  id: number;
  name: string;
  location: string | null;
  enabled: boolean;
  autoPrintOnNewOrder: boolean;
  printsKitchenTicket: boolean;
  printsCustomerReceipt: boolean;
  printsItemLabels: boolean;
  suppressItemLabelsForPlateLines: boolean;
};

interface Props {
  open: boolean;
  onClose: () => void;
  surface: PrinterSettingsSurface;
  authToken: string | null;
}

const ENDPOINTS: Record<PrinterSettingsSurface, { list: string; patch: (id: number) => string; label: string }> = {
  taker: {
    list: "/api/event-taker/printers",
    patch: id => `/api/event-taker/printers/${id}`,
    label: "Staff Order Taker",
  },
  kitchen: {
    list: "/api/event-ordering/printers",
    patch: id => `/api/event-ordering/printers/${id}`,
    label: "Kitchen Display",
  },
};

// Per-surface allow-list — mirrors the server-side allow-list. Hides toggles
// that the surface isn't authorized to send so staff can't get confused
// about why flipping something has no effect.
const VISIBLE_TOGGLES: Record<PrinterSettingsSurface, ReadonlyArray<{ key: keyof PrinterRow; label: string }>> = {
  taker: [
    { key: "enabled", label: "Enabled" },
    { key: "autoPrintOnNewOrder", label: "Auto-print on new order" },
    { key: "printsKitchenTicket", label: "Kitchen ticket" },
    { key: "printsCustomerReceipt", label: "Customer receipt" },
  ],
  kitchen: [
    { key: "enabled", label: "Enabled" },
    { key: "autoPrintOnNewOrder", label: "Auto-print on new order" },
    { key: "printsKitchenTicket", label: "Kitchen ticket" },
    { key: "printsItemLabels", label: "Item labels" },
    { key: "suppressItemLabelsForPlateLines", label: "Suppress labels for plated items" },
  ],
};

export function PrinterSettingsModal({ open, onClose, surface, authToken }: Props) {
  const [rows, setRows] = useState<PrinterRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const cfg = ENDPOINTS[surface];
  const toggles = VISIBLE_TOGGLES[surface];

  useEffect(() => {
    if (!open || !authToken) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${BASE}${cfg.list}`, { headers: { Authorization: `Bearer ${authToken}` } })
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as PrinterRow[];
      })
      .then(data => { if (!cancelled) setRows(data); })
      .catch(err => { if (!cancelled) setError(err.message ?? "Failed to load"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, authToken, cfg.list]);

  async function toggle(printer: PrinterRow, field: keyof PrinterRow) {
    if (!authToken) return;
    const key = `${printer.id}:${String(field)}`;
    setSavingKey(key);
    setError(null);
    const next = !(printer[field] as boolean);
    // Optimistic update.
    setRows(rs => rs.map(r => r.id === printer.id ? { ...r, [field]: next } : r));
    try {
      const res = await fetch(`${BASE}${cfg.patch(printer.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ [field]: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const updated = (await res.json()) as PrinterRow;
      setRows(rs => rs.map(r => r.id === updated.id ? updated : r));
    } catch (err) {
      // Roll back.
      setRows(rs => rs.map(r => r.id === printer.id ? { ...r, [field]: !next } : r));
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSavingKey(k => k === key ? null : k);
    }
  }

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card text-card-foreground rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col border border-border"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Printer className="w-5 h-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Printer Settings</h2>
            <span className="text-xs text-muted-foreground ml-1">({cfg.label} scope)</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded hover:bg-secondary text-muted-foreground"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-3 text-xs text-muted-foreground border-b border-border bg-muted/40">
          Changes save instantly to the admin printer config. The admin portal at
          {" "}<code className="bg-background px-1 rounded border border-border">/admin/printers</code> is the source of truth — what you see here mirrors it.
        </div>

        <div className="flex-1 overflow-auto p-5 space-y-4">
          {loading && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading printers…
            </div>
          )}
          {error && (
            <div className="rounded bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 text-red-700 dark:text-red-300 text-sm px-3 py-2">
              {error}
            </div>
          )}
          {!loading && rows.length === 0 && !error && (
            <div className="text-sm text-muted-foreground">
              No printers configured yet. Add one in the admin portal.
            </div>
          )}
          {rows.map(p => (
            <div key={p.id} className="rounded-lg border border-border p-4">
              <div className="flex items-baseline justify-between mb-3">
                <div>
                  <div className="font-semibold">{p.name}</div>
                  {p.location && <div className="text-xs text-muted-foreground">{p.location}</div>}
                </div>
                <div className="text-[11px] text-muted-foreground/70">id #{p.id}</div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {toggles.map(({ key, label }) => {
                  const checked = !!p[key];
                  const saving = savingKey === `${p.id}:${String(key)}`;
                  return (
                    <label
                      key={String(key)}
                      className="flex items-center justify-between gap-3 px-3 py-2 rounded border border-border hover:bg-secondary cursor-pointer text-sm"
                    >
                      <span className="flex items-center gap-2">
                        {label}
                        {saving && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
                      </span>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={saving}
                        onChange={() => toggle(p, key)}
                        className="w-4 h-4"
                      />
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
