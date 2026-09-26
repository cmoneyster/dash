import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useParams } from "wouter";
import { ArrowLeft, Check, ChevronRight, Plus, RefreshCw, Send, Trash2 } from "lucide-react";
import { usePageMeta } from "@/lib/usePageMeta";
import { getRevisionPlan, PlanApiError, readablePlanError, submitRevision, type RevisionFields, type RevisionItem, type RevisionPlan } from "@/lib/planRevisions";

const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
const dateInput = (value: string | null) => value?.slice(0, 10) ?? "";
const inputClass = "w-full min-h-11 rounded-xl border border-border bg-background px-3 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15";

export default function RevisePlan() {
  usePageMeta({ title: "Suggest changes to your event menu | dash Catering", description: "Review your catering inquiry and send menu changes to the dash team.", noindex: true });
  const { token = "" } = useParams<{ token: string }>();
  const [plan, setPlan] = useState<RevisionPlan | null>(null);
  const [form, setForm] = useState<RevisionFields | null>(null);
  const [note, setNote] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [terminal, setTerminal] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submissionId, setSubmissionId] = useState(() => crypto.randomUUID());
  const [unsentDraft, setUnsentDraft] = useState<{ form: RevisionFields; note: string } | null>(null);
  const [refreshedMessage, setRefreshedMessage] = useState("");

  async function load(draft?: { form: RevisionFields; note: string }) {
    setLoading(true); setError("");
    try {
      const next = await getRevisionPlan(token);
      setPlan(next);
      if (draft) {
        // A 409 can mean a different revision is already pending. Preserve the
        // customer's work even when the server no longer accepts submissions.
        setUnsentDraft(draft);
        setForm(draft.form);
        setNote(draft.note);
        setRefreshedMessage(next.pending ? "" : "The plan changed while you were editing. Your unsent changes are still here; review them against the latest plan before sending.");
      } else {
        setForm({
          items: next.items.map(i => ({ ...i })),
          eventDate: next.inquiry.eventDate, eventTime: next.inquiry.eventTime,
          guestCount: next.inquiry.guestCount, venueAddress: next.inquiry.venueAddress, menuNotes: next.inquiry.menuNotes,
        });
        setNote("");
        setUnsentDraft(null);
        setRefreshedMessage("");
      }
      setSubmissionId(crypto.randomUUID()); setTerminal(false); setConflict(false);
    } catch (err) {
      setError(readablePlanError(err));
      if (draft) { setUnsentDraft(draft); setConflict(true); }
      setTerminal(err instanceof PlanApiError && [403, 404, 410, 423].includes(err.status));
    } finally { setLoading(false); }
  }
  useEffect(() => {
    setPlan(null);
    setForm(null);
    setSubmitted(false);
    setUnsentDraft(null);
    void load();
  }, [token]);

  const menu = plan?.availableMenu ?? [];
  const filteredMenu = useMemo(() => menu.filter(m => `${m.name} ${m.category}`.toLowerCase().includes(search.toLowerCase())), [menu, search]);
  const estimate = useMemo(() => (form?.items ?? []).reduce((total, item) => {
    const m = menu.find(x => x.id === item.menuItemId);
    const size = m?.sizes?.find(s => s.slot === item.sizeSlot);
    return total + Math.max(0, Number(item.quantity) || 0) * Number(size?.price ?? m?.price ?? item.unitPrice ?? 0);
  }, 0), [form?.items, menu]);
  const editable = !!form && !!plan && !plan.pending && !submitted;

  function addItem(id: number, slot: number | null = null) {
    const m = menu.find(x => x.id === id);
    if (!m || !form) return;
    const selectedSlot = m.pricingTemplate === "pan_sizes" ? slot ?? m.sizes?.[0]?.slot ?? null : null;
    setForm(f => {
      if (!f) return f;
      const existingIndex = f.items.findIndex(i => i.menuItemId === id && (i.sizeSlot ?? null) === selectedSlot);
      const items = existingIndex === -1
        ? [...f.items, { menuItemId: id, quantity: Math.max(1, Number(m.minimumOrderQty) || 1), sizeSlot: selectedSlot, name: m.name }]
        : f.items.map((i, n) => n === existingIndex ? { ...i, quantity: i.quantity + 1 } : i);
      return { ...f, items };
    });
  }
  function changeItem(index: number, patch: Partial<RevisionItem>) {
    setForm(f => {
      if (!f) return f;
      const current = f.items[index];
      if (!current) return f;
      const next = { ...current, ...patch };
      const duplicateIndex = patch.sizeSlot !== undefined
        ? f.items.findIndex((i, n) => n !== index && i.menuItemId === next.menuItemId && (i.sizeSlot ?? null) === (next.sizeSlot ?? null))
        : -1;
      if (duplicateIndex < 0) return { ...f, items: f.items.map((i, n) => n === index ? next : i) };
      // Switching into an already-selected size combines the two quantities.
      return { ...f, items: f.items.filter((_, n) => n !== index).map(i =>
        i === f.items[duplicateIndex] ? { ...i, quantity: i.quantity + next.quantity } : i,
      ) };
    });
  }
  function removeItem(index: number) {
    setForm(f => f && ({ ...f, items: f.items.filter((_, n) => n !== index) }));
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!plan || !form || !editable) return;
    if (form.items.some(i => !Number.isInteger(i.quantity) || i.quantity < 1)) { setError("Enter a valid quantity for every item."); return; }
    if (form.guestCount != null && (!Number.isInteger(form.guestCount) || form.guestCount < 1)) { setError("Guest count must be at least 1."); return; }
    setSaving(true); setError("");
    try {
      await submitRevision(token, {
        version: plan.version, submissionId,
        items: form.items.map(({ menuItemId, quantity, sizeSlot }) => ({ menuItemId, quantity, sizeSlot: sizeSlot ?? null })),
        eventDate: form.eventDate || null, eventTime: form.eventTime || null,
        guestCount: form.guestCount, venueAddress: form.venueAddress?.trim() || null,
        menuNotes: form.menuNotes?.trim() || null, note: note.trim(),
      });
      setUnsentDraft(null);
      setSubmitted(true);
    } catch (err) {
      setError(readablePlanError(err));
      if (err instanceof PlanApiError && err.status === 409) {
        setConflict(true);
        await load({ form, note });
      }
      if (err instanceof PlanApiError && [403, 404, 410, 423].includes(err.status)) setTerminal(true);
    } finally { setSaving(false); }
  }

  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-5 sm:px-8">
          <a href={`${import.meta.env.BASE_URL.replace(/\/$/, "")}/`} className="text-xl font-bold tracking-tight" data-testid="link-home">dash<span className="font-normal text-muted-foreground"> / catering</span></a>
          <span className="text-xs font-semibold uppercase tracking-[.16em] text-muted-foreground">Event plan revision</span>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-5 pb-28 pt-10 sm:px-8 sm:pt-14">
        {loading ? <div className="space-y-5 animate-pulse" aria-label="Loading plan"><div className="h-10 w-2/3 rounded-xl bg-secondary" /><div className="h-24 rounded-2xl bg-secondary" /><div className="h-48 rounded-2xl bg-secondary" /></div>
          : error && !plan ? <div className="rounded-2xl border border-border bg-card p-8" role="alert" data-testid="status-plan-error"><h1 className="text-2xl font-semibold">We couldn't open this plan</h1><p className="mt-3 text-muted-foreground">{error}</p>{!terminal && <button type="button" onClick={() => void load()} className="mt-5 inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-primary-foreground" data-testid="button-retry-plan"><RefreshCw size={16} /> Try again</button>}</div>
          : plan && form && <>
            {submitted || plan.pending ? <div className="rounded-2xl border border-border bg-card p-6 sm:p-12" data-testid="status-revision-pending"><div className="mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-secondary"><Check size={24} /></div><p className="text-xs font-bold uppercase tracking-[.18em] text-muted-foreground">{unsentDraft ? "Another request is awaiting review" : "Sent to the catering team"}</p><h1 className="mt-3 text-3xl font-semibold tracking-tight">{unsentDraft ? "This plan already has changes in review." : "Your changes are in good hands."}</h1><p className="mt-4 max-w-xl text-muted-foreground">{unsentDraft ? "Your latest edits were not submitted. The team is reviewing an earlier request. Keep a copy of the changes below and contact the catering team if they're important to include." : "We'll review your suggestions and follow up with an updated quote. This request stays connected to your existing inquiry—there's nothing else you need to submit."}</p>{unsentDraft && <div className="mt-6 rounded-xl border border-border bg-secondary/40 p-4 text-sm" data-testid="status-unsent-draft"><h2 className="font-semibold">Your unsent changes</h2><p className="mt-1 text-xs text-muted-foreground">These are only on this screen. They have not reached our team.</p><ul className="mt-3 space-y-1.5">{unsentDraft.form.items.map((item, index) => <li key={`${item.menuItemId}-${item.sizeSlot}-${index}`}>{item.name || menu.find(m => m.id === item.menuItemId)?.name || `Menu item ${item.menuItemId}`} · {menu.find(m => m.id === item.menuItemId)?.sizes?.find(s => s.slot === item.sizeSlot)?.label || item.sizeLabel || "standard"} × {item.quantity}</li>)}</ul><dl className="mt-4 grid gap-x-4 gap-y-2 border-t border-border pt-4 sm:grid-cols-2"><div><dt className="text-xs text-muted-foreground">Date & time</dt><dd>{unsentDraft.form.eventDate?.slice(0, 10) || "Not specified"} · {unsentDraft.form.eventTime || "Not specified"}</dd></div><div><dt className="text-xs text-muted-foreground">Guests</dt><dd>{unsentDraft.form.guestCount ?? "Not specified"}</dd></div><div><dt className="text-xs text-muted-foreground">Venue</dt><dd className="break-words">{unsentDraft.form.venueAddress || "Not specified"}</dd></div><div><dt className="text-xs text-muted-foreground">Menu notes</dt><dd className="whitespace-pre-wrap break-words">{unsentDraft.form.menuNotes || "None"}</dd></div>{unsentDraft.note && <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">Message</dt><dd className="whitespace-pre-wrap break-words">{unsentDraft.note}</dd></div>}</dl></div>}</div>
              : <form onSubmit={submit} className="space-y-10">
                <div><p className="text-xs font-bold uppercase tracking-[.18em] text-muted-foreground">Your event · {plan.inquiry.serviceMode?.replaceAll("_", " ") || "Catering"}</p><h1 className="mt-3 max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">Let's get your menu just right.</h1><p className="mt-4 max-w-2xl text-muted-foreground">Hi {plan.inquiry.clientName}. Adjust your selections below, then send your suggestions back to our team. No new inquiry needed.</p></div>
                <section className="space-y-4" aria-labelledby="menu-heading"><div className="flex items-end justify-between gap-3 border-b border-border pb-3"><div><p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">01 / Your selections</p><h2 id="menu-heading" className="mt-1 text-2xl font-semibold">The menu</h2></div><span className="text-sm text-muted-foreground">{form.items.length} selections</span></div>
                  {form.items.length === 0 && <p className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground" data-testid="status-empty-menu">No items yet. Add something from the menu below.</p>}
                  <div className="space-y-3">{form.items.map((item, index) => {
                    const m = menu.find(x => x.id === item.menuItemId);
                    const sizes = m?.sizes ?? [];
                    return <div key={`${item.menuItemId}-${index}`} className="rounded-2xl border border-border bg-card p-4 sm:p-5" data-testid={`row-revision-item-${index}`}>
                      <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">{m?.name ?? item.name ?? `Menu item ${item.menuItemId}`}</h3><p className="mt-1 text-xs text-muted-foreground">{m?.category || item.sizeLabel || "Your selection"}</p></div><button type="button" onClick={() => removeItem(index)} className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-destructive" aria-label={`Remove ${m?.name ?? item.name}`} data-testid={`button-remove-item-${index}`}><Trash2 size={17} /></button></div>
                      <div className="mt-4 flex flex-wrap items-end gap-3">{sizes.length > 0 && <label className="min-w-36 flex-1 text-xs font-semibold text-muted-foreground">Size<select value={item.sizeSlot ?? sizes[0].slot} onChange={e => changeItem(index, { sizeSlot: Number(e.target.value) })} className={`${inputClass} mt-1`} data-testid={`select-size-${index}`}>{sizes.map(s => <option key={s.slot} value={s.slot}>{s.label} · {money(Number(s.price))}</option>)}</select></label>}<label className="w-28 text-xs font-semibold text-muted-foreground">Quantity<input type="number" min="1" step="1" required value={item.quantity} onChange={e => changeItem(index, { quantity: e.target.value === "" ? 0 : Number(e.target.value) })} className={`${inputClass} mt-1`} data-testid={`input-quantity-${index}`} /></label><span className="mb-3 ml-auto text-sm font-semibold">{money(Number(sizes.find(s => s.slot === item.sizeSlot)?.price ?? m?.price ?? item.unitPrice ?? 0) * (Number(item.quantity) || 0))}</span></div>
                    </div>;
                  })}</div>
                  <div className="rounded-2xl border border-border bg-secondary/30 p-4 sm:p-5"><label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Add from the menu<input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search dishes or categories" className={`${inputClass} mt-2`} data-testid="input-search-menu" /></label><div className="mt-3 max-h-64 divide-y divide-border overflow-y-auto">{filteredMenu.length ? filteredMenu.map(m => <div key={m.id} className="py-3"><p className="text-sm font-semibold">{m.name}</p><p className="mt-0.5 text-xs text-muted-foreground">{m.category}</p><div className="mt-2 flex flex-wrap gap-2">{m.pricingTemplate === "pan_sizes" && m.sizes?.length ? m.sizes.map(size => <button key={size.slot} type="button" onClick={() => addItem(m.id, size.slot)} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold hover:border-primary hover:text-primary" data-testid={`button-add-menu-${m.id}-size-${size.slot}`}><Plus size={14} /> {size.label} · {money(Number(size.price))}</button>) : <button type="button" onClick={() => addItem(m.id)} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold hover:border-primary hover:text-primary" data-testid={`button-add-menu-${m.id}`}><Plus size={14} /> Add · {money(Number(m.price))}</button>}</div></div>) : <p className="py-4 text-sm text-muted-foreground">No matching items.</p>}</div></div>
                </section>
                <section aria-labelledby="details-heading"><p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">02 / The details</p><h2 id="details-heading" className="mt-1 text-2xl font-semibold">Your event</h2><div className="mt-5 grid gap-5 sm:grid-cols-2">
                  <label className="text-sm font-medium">Date<input type="date" value={dateInput(form.eventDate)} onChange={e => setForm({ ...form, eventDate: e.target.value || null })} className={`${inputClass} mt-2`} data-testid="input-event-date" /></label>
                  <label className="text-sm font-medium">Time<input type="time" value={form.eventTime?.slice(0, 5) ?? ""} onChange={e => setForm({ ...form, eventTime: e.target.value || null })} className={`${inputClass} mt-2`} data-testid="input-event-time" /></label>
                  <label className="text-sm font-medium">Guests<input type="number" min="1" step="1" value={form.guestCount ?? ""} onChange={e => setForm({ ...form, guestCount: e.target.value === "" ? null : Number(e.target.value) })} className={`${inputClass} mt-2`} data-testid="input-guest-count" /></label>
                  <label className="text-sm font-medium">Venue / address<input value={form.venueAddress ?? ""} onChange={e => setForm({ ...form, venueAddress: e.target.value })} className={`${inputClass} mt-2`} placeholder="Where should we find you?" data-testid="input-venue" /></label>
                  <label className="text-sm font-medium sm:col-span-2">Menu notes<textarea value={form.menuNotes ?? ""} onChange={e => setForm({ ...form, menuNotes: e.target.value })} rows={3} className={`${inputClass} mt-2 resize-y`} placeholder="Dietary needs, favorites, or anything we should know" data-testid="input-menu-notes" /></label>
                </div></section>
                <section className="rounded-2xl border border-border bg-card p-5 sm:p-7"><p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">03 / Send it back</p><label className="mt-4 block text-sm font-medium">A note for our team (optional)<textarea value={note} onChange={e => setNote(e.target.value)} rows={3} className={`${inputClass} mt-2 resize-y`} placeholder="Tell us what changed or what you're deciding between" data-testid="input-revision-message" /></label><div className="mt-6 flex items-center justify-between gap-4 border-t border-border pt-5"><div><p className="text-xs text-muted-foreground">Indicative menu estimate</p><p className="text-2xl font-semibold" data-testid="text-indicative-estimate">{money(estimate)}</p></div><ChevronRight className="text-muted-foreground" /></div><p className="mt-3 text-xs leading-relaxed text-muted-foreground">Estimate is for menu items only and is not a final quote. Pricing, taxes, service, delivery and other fees are confirmed by the catering team.</p></section>
                {refreshedMessage && <p className="rounded-xl border border-border bg-secondary p-4 text-sm" role="status" data-testid="status-refreshed-plan">{refreshedMessage}</p>}
                {error && <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" data-testid="status-submit-error">{error}{conflict && <button type="button" onClick={() => void load({ form, note })} className="mt-3 flex items-center gap-2 font-semibold underline" data-testid="button-refresh-conflict"><RefreshCw size={15} /> Check latest plan (your unsent edits will be kept)</button>}{terminal && <p className="mt-2">Please request a new link from our team.</p>}</div>}
                <button type="submit" disabled={saving || terminal || conflict} className="flex min-h-13 w-full items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 font-semibold text-primary-foreground transition-opacity hover:opacity-85 disabled:opacity-50 sm:w-auto" data-testid="button-submit-revision"><Send size={17} />{saving ? "Sending changes…" : "Send suggested changes"}</button>
              </form>}
          </>}
      </main>
      <footer className="border-t border-border px-5 py-6 text-center text-xs text-muted-foreground"><ArrowLeft size={12} className="mr-1 inline" /> dash by Hollywood East Cafe · Catering, made personal.</footer>
    </div>
  );
}