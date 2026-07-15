import { describe, it, expect } from "vitest";
import { computeUninvoicedDelta } from "./index.js";

function li(
  id: string,
  quantity: number,
  unitPrice: number,
  name = "Item",
) {
  return { id, name, quantity, unitPrice, menuItemId: null };
}

describe("computeUninvoicedDelta — price-change scenarios", () => {
  it("qty↑ + price↓ with same line total → deltaTotal = 0, no charge, no credit", () => {
    // Shannon Lindstrom scenario: 100×$3.00 → 150×$2.00 = $300 both ways
    const snap = [li("item-1", 100, 3.0)];
    const cur = [li("item-1", 150, 2.0)];
    const result = computeUninvoicedDelta({
      currentLineItems: cur,
      currentFees: [],
      currentDiscounts: [],
      snapshotLineItems: snap,
      snapshotFees: [],
      snapshotDiscounts: [],
    });
    expect(result.deltaTotal).toBe(0);
    expect(result.deltaLineItems).toHaveLength(0);
    expect(result.creditAmount).toBe(0);
  });

  it("qty unchanged + price↑ → charges the price increase × qty", () => {
    // 50 × $4.00 → 50 × $5.00: delta = $50
    const snap = [li("item-2", 50, 4.0)];
    const cur = [li("item-2", 50, 5.0)];
    const result = computeUninvoicedDelta({
      currentLineItems: cur,
      currentFees: [],
      currentDiscounts: [],
      snapshotLineItems: snap,
      snapshotFees: [],
      snapshotDiscounts: [],
    });
    expect(result.deltaTotal).toBe(50);
    expect(result.deltaLineItems).toHaveLength(1);
    expect(result.deltaLineItems[0].unitPrice).toBe(50);
    expect(result.deltaLineItems[0].quantity).toBe(1);
    expect(result.creditAmount).toBe(0);
  });

  it("qty↑ + price↑ → charges full line total delta", () => {
    // 10 × $10 → 20 × $12: delta = $240 − $100 = $140
    const snap = [li("item-3", 10, 10.0)];
    const cur = [li("item-3", 20, 12.0)];
    const result = computeUninvoicedDelta({
      currentLineItems: cur,
      currentFees: [],
      currentDiscounts: [],
      snapshotLineItems: snap,
      snapshotFees: [],
      snapshotDiscounts: [],
    });
    expect(result.deltaTotal).toBe(140);
    expect(result.deltaLineItems).toHaveLength(1);
    expect(result.deltaLineItems[0].unitPrice).toBe(140);
    expect(result.deltaLineItems[0].quantity).toBe(1);
    expect(result.creditAmount).toBe(0);
  });

  it("qty↓ + price↑ with net reduction → credit, no charge", () => {
    // 100 × $5 → 10 × $6: delta = $60 − $500 = −$440
    const snap = [li("item-4", 100, 5.0)];
    const cur = [li("item-4", 10, 6.0)];
    const result = computeUninvoicedDelta({
      currentLineItems: cur,
      currentFees: [],
      currentDiscounts: [],
      snapshotLineItems: snap,
      snapshotFees: [],
      snapshotDiscounts: [],
    });
    expect(result.deltaTotal).toBeLessThanOrEqual(0);
    expect(result.creditAmount).toBe(440);
    expect(result.deltaLineItems).toHaveLength(0);
  });

  it("price unchanged, qty↑ → still uses quantity delta × price (existing behavior)", () => {
    // 10 × $5 → 20 × $5: delta = 10 × $5 = $50
    const snap = [li("item-5", 10, 5.0)];
    const cur = [li("item-5", 20, 5.0)];
    const result = computeUninvoicedDelta({
      currentLineItems: cur,
      currentFees: [],
      currentDiscounts: [],
      snapshotLineItems: snap,
      snapshotFees: [],
      snapshotDiscounts: [],
    });
    expect(result.deltaTotal).toBe(50);
    expect(result.deltaLineItems).toHaveLength(1);
    expect(result.deltaLineItems[0].quantity).toBe(10);
    expect(result.deltaLineItems[0].unitPrice).toBe(5.0);
  });

  it("new item (not in snapshot) → fully charged at current qty × price", () => {
    const snap = [li("item-6", 10, 5.0)];
    const cur = [li("item-6", 10, 5.0), li("item-new", 3, 8.0)];
    const result = computeUninvoicedDelta({
      currentLineItems: cur,
      currentFees: [],
      currentDiscounts: [],
      snapshotLineItems: snap,
      snapshotFees: [],
      snapshotDiscounts: [],
    });
    expect(result.deltaTotal).toBe(24);
  });

  it("item fully removed → credit for full original value", () => {
    const snap = [li("item-7", 5, 10.0)];
    const cur: typeof snap = [];
    const result = computeUninvoicedDelta({
      currentLineItems: cur,
      currentFees: [],
      currentDiscounts: [],
      snapshotLineItems: snap,
      snapshotFees: [],
      snapshotDiscounts: [],
    });
    expect(result.creditAmount).toBe(50);
    expect(result.deltaLineItems).toHaveLength(0);
  });
});
