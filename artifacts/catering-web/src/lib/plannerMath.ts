// Shared planner math used by both the customer Plan/SharedPlan pages
// and the admin Menu Package editor's embedded planner. Computes the
// savory / sweet / entrée coverage so all three surfaces stay in sync.

export type PlannerGroup = "savory" | "sweet" | "entree" | "other";

export interface PlannerMathItem {
  id: number;            // plan-item id used as map key
  menuItem: {
    category: string;
    servingSize?: number | null;
    pricingTemplate?: string | null;
    size1Servings?: number | null; size2Servings?: number | null;
    size3Servings?: number | null; size4Servings?: number | null;
    size5Servings?: number | null;
  };
}

export interface PlannerMathInput {
  guests: number;
  savoryPPG: number;
  sweetPPG: number;
  servingsPPG: number;
  items: PlannerMathItem[];
  piecesMap: Record<number, number>;
  servingsMap: Record<number, number>;
  panQtys: Record<number, Record<number, number>>;
  groupOf: (category: string) => PlannerGroup;
}

export interface PlannerCoverage {
  needSavory: number;
  needSweet: number;
  needEntrees: number;
  haveSavory: number;
  haveSweet: number;
  haveEntrees: number;
}

function panServings(item: PlannerMathItem, panQtys: Record<number, Record<number, number>>) {
  const slots = panQtys[item.id] ?? {};
  const mi = item.menuItem as any;
  let total = 0;
  for (const [idxStr, qty] of Object.entries(slots)) {
    const spu = mi[`size${idxStr}Servings`] ?? mi.servingSize ?? 1;
    total += Number(qty) * spu;
  }
  return total;
}

function pieceServings(item: PlannerMathItem, piecesMap: Record<number, number>) {
  const q = Number(piecesMap[item.id]) || 0;
  return q * (item.menuItem.servingSize ?? 1);
}

function servingsForGroup(
  group: PlannerGroup,
  input: PlannerMathInput,
): number {
  const { items, piecesMap, servingsMap, panQtys, groupOf } = input;
  return items.filter(i => groupOf(i.menuItem.category) === group).reduce((sum, i) => {
    const isPan = (i.menuItem.pricingTemplate ?? null) === "pan_sizes";
    if (isPan) return sum + panServings(i, panQtys);
    if (group === "entree") {
      const q = Number(servingsMap[i.id]) || 0;
      return sum + q * (i.menuItem.servingSize ?? 1);
    }
    return sum + pieceServings(i, piecesMap);
  }, 0);
}

export function computePlannerCoverage(input: PlannerMathInput): PlannerCoverage {
  const { guests, savoryPPG, sweetPPG, servingsPPG } = input;
  return {
    needSavory: guests * savoryPPG,
    needSweet: guests * sweetPPG,
    needEntrees: guests * servingsPPG,
    haveSavory: servingsForGroup("savory", input),
    haveSweet: servingsForGroup("sweet", input),
    haveEntrees: servingsForGroup("entree", input),
  };
}
