import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { AdminLayout } from "@/components/AdminLayout";
import { getAdminToken } from "@/components/AdminGuard";
import {
  Inbox, Loader2, Search, Trash2, ShieldAlert, LinkIcon, X, RefreshCw, CheckSquare, Square,
} from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type UnmatchedMessage = {
  id: number;
  direction: "inbound" | "outbound";
  customerPhone: string;
  body: string;
  occurredAt: string;
  port: number | null;
  inquiryId: number | null;
  seenByAdmin: boolean;
  source: string;
};

type InquirySearchResult = {
  id: number;
  clientName: string;
  clientPhone: string | null;
  eventDate: string | null;
  status: string;
};

function authHeaders() {
  const token = getAdminToken();
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

function relativeTime(iso: string): string {
  try {
    const then = new Date(iso).getTime();
    const diff = Date.now() - then;
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

function fullTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function UnmatchedMessages() {
  const [messages, setMessages] = useState<UnmatchedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [linkingFor, setLinkingFor] = useState<UnmatchedMessage | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // "delete:N" | "block:N" | "bulk-delete"

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${BASE}/api/admin/messages/unmatched`, { headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { messages: UnmatchedMessage[] };
      setMessages(data.messages);
      setError("");
    } catch (e: any) {
      setError(e?.message || "Failed to load unmatched messages");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Clear the sidebar badge as soon as the admin opens this page —
    // the unmatched badge counts unread inbound rows, and "viewing
    // the inbox" counts as reading them. Best-effort; the worst case
    // is a stale badge until the next event.
    fetch(`${BASE}/api/admin/messages/unmatched/mark-seen`, {
      method: "POST",
      headers: authHeaders(),
    }).catch(() => { /* non-fatal */ });
  }, [load]);

  // Live updates via SSE — token is passed as a query param because
  // EventSource cannot set custom headers. Falls back to polling on
  // failure so the inbox stays fresh even if the stream drops.
  useEffect(() => {
    const token = getAdminToken();
    if (!token) return;
    let es: EventSource | null = null;
    let pollInt: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    function startPolling() {
      if (pollInt) return;
      pollInt = setInterval(load, 30_000);
    }
    function stopPolling() {
      if (pollInt) {
        clearInterval(pollInt);
        pollInt = null;
      }
    }

    function connect() {
      try {
        es = new EventSource(`${BASE}/api/admin/messages/stream?token=${encodeURIComponent(token!)}`);
        es.addEventListener("inbound", () => { if (!cancelled) load(); });
        es.addEventListener("unmatched-changed", () => { if (!cancelled) load(); });
        es.addEventListener("hello", () => stopPolling());
        es.onerror = () => {
          // Browser will auto-reconnect; meanwhile rely on the poll fallback.
          startPolling();
        };
      } catch {
        startPolling();
      }
    }

    connect();
    return () => {
      cancelled = true;
      stopPolling();
      es?.close();
    };
  }, [load]);

  const allSelected = messages.length > 0 && messages.every(m => selected.has(m.id));
  const anySelected = selected.size > 0;

  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(messages.map(m => m.id)));
  }
  function toggleOne(id: number) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this message? This cannot be undone.")) return;
    setBusy(`delete:${id}`);
    try {
      const r = await fetch(`${BASE}/api/admin/messages/unmatched/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!r.ok) throw new Error("Delete failed");
      setMessages(prev => prev.filter(m => m.id !== id));
      setSelected(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (e: any) {
      alert(e?.message || "Delete failed");
    } finally {
      setBusy(null);
    }
  }

  async function handleBulkDelete() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} selected message${ids.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
    setBusy("bulk-delete");
    try {
      const r = await fetch(`${BASE}/api/admin/messages/unmatched/bulk-delete`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ ids }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || "Bulk delete failed");
      setMessages(prev => prev.filter(m => !selected.has(m.id)));
      setSelected(new Set());
    } catch (e: any) {
      alert(e?.message || "Bulk delete failed");
    } finally {
      setBusy(null);
    }
  }

  async function handleBlock(msg: UnmatchedMessage) {
    const sameSenderCount = messages.filter(m => m.customerPhone === msg.customerPhone).length;
    if (
      !confirm(
        `Block ${msg.customerPhone}?\n\nThis will:\n• Add the number to the admin blocklist\n• Remove all ${sameSenderCount} message${sameSenderCount === 1 ? "" : "s"} from this sender from the inbox\n• Suppress any future inbound from this number\n• Block any outbound to this number\n\nUndo by editing the database directly.`,
      )
    )
      return;
    setBusy(`block:${msg.id}`);
    try {
      const r = await fetch(`${BASE}/api/admin/messages/unmatched/${msg.id}/block-sender`, {
        method: "POST",
        headers: authHeaders(),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || "Block failed");
      setMessages(prev => prev.filter(m => m.customerPhone !== msg.customerPhone));
      setSelected(new Set());
    } catch (e: any) {
      alert(e?.message || "Block failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <AdminLayout>
      <div className="space-y-6 max-w-5xl">
        <div className="flex items-center gap-3 justify-between flex-wrap">
          <div className="flex items-center gap-3">
            <Inbox className="w-6 h-6 text-foreground/70" />
            <div>
              <h1 className="font-display font-bold text-2xl">Unmatched Messages</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                Inbound texts whose sender doesn't match any catering inquiry's phone number.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground border border-border rounded-xl px-3 py-2 hover:bg-secondary transition-colors disabled:opacity-50"
            >
              <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
              Refresh
            </button>
          </div>
        </div>

        {error && (
          <div className="bg-destructive/10 border border-destructive/30 text-destructive rounded-2xl p-4 text-sm">
            {error}
          </div>
        )}

        {anySelected && (
          <div className="bg-secondary/50 border border-border rounded-2xl px-4 py-3 flex items-center gap-3 flex-wrap">
            <span className="text-sm font-medium">{selected.size} selected</span>
            <button
              type="button"
              onClick={handleBulkDelete}
              disabled={busy === "bulk-delete"}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-destructive border border-destructive/40 rounded-xl px-3 py-1.5 hover:bg-destructive/10 transition-colors disabled:opacity-50"
            >
              {busy === "bulk-delete" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              Delete selected
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Clear selection
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : messages.length === 0 ? (
          <div className="bg-card border border-border rounded-2xl p-12 text-center text-muted-foreground">
            <Inbox className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No unmatched messages.</p>
            <p className="text-sm mt-1">Inbound texts that match an existing inquiry's phone number flow straight into the inquiry chat.</p>
          </div>
        ) : (
          <div className="bg-card border border-border rounded-2xl overflow-hidden">
            <div className="px-4 py-2 border-b border-border flex items-center gap-2 bg-secondary/30 text-xs font-medium text-muted-foreground">
              <button
                type="button"
                onClick={toggleAll}
                className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors"
              >
                {allSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                Select all
              </button>
              <span className="ml-auto">{messages.length} message{messages.length === 1 ? "" : "s"}</span>
            </div>
            <ul className="divide-y divide-border">
              {messages.map(m => {
                const isChecked = selected.has(m.id);
                return (
                  <li
                    key={m.id}
                    className={cn(
                      "px-4 py-3 flex items-start gap-3 hover:bg-secondary/30 transition-colors",
                      isChecked && "bg-primary/5",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => toggleOne(m.id)}
                      className="mt-1 shrink-0"
                      aria-label={isChecked ? "Deselect" : "Select"}
                    >
                      {isChecked ? (
                        <CheckSquare className="w-4 h-4 text-primary" />
                      ) : (
                        <Square className="w-4 h-4 text-muted-foreground" />
                      )}
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="font-mono text-sm font-semibold">{m.customerPhone}</span>
                        <span className="text-xs text-muted-foreground" title={fullTime(m.occurredAt)}>
                          {relativeTime(m.occurredAt)}
                        </span>
                        {m.port != null && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-secondary rounded-full font-mono">port {m.port}</span>
                        )}
                      </div>
                      <p className="text-sm text-foreground/90 whitespace-pre-wrap break-words">{m.body}</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => setLinkingFor(m)}
                        className="inline-flex items-center gap-1 text-xs font-medium text-foreground border border-border rounded-lg px-2 py-1 hover:bg-secondary transition-colors"
                        title="Link this conversation to an existing inquiry"
                      >
                        <LinkIcon className="w-3 h-3" />
                        Link
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(m.id)}
                        disabled={busy === `delete:${m.id}`}
                        className="inline-flex items-center gap-1 text-xs font-medium text-foreground border border-border rounded-lg px-2 py-1 hover:bg-destructive/10 hover:text-destructive hover:border-destructive/40 transition-colors disabled:opacity-50"
                        title="Delete just this message (sender can text again)"
                      >
                        {busy === `delete:${m.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                        Delete
                      </button>
                      <button
                        type="button"
                        onClick={() => handleBlock(m)}
                        disabled={busy === `block:${m.id}`}
                        className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 border border-amber-300 rounded-lg px-2 py-1 hover:bg-amber-50 transition-colors disabled:opacity-50"
                        title="Block sender and remove all their messages"
                      >
                        {busy === `block:${m.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldAlert className="w-3 h-3" />}
                        Block
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      {linkingFor && (
        <LinkInquiryModal
          message={linkingFor}
          onClose={() => setLinkingFor(null)}
          onLinked={() => {
            setLinkingFor(null);
            load();
          }}
        />
      )}
    </AdminLayout>
  );
}

// ── Inquiry-picker modal ──────────────────────────────────────────────────────
//
// Reuses the existing `/api/admin/catering` list endpoint and filters
// client-side by name / phone-digits / event date. The picker is small and
// linked-by-search rather than paginated because the catering list is
// well under a few hundred rows in practice.

function LinkInquiryModal({
  message,
  onClose,
  onLinked,
}: {
  message: UnmatchedMessage;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [query, setQuery] = useState("");
  const [allInquiries, setAllInquiries] = useState<InquirySearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [linking, setLinking] = useState<number | null>(null);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    (async () => {
      try {
        const r = await fetch(`${BASE}/api/admin/catering`, { headers: authHeaders() });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as Array<{
          id: number;
          clientName: string;
          clientPhone: string | null;
          eventDate: string | null;
          status: string;
        }>;
        setAllInquiries(
          data.map(i => ({
            id: i.id,
            clientName: i.clientName,
            clientPhone: i.clientPhone,
            eventDate: i.eventDate,
            status: i.status,
          })),
        );
      } catch (e: any) {
        setError(e?.message || "Failed to load inquiries");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const qDigits = query.replace(/\D/g, "");
    if (!q && !qDigits) return allInquiries.slice(0, 50);
    return allInquiries
      .filter(i => {
        if (q && i.clientName.toLowerCase().includes(q)) return true;
        if (qDigits && i.clientPhone && i.clientPhone.replace(/\D/g, "").includes(qDigits)) return true;
        if (q && i.eventDate && i.eventDate.includes(q)) return true;
        return false;
      })
      .slice(0, 50);
  }, [query, allInquiries]);

  async function link(inquiryId: number) {
    setLinking(inquiryId);
    setError("");
    try {
      const r = await fetch(`${BASE}/api/admin/messages/unmatched/${message.id}/link`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ inquiryId }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || "Link failed");
      onLinked();
    } catch (e: any) {
      setError(e?.message || "Link failed");
    } finally {
      setLinking(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-card rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="font-display font-bold text-lg">Link to inquiry</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              From <span className="font-mono">{message.customerPhone}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl text-muted-foreground hover:bg-secondary"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 border-b border-border">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search by name, phone, or date…"
              className="w-full pl-9 pr-3 py-2 border border-border rounded-xl bg-background text-sm"
            />
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Linking will also attach any other unmatched messages from this same number.
          </p>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-6 text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading inquiries…
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground text-center">
              No matching inquiries.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {filtered.map(i => (
                <li key={i.id} className="px-4 py-3 flex items-center gap-3 hover:bg-secondary/30">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm truncate">
                      {i.clientName}{" "}
                      <span className="text-xs font-mono text-muted-foreground">#{i.id}</span>
                    </div>
                    <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
                      {i.clientPhone && <span className="font-mono">{i.clientPhone}</span>}
                      {i.eventDate && <span>• {i.eventDate}</span>}
                      <span className="capitalize">• {i.status.replace(/_/g, " ")}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => link(i.id)}
                    disabled={linking != null}
                    className="text-xs font-semibold px-3 py-1.5 bg-foreground text-background rounded-lg hover:bg-primary hover:text-primary-foreground disabled:opacity-50"
                  >
                    {linking === i.id ? <Loader2 className="w-3 h-3 animate-spin inline" /> : "Link"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {error && (
          <div className="p-3 border-t border-border text-sm text-destructive">{error}</div>
        )}
      </div>
    </div>
  );
}
