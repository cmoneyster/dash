import { describe, expect, it } from "vitest";
import { calculateRevisionPlanner } from "../revisionPlanner";
import type { RevisionFields, RevisionPlan } from "../planRevisions";

const availableMenu: RevisionPlan["availableMenu"] = [
  { id: 1, name: "Savory bites", category: "Savory", plannerGroup: "savory", price: 4, pricingTemplate: "per_unit", servingSize: 3, sizes: [], minimumOrderQty: 1 },
  { id: 2, name: "Sweet bites", category: "Sweet", plannerGroup: "sweet", price: 4, pricingTemplate: "per_unit", servingSize: null, sizes: [], minimumOrderQty: 1 },
  { id: 3, name: "Entrée pan", category: "Entrées", plannerGroup: "entree", price: 50, pricingTemplate: "pan_sizes", servingSize: null, sizes: [
    { slot: 1, label: "Small", price: 50, servings: 8 },
    { slot: 2, label: "Large", price: 90, servings: 16 },
    { slot: 3, label: "Unspecified", price: 90, servings: null },
  ], minimumOrderQty: 1 },
];
const form: RevisionFields = {
  items: [
    { menuItemId: 1, quantity: 2, sizeSlot: null },
    { menuItemId: 2, quantity: 4, sizeSlot: null },
    { menuItemId: 3, quantity: 2, sizeSlot: 1 },
    { menuItemId: 3, quantity: 2, sizeSlot: 2 },
  ],
  guestCount: 10, eventDate: null, eventTime: null, venueAddress: null, menuNotes: null,
};
const plan: RevisionPlan = {
  version: "test", inquiry: { ...form, clientName: "Test", serviceMode: null },
  items: form.items, availableMenu, pending: false,
};
const targets = { savoryPPG: 3, sweetPPG: 2, servingsPPG: 4 };

describe("revision serving planner", () => {
  it("uses the revision guest count and adds each pan size separately", () => {
    const original = JSON.stringify(form);
    const first = calculateRevisionPlanner(form, plan, targets);
    expect(first.coverage).toEqual({
      needSavory: 30, needSweet: 20, needEntrees: 40,
      haveSavory: 6, haveSweet: 4, haveEntrees: 48,
    });
    expect(first.lines.map(line => line.contribution)).toEqual([6, 4, 16, 32]);
    expect(first.hasSmallBites).toBe(true);
    expect(first.hasEntrees).toBe(true);
    expect(first.assumedCount).toBe(1);

    const changed = { ...form, guestCount: 20, items: form.items.map((item, index) =>
      index === 2 ? { ...item, quantity: 3, sizeSlot: 2 } : item,
    ) };
    const next = calculateRevisionPlanner(changed, plan, { ...targets, servingsPPG: 5 });
    expect(next.coverage.needEntrees).toBe(100);
    expect(next.coverage.haveEntrees).toBe(80); // 3 large + 2 large pans
    expect(next.lines[2].contribution).toBe(48);
    expect(JSON.stringify(form)).toBe(original); // calculator never edits the proposal
  });

  it("does not claim coverage for unavailable or unknown-yield pans", () => {
    const changed: RevisionFields = { ...form, guestCount: null, items: [
      { menuItemId: 3, quantity: 1, sizeSlot: 3 },
      { menuItemId: 99, quantity: 5, sizeSlot: null, plannerGroup: "savory", available: false, servingSize: 10 },
      { menuItemId: 100, quantity: 5, sizeSlot: null, plannerGroup: "other", available: true },
    ] };
    const result = calculateRevisionPlanner(changed, plan, targets);
    expect(result.coverage.haveEntrees).toBe(0);
    expect(result.coverage.haveSavory).toBe(0);
    expect(result.coverage.needEntrees).toBe(0);
    expect(result.excludedCount).toBe(1);
    expect(result.lines[0].explanation).toMatch(/yield unavailable/);
    expect(result.lines[1].explanation).toMatch(/unavailable/);
    expect(result.lines[2].contribution).toBeNull();
  });

  it("uses the regular serving size if a configured pan size has no separate yield", () => {
    const withFallback: RevisionPlan = { ...plan, availableMenu: plan.availableMenu.map(item =>
      item.id === 3 ? { ...item, servingSize: 12 } : item,
    ) };
    const result = calculateRevisionPlanner(
      { ...form, items: [{ menuItemId: 3, quantity: 2, sizeSlot: 3 }] },
      withFallback,
      targets,
    );
    expect(result.coverage.haveEntrees).toBe(24);
    expect(result.excludedCount).toBe(0);
  });
});