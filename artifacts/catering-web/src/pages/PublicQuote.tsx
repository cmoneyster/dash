import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { Loader2, Download, AlertCircle, CalendarDays, Clock, MapPin, Users, CreditCard, CheckCircle2, MessageSquare, Check, X, Mail, Phone } from "lucide-react";
import { computeOtdSetupFeeWaivedDisplay } from "@workspace/pricing";
import { formatCurrency } from "@/lib/utils";
import { TAX_DISCLOSURE, TAX_DISCLOSURE_SHORT } from "@/lib/tax";
import {
  PAYMENT_TERMS_TITLE,
  PAYMENT_TERMS_BULLETS,
  NOT_PROVIDED,
} from "@/lib/quote-copy";
import { formatLocalDate, isDateOnlyString } from "@/lib/date";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type Adjustment = {
  id: string;
  label: string;
  kind: "fixed" | "percent";
  amount: number;
  computed: number;
};

type LineItem = {
  id: string;
  name: string;
  quantity: number;
  unitPrice: number;
  notes?: string | null;
  lineTotal: number;
  pricingTemplate?: "per_unit" | "pan_sizes" | null;
  sizeLabel?: string | null;
  sizeServings?: number | null;
  unit?: string | null;
  servingSize?: number | null;
};

function lineDescriptor(li: LineItem): string | null {
  if (li.pricingTemplate === "pan_sizes" && li.sizeLabel) {
    return li.sizeServings != null
      ? `${li.sizeLabel} · ${li.sizeServings} servings`
      : li.sizeLabel;
  }
  if (li.unit) {
    return li.servingSize && li.servingSize > 1
      ? `${li.unit} of ${li.servingSize}`
      : `per ${li.unit}`;
  }
  return null;
}

type Quote = {
  quoteNumber: string | null;
  quoteIssuedAt: string | null;
  quoteExpiresAt: string | null;
  quoteNotes: string | null;
  acceptedAt: string | null;
  changeRequestAt: string | null;
  changeRequestMessage: string | null;
  client: {
    name: string;
    organization: string | null;
    email: string | null;
    phone: string | null;
    eventDate: string | null;
    eventTime: string | null;
    guestCount: number | null;
    venueAddress: string | null;
  };
  lineItems: LineItem[];
  subtotal: number;
  fees: Adjustment[];
  feesTotal: number;
  discounts: Adjustment[];
  discountsTotal: number;
  total: number;
  // OTD snapshot fields — used to render a struck-through "setup fee
  // waived (minimum met)" ghost row in the totals block when the food
  // subtotal cleared the per-inquiry waiver threshold.
  serviceMode: string | null;
  otdSetupFee: number | null;
  otdFeeWaiverThreshold: number | null;
  offlinePayments: Array<{ id: string; amount: number; method: string; date: string }>;
  offlinePaidTotal: number;
  square: {
    status: string | null;
    hostedUrl: string | null;
    amountPaid: number;
    balanceDue: number;
    depositPaidAt: string | null;
    paidInFullAt: string | null;
  } | null;
};

function fmtDate(d: string | null) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  } catch { return d; }
}

