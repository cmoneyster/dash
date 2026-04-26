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

// ============================================================================
// OTD on-site setup fee synthesis — shared across the admin Quote Builder UI
// (artifacts/catering-web) and the server routes that snapshot/seed it
// (artifacts/api-server). Centralized here so the stable id, label, and
// waiver logic can never drift between the three call sites.
// ============================================================================

// Stable id used for the synthesized "On the Dash on-site setup fee" row in
// the Quote Builder fees array. The matching Quote Builder helper for the
// extra-hours upcharge uses the sibling id "otd-extra-hours". Keeping the
// id literal exported lets backend and frontend dedupe / strip the row by
// the same key.
export const OTD_SETUP_FEE_ID = "otd-setup-fee";

// Stable, customer-facing label for the row. Surfaces in the PDF, the
// admin Quote Builder fees list, and the public quote payload.
export const OTD_SETUP_FEE_LABEL = "On the Dash — on-site setup fee";

// Minimal shape of a fee/discount row used by both api-server and
// catering-web. Mirrors `QuoteAdjustment` from `@workspace/db/schema` but
// is redeclared locally so this package stays free of a `@workspace/db`
// dependency (it is consumed by both backend and frontend bundles).
export type OtdQuoteAdjustment = {
  id: string;
  label: string;
  kind: "fixed" | "percent";
  amount: number;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Compute the synthesized OTD setup-fee row, or null when no row should
 * be present. Returns null in any of these cases (matching the orange
 * info card and waiver-badge logic in the admin UI):
 *   - serviceMode is not "on_the_dash"
 *   - the snapshot setup fee is missing or non-positive
 *   - the food subtotal has reached/passed the per-inquiry waiver threshold
 *
 * The label and id are stable so persisted rows do not churn between
 * renders / saves.
 */
export function computeOtdSetupFeeRow(
  serviceMode: string | null | undefined,
  setupFee: number | null | undefined,
  waiverThreshold: number | null | undefined,
  subtotal: number,
): OtdQuoteAdjustment | null {
  if (serviceMode !== "on_the_dash") return null;
  if (setupFee == null || !Number.isFinite(setupFee) || setupFee <= 0) return null;
  if (
    waiverThreshold != null
    && Number.isFinite(waiverThreshold)
    && subtotal >= waiverThreshold
  ) {
    return null;
  }
  return {
    id: OTD_SETUP_FEE_ID,
    label: OTD_SETUP_FEE_LABEL,
    kind: "fixed",
    amount: round2(setupFee),
  };
}

/**
 * Semantic equality for two synthesized fee rows. Used by the admin
 * mode-toggle handler to decide whether to write back a new fees array,
 * so we don't churn quote totals on no-op re-saves.
 */
export function otdSetupFeeRowEquals(
  a: OtdQuoteAdjustment | null,
  b: OtdQuoteAdjustment | null,
): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return (
    a.id === b.id
    && a.kind === b.kind
    && a.label === b.label
    && Math.abs(Number(a.amount) - Number(b.amount)) < 0.005
  );
}
