import { useState, useEffect, useCallback } from "react";
import { useParams, Link } from "wouter";
import { Layout } from "@/components/Layout";
import { formatCurrency } from "@/lib/utils";
import { getSessionId } from "@/lib/session";
import { Trash2, ShoppingBag, Heart, Users, AlertTriangle, Copy, CheckCheck, Loader2 } from "lucide-react";
import { ImageLightbox } from "@/components/ImageLightbox";
import { useToast } from "@/hooks/use-toast";

type MenuItemData = {
  id: number;
  name: string;
  category: string;
  description: string | null;
  price: number;
  imageUrl: string | null;
  allergens: string[];
};

type PlanItem = {
  id: number;
  menuItemId: number;
  menuItem: MenuItemData;
};

type SharedPlanData = {
  sessionId: string;
  shareToken: string;
  planName: string | null;
  expiresAt: string;
  items: PlanItem[];
};

function daysUntil(dateStr: string) {
  const diff = new Date(dateStr).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

export default function SharedPlan() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const { toast } = useToast();
  const sessionId = getSessionId();
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  const [plan, setPlan] = useState<SharedPlanData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [copying, setCopying] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [allMenuItems, setAllMenuItems] = useState<MenuItemData[]>([]);
  const [addingId, setAddingId] = useState<number | null>(null);

  const fetchPlan = useCallback(async () => {
    try {
      const res = await fetch(`/api/plan/share/${token}`);
      if (res.status === 404) { setError("This plan link is invalid or does not exist."); return; }
      if (res.status === 410) { setError("This shared plan has expired (links last 60 days from last use)."); return; }
      if (!res.ok) { setError("Failed to load plan."); return; }
      const data: SharedPlanData = await res.json();
      setPlan(data);
    } catch {
      setError("Could not connect to server.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchPlan(); }, [fetchPlan]);

  // Load menu items for the "Add items" panel
  useEffect(() => {
    fetch("/api/menu")
      .then(r => r.json())
      .then((data: MenuItemData[]) => {
        const active = data.filter((i: any) => i.isAvailable !== false && i.available !== false);
        setAllMenuItems(active);
      })
      .catch(() => {});
  }, []);

  const handleRemove = async (itemId: number) => {
    setRemovingId(itemId);
    try {
      const res = await fetch(`/api/plan/share/${token}/items/${itemId}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      const data: SharedPlanData = await res.json();
      setPlan(data);
      toast({ title: "Removed", description: "Item removed from the shared plan." });
    } catch {
      toast({ title: "Error", description: "Could not remove item.", variant: "destructive" });
    } finally {
      setRemovingId(null);
    }
  };

  const handleAdd = async (menuItemId: number) => {
    setAddingId(menuItemId);
    try {
      const res = await fetch(`/api/plan/share/${token}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ menuItemId }),
      });
      if (!res.ok) throw new Error();
      const data: SharedPlanData = await res.json();
      setPlan(data);
      toast({ title: "Added", description: "Item added to the shared plan." });
    } catch {
      toast({ title: "Error", description: "Could not add item.", variant: "destructive" });
    } finally {
      setAddingId(null);
    }
  };

  const handleCopyToMyPlan = async () => {
    if (!plan || copying) return;
    setCopying(true);
    try {
      let added = 0;
      for (const item of plan.items) {
        const res = await fetch("/api/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, menuItemId: item.menuItemId }),
        });
        if (res.ok) added++;
      }
      toast({
        title: "Copied!",
        description: `${added} item${added !== 1 ? "s" : ""} added to your plan.`,
      });
    } catch {
      toast({ title: "Error", description: "Could not copy plan.", variant: "destructive" });
    } finally {
      setCopying(false);
    }
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2500);
    } catch {
      toast({ title: "Error", description: "Could not copy link.", variant: "destructive" });
    }
  };

  if (loading) {
    return (
      <Layout>
        <div className="h-96 flex items-center justify-center text-muted-foreground gap-3">
          <Loader2 className="w-5 h-5 animate-spin" /> Loading shared plan…
        </div>
      </Layout>
    );
  }

  if (error) {
    return (
      <Layout>
        <div className="max-w-xl mx-auto px-4 py-24 text-center">
          <AlertTriangle className="w-12 h-12 text-amber-500 mx-auto mb-4" />
          <h2 className="font-display font-bold text-2xl mb-2">Oops</h2>
          <p className="text-muted-foreground mb-8">{error}</p>
          <Link href="/menu" className="px-6 py-3 bg-primary text-primary-foreground font-semibold rounded-xl inline-block">
            Browse Menu
          </Link>
        </div>
      </Layout>
    );
  }

  if (!plan) return null;

  const days = daysUntil(plan.expiresAt);
  const planItemIds = new Set(plan.items.map(i => i.menuItemId));

  const categories = Array.from(new Set(allMenuItems.map(i => i.category))).sort();

  return (
    <Layout>
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-20">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-4 mb-4">
          <div className="w-12 h-12 bg-primary/10 rounded-2xl flex items-center justify-center text-primary shrink-0">
            <Users className="w-6 h-6" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="font-display font-bold text-3xl sm:text-4xl truncate">
              {plan.planName || "Shared Event Plan"}
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Shared plan · anyone with this link can view and edit
            </p>
          </div>
        </div>

        {/* Expiry + actions row */}
        <div className="flex flex-wrap items-center gap-3 mb-10">
          <span className={`text-xs font-semibold px-3 py-1.5 rounded-full ${
            days <= 7 ? "bg-amber-100 text-amber-700" : "bg-secondary text-muted-foreground"
          }`}>
            {days === 0 ? "Expires today!" : `Link active for ${days} more day${days !== 1 ? "s" : ""}`}
          </span>

          <button
            onClick={handleCopyLink}
            className="flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-full border border-border hover:bg-secondary transition-colors"
          >
            {linkCopied ? <CheckCheck className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
            {linkCopied ? "Copied!" : "Copy link"}
          </button>

          {plan.items.length > 0 && (
            <button
              onClick={handleCopyToMyPlan}
              disabled={copying}
              className="flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-60"
            >
              {copying
                ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Copying…</>
                : <><Heart className="w-3.5 h-3.5" /> Save to my plan</>}
            </button>
          )}
        </div>

        {plan.items.length === 0 ? (
          <div className="text-center py-20 bg-card rounded-3xl border border-dashed border-border mb-10">
            <Heart className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
            <h3 className="font-display font-bold text-xl mb-2">No items yet</h3>
            <p className="text-muted-foreground text-sm">Add items from the section below to get started.</p>
          </div>
        ) : (
          <div className="space-y-4 mb-10">
            {plan.items.map(item => (
              <div
                key={item.id}
                className="flex flex-col sm:flex-row gap-5 bg-card p-5 rounded-2xl border border-border shadow-sm"
              >
                {item.menuItem.imageUrl && (
                  <img
                    src={item.menuItem.imageUrl}
                    alt=""
                    onClick={() => setLightboxSrc(item.menuItem.imageUrl!)}
                    className="w-full sm:w-28 h-28 rounded-xl object-cover shrink-0 bg-secondary cursor-zoom-in hover:opacity-90 transition-opacity"
                  />
                )}
                <div className="flex-1 flex flex-col justify-between">
                  <div className="flex justify-between items-start mb-1">
                    <div>
                      <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1 block">
                        {item.menuItem.category}
                      </span>
                      <h4 className="font-display font-bold text-lg">{item.menuItem.name}</h4>
                    </div>
                    <span className="font-bold text-primary">{formatCurrency(item.menuItem.price)}</span>
                  </div>
                  <p className="text-muted-foreground text-sm line-clamp-2 mb-3">{item.menuItem.description}</p>
                  <div className="flex justify-between items-center">
                    <button
                      onClick={() => handleRemove(item.id)}
                      disabled={removingId === item.id}
                      className="text-sm font-semibold text-muted-foreground hover:text-destructive transition-colors flex items-center gap-1.5 disabled:opacity-50"
                    >
                      {removingId === item.id
                        ? <Loader2 className="w-4 h-4 animate-spin" />
                        : <Trash2 className="w-4 h-4" />}
                      Remove
                    </button>
                    <a
                      href={`/menu`}
                      className="text-sm font-semibold text-muted-foreground hover:text-primary transition-colors flex items-center gap-1.5"
                    >
                      <ShoppingBag className="w-4 h-4" /> Browse menu
                    </a>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Add items section */}
        {allMenuItems.length > 0 && (
          <div className="bg-card border border-border rounded-3xl overflow-hidden shadow-sm">
            <div className="px-6 py-4 border-b border-border">
              <h2 className="font-display font-bold text-lg">Add items to this plan</h2>
              <p className="text-sm text-muted-foreground">Click + to add any item to the shared plan</p>
            </div>
            <div className="divide-y divide-border">
              {categories.map(cat => {
                const catItems = allMenuItems.filter(i => i.category === cat);
                return (
                  <div key={cat} className="px-6 py-4">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">{cat}</h3>
                    <div className="space-y-2">
                      {catItems.map(mi => {
                        const inPlan = planItemIds.has(mi.id);
                        return (
                          <div
                            key={mi.id}
                            className={`flex items-center gap-3 p-3 rounded-xl transition-colors ${
                              inPlan ? "bg-primary/5 border border-primary/20" : "bg-secondary/40 hover:bg-secondary/70"
                            }`}
                          >
                            {mi.imageUrl && (
                              <img src={mi.imageUrl} alt="" className="w-10 h-10 rounded-lg object-cover shrink-0" />
                            )}
                            <div className="flex-1 min-w-0">
                              <p className="font-semibold text-sm truncate">{mi.name}</p>
                              <p className="text-xs text-muted-foreground">{formatCurrency(mi.price)}</p>
                            </div>
                            {inPlan ? (
                              <span className="text-xs font-semibold text-primary px-3 py-1.5 rounded-full bg-primary/10">
                                In plan ✓
                              </span>
                            ) : (
                              <button
                                onClick={() => handleAdd(mi.id)}
                                disabled={addingId === mi.id}
                                className="w-8 h-8 rounded-full bg-foreground text-background flex items-center justify-center font-bold text-lg hover:bg-primary transition-colors disabled:opacity-50 shrink-0"
                              >
                                {addingId === mi.id ? <Loader2 className="w-4 h-4 animate-spin" /> : "+"}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
