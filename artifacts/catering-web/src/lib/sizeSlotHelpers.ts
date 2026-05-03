// Typed accessors for the size1..size5 fields on a menu item, replacing
// the `(mi as any)[`size${k}Label`]` pattern with strongly-typed helpers.

import type { PackageSizeMenuItem } from "@/lib/menuPackages";

export type SizeSlot = 1 | 2 | 3 | 4 | 5;

// MenuItem rows from /api/admin/menu-items carry the same pan-size
// columns at runtime even though the generated MenuItem type omits
// them. Use this when feeding raw rows into sizeLabel/sizePrice/etc.
export type MenuItemWithSizes = PackageSizeMenuItem;

const labelKeys = ["size1Label", "size2Label", "size3Label", "size4Label", "size5Label"] as const;
const priceKeys = ["size1Price", "size2Price", "size3Price", "size4Price", "size5Price"] as const;
const servingsKeys = ["size1Servings", "size2Servings", "size3Servings", "size4Servings", "size5Servings"] as const;

export function sizeLabel(mi: PackageSizeMenuItem, slot: SizeSlot): string | null {
  return mi[labelKeys[slot - 1]];
}

export function sizePrice(mi: PackageSizeMenuItem, slot: SizeSlot): number | null {
  const v = mi[priceKeys[slot - 1]];
  if (v == null) return null;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

export function sizeServings(mi: PackageSizeMenuItem, slot: SizeSlot): number | null {
  return mi[servingsKeys[slot - 1]];
}

export function firstAvailableSizeSlot(mi: PackageSizeMenuItem): SizeSlot | null {
  for (const slot of [1, 2, 3, 4, 5] as const) {
    if (sizeLabel(mi, slot) != null) return slot;
  }
  return null;
}
