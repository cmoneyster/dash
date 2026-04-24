// Numeric DB columns come back as strings via Drizzle, but admin-side
// API responses already coerce them to numbers. Accept either so the same
// helper can be used by the server (string fields) and the React client
// (number fields) without forcing the caller to re-stringify.
export type EffectivePriceMenuItem = {
  price: string | number;
  tier2Qty: number | null;
  tier2Price: string | number | null;
  tier3Qty: number | null;
  tier3Price: string | number | null;
};

// Which rule actually decided the returned per-unit price. Useful for the
// cart UI ("Tier 2 price" badge) and the admin quote editor (highlighting
// the auto-applied tier on the line).
export type EffectivePriceTier = "size" | "tier3" | "tier2" | "base";

function num(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export function computeEffectivePriceDetail(
  item: EffectivePriceMenuItem,
  qty: number,
  sizePrice: number | string | null | undefined,
): { price: number; tier: EffectivePriceTier } {
  const sized = num(sizePrice);
  if (sized != null) return { price: sized, tier: "size" };
  const t2q = item.tier2Qty;
  const t2p = num(item.tier2Price);
  const t3q = item.tier3Qty;
  const t3p = num(item.tier3Price);
  if (t3q && t3p != null && qty >= t3q) return { price: t3p, tier: "tier3" };
  if (t2q && t2p != null && qty >= t2q) return { price: t2p, tier: "tier2" };
  return { price: num(item.price) ?? 0, tier: "base" };
}

export function computeEffectivePrice(
  item: EffectivePriceMenuItem,
  qty: number,
  sizePrice: number | string | null | undefined,
): number {
  return computeEffectivePriceDetail(item, qty, sizePrice).price;
}
