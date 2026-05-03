/**
 * Label expansion: turn an order line item (with qty and label_policy) into
 * one or more item-label payloads. See lib/db schema/menu-items.ts for the
 * three policies:
 *   - per_unit  → 1 label per unit
 *   - combined  → 1 label total
 *   - per_box   → 1 label per labelBoxSize, with a leftover label for the
 *                 remainder (qty 14, box 6 → [6, 6, 2])
 *
 * Plate labels are NOT generated here — those come from the plate path in
 * the fan-out (1 plate-label per plate, regardless of contents). When
 * `suppressItemLabelsForPlateLines` is on for the printer, items that are
 * fully assigned to plates should be filtered out by the caller before
 * passing them in.
 */

export type LabelPolicy = "per_unit" | "combined" | "per_box";

export type LabelLineInput = {
  itemId: number;
  itemName: string;
  quantity: number;
  notes?: string | null;
  modifiers?: string[];
  labelPolicy: LabelPolicy;
  labelBoxSize?: number | null;
};

export type LabelPayload = {
  itemId: number;
  itemName: string;
  quantity: number;
  notes?: string | null;
  modifiers?: string[];
  // True if this label represents a full box at pack size (used by the
  // renderer to print a "BOX" tag).
  isFullBox?: boolean;
};

export function expandItemLabels(line: LabelLineInput): LabelPayload[] {
  if (line.quantity <= 0) return [];

  if (line.labelPolicy === "combined") {
    return [
      {
        itemId: line.itemId,
        itemName: line.itemName,
        quantity: line.quantity,
        notes: line.notes ?? null,
        modifiers: line.modifiers,
      },
    ];
  }

  if (line.labelPolicy === "per_box") {
    const box = Math.max(1, Math.floor(line.labelBoxSize ?? 1));
    if (box <= 1) {
      // Fall back to per_unit when no valid box size set.
      return Array.from({ length: line.quantity }, () => ({
        itemId: line.itemId,
        itemName: line.itemName,
        quantity: 1,
        notes: line.notes ?? null,
        modifiers: line.modifiers,
      }));
    }
    const labels: LabelPayload[] = [];
    let remaining = line.quantity;
    while (remaining > 0) {
      const take = Math.min(box, remaining);
      labels.push({
        itemId: line.itemId,
        itemName: line.itemName,
        quantity: take,
        notes: line.notes ?? null,
        modifiers: line.modifiers,
        isFullBox: take === box,
      });
      remaining -= take;
    }
    return labels;
  }

  // per_unit (default): one label per unit.
  return Array.from({ length: line.quantity }, () => ({
    itemId: line.itemId,
    itemName: line.itemName,
    quantity: 1,
    notes: line.notes ?? null,
    modifiers: line.modifiers,
  }));
}

export function expandAllItemLabels(lines: LabelLineInput[]): LabelPayload[] {
  return lines.flatMap((l) => expandItemLabels(l));
}
