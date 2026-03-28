import { Plus, Heart, HeartOff, Info, ChevronRight } from "lucide-react";
import type { MenuItem } from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/utils";
import { isPanSizesItem } from "@/lib/menu-types";

interface MenuCardProps {
  item: MenuItem;
  onAddToCart: (item: MenuItem) => void;
  onTogglePlan: (item: MenuItem) => void;
  isInPlan?: boolean;
}

function TierRow({ label, price, isBase }: { label: string; price: number; isBase?: boolean }) {
  return (
    <div className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs ${isBase ? "bg-secondary text-foreground/70" : "bg-primary/10 text-primary"}`}>
      <span className="font-semibold">{label}</span>
      <span className="font-bold">{formatCurrency(price)}<span className="font-normal opacity-70"> / ea</span></span>
    </div>
  );
}

export function MenuCard({ item, onAddToCart, onTogglePlan, isInPlan }: MenuCardProps) {
  const hasTiers = !!(item.tier2Qty && item.tier2Price);
  const minQty = item.minimumOrderQty ?? 1;
  const isPanSizes = isPanSizesItem(item);

  return (
    <div className="bg-card rounded-2xl border border-border/50 overflow-hidden hover:shadow-xl hover:shadow-black/5 hover:border-primary/20 transition-all duration-300 group flex flex-col">
      <div className="relative h-56 overflow-hidden bg-secondary">
        {item.imageUrl ? (
          <img
            src={item.imageUrl}
            alt={item.name}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700"
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
            {formatCurrency(item.price)}
          </span>
        </div>

        <p className="text-muted-foreground text-sm leading-relaxed mb-4 line-clamp-2 flex-1">
          {item.description}
        </p>

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

        <button
          onClick={() => onAddToCart(item)}
          disabled={!item.available}
          className="w-full py-3.5 px-4 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground disabled:opacity-50 disabled:hover:bg-foreground disabled:hover:text-background transition-colors flex items-center justify-center gap-2 group/btn mt-auto"
        >
          {isPanSizes ? (
            <>
              <ChevronRight className="w-5 h-5" />
              {item.available ? "Select Size" : "Unavailable"}
            </>
          ) : (
            <>
              <Plus className="w-5 h-5 group-hover/btn:rotate-90 transition-transform duration-300" />
              {item.available ? "Add to Order" : "Unavailable"}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
