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
export const OTD_SETUP_FEE_LABEL = "On the Dash on-site setup fee";

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

/**
 * Display-only "ghost" row for the OTD on-site setup fee, returned ONLY when
 * the fee was suppressed purely because the food subtotal met/exceeded the
 * waiver threshold. Renderers (admin Quote Builder totals, public quote page,
 * and the quote PDF) use this to show the original fee with a strikethrough
 * plus a "waived (minimum met)" caption, so customers and admins can see
 * that a setup fee existed and was waived because the order qualified.
 *
 * The activation guards are deliberately the inverse of `computeOtdSetupFeeRow`:
 * whenever that helper returns null *because of waiver* (not because the fee
 * itself is missing), this helper returns a non-null display row, and vice
 * versa. The two are mutually exclusive at every input.
 *
 * The label intentionally reuses `OTD_SETUP_FEE_LABEL` and the threshold
 * comes back unchanged so callers can format the "waived: order met $X
 * minimum" text with a single source of truth.
 */
export type OtdWaivedSetupFeeDisplay = {
  label: string;
  originalAmount: number;
  waiverThreshold: number;
};
export function computeOtdSetupFeeWaivedDisplay(
  serviceMode: string | null | undefined,
  setupFee: number | null | undefined,
  waiverThreshold: number | null | undefined,
  subtotal: number,
): OtdWaivedSetupFeeDisplay | null {
  if (serviceMode !== "on_the_dash") return null;
  if (setupFee == null || !Number.isFinite(setupFee) || setupFee <= 0) return null;
  // Mirror `computeOtdSetupFeeRow`'s waiver branch *exactly* so the two
  // helpers stay mutually exclusive at every input (including the
  // degenerate threshold === 0 case and the NaN-subtotal edge case where
  // `subtotal >= waiverThreshold` is false even though the comparison
  // operands are pathological).
  if (waiverThreshold == null || !Number.isFinite(waiverThreshold)) return null;
  if (!Number.isFinite(subtotal) || subtotal < waiverThreshold) return null;
  return {
    label: OTD_SETUP_FEE_LABEL,
    originalAmount: round2(setupFee),
    waiverThreshold: round2(waiverThreshold),
  };
}

// ============================================================================
// Supplemental-invoice "uninvoiced delta" — shared between admin Quote Builder
// (catering-web) and the Square supplemental publish handler (api-server) so
// the previewed delta and the actual billed delta cannot drift.
// ============================================================================

// Minimal shape of a quote line item, redeclared locally so this package
// stays free of `@workspace/db`. Mirrors `QuoteLineItem` from
// `@workspace/db/schema` (only the fields the delta needs).
export type DeltaQuoteLineItem = {
  id: string;
  name: string;
  quantity: number | string;
  unitPrice: number | string;
  notes?: string | null;
  // Sizing/unit descriptor fields — passed through unchanged so the
  // supplemental Square order line keeps the same name/notes the
  // primary used.
  pricingTemplate?: "per_unit" | "pan_sizes" | null;
  sizeSlot?: number | null;
  sizeLabel?: string | null;
  sizeServings?: number | null;
  unit?: string | null;
  servingSize?: number | null;
};

export type UninvoicedDelta = {
  // The exact rows that should be billed on the supplemental invoice.
  // Quantities/amounts are already the **delta** amounts, so the caller
  // can plug them straight into a Square order without re-subtracting.
  deltaLineItems: Array<DeltaQuoteLineItem & { quantity: number; unitPrice: number }>;
  deltaFees: OtdQuoteAdjustment[];
  deltaDiscounts: OtdQuoteAdjustment[];
  // Net credit from items reduced in quantity vs the snapshot (always >= 0).
  // Applied as a discount on the supplemental Square order so the billed
  // amount equals the true net change rather than just the sum of increases.
  creditAmount: number;
  // Total dollar value of the delta after applying discounts and credits.
  // Always >= 0. Use this to enable/disable the "Issue supplemental invoice"
  // button and to refuse server-side issuance when the delta is zero.
  deltaTotal: number;
};

