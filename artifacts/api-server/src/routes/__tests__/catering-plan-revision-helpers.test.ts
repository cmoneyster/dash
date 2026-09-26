import { describe, expect, it } from "vitest";
import {
  isValidEventDate,
  isValidGuestCount,
  isValidRevisionQuantity,
  isPublicMenuCategory,
  mergePlanLineItems,
  planSelectionKey,
  choosePlanLink,
  effectivePricesMatch,
  publicMenuItems,
  sameRevisionBaseSnapshot,
} from "../../lib/catering-plan-revision-helpers";

describe("catering plan revision helpers", () => {
  it("validates real YYYY-MM-DD calendar dates", () => {
    expect(isValidEventDate(null)).toBe(true);
    expect(isValidEventDate("2024-02-29")).toBe(true);
    expect(isValidEventDate("2023-02-29")).toBe(false);
    expect(isValidEventDate("2024-2-09")).toBe(false);
    expect(isValidEventDate("2024-04-31")).toBe(false);
  });

  it("bounds guest counts and requested item quantities", () => {
    expect(isValidGuestCount(null)).toBe(true);
    expect(isValidGuestCount(100_000)).toBe(true);
    expect(isValidGuestCount(100_001)).toBe(false);
    expect(isValidGuestCount(0)).toBe(false);
    expect(isValidRevisionQuantity(1)).toBe(true);
    expect(isValidRevisionQuantity(10_000)).toBe(true);
    expect(isValidRevisionQuantity(10_001)).toBe(false);
    expect(isValidRevisionQuantity(1.5)).toBe(false);
  });

  it("keys menu variants by item and size slot", () => {
    expect(planSelectionKey(8, 1)).not.toBe(planSelectionKey(8, 2));
    expect(planSelectionKey(8, null)).toBe(planSelectionKey(8, null));
  });

  it("uses public menu hidden-category rules", () => {
    const categories = [{ name: "Hidden", visible: false }, { name: "Visible", visible: true }];
    const items = [{ category: "Hidden", id: 1 }, { category: "Visible", id: 2 }, { category: "Unlisted", id: 3 }];
    expect(publicMenuItems(items, categories).map((item) => item.id)).toEqual([2, 3]);
    expect(isPublicMenuCategory("Hidden", categories)).toBe(false);
    expect(isPublicMenuCategory("Unlisted", categories)).toBe(true);
  });

  it("reuses an active token for sends and only creates one when necessary", () => {
    const now = new Date("2026-06-02T00:00:00Z");
    const existing = {
      token: "working-token",
      expiresAt: new Date("2026-07-02T00:00:00Z"),
      revokedAt: null,
    };
    expect(choosePlanLink("email", existing, "new", new Date("2026-07-02T00:00:00Z"), now))
      .toEqual({ token: "working-token", expiresAt: existing.expiresAt, created: false });
    expect(choosePlanLink("sms", existing, "new", new Date("2026-07-02T00:00:00Z"), now))
      .toMatchObject({ token: "working-token", created: false });
    expect(choosePlanLink("copy", existing, "new", new Date("2026-07-02T00:00:00Z"), now))
      .toMatchObject({ token: "new", created: true });
    expect(choosePlanLink("email", { ...existing, expiresAt: now }, "new", new Date("2026-07-02T00:00:00Z"), now))
      .toMatchObject({ token: "new", created: true });
  });

  it("detects effective catalog price changes at cent precision", () => {
    expect(effectivePricesMatch(12.341, 12.344)).toBe(true);
    expect(effectivePricesMatch(12.34, 12.35)).toBe(false);
    expect(effectivePricesMatch(12, null)).toBe(false);
  });

  it("detects staff quote snapshot edits including pricing mode and notes", () => {
    const base = {
      lineItems: [{ menuItemId: 3, unitPrice: 20, priceMode: "auto", notes: "prep" }],
      fees: [{ id: "delivery", amount: 5 }],
    };
    expect(sameRevisionBaseSnapshot(base, { fees: base.fees, lineItems: base.lineItems })).toBe(true);
    expect(sameRevisionBaseSnapshot(base, {
      ...base,
      lineItems: [{ ...base.lineItems[0], unitPrice: 21 }],
    })).toBe(false);
    expect(sameRevisionBaseSnapshot(base, {
      ...base,
      lineItems: [{ ...base.lineItems[0], priceMode: "manual" }],
    })).toBe(false);
    expect(sameRevisionBaseSnapshot(base, {
      ...base,
      lineItems: [{ ...base.lineItems[0], notes: "no nuts" }],
    })).toBe(false);
  });

  it("replaces each menu variant while preserving custom-line positions", () => {
    type Line = { menuItemId: number | null; sizeSlot?: number | null; name: string };
    const current: Line[] = [
      { menuItemId: 12, sizeSlot: 1, name: "small" },
      { menuItemId: null, name: "staff custom" },
      { menuItemId: 12, sizeSlot: 2, name: "medium" },
    ];
    const proposed: Line[] = [
      { menuItemId: 12, sizeSlot: 1, name: "updated small" },
      { menuItemId: 12, sizeSlot: 3, name: "new large" },
    ];
    expect(mergePlanLineItems(current, proposed)).toEqual([
      proposed[0],
      current[1],
      proposed[1],
    ]);
  });
});