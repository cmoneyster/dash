export type EffectivePriceMenuItem = {
  price: string;
  tier2Qty: number | null;
  tier2Price: string | null;
  tier3Qty: number | null;
  tier3Price: string | null;
};

export function computeEffectivePrice(
  item: EffectivePriceMenuItem,
  qty: number,
  sizePrice: number | string | null | undefined,
): number {
  if (sizePrice != null) {
    return typeof sizePrice === "string" ? parseFloat(sizePrice) : sizePrice;
  }
  const t2q = item.tier2Qty;
  const t2p = item.tier2Price ? parseFloat(item.tier2Price) : null;
  const t3q = item.tier3Qty;
  const t3p = item.tier3Price ? parseFloat(item.tier3Price) : null;
  if (t3q && t3p && qty >= t3q) return t3p;
  if (t2q && t2p && qty >= t2q) return t2p;
  return parseFloat(item.price);
}
