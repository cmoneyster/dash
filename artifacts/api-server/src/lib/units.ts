export type UnitFamily = "weight" | "volume" | "count";

export type UnitDef = {
  symbol: string;
  label: string;
  family: UnitFamily;
  toBase: number;
};

export const UNITS: UnitDef[] = [
  { symbol: "g",      label: "Grams",        family: "weight", toBase: 1 },
  { symbol: "oz",     label: "Ounces",       family: "weight", toBase: 28.3495 },
  { symbol: "lb",     label: "Pounds",       family: "weight", toBase: 453.592 },
  { symbol: "kg",     label: "Kilograms",    family: "weight", toBase: 1000 },
  { symbol: "ml",     label: "Milliliters",  family: "volume", toBase: 1 },
  { symbol: "tsp",    label: "Teaspoons",    family: "volume", toBase: 4.92892 },
  { symbol: "tbsp",   label: "Tablespoons",  family: "volume", toBase: 14.7868 },
  { symbol: "fl_oz",  label: "Fluid Ounces", family: "volume", toBase: 29.5735 },
  { symbol: "cup",    label: "Cups",         family: "volume", toBase: 236.588 },
  { symbol: "pint",   label: "Pints",        family: "volume", toBase: 473.176 },
  { symbol: "quart",  label: "Quarts",       family: "volume", toBase: 946.353 },
  { symbol: "gallon", label: "Gallons",      family: "volume", toBase: 3785.41 },
  { symbol: "l",      label: "Liters",       family: "volume", toBase: 1000 },
  { symbol: "each",   label: "Each",         family: "count",  toBase: 1 },
  { symbol: "dozen",  label: "Dozen",        family: "count",  toBase: 12 },
];

export const UNIT_MAP = new Map(UNITS.map(u => [u.symbol, u]));

export function getUnitFamily(unit: string): UnitFamily | null {
  return UNIT_MAP.get(unit)?.family ?? null;
}

export function isCanonicalUnit(unit: string): boolean {
  return UNIT_MAP.has(unit);
}

export function conversionFactor(recipeUnit: string, ingredientUnit: string): number | null {
  if (recipeUnit === ingredientUnit) return 1;
  const ru = UNIT_MAP.get(recipeUnit);
  const iu = UNIT_MAP.get(ingredientUnit);
  if (!ru || !iu) return null;
  if (ru.family !== iu.family) return null;
  return ru.toBase / iu.toBase;
}

// Returns true when BOTH units are canonical but belong to different families
// (e.g. oz vs cup). This is a data-error state — conversion is not just
// unknown (legacy text), it is explicitly impossible. Returns false when
// either unit is unrecognized (legacy free-text), since those should fall
// back to 1:1 rather than be flagged as an error.
export function isIncompatibleConversion(recipeUnit: string, ingredientUnit: string): boolean {
  if (recipeUnit === ingredientUnit) return false;
  const ru = UNIT_MAP.get(recipeUnit);
  const iu = UNIT_MAP.get(ingredientUnit);
  if (!ru || !iu) return false; // unknown unit → legacy, not an error
  return ru.family !== iu.family;
}

export function groupedUnits() {
  const families = new Map<string, UnitDef[]>();
  for (const u of UNITS) {
    const arr = families.get(u.family) ?? [];
    arr.push(u);
    families.set(u.family, arr);
  }
  return Array.from(families.entries()).map(([family, units]) => ({ family, units }));
}
