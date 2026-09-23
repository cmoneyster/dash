import { useEffect, useMemo, useRef, useState } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import { getAdminToken } from "@/components/AdminGuard";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Ban,
  ExternalLink,
  RefreshCw,
  Save,
  Plus,
  Trash2,
  Play,
  AlertTriangle,
  Image as ImageIcon,
  Link2,
  Copy,
  BookOpen,
} from "lucide-react";

const BASE = "/api";

type Candidate = {
  id: number;
  instagramPostId: string;
  hashtag: string;
  caption: string;
  permalink: string;
  mediaType: string;
  thumbnailUrl: string | null;
  postedAt: string | null;
  status: "pending" | "approved" | "denied" | "blacklisted";
  autoRule: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  approvedAt: string | null;
  isUnavailable: boolean;
  source: string;
  createdAt: string;
};

type CandidatesResponse = {
  candidates: Candidate[];
  counts: { pending: number; approved: number; denied: number; blacklisted: number };
};

type StatusResponse = {
  configured: boolean;
  instagramHandle: string;
  instagramHashtags: string[];
  instagramWallEnabled: boolean;
  instagramWallMaxItems: number;
  instagramWallShowOnHome: boolean;
  instagramWallShowOnGallery: boolean;
  instagramAutoApproveMention: boolean;
  instagramAutoDenyOlderThanDays: number | null;
  lastPolledAt: string | null;
  pulledLast24h: number;
  pendingCount: number;
  webhookAppSecretConfigured: boolean;
  webhookVerifyTokenConfigured: boolean;
};

type PollerSummary = {
  ranAt: string;
  hashtags: string[];
  apiCalls: number;
  inserted: number;
  skipped: number;
  errors: Array<{ hashtag: string; kind: string; message: string }>;
  notConfigured?: boolean;
};

type TabKey = "pending" | "approved" | "denied" | "all";
const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "denied", label: "Denied" },
  { key: "all", label: "All" },
];

function authHeaders(): Record<string, string> {
  const t = getAdminToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { ...authHeaders() } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `Request failed: ${r.status}`);
  return r.json() as Promise<T>;
}

async function postJson<T>(url: string, body: any): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `Request failed: ${r.status}`);
  return r.json() as Promise<T>;
}

