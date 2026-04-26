import type { MenuItem } from "@workspace/api-client-react";

export interface PanSizeMenuItem extends MenuItem {
  pricingTemplate: "pan_sizes";
  size1Label?: string | null;
  size1Price?: number | null;
  size1Servings?: number | null;
  size2Label?: string | null;
  size2Price?: number | null;
  size2Servings?: number | null;
  size3Label?: string | null;
  size3Price?: number | null;
  size3Servings?: number | null;
  size4Label?: string | null;
  size4Price?: number | null;
  size4Servings?: number | null;
  size5Label?: string | null;
  size5Price?: number | null;
  size5Servings?: number | null;
}

export function isPanSizesItem(item: MenuItem): item is PanSizeMenuItem {
  return (item as { pricingTemplate?: string }).pricingTemplate === "pan_sizes";
}

export function getPanSizesFromPrice(item: MenuItem): number | null {
  const sized = item as Partial<PanSizeMenuItem>;
  const prices = [
    sized.size1Price,
    sized.size2Price,
    sized.size3Price,
    sized.size4Price,
    sized.size5Price,
  ]
    .map((p) => {
      if (p === null || p === undefined) return null;
      const n = Number(p);
      return isFinite(n) ? n : null;
    })
    .filter((p): p is number => p !== null)
    .sort((a, b) => a - b);
  return prices.length > 0 ? prices[0] : null;
}

// Returns the smallest and largest populated per-size serving counts for a
// pan-size item (e.g. {min:15, max:45} for Small/Medium/Large pans). Returns
// null when nothing is populated, so the caller can fall back gracefully.
export function getPanSizesServingRange(item: MenuItem): { min: number; max: number } | null {
  const sized = item as Partial<PanSizeMenuItem>;
  const servings = [
    sized.size1Servings,
    sized.size2Servings,
    sized.size3Servings,
    sized.size4Servings,
    sized.size5Servings,
  ]
    .filter((n): n is number => typeof n === "number" && isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (servings.length === 0) return null;
  return { min: servings[0], max: servings[servings.length - 1] };
}

// Single source of truth for the "Serves …" line on the public menu cards.
// Pan-size items render a min–max range derived from their per-size serving
// counts (or a single number when min === max). Per-unit items keep the
// existing "Serves N (unit)" line. Falls back to per-unit text whenever the
// pan-size data isn't usable, so the row never renders blank.
export function formatServingsLine(item: MenuItem): string {
  if (isPanSizesItem(item)) {
    const range = getPanSizesServingRange(item);
    if (range) {
      return range.min === range.max
        ? `Serves ${range.min}`
        : `Serves ${range.min}\u2013${range.max}`;
    }
  }
  return `Serves ${item.servingSize} (${item.unit})`;
}
