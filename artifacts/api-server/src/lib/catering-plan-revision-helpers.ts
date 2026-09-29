export const MAX_REVISION_ITEM_QUANTITY = 10_000;
export const MAX_REVISION_GUEST_COUNT = 100_000;

export function isValidRevisionQuantity(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= MAX_REVISION_ITEM_QUANTITY;
}

export function isValidGuestCount(value: unknown): value is number | null {
  return value === null || (Number.isInteger(value) && Number(value) >= 1 && Number(value) <= MAX_REVISION_GUEST_COUNT);
}

export function isValidEventDate(value: string | null): boolean {
  if (value === null) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function planSelectionKey(menuItemId: number, sizeSlot: number | null): string {
  return `${menuItemId}:${sizeSlot ?? "unit"}`;
}

export function publicMenuItems<T extends { category: string }>(
  items: T[],
  categories: Array<{ name: string; visible: boolean }>,
): T[] {
  const hidden = new Set(categories.filter((category) => !category.visible).map((category) => category.name));
  return items.filter((item) => !hidden.has(item.category));
}

export function isPublicMenuCategory(
  name: string,
  categories: Array<{ name: string; visible: boolean }>,
): boolean {
  return !categories.some((category) => category.name === name && !category.visible);
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sameRevisionBaseSnapshot(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

export function effectivePricesMatch(left: number | null | undefined, right: number | null | undefined): boolean {
  return left != null && right != null && Number.isFinite(left) && Number.isFinite(right)
    && Math.round(left * 100) === Math.round(right * 100);
}

export function choosePlanLink(
  channel: "copy" | "email" | "sms",
  existing: { token: string; expiresAt: Date; revokedAt: Date | null } | undefined,
  newToken: string,
  newExpiresAt: Date,
  now: Date,
): { token: string; expiresAt: Date; created: boolean } {
  const reuse = channel !== "copy" && existing != null &&
    existing.revokedAt == null && existing.expiresAt > now;
  return reuse
    ? { token: existing.token, expiresAt: existing.expiresAt, created: false }
    : { token: newToken, expiresAt: newExpiresAt, created: true };
}

export function mergePlanLineItems<T extends { menuItemId: number | null; sizeSlot?: number | null }>(
  current: T[],
  proposed: T[],
): T[] {
  const replacements = new Map(proposed.map((line) => [
    planSelectionKey(Number(line.menuItemId), line.sizeSlot ?? null),
    line,
  ]));
  const merged: T[] = [];
  const emitted = new Set<string>();
  for (const line of current) {
    if (line.menuItemId == null) {
      merged.push(line);
      continue;
    }
    const key = planSelectionKey(Number(line.menuItemId), line.sizeSlot ?? null);
    const replacement = replacements.get(key);
    if (replacement && !emitted.has(key)) {
      merged.push(replacement);
      emitted.add(key);
    }
  }
  for (const line of proposed) {
    const key = planSelectionKey(Number(line.menuItemId), line.sizeSlot ?? null);
    if (!emitted.has(key)) {
      merged.push(line);
      emitted.add(key);
    }
  }
  return merged;
}