function fmtDeliveryWindow(time: string | null | undefined): string {
  if (!time) return "";
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return time;
  const startH = parseInt(match[1], 10);
  const startM = parseInt(match[2], 10);
  if (startH > 23 || startM > 59) return time;
  const endTotalMin = startH * 60 + startM + 30;
  const endH = Math.floor(endTotalMin / 60) % 24;
  const endM = endTotalMin % 60;
  const fmt12 = (h: number, m: number) => {
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, "0")}`;
  };
  const startPeriod = startH < 12 ? "AM" : "PM";
  const endPeriod = endH < 12 ? "AM" : "PM";
  if (startPeriod === endPeriod) return `${fmt12(startH, startM)}–${fmt12(endH, endM)} ${startPeriod}`;
  return `${fmt12(startH, startM)} ${startPeriod}–${fmt12(endH, endM)} ${endPeriod}`;
}

export default function PublicQuote() {
  const [, params] = useRoute("/quote/:token");
  const token = params?.token;
  const [quote, setQuote] = useState<Quote | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showChangeForm, setShowChangeForm] = useState(false);
  const [changeMessage, setChangeMessage] = useState("");
  const [submitting, setSubmitting] = useState<null | "accept" | "changes">(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Editable delivery date/time — pre-populated from quote when it loads.
  const [acceptDate, setAcceptDate] = useState("");
  const [acceptTime, setAcceptTime] = useState("");
  // Whether the user has opened the "change delivery details" panel when
  // both values are already set (allows corrections without a 422 round-trip).
  const [showDateTimeEdit, setShowDateTimeEdit] = useState(false);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    fetch(`${BASE}/api/quote/${token}`)
      .then(async (r) => {
        if (r.ok) return r.json();
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error || "Quote not found");
      })
      .then((q: Quote) => {
        setQuote(q);
        // Pre-populate date/time inputs from whatever the inquiry already has
        // so the confirm/change flow works without the user having to retype.
        setAcceptDate(q.client.eventDate ?? "");
        setAcceptTime(q.client.eventTime ?? "");
        setLoading(false);
      })
      .catch((err) => { setError(err.message); setLoading(false); });
  }, [token]);

  async function acceptQuote() {
    if (!token || submitting) return;
    setSubmitting("accept"); setActionError(null);
    try {
      // Always send current acceptDate/acceptTime so the server can store or
      // correct them. Body values take precedence over whatever is on the inquiry.
      const r = await fetch(`${BASE}/api/quote/${token}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventDate: acceptDate || undefined, eventTime: acceptTime || undefined }),
      });
      const data = await r.json();
      if (r.status === 422) {
        // Shouldn't normally reach here (inputs are required before enabling Accept),
        // but handle gracefully as a safety net.
        setActionError(data.error || "Delivery date and time are required.");
        return;
      }
      if (!r.ok) { setActionError(data.error || "Could not accept quote."); return; }
      setQuote(data);
      setShowChangeForm(false);
      setShowDateTimeEdit(false);
    } catch {
      setActionError("Could not accept quote. Please try again.");
    } finally {
      setSubmitting(null);
    }
  }

  async function submitChangeRequest() {
    if (!token || submitting) return;
    if (!changeMessage.trim()) { setActionError("Please describe the changes you'd like."); return; }
    setSubmitting("changes"); setActionError(null);
    try {
      const r = await fetch(`${BASE}/api/quote/${token}/request-changes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: changeMessage.trim() }),
      });
      const data = await r.json();
      if (!r.ok) { setActionError(data.error || "Could not submit changes."); return; }
      setQuote(data);
      setShowChangeForm(false);
      setChangeMessage("");
    } catch {
      setActionError("Could not submit changes. Please try again.");
    } finally {
      setSubmitting(null);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-secondary/30">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !quote) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-secondary/30 p-6">
        <div className="bg-card max-w-md w-full p-8 rounded-2xl border border-border text-center">
          <AlertCircle className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
          <h1 className="font-display text-xl font-bold mb-2">Quote not available</h1>
          <p className="text-sm text-muted-foreground">{error ?? "This link may have expired."}</p>
        </div>
      </div>
    );
  }

  const pdfUrl = `${BASE}/api/quote/${token}/pdf`;

  return (
    <div className="min-h-screen bg-secondary/30 py-8 px-4">
      <div className="max-w-3xl mx-auto bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
        {/* Header */}
        <div className="px-8 py-6 border-b border-border flex items-start justify-between gap-4 bg-gradient-to-br from-primary/5 to-transparent">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Catering Quote</p>
            <h1 className="font-display text-2xl font-bold mt-1">dash Catering</h1>
            <p className="text-xs text-muted-foreground mt-0.5">by Hollywood East Cafe</p>
          </div>
          <div className="text-right text-sm">
            <p className="font-mono font-bold text-primary">{quote.quoteNumber ?? "DRAFT"}</p>
            <p className="text-xs text-muted-foreground mt-1">Issued {fmtDate(quote.quoteIssuedAt)}</p>
            {quote.quoteExpiresAt && (
              <p className="text-xs text-muted-foreground">Valid until {fmtDate(quote.quoteExpiresAt)}</p>
            )}
          </div>
        </div>

        {/* Client block — always renders contact + event rows with a
            placeholder so missing fields don't collapse the layout. */}
        <div className="px-8 py-5 border-b border-border grid gap-5 sm:grid-cols-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Prepared for</p>
            <p className="text-lg font-semibold">{quote.client.name}</p>
            {quote.client.organization && <p className="text-sm">{quote.client.organization}</p>}
            <div className="mt-2 space-y-1 text-sm text-muted-foreground">
              <p className="flex items-center gap-1.5">
                <Mail className="w-3.5 h-3.5 flex-shrink-0" />
                <span>{quote.client.email?.trim() || NOT_PROVIDED}</span>
              </p>
              <p className="flex items-center gap-1.5">
                <Phone className="w-3.5 h-3.5 flex-shrink-0" />
                <span>{quote.client.phone?.trim() || NOT_PROVIDED}</span>
              </p>
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Event Details</p>
            <div className="space-y-1 text-sm text-muted-foreground">
              <p className="flex items-center gap-1.5">
                <CalendarDays className="w-3.5 h-3.5 flex-shrink-0" />
                <span>{quote.client.eventDate && isDateOnlyString(quote.client.eventDate) ? formatLocalDate(quote.client.eventDate) : (quote.client.eventDate?.trim() || NOT_PROVIDED)}</span>
              </p>
              {quote.client.eventTime && (
                <p className="flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 flex-shrink-0" />
                  <span>Delivery {fmtDeliveryWindow(quote.client.eventTime)}</span>
                </p>
              )}
              <p className="flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 flex-shrink-0" />
                <span>{quote.client.guestCount ? `${quote.client.guestCount} guests` : NOT_PROVIDED}</span>
              </p>
              <p className="flex items-start gap-1.5">
                <MapPin className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>{quote.client.venueAddress?.trim() || NOT_PROVIDED}</span>
              </p>
            </div>
          </div>
        </div>

        {/* Items */}
        <div className="px-8 py-5">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b border-border">
                <th className="py-2">Item</th>
                <th className="py-2 text-right w-16">Qty</th>
                <th className="py-2 text-right w-24">Unit</th>
                <th className="py-2 text-right w-24">Total</th>
              </tr>
            </thead>
            <tbody>
              {quote.lineItems.length === 0 && (
                <tr><td colSpan={4} className="py-6 text-center text-muted-foreground italic">No items yet</td></tr>
              )}
              {quote.lineItems.map((li) => {
                const desc = lineDescriptor(li);
                return (
                <tr key={li.id} className="border-b border-border/40 last:border-0">
                  <td className="py-3">
                    <p className="font-medium">{li.name}</p>
                    {desc && <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>}
                    {li.notes && <p className="text-xs text-muted-foreground mt-0.5 italic">{li.notes}</p>}
                  </td>
                  <td className="py-3 text-right">{li.quantity}</td>
                  <td className="py-3 text-right text-muted-foreground">{formatCurrency(li.unitPrice)}</td>
                  <td className="py-3 text-right font-semibold">{formatCurrency(li.lineTotal)}</td>
                </tr>
                );
              })}
            </tbody>
          </table>

          {/* Totals */}
          <div className="mt-4 ml-auto max-w-xs space-y-1 text-sm">
            <div className="flex justify-between py-1">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="font-medium">{formatCurrency(quote.subtotal)}</span>
            </div>
            {quote.fees.map((f) => (
              <div key={f.id} className="flex justify-between py-1">
                <span className="text-muted-foreground">{f.label}{f.kind === "percent" ? ` (${f.amount}%)` : ""}</span>
                <span>{formatCurrency(f.computed)}</span>
              </div>
            ))}
            {(() => {
              // Ghost row for the OTD setup fee when it was waived because
              // the food subtotal cleared the per-inquiry threshold. The fee
              // is already absent from `quote.fees` (the shared pricing helper
              // strips it), so this is purely informational — the original
              // amount is shown crossed out with a small "Waived" caption so
              // the customer can see what they saved.
              const waived = computeOtdSetupFeeWaivedDisplay(
                quote.serviceMode,
                quote.otdSetupFee,
                quote.otdFeeWaiverThreshold,
                quote.subtotal,
              );
              if (!waived) return null;
              return (
                <div key="otd-waived-display" className="py-1">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{waived.label}</span>
                    <span className="text-muted-foreground line-through">
                      {formatCurrency(waived.originalAmount)}
                    </span>
                  </div>
                  <div className="text-right text-xs text-emerald-700">
                    Waived — order met {formatCurrency(waived.waiverThreshold)} minimum
                  </div>
                </div>
              );
            })()}
            {quote.discounts.map((d) => (
              <div key={d.id} className="flex justify-between py-1 text-emerald-700">
                <span>{d.label}{d.kind === "percent" ? ` (${d.amount}%)` : ""}</span>
                <span>-{formatCurrency(d.computed)}</span>
              </div>
            ))}
            <div className="flex justify-between py-2 border-t border-border mt-2 font-bold text-base">
              <span>Total</span>
              <span className="text-primary">{formatCurrency(quote.total)}</span>
            </div>
            <p className="text-xs text-muted-foreground text-right pt-1">{TAX_DISCLOSURE}</p>
            {(quote.offlinePayments?.length ?? 0) > 0 && (() => {
              const pmtLabel = (m: string) =>
                m === "check" ? "Check" : m === "cash" ? "Cash" : m === "wire" ? "Wire transfer" : "Payment";
              const remaining = Math.max(0, quote.total - (quote.offlinePaidTotal ?? 0));
              return (
                <>
                  <div className="border-t border-border mt-3 pt-2 space-y-1">
                    {quote.offlinePayments.map((p) => (
                      <div key={p.id} className="flex justify-between py-0.5 text-emerald-700 dark:text-emerald-400 text-sm">
                        <span>Deposit received ({pmtLabel(p.method)})</span>
                        <span>-{formatCurrency(p.amount)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-between py-2 border-t border-border mt-2 font-bold text-base">
                    <span>Balance due</span>
                    <span className="text-primary">{formatCurrency(remaining)}</span>
                  </div>
                </>
              );
            })()}
          </div>
        </div>

        {/* Payment Terms */}
        <div className="px-8 py-5 border-t border-border bg-secondary/20">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            {PAYMENT_TERMS_TITLE}
          </p>
          <ul className="space-y-1.5 text-sm">
            {PAYMENT_TERMS_BULLETS.map((bullet) => (
              <li key={bullet} className="flex gap-2">
                <span className="text-muted-foreground" aria-hidden>•</span>
                <span>{bullet}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Notes */}
        {quote.quoteNotes && (
          <div className="px-8 py-5 border-t border-border bg-secondary/40">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Notes</p>
            <p className="text-sm whitespace-pre-wrap">{quote.quoteNotes}</p>
          </div>
        )}

        {/* Square payment status */}
        {quote.square && (
          <div className="px-8 py-5 border-t border-border bg-violet-50/40 dark:bg-violet-950/40">
            {quote.square.paidInFullAt ? (
              <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="w-5 h-5" />
                <p className="font-semibold">Paid in full — thank you!</p>
              </div>
            ) : (
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="text-sm">
                  {quote.square.depositPaidAt ? (
                    <>
                      <p className="font-semibold text-emerald-700 dark:text-emerald-400">Deposit received: {formatCurrency(quote.square.amountPaid)}</p>
                      <p className="text-muted-foreground">Remaining balance: <strong>{formatCurrency(quote.square.balanceDue)}</strong></p>
                    </>
                  ) : (
                    <p className="text-muted-foreground">
                      Balance due: <strong className="text-foreground">{formatCurrency(quote.square.balanceDue || quote.total)}</strong>
                      <span className="ml-2 text-xs">({TAX_DISCLOSURE_SHORT})</span>
                    </p>
                  )}
                </div>
                {quote.square.hostedUrl && (
                  <a
                    href={quote.square.hostedUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 px-5 py-2.5 bg-violet-600 text-white font-semibold rounded-xl hover:bg-violet-700 transition-colors text-sm shadow-sm"
                  >
                    <CreditCard className="w-4 h-4" />
                    {quote.square.depositPaidAt ? "Pay remaining balance" : "Pay invoice"}
                  </a>
                )}
              </div>
            )}
          </div>
        )}

        {/* Client response state */}
        {quote.acceptedAt ? (
          <div className="px-8 py-5 border-t border-border bg-emerald-50/60 dark:bg-emerald-950/40">
            <div className="flex items-center gap-2 text-emerald-800 dark:text-emerald-400">
              <CheckCircle2 className="w-5 h-5" />
              <p className="font-semibold">Quote accepted on {fmtDate(quote.acceptedAt)} — thank you!</p>
            </div>
            <p className="text-xs text-emerald-700/80 dark:text-emerald-500/80 mt-1 ml-7">
              We'll be in touch with next steps. Reach out anytime if anything changes.
            </p>
          </div>
        ) : quote.changeRequestAt ? (
          <div className="px-8 py-5 border-t border-border bg-amber-50/60 dark:bg-amber-950/40">
            <div className="flex items-center gap-2 text-amber-800 dark:text-amber-400">
              <MessageSquare className="w-5 h-5" />
              <p className="font-semibold">Changes requested on {fmtDate(quote.changeRequestAt)}</p>
            </div>
            {quote.changeRequestMessage && (
              <p className="text-sm text-amber-900 dark:text-amber-300 mt-2 ml-7 whitespace-pre-wrap italic">"{quote.changeRequestMessage}"</p>
            )}
            <p className="text-xs text-amber-700/80 dark:text-amber-500/80 mt-2 ml-7">
              We'll review and follow up shortly. You can still accept this quote below if you change your mind.
            </p>
          </div>
        ) : null}

        {/* Actions */}
        {!quote.acceptedAt && (
          <div className="px-8 py-5 border-t border-border space-y-3">
            {(() => {
              const missingDate = !quote.client.eventDate;
              const missingTime = !quote.client.eventTime;
              const needsInput = missingDate || missingTime || showDateTimeEdit;
              return needsInput ? (
                <div className={`rounded-xl border p-4 space-y-3 ${missingDate || missingTime ? "border-amber-300 dark:border-amber-800/50 bg-amber-50/60 dark:bg-amber-950/40" : "border-border bg-secondary/30"}`}>
                  {(missingDate || missingTime) && (
                    <p className="text-sm font-semibold text-amber-800 dark:text-amber-400">
                      {missingDate && missingTime
                        ? "A delivery date and time are required to confirm your order."
                        : missingDate
                          ? "A delivery date is required to confirm your order."
                          : "A delivery time is required to confirm your order."}
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-muted-foreground mb-1">Event Date</label>
                      <input
                        type="date"
                        value={acceptDate}
                        onChange={e => setAcceptDate(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-border rounded-xl bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-muted-foreground mb-1">Delivery Time</label>
                      <input
                        type="time"
                        value={acceptTime}
                        onChange={e => setAcceptTime(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-border rounded-xl bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                      />
                    </div>
                  </div>
                  {showDateTimeEdit && (
                    <button
                      type="button"
                      onClick={() => { setShowDateTimeEdit(false); setAcceptDate(quote.client.eventDate ?? ""); setAcceptTime(quote.client.eventTime ?? ""); }}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Clock className="w-4 h-4 flex-shrink-0" />
                  <span>Delivery {fmtDeliveryWindow(quote.client.eventTime)}</span>
                  <button
                    type="button"
                    onClick={() => setShowDateTimeEdit(true)}
                    className="ml-1 text-xs text-primary hover:underline"
                  >
                    Change
                  </button>
                </div>
              );
            })()}
            {!showChangeForm ? (
              <div className="flex items-center justify-between flex-wrap gap-3">
                <p className="text-xs text-muted-foreground">
                  Ready to move forward, or have a few tweaks in mind?
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => { setShowChangeForm(true); setActionError(null); }}
                    disabled={submitting !== null}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-secondary text-foreground font-semibold rounded-xl hover:bg-border transition-colors text-sm disabled:opacity-50"
                  >
                    <MessageSquare className="w-4 h-4" /> Request Changes
                  </button>
                  <button
                    type="button"
                    onClick={acceptQuote}
                    disabled={
                      submitting !== null ||
                      // If either stored field is missing, OR the edit panel is open,
                      // require the user to provide non-empty values for both fields.
                      ((!quote.client.eventDate || !quote.client.eventTime || showDateTimeEdit) &&
                        (!acceptDate || !acceptTime))
                    }
                    className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white font-semibold rounded-xl hover:bg-emerald-700 transition-colors text-sm disabled:opacity-50"
                  >
                    {submitting === "accept" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    Accept Quote
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  What would you like to change?
                </label>
                <textarea
                  value={changeMessage}
                  onChange={(e) => setChangeMessage(e.target.value)}
                  rows={4}
                  maxLength={2000}
                  placeholder="e.g., Could we swap the salad for the pasta tray? Also need to bump guest count to 35."
                  className="w-full px-3 py-2 text-sm border border-border rounded-xl bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none resize-y"
                />
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => { setShowChangeForm(false); setActionError(null); }}
                    disabled={submitting !== null}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                  >
                    <X className="w-4 h-4" /> Cancel
                  </button>
                  <button
                    type="button"
                    onClick={submitChangeRequest}
                    disabled={submitting !== null || !changeMessage.trim()}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors text-sm disabled:opacity-50"
                  >
                    {submitting === "changes" ? <Loader2 className="w-4 h-4 animate-spin" /> : <MessageSquare className="w-4 h-4" />}
                    Send Request
                  </button>
                </div>
              </div>
            )}
            {actionError && <p className="text-xs text-red-600">{actionError}</p>}
          </div>
        )}

        {/* Footer */}
        <div className="px-8 py-5 border-t border-border flex items-center justify-end">
          <a
            href={pdfUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors text-sm"
          >
            <Download className="w-4 h-4" /> Download PDF
          </a>
        </div>
      </div>
    </div>
  );
}