function toNumber(v: number | string | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Compute the uninvoiced delta between the live quote arrays and the
 * snapshot taken at the time the primary invoice was published.
 *
 * Matching / billing rules:
 *  - Line items match by stable `id`. Delta quantity = max(0, current −
 *    snapshot). New ids count their full quantity. Negative changes
 *    (quantity reductions) are ignored — refunds/write-downs are out of
 *    scope and must be handled in Square directly.
 *  - Fees and discounts also match by stable `id` (including the
 *    synthesized `otd-extra-hours` and `otd-setup-fee` rows from task
 *    #136). Their **dollar contribution** is computed under the full
 *    current quote vs the snapshot quote (percent rows are evaluated
 *    against the same base each pricing engine elsewhere uses: subtotal
 *    for fees, subtotal+fees for discounts). The supplemental bills the
 *    positive dollar difference, materialized as a `fixed` adjustment
 *    row so Square's invoice math is independent of the supplemental's
 *    own line-item subtotal. New rows / kind-changed rows count their
 *    full current dollar contribution as new.
 *
 * Returns deltaTotal = max(0, deltaSubtotal + deltaFeesTotal − deltaDiscountsTotal − creditAmount)
 * where creditAmount is the net dollar value of all quantity reductions (including full removals).
 *
 * Pure function: no DB, no Square calls, no rounding errors above 1¢.
 */
export function computeUninvoicedDelta(opts: {
  currentLineItems: DeltaQuoteLineItem[] | null | undefined;
  currentFees: OtdQuoteAdjustment[] | null | undefined;
  currentDiscounts: OtdQuoteAdjustment[] | null | undefined;
  snapshotLineItems: DeltaQuoteLineItem[] | null | undefined;
  snapshotFees: OtdQuoteAdjustment[] | null | undefined;
  snapshotDiscounts: OtdQuoteAdjustment[] | null | undefined;
}): UninvoicedDelta {
  const cur = opts.currentLineItems ?? [];
  const snap = opts.snapshotLineItems ?? [];
  const snapById = new Map<string, DeltaQuoteLineItem>();
  for (const r of snap) {
    if (r && typeof r.id === "string") snapById.set(r.id, r);
  }

  const deltaLineItems: Array<DeltaQuoteLineItem & { quantity: number; unitPrice: number }> = [];
  let creditAmount = 0;

  // Build a lookup of current items so we can detect full removals below.
  const curById = new Map<string, DeltaQuoteLineItem>();
  for (const row of cur) {
    if (row && typeof row.id === "string") curById.set(row.id, row);
  }

  for (const row of cur) {
    if (!row || typeof row.id !== "string") continue;
    const curQty = toNumber(row.quantity);
    const curUnit = toNumber(row.unitPrice);
    const prev = snapById.get(row.id);
    const prevQty = prev ? toNumber(prev.quantity) : 0;
    const prevUnit = prev ? toNumber(prev.unitPrice) : 0;
    // When the unit price changed (manual override or pan-size upgrade), use
    // the dollar delta of the full line total rather than deltaQty × curPrice.
    // The latter misattributes the price change to only the quantity delta and
    // can over- or under-charge on the supplemental.
    //   e.g. qty 100→150 @ $3→$2: deltaQty×curPrice = $100 (wrong)
    //         line total delta = $300−$300 = $0             (correct)
    // 0.005 tolerance handles floating-point representation of prices like $1.75.
    const priceChanged = prev != null && Math.abs(curUnit - prevUnit) >= 0.005;
    if (priceChanged) {
      const dollarDelta = round2(curQty * curUnit - prevQty * prevUnit);
      if (dollarDelta > 0 && curUnit > 0) {
        // Emit as qty=1 at the net dollar delta so the item name still
        // appears on the Square supplemental invoice line.
        deltaLineItems.push({ ...row, quantity: 1, unitPrice: dollarDelta });
      } else if (dollarDelta < 0) {
        creditAmount = round2(creditAmount + Math.abs(dollarDelta));
      }
      // dollarDelta === 0 → net no-op, no action needed
    } else {
      // Price unchanged (or new item): use quantity delta × price, which
      // gives a clean per-unit line on the Square supplemental invoice.
      const deltaQty = round2(curQty - prevQty);
      if (deltaQty > 0 && curUnit > 0) {
        deltaLineItems.push({
          ...row,
          quantity: deltaQty,
          unitPrice: curUnit,
        });
      } else if (deltaQty < 0 && curUnit > 0) {
        // Quantity was reduced: accumulate a credit for the dollar value
        // of the reduction so the supplemental net-charges the true
        // difference (increases minus reductions) rather than overbilling
        // by ignoring decrements.
        creditAmount = round2(creditAmount + Math.abs(deltaQty) * curUnit);
      }
    }
  }

  // Also credit items that were entirely removed from the current quote
  // (present in snapshot, absent in current). Their effective current qty
  // is 0, so the full snapshot qty × unit price is a reduction.
  for (const row of snap) {
    if (!row || typeof row.id !== "string") continue;
    if (curById.has(row.id)) continue; // partial change already handled above
    const snapQty = toNumber(row.quantity);
    const snapUnit = toNumber(row.unitPrice);
    if (snapQty > 0 && snapUnit > 0) {
      creditAmount = round2(creditAmount + snapQty * snapUnit);
    }
  }

  // Dollar contribution of one adjustment row against a given base.
  // Mirrors the engine used everywhere else in the app: fixed = literal
  // dollars; percent = base * pct/100. Returns 0 for non-finite inputs.
  function rowDollars(
    row: OtdQuoteAdjustment | undefined,
    base: number,
  ): number {
    if (!row) return 0;
    const amt = toNumber(row.amount);
    if (row.kind === "percent") return round2(base * (amt / 100));
    return round2(amt);
  }

  // Build "delta-as-fixed-dollars" for fees or discounts. We evaluate
  // each row's dollar contribution under (current quote, current base)
  // vs (snapshot quote, snapshot base), then bill the positive
  // difference as a `fixed` row. This handles all three real scenarios
  // correctly:
  //   - new line items only (rate unchanged) → percent fee scales up,
  //     the increase is billed.
  //   - rate changed (no new line items) → dollar increase against the
  //     unchanged base is billed.
  //   - kind change (percent ↔ fixed) → the previous contribution is
  //     treated as the snapshot dollars, the current as the new dollars,
  //     and the positive difference is billed.
  // Removed rows (snapshot-only) intentionally do not produce charges —
  // a removed discount that should claw money back must be handled by
  // explicit re-billing in Square, not implicit here.
  function adjustmentDollarDelta(
    current: OtdQuoteAdjustment[] | null | undefined,
    snapshot: OtdQuoteAdjustment[] | null | undefined,
    currentBase: number,
    snapshotBase: number,
  ): { rows: OtdQuoteAdjustment[]; total: number } {
    const snapMap = new Map<string, OtdQuoteAdjustment>();
    for (const r of snapshot ?? []) {
      if (r && typeof r.id === "string") snapMap.set(r.id, r);
    }
    const rows: OtdQuoteAdjustment[] = [];
    let total = 0;
    for (const row of current ?? []) {
      if (!row || typeof row.id !== "string") continue;
      const curDollars = rowDollars(row, currentBase);
      const prev = snapMap.get(row.id);
      const prevDollars = rowDollars(prev, snapshotBase);
      const deltaDollars = round2(curDollars - prevDollars);
      if (deltaDollars <= 0) continue;
      // Always emit as a fixed-dollar row so Square's invoice total
      // never depends on the supplemental's own line-item subtotal.
      rows.push({ id: row.id, label: row.label, kind: "fixed", amount: deltaDollars });
      total = round2(total + deltaDollars);
    }
    return { rows, total };
  }

  const deltaSubtotal = round2(
    deltaLineItems.reduce((s, li) => s + li.quantity * li.unitPrice, 0),
  );

  // Bases used to evaluate percent rows. The current/snapshot subtotals
  // include *all* line items (not just the delta) because the rate
  // applies to the whole quote, not the delta slice.
  const currentSubtotal = round2(
    (opts.currentLineItems ?? []).reduce(
      (s, li) => s + toNumber(li?.quantity) * toNumber(li?.unitPrice), 0,
    ),
  );
  const snapshotSubtotal = round2(
    (opts.snapshotLineItems ?? []).reduce(
      (s, li) => s + toNumber(li?.quantity) * toNumber(li?.unitPrice), 0,
    ),
  );

  const fees = adjustmentDollarDelta(
    opts.currentFees, opts.snapshotFees,
    currentSubtotal, snapshotSubtotal,
  );

  // Discounts apply on subtotal+fees, in both worlds. Use the *full*
  // current/snapshot fee dollar values (not the delta), since a
  // percent discount's base is the whole post-fee total.
  const currentFeesDollars = round2(
    (opts.currentFees ?? []).reduce(
      (s, f) => s + rowDollars(f, currentSubtotal), 0,
    ),
  );
  const snapshotFeesDollars = round2(
    (opts.snapshotFees ?? []).reduce(
      (s, f) => s + rowDollars(f, snapshotSubtotal), 0,
    ),
  );
  const discounts = adjustmentDollarDelta(
    opts.currentDiscounts, opts.snapshotDiscounts,
    round2(currentSubtotal + currentFeesDollars),
    round2(snapshotSubtotal + snapshotFeesDollars),
  );

  const deltaTotal = round2(Math.max(0, deltaSubtotal + fees.total - discounts.total - creditAmount));

  return {
    deltaLineItems,
    deltaFees: fees.rows,
    deltaDiscounts: discounts.rows,
    creditAmount,
    deltaTotal,
  };
}
