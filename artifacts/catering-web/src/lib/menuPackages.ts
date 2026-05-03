// Client helpers for the pre-built menu packages feature: types,
// fetchers, and the load-into-planner / load-into-cart flows used by
// both the customer Menu page and the admin Edit page.

import { getAdminToken } from "@/components/AdminGuard";
import { sizeLabel as sizeLabelOf, sizePrice as sizePriceOf } from "@/lib/sizeSlotHelpers";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra, Authorization: `Bearer ${getAdminToken() ?? ""}` };
}

export const adminMenuPackagesApi = {
  list: async (): Promise<AdminMenuPackageSummary[]> => {
    const r = await fetch(`${API_BASE}/api/admin/menu-packages`, { headers: adminHeaders() });
    if (!r.ok) throw new Error("Failed to load packages");
    return r.json();
  },
  get: async (id: number): Promise<AdminMenuPackage> => {
    const r = await fetch(`${API_BASE}/api/admin/menu-packages/${id}`, { headers: adminHeaders() });
    if (!r.ok) throw new Error("Failed to load package");
    return r.json();
  },
  create: async (body: Record<string, unknown>): Promise<AdminMenuPackage> => {
    const r = await fetch(`${API_BASE}/api/admin/menu-packages`, {
      method: "POST",
      headers: adminHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e?.error ?? "Create failed");
    }
    return r.json();
  },
  update: async (id: number, body: Record<string, unknown>): Promise<AdminMenuPackage> => {
    const r = await fetch(`${API_BASE}/api/admin/menu-packages/${id}`, {
      method: "PUT",
      headers: adminHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e?.error ?? "Save failed");
    }
    return r.json();
  },
  remove: async (id: number): Promise<void> => {
    const r = await fetch(`${API_BASE}/api/admin/menu-packages/${id}`, {
      method: "DELETE",
      headers: adminHeaders(),
    });
    if (!r.ok) throw new Error("Delete failed");
  },
  reorder: async (ids: number[]): Promise<void> => {
    const r = await fetch(`${API_BASE}/api/admin/menu-packages/reorder`, {
      method: "POST",
      headers: adminHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ ids }),
    });
    if (!r.ok) throw new Error("Reorder failed");
  },
};

export type PackageSizeMenuItem = {
  id: number;
  name: string;
  category: string;
  description: string | null;
  price: number;
  imageUrl: string | null;
  allergens: string[];
  servingSize: number | null;
  unit: string | null;
  minimumOrderQty: number | null;
  pricingTemplate: string | null;
  available: boolean;
  otdEligible: boolean;
  size1Label: string | null; size1Price: string | null; size1Servings: number | null;
  size2Label: string | null; size2Price: string | null; size2Servings: number | null;
  size3Label: string | null; size3Price: string | null; size3Servings: number | null;
  size4Label: string | null; size4Price: string | null; size4Servings: number | null;
  size5Label: string | null; size5Price: string | null; size5Servings: number | null;
};

export type PublicPackageItem = {
  id: number;
  menuItemId: number;
  quantity: number;
  sizeKey: number | null;
  sortOrder: number;
  menuItem: PackageSizeMenuItem;
};

export type PublicMenuPackage = {
  id: number;
  name: string;
  description: string;
  imageUrl: string | null;
  servesGuests: number;
  sortOrder: number;
  partiallyAvailable: boolean;
  // True only when every available item in the package is on-the-dash
  // eligible (i.e. the food trailer can cook them on-site). Older API
  // builds may omit this — treat missing as false on the client.
  otdEligible?: boolean;
  items: PublicPackageItem[];
};

export type AdminMenuPackageSummary = Omit<PublicMenuPackage, "items"> & {
  hidden: boolean;
  itemCount: number;
  updatedAt?: string;
};

export type AdminMenuPackage = PublicMenuPackage & { hidden: boolean; updatedAt?: string };

const PLANNER_STORAGE_KEY = "dash_plan_planner_v1";

type StoredPlanner = {
  guests?: number;
  savoryPPG?: number;
  sweetPPG?: number;
  servingsPPG?: number;
  piecesMap?: Record<string, number>;
  servingsMap?: Record<string, number>;
  panQtys?: Record<string, Record<string, number>>;
  serviceMode?: string;
};

function readPlannerStorage(): StoredPlanner {
  try {
    const raw = localStorage.getItem(PLANNER_STORAGE_KEY);
    return raw ? JSON.parse(raw) as StoredPlanner : {};
  } catch { return {}; }
}

function writePlannerStorage(s: StoredPlanner) {
  try { localStorage.setItem(PLANNER_STORAGE_KEY, JSON.stringify(s)); } catch {}
}

export async function fetchPublicPackages(): Promise<PublicMenuPackage[]> {
  const res = await fetch(`${API_BASE}/api/menu-packages`);
  if (!res.ok) throw new Error("Failed to load packages");
  return res.json();
}

export async function fetchPublicPackage(id: number): Promise<PublicMenuPackage> {
  const res = await fetch(`${API_BASE}/api/menu-packages/${id}`);
  if (!res.ok) throw new Error("Failed to load package");
  return res.json();
}

export type LoadMode = "merge" | "replace";

// ── Cart loading ─────────────────────────────────────────────────────────

