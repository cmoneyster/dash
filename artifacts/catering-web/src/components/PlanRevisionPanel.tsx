import { useCallback, useEffect, useState } from "react";
import { Check, Clipboard, Clock3, Link2, Mail, MessageSquare, RefreshCw, X } from "lucide-react";
import { createRevisionLink, getRevisionHistory, readablePlanError, reviewRevision, revokeRevisionLink, type PlanRevision, type RevisionFields, type RevisionHistory, type RevisionItem } from "@/lib/planRevisions";

const shortDate = (value: string) => new Date(value).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
const formatValue = (key: string, value: unknown) => {
  if (value == null || value === "") return "Not specified";
  if (key === "eventDate" && typeof value === "string") return value.slice(0, 10);
  return String(value);
};
function changes(revision: PlanRevision) {
  const names: Record<string, string> = { eventDate: "Event date", eventTime: "Event time", guestCount: "Guests", venueAddress: "Venue / address", menuNotes: "Menu notes" };
  const fields = (Object.keys(names) as (keyof Omit<RevisionFields, "items">)[]).filter(key => revision.base?.[key] !== revision.proposed?.[key]);
  const itemLabel = (item: RevisionItem) => `${item.name || `Menu item #${item.menuItemId}`}${item.sizeLabel ? ` · ${item.sizeLabel}` : item.sizeSlot != null ? ` · size ${item.sizeSlot}` : ""} × ${item.quantity}`;
  const itemKey = (item: RevisionItem) => `${item.menuItemId}:${item.sizeSlot ?? ""}`;
  const before = new Map((revision.base?.items ?? []).map(item => [itemKey(item), item]));
  const after = new Map((revision.proposed?.items ?? []).map(item => [itemKey(item), item]));
  const itemChanges = [...new Set([...before.keys(), ...after.keys()])].filter(key => before.get(key)?.quantity !== after.get(key)?.quantity);
  return <div className="space-y-2 text-xs text-muted-foreground">
    {fields.map(key => <p key={key}><span className="font-semibold text-foreground">{names[key]}:</span> <span className="line-through">{formatValue(key, revision.base[key])}</span> → <span className="font-medium text-foreground">{formatValue(key, revision.proposed[key])}</span></p>)}
    {itemChanges.map(key => <p key={key}><span className="font-semibold text-foreground">Menu:</span> {before.has(key) ? itemLabel(before.get(key)!) : "Not included"} → <span className="font-medium text-foreground">{after.has(key) ? itemLabel(after.get(key)!) : "Removed"}</span></p>)}
    {!fields.length && !itemChanges.length && <p>No menu or event details changed.</p>}
  </div>;
}

