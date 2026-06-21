import { MapPin, Flame } from "lucide-react";
import type { ServiceMode } from "@/lib/serviceMode";

// Compact toggle used at the top of Menu / Plan / SharedPlan so the
// customer can flip between "Drop-Off / Meet-Up" and "On the Dash
// Experience" while browsing. The Cart page has the authoritative
// expanded picker with fee preview + ineligibility warnings; this
// banner is a heads-up that influences which items show the OTD badge
// as relevant to the current mode.
export function ServiceModeBanner({
  mode,
  onChange,
}: {
  mode: ServiceMode;
  onChange: (m: ServiceMode) => void;
}) {
  return (
    <div className="bg-card border border-border rounded-2xl p-4 mb-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="text-sm">
          <p className="font-semibold">How would you like your order?</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {mode === "drop_off" ? (
              <>Any order size welcome — even a single pan. We drop off or meet up, whatever works for you.</>
            ) : (
              <>Look for the <span className="text-orange-600 font-semibold">On the Dash</span> badge — those are dishes our food trailer cooks fresh on-site.</>
            )}
          </p>
        </div>
        <div className="inline-flex rounded-xl border border-border bg-background p-1 shrink-0">
          <button
            type="button"
            onClick={() => onChange("drop_off")}
            aria-pressed={mode === "drop_off"}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              mode === "drop_off"
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <MapPin className="w-3.5 h-3.5" />
            Drop-Off / Meet-Up
          </button>
          <button
            type="button"
            onClick={() => onChange("on_the_dash")}
            aria-pressed={mode === "on_the_dash"}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              mode === "on_the_dash"
                ? "bg-orange-600 text-white"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Flame className="w-3.5 h-3.5" />
            On the Dash
          </button>
        </div>
      </div>
    </div>
  );
}
