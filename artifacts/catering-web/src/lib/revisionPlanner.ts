import { computePlannerCoverage, type PlannerCoverage, type PlannerGroup, type PlannerMathItem } from "./plannerMath";
import type { RevisionFields, RevisionPlan } from "./planRevisions";

export type RevisionPlannerTargets = { savoryPPG: number; sweetPPG: number; servingsPPG: number };
export type RevisionPlannerLine = {
  group: PlannerGroup;
  contribution: number | null;
  unit: "pcs" | "servings" | null;
  explanation: string | null;
};

export function calculateRevisionPlanner(
  form: RevisionFields,
  plan: RevisionPlan,
  targets: RevisionPlannerTargets,
): {
  coverage: PlannerCoverage;
  lines: RevisionPlannerLine[];
  hasSmallBites: boolean;
  hasEntrees: boolean;
  excludedCount: number;
  assumedCount: number;
} {
  const menuById = new Map(plan.availableMenu.map(item => [item.id, item]));
  const mathItems: PlannerMathItem[] = [];
  const piecesMap: Record<number, number> = {};
  const servingsMap: Record<number, number> = {};
  const panQtys: Record<number, Record<number, number>> = {};
  let excludedCount = 0;
  let assumedCount = 0;

  const lines = form.items.map((item, index): RevisionPlannerLine => {
    const catalog = menuById.get(item.menuItemId);
    const group = catalog?.plannerGroup ?? item.plannerGroup ?? "other";
    const unit = group === "savory" || group === "sweet" ? "pcs" : group === "entree" ? "servings" : null;
    if (!catalog && item.available !== true) {
      return { group, contribution: null, unit, explanation: "Item unavailable — not counted in planner" };
    }
    if (!unit) return { group, contribution: null, unit, explanation: null };

    const isPan = (catalog?.pricingTemplate ?? item.pricingTemplate) === "pan_sizes";
    const slot = item.sizeSlot ?? null;
    // For regular items, the original planner assumes one piece/serving when
    // no yield is configured. A whole pan must not silently become one serving.
    const yieldPerUnit = isPan
      ? catalog
        ? catalog.sizes.find(size => size.slot === slot)?.servings ?? catalog.servingSize
        : item.sizeServings ?? item.servingSize
      : catalog?.servingSize ?? item.servingSize ?? 1;
    if ((isPan && slot == null) || yieldPerUnit == null || !Number.isFinite(yieldPerUnit) || yieldPerUnit <= 0) {
      excludedCount++;
      return { group, contribution: null, unit, explanation: "Serving yield unavailable — not counted in planner" };
    }
    if (!isPan && catalog?.servingSize == null && item.servingSize == null) assumedCount++;

    const id = index + 1; // Every selected size gets a distinct calculator key.
    const quantity = Number.isFinite(item.quantity) ? Math.max(0, item.quantity) : 0;
    mathItems.push({ id, menuItem: {
      category: group,
      pricingTemplate: isPan ? "pan_sizes" : "per_unit",
      servingSize: yieldPerUnit,
    } });
    if (isPan) panQtys[id] = { [slot!]: quantity };
    else if (group === "entree") servingsMap[id] = quantity;
    else piecesMap[id] = quantity;
    return { group, contribution: quantity * yieldPerUnit, unit, explanation: null };
  });
  const coverage = computePlannerCoverage({
    guests: Number.isInteger(form.guestCount) && (form.guestCount ?? 0) > 0 ? form.guestCount! : 0,
    ...targets, items: mathItems, piecesMap, servingsMap, panQtys,
    groupOf: category => category as PlannerGroup,
  });
  return {
    coverage, lines, excludedCount, assumedCount,
    hasSmallBites: lines.some(line => line.group === "savory" || line.group === "sweet"),
    hasEntrees: lines.some(line => line.group === "entree"),
  };
}