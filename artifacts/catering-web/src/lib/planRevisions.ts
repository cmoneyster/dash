import { getAdminToken } from "@/components/AdminGuard";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
export type RevisionItem = { menuItemId: number; name?: string; quantity: number; sizeSlot?: number | null; sizeLabel?: string | null; unitPrice?: number | string; pricingTemplate?: string };
export type RevisionFields = { items: RevisionItem[]; eventDate: string | null; eventTime: string | null; guestCount: number | null; venueAddress: string | null; menuNotes: string | null };
export type AvailableMenuItem = { id: number; name: string; category: string; price: number | string; pricingTemplate: string; sizes: { slot: number; label: string; price: number | string }[]; minimumOrderQty: number | null };
export type RevisionPlan = { version: string; inquiry: Omit<RevisionFields, "items"> & { clientName: string; serviceMode: string | null }; items: RevisionItem[]; availableMenu: AvailableMenuItem[]; pending: boolean };
export type PlanRevision = { id: number | string; createdAt: string; status: string; note: string | null; base: RevisionFields; proposed: RevisionFields; reviewedAt?: string | null };
export type RevisionHistory = { link: { url: string; expiresAt: string } | null; revisions: PlanRevision[] };

export class PlanApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try { res = await fetch(`${BASE}${url}`, init); }
  catch { throw new PlanApiError(0, "Couldn't connect. Check your connection and try again."); }
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string; message?: string };
    throw new PlanApiError(res.status, data.error || data.message || (res.status === 409 ? "This plan changed while you were editing." : "Something went wrong. Please try again."));
  }
  return res.json() as Promise<T>;
}
const adminHeaders = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${getAdminToken()}` });
const adminPath = (id: number) => `/api/admin/catering/${id}`;
export const getRevisionPlan = (token: string) => request<RevisionPlan>(`/api/plan/revise/${encodeURIComponent(token)}`);
export const submitRevision = (token: string, body: RevisionFields & { version: string; submissionId: string; note: string }) =>
  request<{ revisionId: number | string; status: "pending" }>(`/api/plan/revise/${encodeURIComponent(token)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
export const getRevisionHistory = (id: number) => request<RevisionHistory>(`${adminPath(id)}/plan-revisions`, { headers: adminHeaders() });
export const createRevisionLink = (id: number, channel: "copy" | "email" | "sms") =>
  request<{ url: string; expiresAt: string }>(`${adminPath(id)}/plan-link`, { method: "POST", headers: adminHeaders(), body: JSON.stringify({ channel }) });
export const revokeRevisionLink = (id: number) =>
  request<{ ok: true }>(`${adminPath(id)}/plan-link`, { method: "DELETE", headers: adminHeaders() });
export const reviewRevision = (id: number, revisionId: number | string, action: "apply" | "decline") =>
  request<{ ok: true }>(`${adminPath(id)}/plan-revisions/${encodeURIComponent(String(revisionId))}/review`, {
    method: "POST", headers: adminHeaders(), body: JSON.stringify({ action }),
  });

export function readablePlanError(err: unknown): string {
  if (err instanceof PlanApiError) {
    if (err.status === 404 || err.status === 410) return "This link has expired or is no longer available. Please ask the catering team for a new link.";
    if (err.status === 403 || err.status === 423) return "This plan is closed to changes. Please contact the catering team directly.";
    return err.message;
  }
  return "Something went wrong. Please try again.";
}