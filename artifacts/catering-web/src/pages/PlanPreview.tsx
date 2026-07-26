import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Layout } from "@/components/Layout";
import { useGetPlan } from "@workspace/api-client-react";
import { getSessionId } from "@/lib/session";
import { formatCurrency } from "@/lib/utils";
import {
  Sparkles, Share2, Copy, CheckCheck, MessageSquare, ArrowRight,
  Loader2, Send, ChefHat, ExternalLink,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// ── Helpers ──────────────────────────────────────────────────────────────────

function readPlanItemsAdded(sessionId: string): number | null {
  try {
    const raw = localStorage.getItem(`chat_messages_${sessionId}`);
    if (!raw) return null;
    const p = JSON.parse(raw) as { planItemsAdded?: number | null };
    return typeof p.planItemsAdded === "number" && p.planItemsAdded > 0
      ? p.planItemsAdded
      : null;
  } catch {
    return null;
  }
}

function buildShareUrl(shareToken: string): string {
  const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
  return `${window.location.origin}${base}/plan/share/${shareToken}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PlanPreview() {
  const sessionId = getSessionId();
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const { data: plan, isLoading } = useGetPlan({ sessionId });
  const [planItemsAdded] = useState<number | null>(() =>
    readPlanItemsAdded(sessionId),
  );

  // ── Share state ──
  const [shareLoading, setShareLoading] = useState(false);
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [showSharePanel, setShowSharePanel] = useState(false);

  const shareUrl = shareToken ? buildShareUrl(shareToken) : null;

  const handleShare = async () => {
    setShowSharePanel(true);
    if (shareToken) return;
    setShareLoading(true);
    try {
      const res = await fetch("/api/plan/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) throw new Error("Failed to create share link");
      const data = await res.json() as { shareToken: string; expiresAt: string };
      setShareToken(data.shareToken);
    } catch {
      toast({
        title: "Error",
        description: "Could not create share link. Please try again.",
        variant: "destructive",
      });
      setShowSharePanel(false);
    } finally {
      setShareLoading(false);
    }
  };

  const handleCopyLink = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2500);
    } catch {
      toast({
        title: "Could not copy",
        description: "Select and copy the link manually.",
        variant: "destructive",
      });
    }
  };

  const handleSmsShare = () => {
    if (!shareUrl) return;
    const body = encodeURIComponent(
      `Here's my catering plan — take a look: ${shareUrl}`,
    );
    window.open(`sms:?body=${body}`, "_self");
  };

  // Redirect if plan is empty and still empty after load
  useEffect(() => {
    if (!isLoading && plan && plan.items.length === 0) {
      navigate("/plan");
    }
  }, [isLoading, plan, navigate]);

  const items = plan?.items ?? [];

  // Group items by category for display
  const byCategory = items.reduce<Record<string, typeof items>>((acc, item) => {
    const cat = item.menuItem.category;
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(item);
    return acc;
  }, {});
  const categories = Object.keys(byCategory);

  return (
    <Layout>
      <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">

        {/* ── Dashy banner ── */}
        {planItemsAdded !== null && planItemsAdded > 0 && (
          <div className="flex items-start gap-3 bg-primary/8 border border-primary/20 rounded-2xl px-5 py-4">
            <div className="w-9 h-9 shrink-0 rounded-full bg-primary/15 flex items-center justify-center mt-0.5">
              <ChefHat className="w-5 h-5 text-primary" />
            </div>
            <div>
              <p className="font-semibold text-foreground">
                We added{" "}
                <span className="text-primary">
                  {planItemsAdded} item{planItemsAdded !== 1 ? "s" : ""}
                </span>{" "}
                to your plan
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">
                Review what was recommended below, then request a quote or
                customize the quantities.
              </p>
            </div>
          </div>
        )}

        {/* ── Header ── */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-display font-bold text-2xl">Your Event Plan</h1>
            <p className="text-muted-foreground text-sm mt-0.5">
              {isLoading
                ? "Loading…"
                : `${items.length} item${items.length !== 1 ? "s" : ""} selected`}
            </p>
          </div>
          {!isLoading && items.length > 0 && (
            <button
              onClick={handleShare}
              className="flex items-center gap-2 px-4 py-2 rounded-xl border border-border bg-card hover:bg-secondary transition-colors text-sm font-medium"
            >
              <Share2 className="w-4 h-4" />
              Share
            </button>
          )}
        </div>

        {/* ── Share panel ── */}
        {showSharePanel && (
          <div className="bg-card border border-border rounded-2xl p-5 space-y-4 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-base">Share this plan</h2>
              <button
                onClick={() => setShowSharePanel(false)}
                className="text-muted-foreground hover:text-foreground transition-colors text-sm"
              >
                Close
              </button>
            </div>
            {shareLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm py-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Creating link…
              </div>
            ) : shareUrl ? (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={shareUrl}
                    className="flex-1 px-3 py-2 bg-background border border-border rounded-xl text-sm font-mono text-muted-foreground focus:outline-none"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <button
                    onClick={handleCopyLink}
                    className="flex items-center gap-1.5 px-3 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-semibold hover:bg-primary/90 transition-colors shrink-0"
                  >
                    {linkCopied ? (
                      <><CheckCheck className="w-4 h-4" /> Copied!</>
                    ) : (
                      <><Copy className="w-4 h-4" /> Copy</>
                    )}
                  </button>
                </div>
                <button
                  onClick={handleSmsShare}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 border border-border rounded-xl text-sm font-medium hover:bg-secondary transition-colors"
                >
                  <MessageSquare className="w-4 h-4" />
                  Send via SMS
                </button>
                <p className="text-xs text-muted-foreground text-center">
                  Anyone with the link can view and add to this plan.
                </p>
              </div>
            ) : null}
          </div>
        )}

        {/* ── Plan items ── */}
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
            <Loader2 className="w-8 h-8 animate-spin" />
            <p className="text-sm">Loading your plan…</p>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-4 text-center">
            <div className="w-14 h-14 rounded-full bg-secondary flex items-center justify-center">
              <Sparkles className="w-7 h-7 text-muted-foreground" />
            </div>
            <div>
              <p className="font-semibold text-foreground">No items yet</p>
              <p className="text-sm text-muted-foreground mt-1">
                Browse the menu and add items to your plan.
              </p>
            </div>
            <Link
              href="/menu"
              className="flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground rounded-xl font-semibold text-sm hover:bg-primary/90 transition-colors"
            >
              Browse menu <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            {categories.map((cat) => (
              <div key={cat} className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
                <div className="px-5 py-3 border-b border-border">
                  <h2 className="font-semibold text-sm uppercase tracking-wider text-muted-foreground">
                    {cat}
                  </h2>
                </div>
                <div className="divide-y divide-border">
                  {byCategory[cat].map((item) => (
                    <div key={item.id} className="flex items-center gap-4 px-5 py-4">
                      {item.menuItem.imageUrl && (
                        <img
                          src={item.menuItem.imageUrl}
                          alt={item.menuItem.name}
                          className="w-14 h-14 rounded-xl object-cover shrink-0"
                        />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-foreground truncate">
                          {item.menuItem.name}
                        </p>
                        {item.menuItem.description && (
                          <p className="text-sm text-muted-foreground mt-0.5 line-clamp-2">
                            {item.menuItem.description}
                          </p>
                        )}
                        {item.menuItem.allergens && item.menuItem.allergens.length > 0 && (
                          <p className="text-xs text-muted-foreground/70 mt-1">
                            {item.menuItem.allergens.join(" · ")}
                          </p>
                        )}
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="font-bold text-foreground">
                          {formatCurrency(item.menuItem.price)}
                        </p>
                        <p className="text-xs text-muted-foreground">per unit</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Bottom CTAs ── */}
        {!isLoading && items.length > 0 && (
          <div className="space-y-3 pt-2">
            {/* Primary: Request a Quote */}
            <Link
              href="/plan?openInquiry=1"
              className="w-full flex items-center justify-center gap-2 px-5 py-3.5 bg-primary text-primary-foreground rounded-2xl font-bold text-base hover:bg-primary/90 transition-colors shadow-lg shadow-primary/20"
            >
              <Send className="w-5 h-5" />
              Request a Quote
            </Link>

            {/* Secondary: Customize quantities */}
            <Link
              href="/plan"
              className="w-full flex items-center justify-center gap-2 px-5 py-3 border border-border rounded-2xl font-semibold text-sm text-foreground hover:bg-secondary transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
              Customize quantities &amp; serving sizes
            </Link>
          </div>
        )}

      </div>
    </Layout>
  );
}
