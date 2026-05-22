import { useState, useEffect } from "react";
import { X, Minus, Plus, ClipboardList } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import type { PanSizeMenuItem } from "@/lib/menu-types";

interface SizeSlot {
  idx: 1 | 2 | 3 | 4 | 5;
  label: string;
  price: number;
  servings: number | null;
}

export interface PanSizeSelection {
  slot: number;
  label: string;
  price: number;
  qty: number;
}

interface PanSizePickerProps {
  item: PanSizeMenuItem;
  onClose: () => void;
  onConfirm: (selections: PanSizeSelection[]) => void;
  loading?: boolean;
}

function getSizeSlots(item: PanSizeMenuItem): SizeSlot[] {
  const slots: SizeSlot[] = [];
  const indices = [1, 2, 3, 4, 5] as const;
  for (const i of indices) {
    const label = item[`size${i}Label`];
    const rawPrice = item[`size${i}Price`];
    const servings = item[`size${i}Servings`] ?? null;
    if (label != null && rawPrice != null) {
      slots.push({ idx: i, label, price: Number(rawPrice), servings });
    }
  }
  return slots;
}

export function PanSizePicker({ item, onClose, onConfirm, loading }: PanSizePickerProps) {
  const slots = getSizeSlots(item);
  const minQty = item.minimumOrderQty ?? 1;

  const [qtys, setQtys] = useState<Record<number, number>>(() => {
    const init: Record<number, number> = {};
    slots.forEach((s, i) => { init[s.idx] = i === 0 ? minQty : 0; });
    return init;
  });
  const [error, setError] = useState("");

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const setQty = (idx: number, val: number) => {
    setQtys(prev => ({ ...prev, [idx]: Math.max(0, val) }));
    if (error) setError("");
  };

  const totalPans = Object.values(qtys).reduce((s, q) => s + q, 0);

  const handleConfirm = () => {
    const selections = slots
      .filter(s => qtys[s.idx] > 0)
      .map(s => ({ slot: s.idx, label: s.label, price: s.price, qty: qtys[s.idx] }));
    if (selections.length === 0) {
      setError("Please select at least one size to add to your order.");
      return;
    }
    if (totalPans < minQty) {
      setError(`Minimum order is ${minQty} pan${minQty !== 1 ? "s" : ""} total. Please increase your selection.`);
      return;
    }
    onConfirm(selections);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-card w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-4 sm:slide-in-from-bottom-0 duration-200">
        {/* Header */}
        <div className="flex items-start justify-between p-5 pb-4 border-b border-border">
          <div>
            <h2 className="font-display font-bold text-xl leading-tight">{item.name}</h2>
            <p className="text-sm text-muted-foreground mt-0.5">Select pan size{slots.length > 1 ? "s" : ""} and quantity</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full hover:bg-secondary transition-colors text-muted-foreground ml-4 shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Size slots */}
        <div className="p-5 space-y-3 max-h-[60vh] overflow-y-auto">
          {slots.map(s => {
            const qty = qtys[s.idx];
            const isSelected = qty > 0;
            return (
              <div
                key={s.idx}
                className={`flex items-center gap-4 p-3.5 rounded-xl border transition-colors ${
                  isSelected
                    ? "border-primary/40 bg-primary/5"
                    : "border-border bg-secondary/30"
                }`}
              >
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm leading-tight">{s.label}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-primary font-bold text-sm">{formatCurrency(s.price)}</span>
                    {s.servings != null && (
                      <span className="text-xs text-muted-foreground">· {s.servings} servings</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => setQty(s.idx, qty - 1)}
                    disabled={qty <= 0}
                    className="w-8 h-8 flex items-center justify-center rounded-full border border-border bg-background hover:border-primary/50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <Minus className="w-3.5 h-3.5" />
                  </button>
                  <span className="w-6 text-center font-bold text-sm tabular-nums">{qty}</span>
                  <button
                    onClick={() => setQty(s.idx, qty + 1)}
                    className="w-8 h-8 flex items-center justify-center rounded-full border border-primary bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}

          {minQty > 1 && (
            <p className="text-xs text-amber-600 font-medium text-center">
              Minimum order: {minQty} pan{minQty !== 1 ? "s" : ""} total
            </p>
          )}

          {error && (
            <p className="text-xs text-destructive font-medium text-center">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="p-5 pt-4 border-t border-border space-y-2">
          <button
            onClick={handleConfirm}
            disabled={loading}
            className="w-full py-3.5 px-4 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
          >
            <ClipboardList className="w-4 h-4" />
            {loading
              ? "Adding…"
              : totalPans > 0
              ? `Add ${totalPans} pan${totalPans !== 1 ? "s" : ""} to Event Plan`
              : "Add to Event Plan"}
          </button>
          <button
            onClick={onClose}
            className="w-full py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