export async function loadPackageIntoCart(
  pkg: PublicMenuPackage,
  sessionId: string,
  mode: LoadMode,
): Promise<{ added: number }> {
  if (mode === "replace") {
    await fetch(`${API_BASE}/api/cart`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
  }

  let added = 0;
  for (const it of pkg.items) {
    const isPan = it.menuItem.pricingTemplate === "pan_sizes";
    const body: Record<string, unknown> = {
      sessionId,
      menuItemId: it.menuItemId,
      quantity: it.quantity,
    };
    if (isPan && it.sizeKey != null && it.sizeKey >= 1 && it.sizeKey <= 5) {
      const slot = it.sizeKey as 1 | 2 | 3 | 4 | 5;
      const lbl = sizeLabelOf(it.menuItem, slot);
      const prc = sizePriceOf(it.menuItem, slot);
      body.sizeSlot = slot;
      if (lbl) body.sizeLabel = lbl;
      if (prc != null) body.sizePrice = prc;
    }
    const res = await fetch(`${API_BASE}/api/cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) added += 1;
  }
  return { added };
}

// ── Planner loading ──────────────────────────────────────────────────────

type PlanItemRow = { id: number; menuItemId: number };

// Fetches the current plan/cart item counts. Used by load actions to
// decide whether to prompt merge-or-replace, since react-query data
// may still be `undefined` on first click.
export async function fetchCurrentItemCount(target: "cart" | "plan", sessionId: string): Promise<number> {
  try {
    const url = target === "cart"
      ? `${API_BASE}/api/cart?sessionId=${encodeURIComponent(sessionId)}`
      : `${API_BASE}/api/plan?sessionId=${encodeURIComponent(sessionId)}`;
    const res = await fetch(url);
    if (!res.ok) return 0;
    const data: unknown = await res.json();
    if (data && typeof data === "object" && "items" in data) {
      const items = (data as { items: unknown }).items;
      if (Array.isArray(items)) return items.length;
    }
    return 0;
  } catch {
    return 0;
  }
}

async function fetchPlanItems(sessionId: string): Promise<PlanItemRow[]> {
  const res = await fetch(`${API_BASE}/api/plan?sessionId=${encodeURIComponent(sessionId)}`);
  if (!res.ok) return [];
  const data: unknown = await res.json();
  const items = (data && typeof data === "object" && "items" in data) ? (data as { items: unknown }).items : null;
  if (!Array.isArray(items)) return [];
  const rows: PlanItemRow[] = [];
  for (const i of items) {
    if (i && typeof i === "object") {
      const rec = i as Record<string, unknown>;
      const id = Number(rec.id);
      const menuItemId = Number(rec.menuItemId);
      if (Number.isFinite(id) && Number.isFinite(menuItemId)) rows.push({ id, menuItemId });
    }
  }
  return rows;
}

export type PlannerGroupResolver = (category: string) => "savory" | "sweet" | "entree" | "other";

// Given a fresh plan + the package items + a category-group resolver,
// merges the package's quantities & pan slot picks into the localStorage
// planner state so the Plan page renders the right counts when the
// customer arrives.
export async function loadPackageIntoPlanner(
  pkg: PublicMenuPackage,
  sessionId: string,
  mode: LoadMode,
  groupOf: PlannerGroupResolver,
): Promise<{ added: number }> {
  if (mode === "replace") {
    await fetch(`${API_BASE}/api/plan`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    // Wipe the saved counts/slot picks for the cleared items.
    const cur = readPlannerStorage();
    writePlannerStorage({
      guests: cur.guests,
      savoryPPG: cur.savoryPPG,
      sweetPPG: cur.sweetPPG,
      servingsPPG: cur.servingsPPG,
      piecesMap: {},
      servingsMap: {},
      panQtys: {},
      serviceMode: cur.serviceMode,
    });
  }

  let added = 0;
  for (const it of pkg.items) {
    const res = await fetch(`${API_BASE}/api/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, menuItemId: it.menuItemId }),
    });
    if (res.ok) added += 1;
  }

  // Refetch plan to learn the new plan_item ids, then seed the storage maps.
  const planItems = await fetchPlanItems(sessionId);
  const stored = readPlannerStorage();
  const piecesMap = { ...(stored.piecesMap ?? {}) };
  const servingsMap = { ...(stored.servingsMap ?? {}) };
  const panQtys: Record<string, Record<string, number>> = { ...(stored.panQtys ?? {}) };

  for (const pi of pkg.items) {
    const planItem = planItems.find(p => p.menuItemId === pi.menuItemId);
    if (!planItem) continue;
    const key = String(planItem.id);
    const isPan = pi.menuItem.pricingTemplate === "pan_sizes";
    if (isPan && pi.sizeKey != null) {
      const slots = { ...(panQtys[key] ?? {}) };
      const sk = String(pi.sizeKey);
      // Merge: sum into existing slot. Replace mode already cleared.
      slots[sk] = (Number(slots[sk]) || 0) + pi.quantity;
      panQtys[key] = slots;
    } else {
      const grp = groupOf(pi.menuItem.category);
      if (grp === "entree") {
        servingsMap[key] = (Number(servingsMap[key]) || 0) + pi.quantity;
      } else if (grp === "savory" || grp === "sweet") {
        piecesMap[key] = (Number(piecesMap[key]) || 0) + pi.quantity;
      }
    }
  }

  writePlannerStorage({
    ...stored,
    piecesMap,
    servingsMap,
    panQtys,
  });
  return { added };
}
