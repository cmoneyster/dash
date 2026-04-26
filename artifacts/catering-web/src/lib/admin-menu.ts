import { getAdminToken } from "@/components/AdminGuard";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export async function adminReorderMenuItems(items: Array<{ id: number; sortOrder: number }>) {
  const res = await fetch(`${BASE}/api/admin/menu/reorder`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getAdminToken()}`,
    },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) throw new Error("Failed to reorder menu items");
}
