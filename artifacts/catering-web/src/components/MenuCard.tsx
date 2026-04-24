import { useState } from "react";
import { Plus, Heart, HeartOff, Info, ChevronRight, Flame } from "lucide-react";
import type { MenuItem } from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/utils";
import { isPanSizesItem, getPanSizesFromPrice } from "@/lib/menu-types";
import { ImageLightbox } from "@/components/ImageLightbox";

interface MenuCardProps {
  item: MenuItem;
  onAddToCart: (item: MenuItem) => void;
  onTogglePlan: (item: MenuItem) => void;
  isInPlan?: boolean;
  serviceMode?: "drop_off" | "on_the_dash";
}

function TierRow({ label, price, isBase }: { label: string; price: number; isBase?: boolean }) {
  return (
    <div className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs ${isBase ? "bg-secondary text-foreground/70" : "bg-primary/10 text-primary"}`}>
      <span className="font-semibold">{label}</span>
      <span className="font-bold">{formatCurrency(price)}<span className="font-normal opacity-70"> / ea</span></span>
    </div>
  );
}

export function MenuCard({ item, onAddToCart, onTogglePlan, isInPlan, serviceMode = "drop_off" }: MenuCardProps) {
  const hasTiers = !!(item.tier2Qty && item.tier2Price);
  const minQty = item.minimumOrderQty ?? 1;
  const isPanSizes = isPanSizesItem(item);
  const panFromPrice = isPanSizes ? getPanSizesFromPrice(item) : null;
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [descExpanded, setDescExpanded] = useState(false);
  const blockedByOtd = serviceMode === "on_the_dash" && !item.otdEligible;
  const addDisabled = !item.available || blockedByOtd;

  return (
    <>
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
      <div className="bg-card rounded-2xl border border-border/50 overflow-hidden hover:shadow-xl hover:shadow-black/5 hover:border-primary/20 transition-all duration-300 group flex flex-col">
        <div className="relative h-56 overflow-hidden bg-secondary">
          {item.imageUrl ? (
            <img
              src={item.imageUrl}
              alt={item.name}
              onClick={() => setLightboxSrc(item.imageUrl!)}
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700 cursor-zoom-in"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-muted-foreground">
              No image available
            </div>
          )}
          <div className="absolute top-4 left-4 flex flex-col gap-2">
            <span className="px-3 py-1 bg-white/90 backdrop-blur-sm text-xs font-bold uppercase tracking-wider rounded-full shadow-sm">
              {item.category}
            </span>
            {!item.available && (
              <span className="px-3 py-1 bg-destructive/90 text-destructive-foreground backdrop-blur-sm text-xs font-bold uppercase tracking-wider rounded-full shadow-sm">
                Sold Out
              </span>
            )}
            {minQty > 1 && (
              <span className="px-3 py-1 bg-amber-500/90 text-white backdrop-blur-sm text-xs font-bold rounded-full shadow-sm">
                Min. {minQty}
              </span>
            )}
            {item.otdEligible && (
              <span
                className="px-3 py-1 bg-orange-600/90 text-white backdrop-blur-sm text-xs font-bold uppercase tracking-wider rounded-full shadow-sm flex items-center gap-1"
                title="On the Dash Experience — we cook this one fresh on-site from our food trailer"
              >
                <Flame className="w-3 h-3" />
                On the Dash
              </span>
            )}
          </div>
          <button
            onClick={() => onTogglePlan(item)}
            className="absolute top-4 right-4 p-2.5 bg-white/90 backdrop-blur-sm rounded-full shadow-sm hover:scale-110 active:scale-95 transition-all text-primary"
          >
            {isInPlan ? <Heart className="w-5 h-5 fill-current" /> : <HeartOff className="w-5 h-5 text-muted-foreground hover:text-primary" />}
          </button>
        </div>

        <div className="p-6 flex flex-col flex-1">
          <div className="flex justify-between items-start mb-2 gap-4">
            <h3 className="font-display font-bold text-xl leading-tight">{item.name}</h3>
            <span className="font-bold text-lg text-primary whitespace-nowrap">
              {isPanSizes
                ? panFromPrice !== null
                  ? `From ${formatCurrency(panFromPrice)}`
                  : "Priced by size"
                : formatCurrency(item.price)}
            </span>
          </div>

          <div className="mb-4 flex-1">
            <p className={`text-muted-foreground text-sm leading-relaxed ${descExpanded ? "" : "line-clamp-2"}`}>
              {item.description}
            </p>
            {item.description && item.description.length > 80 && (
              <button
                onClick={() => setDescExpanded(v => !v)}
                className="text-xs text-primary font-semibold mt-1 hover:underline"
              >
                {descExpanded ? "Less" : "More"}
              </button>
            )}
          </div>

          <div className="flex items-center gap-4 text-xs font-medium text-foreground/70 mb-4">
            <div className="flex items-center gap-1.5">
              <Info className="w-4 h-4 text-primary" />
              Serves {item.servingSize} ({item.unit})
            </div>
            {item.allergens?.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {item.allergens.map(a => (
                  <span key={a} className="px-2 py-0.5 bg-secondary rounded-md text-[10px] uppercase tracking-wider">{a}</span>
                ))}
              </div>
            )}
          </div>

          {hasTiers && (
            <div className="mb-4 space-y-1">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold mb-1.5">Volume Pricing</p>
              <TierRow label={minQty > 1 ? `${minQty}–${(item.tier2Qty! - 1)}` : `1${item.tier2Qty ? `–${item.tier2Qty - 1}` : "+"}`} price={item.price} isBase />
              {item.tier2Qty && item.tier2Price && (
                <TierRow label={item.tier3Qty ? `${item.tier2Qty}–${item.tier3Qty - 1}` : `${item.tier2Qty}+`} price={item.tier2Price} />
              )}
              {item.tier3Qty && item.tier3Price && (
                <TierRow label={`${item.tier3Qty}+`} price={item.tier3Price} />
              )}
            </div>
          )}

          {blockedByOtd && (
            <div
              className="mb-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-[11px] font-semibold text-amber-800 flex items-center gap-1.5"
              title="The food trailer can't cook this on-site. Switch to Standard Drop-Off Catering to order it."
            >
              <Flame className="w-3 h-3 shrink-0" />
              Only available with Standard Drop-Off
            </div>
          )}
          <button
            onClick={() => onAddToCart(item)}
            disabled={addDisabled}
            title={blockedByOtd ? "Switch to Standard Drop-Off Catering to add this item" : undefined}
            className="w-full py-3.5 px-4 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground disabled:opacity-50 disabled:hover:bg-foreground disabled:hover:text-background disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 group/btn mt-auto"
          >
            {isPanSizes ? (
              <>
                <ChevronRight className="w-5 h-5" />
                {!item.available ? "Unavailable" : blockedByOtd ? "Drop-Off only" : "Select Size"}
              </>
            ) : (
              <>
                <Plus className="w-5 h-5 group-hover/btn:rotate-90 transition-transform duration-300" />
                {!item.available ? "Unavailable" : blockedByOtd ? "Drop-Off only" : "Add to Order"}
              </>
            )}
          </button>
        </div>
      </div>
    </>
  );
}

export function MenuCardCompact({ item, onAddToCart, onTogglePlan, isInPlan, serviceMode = "drop_off" }: MenuCardProps) {
  const minQty = item.minimumOrderQty ?? 1;
  const isPanSizes = isPanSizesItem(item);
  const panFromPrice = isPanSizes ? getPanSizesFromPrice(item) : null;
  const hasTiers = !!(item.tier2Qty && item.tier2Price);
  const [descExpanded, setDescExpanded] = useState(false);
  const blockedByOtd = serviceMode === "on_the_dash" && !item.otdEligible;
  const addDisabled = !item.available || blockedByOtd;

  return (
    <div className="bg-card border border-border/50 rounded-2xl px-5 py-4 flex items-center gap-4 hover:border-primary/20 hover:shadow-md hover:shadow-black/5 transition-all duration-200 group">
      {/* Left — item info */}
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <h3 className="font-display font-bold text-base leading-tight">{item.name}</h3>
          {!item.available && (
            <span className="px-2 py-0.5 bg-destructive/10 text-destructive text-[10px] font-bold uppercase tracking-wider rounded-full">
              Sold Out
            </span>
          )}
          {minQty > 1 && (
            <span className="px-2 py-0.5 bg-amber-100 text-amber-700 text-[10px] font-bold rounded-full">
              Min. {minQty}
            </span>
          )}
          {item.otdEligible && (
            <span
              className="px-2 py-0.5 bg-orange-600 text-white text-[10px] font-bold uppercase tracking-wider rounded-full flex items-center gap-1"
              title="On the Dash Experience — we cook this one fresh on-site from our food trailer"
            >
              <Flame className="w-3 h-3" />
              On the Dash
            </span>
          )}
        </div>

        <div className="mb-1.5">
          <p className={`text-muted-foreground text-sm ${descExpanded ? "" : "line-clamp-2"}`}>
            {item.description}
          </p>
          {item.description && item.description.length > 60 && (
            <button
              onClick={() => setDescExpanded(v => !v)}
              className="text-xs text-primary font-semibold mt-0.5 hover:underline"
            >
              {descExpanded ? "Less" : "More"}
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-foreground/60">
          <span className="flex items-center gap-1">
            <Info className="w-3 h-3 text-primary/70" />
            Serves {item.servingSize} ({item.unit})
          </span>
          {hasTiers && (
            <span className="text-primary font-semibold">Volume pricing available</span>
          )}
          {item.allergens?.length > 0 && item.allergens.map(a => (
            <span key={a} className="px-1.5 py-0.5 bg-secondary rounded text-[10px] uppercase tracking-wider">{a}</span>
          ))}
        </div>
      </div>

      {/* Right — price + actions */}
      <div className="flex items-center gap-3 shrink-0">
        <span className="font-bold text-lg text-primary">
          {isPanSizes
            ? panFromPrice !== null
              ? `From ${formatCurrency(panFromPrice)}`
              : "Priced by size"
            : formatCurrency(item.price)}
        </span>

        <button
          onClick={() => onTogglePlan(item)}
          className="p-2 rounded-full hover:bg-secondary transition-colors text-muted-foreground hover:text-primary"
          title={isInPlan ? "Remove from plan" : "Save to plan"}
        >
          {isInPlan
            ? <Heart className="w-5 h-5 fill-primary text-primary" />
            : <HeartOff className="w-5 h-5" />}
        </button>

        <button
          onClick={() => onAddToCart(item)}
          disabled={addDisabled}
          title={blockedByOtd ? "Switch to Standard Drop-Off Catering to add this item" : undefined}
          className="flex items-center gap-1.5 px-4 py-2 bg-foreground text-background text-sm font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {blockedByOtd ? (
            <>
              <Flame className="w-4 h-4" />
              Drop-Off only
            </>
          ) : isPanSizes ? (
            <>
              <ChevronRight className="w-4 h-4" />
              Select Size
            </>
          ) : (
            <>
              <Plus className="w-4 h-4" />
              Add
            </>
          )}
        </button>
      </div>
    </div>
  );
}