async function putJson<T>(url: string, body: any): Promise<T> {
  const r = await fetch(url, {
    method: "PUT",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `Request failed: ${r.status}`);
  return r.json() as Promise<T>;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diffSec = Math.round((Date.now() - d.getTime()) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 30 * 86400) return `${Math.floor(diffSec / 86400)}d ago`;
  return d.toLocaleDateString();
}

export default function HashtagWallModeration() {
  const { toast } = useToast();
  const [tab, setTab] = useState<TabKey>("pending");
  const [candidatesData, setCandidatesData] = useState<CandidatesResponse | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [pollerBusy, setPollerBusy] = useState(false);
  const [lastPoller, setLastPoller] = useState<PollerSummary | null>(null);

  // Sidebar form state — derived from `status` once loaded but managed separately
  // so the admin can edit before saving.
  const [handleDraft, setHandleDraft] = useState("");
  const [hashtagsDraft, setHashtagsDraft] = useState<string[]>([]);
  const [newTag, setNewTag] = useState("");
  const [wallEnabled, setWallEnabled] = useState(false);
  const [maxItems, setMaxItems] = useState(12);
  const [showOnHome, setShowOnHome] = useState(false);
  const [showOnGallery, setShowOnGallery] = useState(false);
  const [autoApproveMention, setAutoApproveMention] = useState(false);
  const [autoDenyOlderDays, setAutoDenyOlderDays] = useState<string>("90");
  const [savingSettings, setSavingSettings] = useState(false);
  const visitMarked = useRef(false);

  async function refreshAll(initial = false) {
    if (initial) setLoading(true);
    try {
      const [s, c] = await Promise.all([
        getJson<StatusResponse>(`${BASE}/admin/instagram/status`),
        getJson<CandidatesResponse>(`${BASE}/admin/instagram/candidates?status=${tab}&limit=120`),
      ]);
      setStatus(s);
      setCandidatesData(c);
      if (initial) {
        setHandleDraft(s.instagramHandle);
        setHashtagsDraft(s.instagramHashtags);
        setWallEnabled(s.instagramWallEnabled);
        setMaxItems(s.instagramWallMaxItems);
        setShowOnHome(s.instagramWallShowOnHome);
        setShowOnGallery(s.instagramWallShowOnGallery);
        setAutoApproveMention(s.instagramAutoApproveMention);
        setAutoDenyOlderDays(s.instagramAutoDenyOlderThanDays != null ? String(s.instagramAutoDenyOlderThanDays) : "");
      }
    } catch (err: any) {
      toast({ title: "Couldn't load Instagram queue", description: err.message, variant: "destructive" });
    } finally {
      if (initial) setLoading(false);
    }
  }

  // Initial load + tab change
  useEffect(() => {
    refreshAll(candidatesData == null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Mark the page visited once after load (clears the sidebar nav badge).
  useEffect(() => {
    if (!visitMarked.current && status) {
      visitMarked.current = true;
      postJson(`${BASE}/admin/instagram/visit`, {}).catch(() => {});
    }
  }, [status]);

  const items = candidatesData?.candidates ?? [];
  const allCheckedOnPage = items.length > 0 && items.every((i) => selectedIds.has(i.id));
  const handle = status?.instagramHandle ?? "";

  function toggleSelect(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (allCheckedOnPage) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        items.forEach((i) => next.delete(i.id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        items.forEach((i) => next.add(i.id));
        return next;
      });
    }
  }

  async function decide(id: number, action: "approve" | "deny" | "blacklist") {
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      await postJson(`${BASE}/admin/instagram/candidates/${id}/decision`, { action });
      // optimistic: bump it from the visible list when we're not on "all"
      setCandidatesData((prev) => prev && {
        ...prev,
        candidates: prev.candidates.filter((c) => tab === "all" ? true : c.id !== id),
      });
      // refresh in the background so the counts update
      refreshAll().catch(() => {});
    } catch (err: any) {
      toast({ title: "Decision failed", description: err.message, variant: "destructive" });
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function bulkDecide(action: "approve" | "deny" | "blacklist") {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    try {
      const res = await postJson<{ updatedCount: number }>(`${BASE}/admin/instagram/candidates/bulk-decision`, { ids, action });
      toast({ title: `Updated ${res.updatedCount} post${res.updatedCount === 1 ? "" : "s"}` });
      setSelectedIds(new Set());
      refreshAll().catch(() => {});
    } catch (err: any) {
      toast({ title: "Bulk update failed", description: err.message, variant: "destructive" });
    }
  }

  async function runPoller() {
    setPollerBusy(true);
    try {
      const res = await postJson<{ summary: PollerSummary; configured: boolean }>(`${BASE}/admin/instagram/poller/run-now`, {});
      setLastPoller(res.summary);
      const insertedTotal = res.summary.inserted;
      if (!res.configured || res.summary.notConfigured) {
        toast({
          title: "Instagram not configured",
          description: "Set INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_USER_ID to enable polling.",
          variant: "destructive",
        });
      } else if (res.summary.errors.length > 0) {
        toast({
          title: `Pulled ${insertedTotal} new — with errors`,
          description: res.summary.errors[0].message,
          variant: "destructive",
        });
      } else {
        toast({ title: `Pulled ${insertedTotal} new post${insertedTotal === 1 ? "" : "s"}` });
      }
      refreshAll().catch(() => {});
    } catch (err: any) {
      toast({ title: "Poller failed", description: err.message, variant: "destructive" });
    } finally {
      setPollerBusy(false);
    }
  }

  async function saveSettings() {
    setSavingSettings(true);
    try {
      await putJson(`${BASE}/admin/instagram/settings`, {
        instagramHandle: handleDraft.trim().replace(/^@/, ""),
        instagramHashtags: hashtagsDraft,
        instagramWallEnabled: wallEnabled,
        instagramWallMaxItems: Number(maxItems) || 12,
        instagramWallShowOnHome: showOnHome,
        instagramWallShowOnGallery: showOnGallery,
        instagramAutoApproveMention: autoApproveMention,
        instagramAutoDenyOlderThanDays: autoDenyOlderDays === "" ? null : Number(autoDenyOlderDays),
      });
      toast({ title: "Settings saved" });
      refreshAll().catch(() => {});
    } catch (err: any) {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    } finally {
      setSavingSettings(false);
    }
  }

  function addHashtag() {
    const cleaned = newTag.trim().replace(/^#/, "").toLowerCase();
    if (!cleaned) return;
    if (!/^[a-z0-9_]+$/.test(cleaned)) {
      toast({ title: "Invalid hashtag", description: "Use letters, numbers, and underscores only.", variant: "destructive" });
      return;
    }
    if (hashtagsDraft.includes(cleaned)) {
      setNewTag("");
      return;
    }
    if (hashtagsDraft.length >= 5) {
      toast({ title: "Max 5 hashtags", description: "Remove one to add another.", variant: "destructive" });
      return;
    }
    setHashtagsDraft((prev) => [...prev, cleaned]);
    setNewTag("");
  }

  return (
    <AdminLayout>
      <div className="space-y-6">
        <header>
          <h1 className="font-display text-3xl font-bold mb-1">Instagram Hashtag Wall</h1>
          <p className="text-muted-foreground">Approve real-customer posts before they show on the public site.</p>
        </header>

        {status && !status.configured && <NotConfiguredBanner />}

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
          {/* ─── Left: tabs + queue ─────────────────────────────────────── */}
          <div className="space-y-4 min-w-0">
            <div className="flex items-center gap-2 border-b border-border overflow-x-auto">
              {TABS.map((t) => {
                const count = candidatesData?.counts ? (
                  t.key === "all"
                    ? (candidatesData.counts.pending + candidatesData.counts.approved + candidatesData.counts.denied + candidatesData.counts.blacklisted)
                    : (candidatesData.counts as any)[t.key]
                ) : null;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => { setTab(t.key); setSelectedIds(new Set()); }}
                    className={
                      "px-4 py-3 text-sm font-semibold border-b-2 -mb-[1px] flex items-center gap-2 " +
                      (tab === t.key ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")
                    }
                  >
                    {t.label}
                    {count != null && (
                      <span className={
                        "px-2 py-0.5 rounded-full text-xs font-bold " +
                        (tab === t.key ? "bg-primary/10 text-primary" : "bg-secondary text-foreground")
                      }>
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
              <div className="flex-1" />
              {items.length > 0 && (
                <label className="text-xs text-muted-foreground flex items-center gap-2 px-2">
                  <input
                    type="checkbox"
                    checked={allCheckedOnPage}
                    onChange={toggleSelectAll}
                    className="rounded"
                  />
                  Select all
                </label>
              )}
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-24">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : items.length === 0 ? (
              <EmptyState tab={tab} configured={status?.configured ?? false} />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {items.map((c) => (
                  <CandidateCard
                    key={c.id}
                    candidate={c}
                    selected={selectedIds.has(c.id)}
                    onToggleSelect={() => toggleSelect(c.id)}
                    onDecide={(action) => decide(c.id, action)}
                    busy={busyIds.has(c.id)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* ─── Right: settings sidebar ────────────────────────────────── */}
          <aside className="space-y-4">
            <SidebarSection title="Brand Instagram handle" subtitle="Used by the public footer link and the @-mention auto-approve rule">
              <div className="flex items-stretch gap-0">
                <span className="px-3 py-2 text-sm text-muted-foreground bg-secondary rounded-l-lg border border-r-0 border-border">@</span>
                <input
                  type="text"
                  value={handleDraft}
                  onChange={(e) => setHandleDraft(e.target.value)}
                  placeholder="hollywoodeastcafe"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="flex-1 min-w-0 px-3 py-2 rounded-r-lg border border-border bg-background text-sm font-mono"
                />
              </div>
            </SidebarSection>
            <SidebarSection title="Watched hashtags" subtitle="Up to 5 at a time">
              <div className="space-y-2">
                {hashtagsDraft.map((tag) => (
                  <div key={tag} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary">
                    <span className="font-mono text-sm flex-1">#{tag}</span>
                    <button
                      type="button"
                      onClick={() => setHashtagsDraft((prev) => prev.filter((t) => t !== tag))}
                      className="text-muted-foreground hover:text-red-600"
                      title="Remove"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
                {hashtagsDraft.length < 5 && (
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newTag}
                      placeholder="newhashtag"
                      onChange={(e) => setNewTag(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addHashtag(); } }}
                      className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-sm"
                    />
                    <button
                      type="button"
                      onClick={addHashtag}
                      className="p-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90"
                      aria-label="Add hashtag"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            </SidebarSection>

            <SidebarSection title="Wall display">
              <ToggleRow label="Wall enabled" value={wallEnabled} onChange={setWallEnabled} />
              <div>
                <label className="block text-sm font-semibold mb-1">Max items shown</label>
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={maxItems}
                  onChange={(e) => setMaxItems(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-semibold">Render on:</p>
                <ToggleRow label="Home page" value={showOnHome} onChange={setShowOnHome} />
                <ToggleRow label="Gallery page (/gallery)" value={showOnGallery} onChange={setShowOnGallery} />
              </div>
            </SidebarSection>

            <SidebarSection title="Auto-rules">
              <div>
                <ToggleRow
                  label={handle ? `Auto-approve when caption mentions @${handle}` : "Auto-approve when caption mentions handle"}
                  value={autoApproveMention}
                  onChange={setAutoApproveMention}
                  disabled={!handle}
                />
                {!handle && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Set an Instagram handle in Site &amp; Social settings to enable this rule.
                  </p>
                )}
              </div>
              <div>
                <label className="block text-sm font-semibold mb-1">Auto-deny posts older than (days)</label>
                <input
                  type="number"
                  min={1}
                  max={3650}
                  value={autoDenyOlderDays}
                  placeholder="leave blank to disable"
                  onChange={(e) => setAutoDenyOlderDays(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                />
              </div>
            </SidebarSection>

            <button
              type="button"
              onClick={saveSettings}
              disabled={savingSettings}
              className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
            >
              {savingSettings ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save settings
            </button>

            <WebhookSection status={status} />

            <SidebarSection title="Poller">
              <p className="text-xs text-muted-foreground">
                New hashtag posts are only fetched when you click “Run poller now”.
              </p>
              <button
                type="button"
                onClick={runPoller}
                disabled={pollerBusy || !status?.configured}
                className="w-full py-2 rounded-lg border border-border bg-background text-sm font-semibold flex items-center justify-center gap-2 hover:bg-secondary disabled:opacity-50"
              >
                {pollerBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                Run poller now
              </button>
              <div className="text-xs text-muted-foreground space-y-1 pt-2">
                <div>Last polled: <strong>{formatRelative(status?.lastPolledAt ?? null)}</strong></div>
                <div>Pulled in last 24h: <strong>{status?.pulledLast24h ?? 0}</strong></div>
                <div>Pending: <strong>{status?.pendingCount ?? 0}</strong></div>
              </div>
              {lastPoller && lastPoller.errors.length > 0 && (
                <div className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 p-2 rounded-lg mt-2 space-y-1">
                  <p className="font-semibold flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Last run errors</p>
                  {lastPoller.errors.slice(0, 3).map((e, i) => (
                    <p key={i}>#{e.hashtag}: {e.message}</p>
                  ))}
                </div>
              )}
            </SidebarSection>
          </aside>
        </div>

        {/* Sticky bulk-action toolbar */}
        {selectedIds.size > 0 && (
          <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 bg-foreground text-background shadow-2xl rounded-2xl px-4 py-3 flex items-center gap-3">
            <span className="text-sm font-semibold">
              {selectedIds.size} selected
            </span>
            <button
              type="button"
              onClick={() => bulkDecide("approve")}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold flex items-center gap-1"
            >
              <CheckCircle2 className="w-4 h-4" /> Approve
            </button>
            <button
              type="button"
              onClick={() => bulkDecide("deny")}
              className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-white text-sm font-semibold flex items-center gap-1"
            >
              <XCircle className="w-4 h-4" /> Deny
            </button>
            <button
              type="button"
              onClick={() => bulkDecide("blacklist")}
              className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-semibold flex items-center gap-1"
            >
              <Ban className="w-4 h-4" /> Hide forever
            </button>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="px-2 py-1.5 text-sm text-background/70 hover:text-background"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}

function NotConfiguredBanner() {
  return (
    <div className="rounded-xl border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-950/40 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
        <div className="text-sm text-amber-900 dark:text-amber-200 space-y-2">
          <p className="font-semibold">Instagram credentials are not configured.</p>
          <p>
            The poller is paused. Set <code className="px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/60">INSTAGRAM_ACCESS_TOKEN</code> and{" "}
            <code className="px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/60">INSTAGRAM_USER_ID</code> in your environment secrets to start pulling posts.
          </p>
          <ol className="list-decimal list-inside space-y-1 text-amber-900/90 dark:text-amber-300">
            <li>Convert your Instagram account to a Business account.</li>
            <li>Create an app in the <a className="underline" href="https://developers.facebook.com/" target="_blank" rel="noopener noreferrer">Meta Developer console</a>.</li>
            <li>Enable Instagram Graph API + Hashtag Search permissions.</li>
            <li>Add your IG account as an Instagram Tester (development mode).</li>
            <li>Generate a long-lived user access token; save it as <code className="px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/60">INSTAGRAM_ACCESS_TOKEN</code>.</li>
            <li>Save the IG Business User id as <code className="px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/60">INSTAGRAM_USER_ID</code>.</li>
          </ol>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ tab, configured }: { tab: TabKey; configured: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-border p-12 text-center">
      <ImageIcon className="w-10 h-10 mx-auto text-muted-foreground/50 mb-3" />
      <p className="text-foreground font-semibold mb-1">
        {tab === "pending" ? "No pending posts" : `No ${tab} posts yet`}
      </p>
      <p className="text-sm text-muted-foreground">
        {configured
          ? "The poller runs every 30 min. Add a hashtag in the sidebar or click \"Run poller now\"."
          : "Set up Instagram credentials above to start pulling posts."}
      </p>
    </div>
  );
}

function CandidateCard({
  candidate, selected, onToggleSelect, onDecide, busy,
}: {
  candidate: Candidate;
  selected: boolean;
  onToggleSelect: () => void;
  onDecide: (action: "approve" | "deny" | "blacklist") => void;
  busy: boolean;
}) {
  const [showFullCaption, setShowFullCaption] = useState(false);
  const c = candidate;
  const longCaption = c.caption.length > 220;
  const captionDisplay = showFullCaption || !longCaption ? c.caption : c.caption.slice(0, 220) + "…";
  const statusBadge = useMemo(() => {
    switch (c.status) {
      case "pending": return { label: "Pending", className: "bg-amber-100 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300" };
      case "approved": return { label: "Approved", className: "bg-emerald-100 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300" };
      case "denied": return { label: "Denied", className: "bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-400" };
      case "blacklisted": return { label: "Hidden", className: "bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-300" };
      default: return { label: c.status, className: "bg-secondary text-foreground" };
    }
  }, [c.status]);

  return (
    <div className={"rounded-xl border bg-card overflow-hidden flex flex-col " + (selected ? "border-primary ring-2 ring-primary/30" : "border-border")}>
      <label className="absolute m-2 z-10 bg-white/90 rounded p-1 cursor-pointer">
        <input type="checkbox" checked={selected} onChange={onToggleSelect} className="rounded" />
      </label>
      <div className="relative aspect-square bg-secondary">
        {c.thumbnailUrl ? (
          <img
            src={c.thumbnailUrl}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = "0.3"; }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground">
            <ImageIcon className="w-8 h-8" />
          </div>
        )}
        {c.mediaType === "VIDEO" && (
          <span className="absolute top-2 right-2 rounded-full bg-black/70 p-1.5 text-white">
            <Play className="w-3 h-3" />
          </span>
        )}
        <span className={"absolute bottom-2 left-2 px-2 py-0.5 rounded-full text-xs font-semibold " + statusBadge.className}>
          {statusBadge.label}
        </span>
        {c.isUnavailable && (
          <span className="absolute bottom-2 right-2 px-2 py-0.5 rounded-full text-xs font-semibold bg-zinc-800/90 text-white">
            Unavailable
          </span>
        )}
      </div>
      <div className="p-3 flex flex-col flex-1 gap-2">
        <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
          {c.source === "story_mention" ? (
            <span className="px-1.5 py-0.5 rounded font-semibold bg-purple-100 dark:bg-purple-950/50 text-purple-700 dark:text-purple-300">Story</span>
          ) : (
            <span className="font-mono">#{c.hashtag}</span>
          )}
          <span>•</span>
          <span>{c.postedAt ? formatRelative(c.postedAt) : "no date"}</span>
          {c.autoRule && <span className="text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-1.5 py-0.5 rounded">{c.autoRule}</span>}
        </div>
        <p className="text-sm text-foreground/80 break-words whitespace-pre-wrap">
          {captionDisplay || <em className="text-muted-foreground">(no caption)</em>}
          {longCaption && (
            <button
              type="button"
              onClick={() => setShowFullCaption((s) => !s)}
              className="ml-1 text-primary text-xs font-semibold"
            >
              {showFullCaption ? "show less" : "show more"}
            </button>
          )}
        </p>

        {c.status !== "pending" && (c.decidedBy || c.decidedAt) && (
          <p className="text-xs text-muted-foreground">
            Decided {formatRelative(c.decidedAt)}
            {c.decidedBy ? ` by ${c.decidedBy}` : ""}
          </p>
        )}

        <div className="flex-1" />

        <div className="flex items-center gap-1 pt-1">
          {c.permalink && (
            <a
              href={c.permalink}
              target="_blank"
              rel="noopener noreferrer"
              className="px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-secondary text-foreground hover:bg-secondary/70 inline-flex items-center gap-1"
            >
              <ExternalLink className="w-3 h-3" /> Instagram
            </a>
          )}
          <div className="flex-1" />
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecide("approve")}
            className="px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white inline-flex items-center gap-1 disabled:opacity-50"
            title="Approve"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecide("deny")}
            className="px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-amber-500 hover:bg-amber-400 text-white inline-flex items-center gap-1 disabled:opacity-50"
            title="Deny"
          >
            <XCircle className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecide("blacklist")}
            className="px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-red-600 hover:bg-red-500 text-white inline-flex items-center gap-1 disabled:opacity-50"
            title="Hide forever"
          >
            <Ban className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function WebhookSection({ status }: { status: StatusResponse | null }) {
  const { toast } = useToast();
  const webhookUrl = `${window.location.origin}/api/webhooks/instagram`;
  const appSecretOk = status?.webhookAppSecretConfigured ?? false;
  const verifyTokenOk = status?.webhookVerifyTokenConfigured ?? false;
  const fullyConfigured = appSecretOk && verifyTokenOk;

  function copyUrl() {
    navigator.clipboard.writeText(webhookUrl).then(
      () => toast({ title: "Webhook URL copied" }),
      () => toast({ title: "Copy failed", variant: "destructive" }),
    );
  }

  return (
    <SidebarSection
      title="Story mention webhook"
      subtitle="Customers who @mention you in their Instagram Story flow here automatically"
    >
      <div className="space-y-3">
        <div>
          <p className="text-xs font-semibold mb-1 text-muted-foreground">Webhook URL (paste into Meta app)</p>
          <div className="flex items-center gap-1">
            <code className="flex-1 text-xs bg-secondary rounded px-2 py-1.5 break-all font-mono select-all">
              {webhookUrl}
            </code>
            <button
              type="button"
              onClick={copyUrl}
              className="p-1.5 rounded-lg border border-border hover:bg-secondary flex-shrink-0"
              title="Copy URL"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-muted-foreground">Required env vars</p>
          <EnvVarRow name="INSTAGRAM_APP_SECRET" ok={appSecretOk} />
          <EnvVarRow name="INSTAGRAM_WEBHOOK_VERIFY_TOKEN" ok={verifyTokenOk} />
        </div>

        {!fullyConfigured && (
          <div className="rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/50 p-2.5 text-xs text-amber-900 dark:text-amber-200 space-y-1">
            <p className="font-semibold">Setup steps</p>
            <ol className="list-decimal list-inside space-y-0.5 text-amber-900/80 dark:text-amber-300">
              <li>In Meta app dashboard → Webhooks → Instagram → add field <strong>mentions</strong></li>
              <li>Paste the URL above and any string as your Verify Token</li>
              <li>Save that same string as <code className="font-mono">INSTAGRAM_WEBHOOK_VERIFY_TOKEN</code></li>
              <li>Copy App Secret (Settings → Basic) into <code className="font-mono">INSTAGRAM_APP_SECRET</code></li>
            </ol>
          </div>
        )}

        {fullyConfigured && (
          <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/50 p-2.5 text-xs text-emerald-800 dark:text-emerald-300 flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
            Webhook configured — story @mentions will flow into the pending queue.
          </div>
        )}

        <a
          href="https://developers.facebook.com/docs/instagram-platform/webhooks"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
        >
          <BookOpen className="w-3 h-3" /> Meta webhook docs
        </a>
      </div>
    </SidebarSection>
  );
}

function EnvVarRow({ name, ok }: { name: string; ok: boolean }) {
  return (
    <div className="flex items-center gap-2">
      {ok
        ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
        : <XCircle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />}
      <code className="text-xs font-mono text-muted-foreground">{name}</code>
    </div>
  );
}

function SidebarSection({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div>
        <h3 className="font-semibold text-sm">{title}</h3>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

function ToggleRow({ label, value, onChange, disabled }: { label: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={"flex items-center justify-between gap-2 text-sm " + (disabled ? "opacity-50" : "")}>
      <span>{label}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!value)}
        className={"relative inline-flex h-5 w-9 items-center rounded-full transition-colors " + (value ? "bg-primary" : "bg-secondary border border-border")}
        role="switch"
        aria-checked={value}
      >
        <span
          className={"inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow " + (value ? "translate-x-4" : "translate-x-0.5")}
        />
      </button>
    </label>
  );
}
