import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { MenuCard, MenuCardCompact } from "@/components/MenuCard";
import { PackageDetail } from "@/components/PackageDetail";
import { fetchPublicPackages, type PublicMenuPackage } from "@/lib/menuPackages";
import { Users, Package as PackageIcon, Flame, Instagram } from "lucide-react";
import { 
  useListMenuItems,
  useAddToPlan, 
  useGetPlan,
  getGetPlanQueryKey
} from "@workspace/api-client-react";
import { getSessionId } from "@/lib/session";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Search } from "lucide-react";
import type { MenuItem } from "@workspace/api-client-react";
import { useCategories } from "@/lib/categories";
import { ServiceModeBanner } from "@/components/ServiceModeBanner";
import { loadServiceMode, saveServiceMode, type ServiceMode } from "@/lib/serviceMode";
import { useLocation, useSearch } from "wouter";
import { useInstagramHandle } from "@/lib/instagram";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function Menu() {
  const initialCategory = (() => {
    if (typeof window === "undefined") return "";
    const c = new URLSearchParams(window.location.search).get("category");
    return c ?? "";
  })();
  const [category, setCategory] = useState<string>(initialCategory);
  const [categoryFromUrlChecked, setCategoryFromUrlChecked] = useState<boolean>(!initialCategory);

  // Keep category in sync with ?category= when navigate() changes only the
  // query string (same /menu path, no remount). This is what makes Dashy's
  // item links actually update the category filter without a full remount.
  const searchStr = useSearch();
  useEffect(() => {
    const paramCat = new URLSearchParams(searchStr).get("category") ?? "";
    setCategory(paramCat);
    if (paramCat) setCategoryFromUrlChecked(false); // re-trigger validation
  // searchStr is the only real dependency; setters are stable
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchStr]);

  // Parse ?item=<id> so Dashy links can deep-link to a specific card.
  const targetItemId = useMemo(() => {
    const v = new URLSearchParams(searchStr).get("item");
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [searchStr]);

  const [highlightedItemId, setHighlightedItemId] = useState<number | null>(null);

  const [serviceMode, setServiceMode] = useState<ServiceMode>(() => loadServiceMode());
  useEffect(() => { saveServiceMode(serviceMode); }, [serviceMode]);
  const sessionId = getSessionId();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const { data: menuItems, isLoading } = useListMenuItems({ category: category || undefined });
  const { data: plan } = useGetPlan({ sessionId });

  // Once the items for the target category have loaded, scroll to the
  // specific item card and briefly highlight it with a ring.
  useEffect(() => {
    if (!targetItemId || !menuItems?.length) return;
    // requestAnimationFrame defers until after the browser has painted the
    // new cards. Without it, on desktop with cached React Query data the
    // effect can fire in the same flush as the render — before the DOM
    // nodes are committed — so getElementById returns null and scroll is skipped.
    const rafId = requestAnimationFrame(() => {
      const el = document.getElementById(`menu-item-${targetItemId}`);
      if (!el) return;
      // Manual scroll so we can subtract the sticky header (h-20 = 80px)
      // plus a small breathing gap. scrollIntoView({ block:"center" }) can
      // silently no-op on desktop when the item is already near the viewport
      // top, and doesn't account for the fixed header.
      const HEADER_H = 88; // 80px nav + 8px gap
      const top = el.getBoundingClientRect().top + window.scrollY - HEADER_H;
      window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      setHighlightedItemId(targetItemId);
      const t = setTimeout(() => setHighlightedItemId(null), 2500);
      // t cleanup is best-effort; the 2.5s timeout is harmless if it fires
      // after the component unmounts
      return () => clearTimeout(t);
    });
    return () => cancelAnimationFrame(rafId);
  }, [targetItemId, menuItems]);

  const addToPlan = useAddToPlan({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetPlanQueryKey({ sessionId }) });
        toast({ title: "Added to plan", description: "Item saved to your event plan." });
      }
    }
  });

  const planItemIds = new Set(plan?.items?.map(i => i.menuItemId) || []);

  const handleAddToPlan = (item: MenuItem) => {
    if (planItemIds.has(item.id)) {
      navigate("/plan");
    } else {
      addToPlan.mutate({ data: { sessionId, menuItemId: item.id } });
    }
  };

  const handleTogglePlan = async (item: MenuItem) => {
    if (planItemIds.has(item.id)) {
      const planItem = plan?.items.find(i => i.menuItemId === item.id);
      if (!planItem) return;
      try {
        await fetch(`/api/plan/${planItem.id}?sessionId=${encodeURIComponent(sessionId)}`, { method: "DELETE" });
        queryClient.invalidateQueries({ queryKey: getGetPlanQueryKey({ sessionId }) });
        toast({ title: "Removed from plan", description: "Item removed from your event plan." });
      } catch {
        toast({ title: "Error", description: "Could not remove item. Please try again.", variant: "destructive" });
      }
    } else {
      addToPlan.mutate({ data: { sessionId, menuItemId: item.id } });
    }
  };

  const igHandle = useInstagramHandle();
  const { data: categoryData } = useCategories();
  const PACKAGES_FILTER = "__packages__";
  const categories = [
    { value: "", label: "All Items" },
    { value: PACKAGES_FILTER, label: "Packages" },
    ...(categoryData ?? []).map((c) => ({ value: c.name, label: c.name })),
  ];

  // ── Pre-built menu packages ──
  const [packages, setPackages] = useState<PublicMenuPackage[]>([]);
  const [openPackageId, setOpenPackageId] = useState<number | null>(null);
  useEffect(() => {
    fetchPublicPackages().then(setPackages).catch(() => setPackages([]));
  }, []);

  useEffect(() => {
    if (categoryFromUrlChecked) return;
    if (!categoryData) return;
    const known = new Set(categoryData.map((c) => c.name));
    if (category && !known.has(category)) setCategory("");
    setCategoryFromUrlChecked(true);
  }, [categoryData, category, categoryFromUrlChecked]);

  return (
    <Layout>
      {openPackageId !== null && (
        <PackageDetail packageId={openPackageId} onClose={() => setOpenPackageId(null)} />
      )}
      <div className="bg-secondary/30 py-16 border-b border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h1 className="font-display font-bold text-3xl sm:text-5xl mb-4">Curated Offerings</h1>
          <p className="text-muted-foreground max-w-2xl mx-auto text-lg">
            Discover our seasonal selections, crafted with passion and precision. Build your perfect event menu or add favorites to your wishlist.
          </p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <ServiceModeBanner mode={serviceMode} onChange={setServiceMode} />

        {/* Featured packages strip — only on the default "All Items" view */}
        {!category && packages.length > 0 && (
          <section className="mb-12">
            <div className="flex items-baseline justify-between mb-4">
              <h2 className="font-display font-bold text-2xl flex items-center gap-2">
                <PackageIcon className="w-6 h-6 text-primary" /> Pre-Built Packages
              </h2>
              <button
                onClick={() => setCategory(PACKAGES_FILTER)}
                className="text-sm font-semibold text-primary hover:underline"
              >
                See all
              </button>
            </div>
            <div className="flex gap-4 overflow-x-auto pb-2 -mx-1 px-1 snap-x snap-mandatory">
              {packages.slice(0, 6).map((p) => (
                <PackageCard key={p.id} pkg={p} serviceMode={serviceMode} onOpen={() => setOpenPackageId(p.id)} />
              ))}
            </div>
          </section>
        )}
        {/* Filters */}
        <div className="flex flex-col sm:flex-row justify-between items-center mb-12 gap-6">
          <div className="flex flex-wrap gap-2 justify-center">
            {categories.map(c => (
              <button
                key={c.value}
                onClick={() => setCategory(c.value)}
                className={`px-5 py-2 rounded-full font-medium text-sm transition-all ${
                  category === c.value
                    ? "bg-primary text-primary-foreground shadow-md"
                    : "bg-card border border-border text-foreground hover:border-primary/50"
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        {category === PACKAGES_FILTER ? (
          packages.length === 0 ? (
            <div className="text-center py-24 bg-card rounded-3xl border border-border border-dashed">
              <PackageIcon className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
              <h3 className="font-display font-bold text-2xl mb-2">No packages yet</h3>
              <p className="text-muted-foreground">Check back soon — pre-built packages will show up here.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
              {packages.map(p => (
                <PackageCard key={p.id} pkg={p} serviceMode={serviceMode} onOpen={() => setOpenPackageId(p.id)} />
              ))}
            </div>
          )
        ) : isLoading ? (
          <div className="flex justify-center py-24">
            <Loader2 className="w-12 h-12 text-primary animate-spin" />
          </div>
        ) : menuItems?.length === 0 ? (
          <div className="text-center py-24 bg-card rounded-3xl border border-border border-dashed">
            <Search className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
            <h3 className="font-display font-bold text-2xl mb-2">No items found</h3>
            <p className="text-muted-foreground">Try selecting a different category.</p>
          </div>
        ) : (() => {
          const featured = menuItems?.filter(i => i.imageUrl) ?? [];
          const listed   = menuItems?.filter(i => !i.imageUrl) ?? [];
          const cardProps = (item: typeof featured[0]) => ({
            item,
            onAddToPlan: handleAddToPlan,
            onTogglePlan: handleTogglePlan,
            isInPlan: planItemIds.has(item.id),
            serviceMode,
          });
          return (
            <div className="space-y-10">
              {/* Featured — items with photos */}
              {featured.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                  {featured.map(item => (
                    <div
                      key={item.id}
                      id={`menu-item-${item.id}`}
                      className={highlightedItemId === item.id ? "rounded-2xl ring-2 ring-primary ring-offset-2 ring-offset-background transition-shadow" : ""}
                    >
                      <MenuCard {...cardProps(item)} />
                    </div>
                  ))}
                </div>
              )}

              {/* Compact list — items without photos */}
              {listed.length > 0 && (
                <div>
                  {featured.length > 0 && (
                    <div className="flex items-center gap-4 mb-6">
                      <div className="flex-1 h-px bg-border" />
                      <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground px-2">
                        More on the Menu
                      </span>
                      <div className="flex-1 h-px bg-border" />
                    </div>
                  )}
                  <div className="space-y-3">
                    {listed.map(item => (
                      <div
                        key={item.id}
                        id={`menu-item-${item.id}`}
                        className={highlightedItemId === item.id ? "rounded-xl ring-2 ring-primary ring-offset-2 ring-offset-background transition-shadow" : ""}
                      >
                        <MenuCardCompact {...cardProps(item)} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {igHandle && (
        <div className="border-t border-border mt-4 py-10 bg-secondary/20">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-6">
            <div className="text-center sm:text-left">
              <p className="font-semibold text-foreground text-lg">Hungry for more inspiration?</p>
              <p className="text-sm text-muted-foreground mt-1">
                Follow us on Instagram for behind-the-scenes, seasonal specials, and event highlights.
              </p>
            </div>
            <a
              href={`https://instagram.com/${igHandle}`}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 inline-flex items-center gap-2 px-5 py-2.5 rounded-full border border-border bg-card font-semibold text-sm hover:border-primary hover:text-primary transition-colors"
            >
              <Instagram className="w-4 h-4" />
              Follow @{igHandle}
            </a>
          </div>
        </div>
      )}
    </Layout>
  );
}

function PackageCard({
  pkg,
  serviceMode,
  onOpen,
}: {
  pkg: PublicMenuPackage;
  serviceMode: ServiceMode;
  onOpen: () => void;
}) {
  const otdEligible = pkg.otdEligible === true;
  const blockedByOtd = serviceMode === "on_the_dash" && !otdEligible;
  return (
    <button
      onClick={onOpen}
      className={`text-left bg-card rounded-3xl border border-border shadow-sm hover:shadow-lg transition-all overflow-hidden group min-w-[280px] sm:min-w-0 snap-start flex flex-col ${
        blockedByOtd ? "opacity-60" : ""
      }`}
    >
      <div className="relative">
        {pkg.imageUrl ? (
          <div className="aspect-[16/10] overflow-hidden bg-secondary">
            <img
              src={pkg.imageUrl}
              alt={pkg.name}
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
            />
          </div>
        ) : (
          <div className="aspect-[16/10] bg-gradient-to-br from-primary/20 to-secondary flex items-center justify-center">
            <PackageIcon className="w-12 h-12 text-primary/40" />
          </div>
        )}
        {otdEligible && (
          <span
            className="absolute top-3 left-3 px-3 py-1 bg-orange-600/90 text-white backdrop-blur-sm text-xs font-bold uppercase tracking-wider rounded-full shadow-sm flex items-center gap-1"
            title="On the Dash Experience — every item in this package can be cooked fresh on-site from our food trailer."
          >
            <Flame className="w-3 h-3" />
            On the Dash
          </span>
        )}
      </div>
      <div className="p-5 flex-1 flex flex-col">
        <h3 className="font-display font-bold text-xl mb-1">{pkg.name}</h3>
        <div className="text-sm text-muted-foreground flex items-center gap-1 mb-2">
          <Users className="w-3.5 h-3.5" /> Serves about {pkg.servesGuests}
          <span className="mx-1.5">•</span>
          {pkg.items.length} item{pkg.items.length !== 1 ? "s" : ""}
        </div>
        {pkg.description && (
          <p className="text-sm text-muted-foreground line-clamp-3 flex-1">{pkg.description}</p>
        )}
        {blockedByOtd && (
          <div className="mt-3 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-[11px] font-semibold text-amber-800 flex items-center gap-1.5">
            <Flame className="w-3 h-3 shrink-0" />
            Only available with Standard Drop-Off
          </div>
        )}
        <span className="mt-4 text-sm font-semibold text-primary">View details →</span>
      </div>
    </button>
  );
}