export function PlanRevisionPanel({ inquiryId, locked, isDirty, quoteIssued, onApplied }: {
  inquiryId: number; locked: boolean; isDirty: boolean; quoteIssued: boolean; onApplied: () => Promise<void>;
}) {
  const [data, setData] = useState<RevisionHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try { setData(await getRevisionHistory(inquiryId)); }
    catch (e) { setError(readablePlanError(e)); }
    finally { setLoading(false); }
  }, [inquiryId]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);
  const activeLink = data?.link && new Date(data.link.expiresAt).getTime() > Date.now() ? data.link : null;

  async function send(channel: "copy" | "email" | "sms") {
    if (locked) return;
    setBusy(channel); setError(""); setMessage("");
    try {
      const result = await createRevisionLink(inquiryId, channel);
      setData(prev => ({ link: result, revisions: prev?.revisions ?? [] }));
      if (channel === "copy") {
        try { await navigator.clipboard.writeText(result.url); setMessage("Revision link copied."); }
        catch { setMessage("Copy the link from the field below."); }
      } else setMessage(`Revision link sent by ${channel === "sms" ? "text" : "email"}.`);
    } catch (e) { setError(readablePlanError(e)); }
    finally { setBusy(""); }
  }
  async function revoke() {
    if (!window.confirm("Revoke this link? The customer will no longer be able to submit changes with it.")) return;
    setBusy("revoke"); setError("");
    try { await revokeRevisionLink(inquiryId); await refresh(); setMessage("Link revoked."); }
    catch (e) { setError(readablePlanError(e)); }
    finally { setBusy(""); }
  }
  async function review(revision: PlanRevision, action: "apply" | "decline") {
    if (action === "apply" && isDirty && !window.confirm("You have unsaved changes in the inquiry editor. Applying this revision will reload the inquiry and discard those edits. Continue?")) return;
    if (!window.confirm(action === "apply" ? "Apply this customer's changes to the inquiry and quote builder?" : "Decline this suggested revision?")) return;
    setBusy(`${action}-${revision.id}`); setError(""); setMessage("");
    try {
      await reviewRevision(inquiryId, revision.id, action);
      if (action === "apply") await onApplied();
      await refresh();
      setMessage(action === "apply"
        ? quoteIssued
          ? "Revision applied. The previous quote link is no longer valid. Generate and send a new quote."
          : "Revision applied. The inquiry has been refreshed."
        : "Revision declined.");
    } catch (e) { setError(readablePlanError(e)); await refresh(); }
    finally { setBusy(""); }
  }
  const actionClass = "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40";
  return <section className="rounded-xl border border-border bg-card p-4 sm:p-5" data-testid="panel-plan-revisions">
    <div className="flex items-start justify-between gap-3"><div><p className="flex items-center gap-2 text-sm font-bold"><Link2 size={16} className="text-primary" /> Customer plan revisions</p><p className="mt-1 text-xs text-muted-foreground">Invite changes to this inquiry without starting over.</p></div><button type="button" onClick={refresh} disabled={loading} className="rounded-lg p-2 text-muted-foreground hover:bg-secondary" aria-label="Refresh revisions" data-testid="button-refresh-revisions"><RefreshCw size={15} /></button></div>
    {locked && <p className="mt-4 rounded-lg bg-secondary p-3 text-xs text-muted-foreground" data-testid="status-revision-locked">Revisions are unavailable for accepted, invoiced, completed or cancelled inquiries.</p>}
    {!locked && isDirty && <p className="mt-4 rounded-lg bg-secondary p-3 text-xs text-muted-foreground" data-testid="status-revision-unsaved">Save your inquiry changes before sending a revision link. The customer sees the last saved plan.</p>}
    {loading && !data ? <div className="mt-5 space-y-2 animate-pulse"><div className="h-9 rounded-lg bg-secondary" /><div className="h-14 rounded-lg bg-secondary" /></div> : <>
      <div className="mt-5 flex flex-wrap gap-2">
        <button type="button" disabled={locked || isDirty || !!busy} onClick={() => send("copy")} className={actionClass} data-testid="button-create-revision-link"><Clipboard size={14} /> Copy link</button>
        <button type="button" disabled={locked || isDirty || !!busy} onClick={() => send("email")} className={actionClass} data-testid="button-email-revision-link"><Mail size={14} /> Email</button>
        <button type="button" disabled={locked || isDirty || !!busy} onClick={() => send("sms")} className={actionClass} data-testid="button-sms-revision-link"><MessageSquare size={14} /> SMS</button>
      </div>
      {activeLink && <div className="mt-4 rounded-lg bg-secondary/50 p-3"><div className="flex items-center gap-2 text-xs text-muted-foreground"><Clock3 size={13} /> Expires {shortDate(activeLink.expiresAt)}</div><div className="mt-2 flex items-center gap-2"><input readOnly value={activeLink.url} onFocus={e => e.target.select()} className="min-w-0 flex-1 rounded-lg border border-border bg-background p-2 text-xs" aria-label="Customer revision link" data-testid="input-revision-link" /><button type="button" onClick={() => navigator.clipboard.writeText(activeLink.url).then(() => setMessage("Link copied.")).catch(() => setError("Select and copy the link manually."))} className={actionClass} aria-label="Copy revision link" data-testid="button-copy-existing-link"><Clipboard size={14} /></button></div><button type="button" onClick={revoke} disabled={!!busy} className="mt-2 text-xs font-medium text-destructive underline disabled:opacity-40" data-testid="button-revoke-revision-link">Revoke link</button></div>}
      {data?.link && !activeLink && <p className="mt-3 text-xs text-muted-foreground">Previous link expired. Send a new one to reopen editing.</p>}
      <div className="mt-6 border-t border-border pt-4"><h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Suggested changes</h3>
        {!data?.revisions?.length ? <p className="mt-3 text-xs text-muted-foreground" data-testid="status-no-revisions">No revisions yet. Share the link to invite a menu update.</p> :
          <div className="mt-3 space-y-3">{data.revisions.map(revision => <article key={revision.id} className="rounded-xl border border-border p-3 sm:p-4" data-testid={`card-revision-${revision.id}`}><div className="flex items-center justify-between gap-3"><span className="text-xs font-semibold">Customer suggested · {shortDate(revision.createdAt)}</span><span className="rounded-full bg-secondary px-2 py-1 text-[11px] font-bold capitalize" data-testid={`status-revision-${revision.id}`}>{revision.status}</span></div>{revision.reviewedAt && <p className="mt-1 text-xs text-muted-foreground">Reviewed by staff · {shortDate(revision.reviewedAt)}</p>}{revision.note && <p className="mt-3 border-l-2 border-primary pl-3 text-xs italic">“{revision.note}”</p>}<div className="mt-3">{changes(revision)}</div>{revision.status === "pending" && <div className="mt-4 flex flex-wrap gap-2"><button type="button" disabled={locked || !!busy} onClick={() => review(revision, "apply")} className={actionClass} data-testid={`button-apply-revision-${revision.id}`}><Check size={14} /> Apply changes</button><button type="button" disabled={!!busy} onClick={() => review(revision, "decline")} className={actionClass} data-testid={`button-decline-revision-${revision.id}`}><X size={14} /> Decline</button></div>}</article>)}</div>}
      </div>
    </>}
    {error && <p className="mt-3 text-xs text-destructive" role="alert" data-testid="status-revisions-error">{error}</p>}
    {message && <p className="mt-3 text-xs font-medium text-primary" role="status" data-testid="status-revisions-message">{message}</p>}
  </section>;
}