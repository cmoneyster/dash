import { describe, it, expect } from "vitest";
import {
  computeEffectivePrice,
  computeEffectivePriceDetail,
} from "@workspace/pricing";

// Pure unit tests for the shared pricing helper. These lock the contract
// that both the server (string-typed Drizzle rows) and the React client
// (number-typed admin API responses) depend on. Together with the
// cart-order pricing contract test in this folder, this prevents the
// drift Tasks #97 and #102 were created to eliminate.

describe("computeEffectivePrice (shared helper)", () => {
  // The server passes Drizzle string columns through verbatim.
  it("string inputs: walks tier3 → tier2 → base by quantity", () => {
    const item = {
      price: "10.00",
      tier2Qty: 5,
      tier2Price: "8.00",
      tier3Qty: 10,
      tier3Price: "6.00",
    };
    expect(computeEffectivePrice(item, 1, null)).toBeCloseTo(10);
    expect(computeEffectivePrice(item, 4, null)).toBeCloseTo(10);
    expect(computeEffectivePrice(item, 5, null)).toBeCloseTo(8);
    expect(computeEffectivePrice(item, 9, null)).toBeCloseTo(8);
    expect(computeEffectivePrice(item, 10, null)).toBeCloseTo(6);
    expect(computeEffectivePrice(item, 99, null)).toBeCloseTo(6);
  });

  // The catering-web admin already coerces these to numbers in the API
  // response — accepting both shapes lets the same helper run on both
  // sides without forcing the client to re-stringify.
  it("number inputs: matches string inputs", () => {
    const stringItem = {
      price: "10.00",
      tier2Qty: 5,
      tier2Price: "8.00",
      tier3Qty: 10,
      tier3Price: "6.00",
    };
    const numberItem = {
      price: 10,
      tier2Qty: 5,
      tier2Price: 8,
      tier3Qty: 10,
      tier3Price: 6,
    };
    for (const qty of [1, 4, 5, 9, 10, 25]) {
      expect(computeEffectivePrice(numberItem, qty, null)).toBeCloseTo(
        computeEffectivePrice(stringItem, qty, null),
      );
    }
  });

  it("sizePrice always wins over base/tier prices", () => {
    const item = {
      price: "999.00", // intentionally wrong base
      tier2Qty: 1,
      tier2Price: "888.00",
      tier3Qty: 2,
      tier3Price: "777.00",
    };
    expect(computeEffectivePrice(item, 1, "75.00")).toBeCloseTo(75);
    expect(computeEffectivePrice(item, 50, 75)).toBeCloseTo(75);
    // sizePrice = 0 is a real (free) sized line, not "no size selected".
    expect(computeEffectivePrice(item, 1, 0)).toBeCloseTo(0);
  });

  it("missing tiers fall through to base", () => {
    const item = {
      price: "12.00",
      tier2Qty: null,
      tier2Price: null,
      tier3Qty: null,
      tier3Price: null,
    };
    expect(computeEffectivePrice(item, 1, null)).toBeCloseTo(12);
    expect(computeEffectivePrice(item, 100, null)).toBeCloseTo(12);
  });

  it("partially configured tiers are ignored without crashing", () => {
    // tier2Qty present but no price → ignore tier2.
    const item = {
      price: "10.00",
      tier2Qty: 5,
      tier2Price: null,
      tier3Qty: null,
      tier3Price: null,
    };
    expect(computeEffectivePrice(item, 10, null)).toBeCloseTo(10);
  });

  // Free-tier semantics: a tier price of 0 is a real "free above this qty"
  // configuration, not "no tier set". The shared helper distinguishes
  // null (unset) from 0 (set-to-free). This nails down the contract so a
  // future Number-truthy refactor can't silently regress tier3Price = 0
  // back to the base price.
  it("tier price of 0 means 'free above qty', not 'unset'", () => {
    const item = {
      price: "10.00",
      tier2Qty: 5,
      tier2Price: 0,
      tier3Qty: null,
      tier3Price: null,
    };
    expect(computeEffectivePrice(item, 4, null)).toBeCloseTo(10);
    expect(computeEffectivePrice(item, 5, null)).toBeCloseTo(0);
    expect(computeEffectivePriceDetail(item, 5, null).tier).toBe("tier2");
  });

  // Inverse: tier qty of 0 is treated as "no threshold" (falsy), so it
  // never applies. This matches the original server + admin behavior.
  it("tier qty of 0 is treated as unset", () => {
    const item = {
      price: "10.00",
      tier2Qty: 0,
      tier2Price: "5.00",
      tier3Qty: null,
      tier3Price: null,
    };
    expect(computeEffectivePrice(item, 1, null)).toBeCloseTo(10);
    expect(computeEffectivePrice(item, 100, null)).toBeCloseTo(10);
  });
});

describe("computeEffectivePriceDetail (shared helper)", () => {
  const item = {
    price: 10,
    tier2Qty: 5,
    tier2Price: 8,
    tier3Qty: 10,
    tier3Price: 6,
  };

  it("returns which rule decided the price", () => {
    expect(computeEffectivePriceDetail(item, 1, null).tier).toBe("base");
    expect(computeEffectivePriceDetail(item, 5, null).tier).toBe("tier2");
    expect(computeEffectivePriceDetail(item, 10, null).tier).toBe("tier3");
    expect(computeEffectivePriceDetail(item, 99, "42").tier).toBe("size");
  });

  it("returned price always equals computeEffectivePrice", () => {
    for (const qty of [1, 5, 10]) {
      const detail = computeEffectivePriceDetail(item, qty, null);
      expect(detail.price).toBeCloseTo(computeEffectivePrice(item, qty, null));
    }
  });
});
