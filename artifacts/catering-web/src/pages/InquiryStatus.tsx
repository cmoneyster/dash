import { useEffect, useState } from "react";
import { useParams, Link } from "wouter";
import { CheckCircle, Calendar, Users, Truck, Clock, ChefHat } from "lucide-react";

interface InquiryData {
  id: number;
  clientName: string;
  eventDate: string | null;
  guestCount: number | null;
  serviceMode: string;
  status: string;
  createdAt: string;
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m) return `${m[2]}/${m[3]}/${m[1]}`;
  return iso;
}

function serviceModeLabel(mode: string): string {
  if (mode === "on_the_dash") return "On the Dash (food trailer)";
  return "Standard Drop-Off";
}

export default function InquiryStatus() {
  const { id } = useParams<{ id: string }>();
  const [inquiry, setInquiry] = useState<InquiryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    fetch(`/api/chat/inquiry/${encodeURIComponent(id)}`)
      .then(async (res) => {
        if (res.status === 404) { setNotFound(true); return; }
        if (!res.ok) throw new Error("Failed to fetch");
        setInquiry(await res.json());
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <ChefHat className="w-8 h-8 animate-pulse" />
          <p className="text-sm">Loading your inquiry…</p>
        </div>
      </div>
    );
  }

  if (notFound || !inquiry) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="max-w-md text-center space-y-4">
          <h1 className="text-2xl font-bold text-foreground">Inquiry not found</h1>
          <p className="text-muted-foreground">
            We couldn't find this inquiry. It may have been submitted under a different session.
          </p>
          <Link
            href="/"
            className="inline-block mt-2 px-6 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            Back to home
          </Link>
        </div>
      </div>
    );
  }

  const eventDate = formatDate(inquiry.eventDate);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4 py-16">
      <div className="w-full max-w-lg space-y-8">
        {/* Success header */}
        <div className="text-center space-y-3">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-100 dark:bg-emerald-950/40">
            <CheckCircle className="w-9 h-9 text-emerald-600 dark:text-emerald-400" />
          </div>
          <h1 className="text-3xl font-bold text-foreground">
            We've got your request!
          </h1>
          <p className="text-muted-foreground max-w-sm mx-auto leading-relaxed">
            Thanks, <strong>{inquiry.clientName}</strong>. A member of the dash team will be
            in touch with you shortly.
          </p>
        </div>

        {/* Details card */}
        <div className="rounded-2xl border border-border bg-card shadow-sm divide-y divide-border">
          <div className="px-6 py-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Inquiry summary
            </p>
            <dl className="space-y-3">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 w-8 h-8 rounded-lg bg-secondary flex items-center justify-center shrink-0">
                  <Clock className="w-4 h-4 text-muted-foreground" />
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Reference</dt>
                  <dd className="font-semibold text-foreground">Inquiry #{inquiry.id}</dd>
                </div>
              </div>

              {eventDate && (
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 w-8 h-8 rounded-lg bg-secondary flex items-center justify-center shrink-0">
                    <Calendar className="w-4 h-4 text-muted-foreground" />
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Event date</dt>
                    <dd className="font-semibold text-foreground">{eventDate}</dd>
                  </div>
                </div>
              )}

              {inquiry.guestCount != null && (
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 w-8 h-8 rounded-lg bg-secondary flex items-center justify-center shrink-0">
                    <Users className="w-4 h-4 text-muted-foreground" />
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Guests</dt>
                    <dd className="font-semibold text-foreground">{inquiry.guestCount}</dd>
                  </div>
                </div>
              )}

              <div className="flex items-start gap-3">
                <div className="mt-0.5 w-8 h-8 rounded-lg bg-secondary flex items-center justify-center shrink-0">
                  <Truck className="w-4 h-4 text-muted-foreground" />
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Service style</dt>
                  <dd className="font-semibold text-foreground">{serviceModeLabel(inquiry.serviceMode)}</dd>
                </div>
              </div>
            </dl>
          </div>

          <div className="px-6 py-4 bg-secondary/30 rounded-b-2xl">
            <p className="text-sm text-muted-foreground leading-relaxed">
              Have questions in the meantime? Email us at{" "}
              <a
                href="mailto:dash@HollywoodEastCafe.com"
                className="text-primary font-medium hover:underline"
              >
                dash@HollywoodEastCafe.com
              </a>
              {" "}and mention your inquiry number above.
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-3">
          <Link
            href="/menu"
            className="flex-1 text-center px-5 py-3 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-secondary transition-colors"
          >
            Browse the menu
          </Link>
          <Link
            href="/plan"
            className="flex-1 text-center px-5 py-3 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            Build your plan
          </Link>
        </div>
      </div>
    </div>
  );
}
