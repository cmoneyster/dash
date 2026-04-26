import { useQuery } from "@tanstack/react-query";
import { getAdminToken } from "@/components/AdminGuard";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export type PlannerGroup = "savory" | "sweet" | "entree" | "other";

export interface Category {
  id: number;
  name: string;
  sortOrder: number;
  visible: boolean;
  plannerGroup: PlannerGroup;
}

export interface AdminCategory extends Category {
  itemCount: number;
}

export const CATEGORIES_QUERY_KEY = ["categories"] as const;
export const ADMIN_CATEGORIES_QUERY_KEY = ["admin", "categories"] as const;

export function useCategories(opts: { includeHidden?: boolean } = {}) {
  const { includeHidden = false } = opts;
  return useQuery<Category[]>({
    queryKey: includeHidden ? [...CATEGORIES_QUERY_KEY, "all"] : CATEGORIES_QUERY_KEY,
    queryFn: async () => {
      const url = includeHidden
        ? `${BASE}/api/categories?includeHidden=true`
        : `${BASE}/api/categories`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to load categories");
      return res.json();
    },
  });
}

// ── Display helpers ──────────────────────────────────────────────────────────
// The category naming convention is "Parent - Child" (e.g.
// "Entrées - Vegetables"). The cart and planner pages render the parent as a
// big bold heading with the child as a smaller subtitle next to it. Splitting
// on " - " keeps that display contract working for any category an admin adds
// in the Category Manager — no source edits required.

export function splitCategoryName(name: string): { label: string; sub?: string } {
  const idx = name.indexOf(" - ");
  if (idx === -1) return { label: name };
  return { label: name.slice(0, idx), sub: name.slice(idx + 3) };
}

// Build a fast lookup from category name → plannerGroup. Used by the planner
// page to decide whether an item is a savory bite, sweet bite, entrée, or
// other — without hardcoding any specific category names.
export function buildPlannerGroupMap(
  categories: Category[] | undefined,
): Map<string, PlannerGroup> {
  const m = new Map<string, PlannerGroup>();
  for (const c of categories ?? []) m.set(c.name, c.plannerGroup);
  return m;
}

export function useAdminCategories() {
  return useQuery<AdminCategory[]>({
    queryKey: ADMIN_CATEGORIES_QUERY_KEY,
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/admin/categories`, {
        headers: { Authorization: `Bearer ${getAdminToken()}` },
      });
      if (!res.ok) throw new Error("Failed to load categories");
      return res.json();
    },
  });
}

export async function adminCreateCategory(body: { name: string; plannerGroup?: PlannerGroup; visible?: boolean }) {
  const res = await fetch(`${BASE}/api/admin/categories`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getAdminToken()}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? "Failed to create category");
  }
  return res.json() as Promise<AdminCategory>;
}

export async function adminUpdateCategory(
  id: number,
  body: Partial<{ name: string; plannerGroup: PlannerGroup; visible: boolean; sortOrder: number }>,
) {
  const res = await fetch(`${BASE}/api/admin/categories/${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getAdminToken()}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? "Failed to update category");
  }
  return res.json() as Promise<AdminCategory>;
}

export async function adminDeleteCategory(id: number) {
  const res = await fetch(`${BASE}/api/admin/categories/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${getAdminToken()}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? "Failed to delete category");
  }
}

export async function adminReorderCategories(items: Array<{ id: number; sortOrder: number }>) {
  const res = await fetch(`${BASE}/api/admin/categories/reorder`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getAdminToken()}`,
    },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) throw new Error("Failed to reorder categories");
}
