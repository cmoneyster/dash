import { useQuery } from "@tanstack/react-query";
import { getAdminToken } from "@/components/AdminGuard";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export interface RecommendedItem {
  menuItemId: number;
  name: string;
  category: string;
  available: boolean;
  sortOrder: number;
  source: "manual" | "sync" | string;
}

export interface TopSeller {
  menuItemId: number;
  name: string;
  category: string;
  totalQuantity: number;
  isCurrentlyRecommended: boolean;
}

export const RECOMMENDATIONS_QUERY_KEY = ["admin", "recommendations"] as const;

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${getAdminToken()}` };
}

export function useAdminRecommendations() {
  return useQuery<RecommendedItem[]>({
    queryKey: RECOMMENDATIONS_QUERY_KEY,
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/admin/recommendations`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to load recommendations");
      return res.json();
    },
  });
}

export async function adminAddRecommendation(menuItemId: number): Promise<RecommendedItem[]> {
  const res = await fetch(`${BASE}/api/admin/recommendations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ menuItemId }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? "Failed to add item");
  }
  return res.json();
}

export async function adminRemoveRecommendation(menuItemId: number): Promise<void> {
  const res = await fetch(`${BASE}/api/admin/recommendations/${menuItemId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok && res.status !== 204) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? "Failed to remove item");
  }
}

export async function adminReorderRecommendations(
  menuItemIds: number[],
): Promise<RecommendedItem[]> {
  const res = await fetch(`${BASE}/api/admin/recommendations/reorder`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ menuItemIds }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? "Failed to reorder");
  }
  return res.json();
}

export async function adminFetchTopSellers(limit: number): Promise<TopSeller[]> {
  const res = await fetch(
    `${BASE}/api/admin/recommendations/top-sellers?limit=${encodeURIComponent(String(limit))}`,
    { headers: authHeaders() },
  );
  if (!res.ok) throw new Error("Failed to load top sellers");
  return res.json();
}

export async function adminSyncRecommendations(
  mode: "merge" | "replace",
  limit: number,
): Promise<{ mode: string; applied: number; list: RecommendedItem[] }> {
  const res = await fetch(`${BASE}/api/admin/recommendations/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ mode, limit }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? "Failed to sync");
  }
  return res.json();
}
