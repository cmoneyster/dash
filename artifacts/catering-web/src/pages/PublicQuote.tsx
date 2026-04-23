import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { Loader2, Download, AlertCircle, CalendarDays, MapPin, Users, CreditCard, CheckCircle2 } from "lucide-react";
import { formatCurrency } from "@/lib/utils";

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
  client: {
    name: string;
    organization: string | null;
    email: string | null;
    phone: string | null;
    eventDate: string | null;
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

export default function PublicQuote() {
  const [, params] = useRoute("/quote/:token");
  const token = params?.token;
  const [quote, setQuote] = useState<Quote | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    fetch(`${BASE}/api/quote/${token}`)
      .then(async (r) => {
        if (r.ok) return r.json();
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error || "Quote not found");
      })
      .then((q) => { setQuote(q); setLoading(false); })
      .catch((err) => { setError(err.message); setLoading(false); });
  }, [token]);

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
            <h1 className="font-display text-2xl font-bold mt-1">Hollywood East Cafe</h1>
            <p className="text-xs text-muted-foreground mt-0.5">dash by Hollywood East Cafe</p>
          </div>
          <div className="text-right text-sm">
            <p className="font-mono font-bold text-primary">{quote.quoteNumber ?? "DRAFT"}</p>
            <p className="text-xs text-muted-foreground mt-1">Issued {fmtDate(quote.quoteIssuedAt)}</p>
            {quote.quoteExpiresAt && (
              <p className="text-xs text-muted-foreground">Valid until {fmtDate(quote.quoteExpiresAt)}</p>
            )}
          </div>
        </div>

        {/* Client block */}
        <div className="px-8 py-5 border-b border-border">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Prepared for</p>
          <p className="text-lg font-semibold">{quote.client.name}</p>
          {quote.client.organization && <p className="text-sm">{quote.client.organization}</p>}
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
            {quote.client.eventDate && (
              <span className="inline-flex items-center gap-1.5"><CalendarDays className="w-3.5 h-3.5" />{quote.client.eventDate}</span>
            )}
            {quote.client.guestCount && (
              <span className="inline-flex items-center gap-1.5"><Users className="w-3.5 h-3.5" />{quote.client.guestCount} guests</span>
            )}
            {quote.client.venueAddress && (
              <span className="inline-flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5" />{quote.client.venueAddress}</span>
            )}
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
          </div>
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
          <div className="px-8 py-5 border-t border-border bg-violet-50/40">
            {quote.square.paidInFullAt ? (
              <div className="flex items-center gap-2 text-emerald-700">
                <CheckCircle2 className="w-5 h-5" />
                <p className="font-semibold">Paid in full — thank you!</p>
              </div>
            ) : (
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="text-sm">
                  {quote.square.depositPaidAt ? (
                    <>
                      <p className="font-semibold text-emerald-700">Deposit received: {formatCurrency(quote.square.amountPaid)}</p>
                      <p className="text-muted-foreground">Remaining balance: <strong>{formatCurrency(quote.square.balanceDue)}</strong></p>
                    </>
                  ) : (
                    <p className="text-muted-foreground">
                      Balance due: <strong className="text-foreground">{formatCurrency(quote.square.balanceDue || quote.total)}</strong>
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

        {/* Actions */}
        <div className="px-8 py-5 border-t border-border flex items-center justify-between flex-wrap gap-3">
          <p className="text-xs text-muted-foreground">
            Reply to your email or text to confirm or request changes.
          </p>
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
