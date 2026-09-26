import { Calculator, Utensils } from "lucide-react";
import type { PlannerCoverage } from "@/lib/plannerMath";
import type { RevisionPlannerTargets } from "@/lib/revisionPlanner";

type Props = {
  guests: number | null;
  targets: RevisionPlannerTargets;
  onTargetsChange: (targets: RevisionPlannerTargets) => void;
  coverage: PlannerCoverage;
  hasSmallBites: boolean;
  hasEntrees: boolean;
  excludedCount: number;
  assumedCount: number;
};

function TargetInput({ label, hint, value, onChange }: {
  label: string; hint: string; value: number; onChange: (value: number) => void;
}) {
  return <label className="block text-xs font-semibold text-muted-foreground">
    {label} <span className="font-normal">({hint})</span>
    <input
      type="number" min="1" max="20" step="1" inputMode="numeric"
      value={value}
      onChange={event => {
        const next = Number(event.target.value);
        if (Number.isInteger(next) && next >= 1 && next <= 20) onChange(next);
      }}
      className="mt-2 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-base font-semibold text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15"
    />
  </label>;
}

function CoverageBar({ label, have, need, unit }: {
  label: string; have: number; need: number; unit: string;
}) {
  const remaining = Math.max(0, need - have);
  const percent = need ? Math.min(100, Math.max(0, have / need * 100)) : 0;
  return <div className="space-y-2">
    <div className="flex flex-wrap items-baseline justify-between gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <span className="font-semibold tabular-nums">{have} / {need} {unit}</span>
    </div>
    <div className="h-2 overflow-hidden rounded-full bg-secondary">
      <div className={`h-full rounded-full ${remaining ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${percent}%` }} />
    </div>
    <p className="text-xs text-muted-foreground">{remaining ? `Suggest ${remaining} more ${unit === "pcs" ? "piece" : "serving"}${remaining === 1 ? "" : "s"}` : "You're covered!"}</p>
  </div>;
}

export function RevisionServingPlanner({
  guests, targets, onTargetsChange, coverage, hasSmallBites, hasEntrees, excludedCount, assumedCount,
}: Props) {
  if (!hasSmallBites && !hasEntrees) return null;
  const validGuests = Number.isInteger(guests) && guests != null && guests > 0;
  return <section className="space-y-5" aria-labelledby="serving-planner-heading" data-testid="revision-serving-planner">
    <div className="border-b border-border pb-3">
      <h2 id="serving-planner-heading" className="text-2xl font-semibold">Serving planner</h2>
      <p className="mt-1 text-sm text-muted-foreground">A guide for {validGuests ? `${guests} guests` : "your guest count"}. Adjust the targets to suit your event; quantities only change when you edit the menu above.</p>
    </div>
    {!validGuests && <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">Enter a guest count under “Your event” to see suggested serving amounts.</p>}
    <div className="grid gap-4 sm:grid-cols-2">
      {hasSmallBites && <div className="space-y-5 rounded-2xl border border-border bg-card p-5" data-testid="planner-small-bites">
        <h3 className="flex items-center gap-2 font-semibold"><Calculator size={18} className="text-primary" /> Small Bites Planner</h3>
        <div className="grid grid-cols-2 gap-3">
          <TargetInput label="Savory pcs/person" hint="rec. 3–4" value={targets.savoryPPG} onChange={savoryPPG => onTargetsChange({ ...targets, savoryPPG })} />
          <TargetInput label="Sweet pcs/person" hint="rec. 2–3" value={targets.sweetPPG} onChange={sweetPPG => onTargetsChange({ ...targets, sweetPPG })} />
        </div>
        {validGuests && <div className="space-y-4">
          <CoverageBar label="Savory" have={coverage.haveSavory} need={coverage.needSavory} unit="pcs" />
          <CoverageBar label="Sweet" have={coverage.haveSweet} need={coverage.needSweet} unit="pcs" />
        </div>}
      </div>}
      {hasEntrees && <div className="space-y-5 rounded-2xl border border-border bg-card p-5" data-testid="planner-entrees">
        <h3 className="flex items-center gap-2 font-semibold"><Utensils size={18} className="text-primary" /> Entrée Planner</h3>
        <TargetInput label="Servings / person" hint="rec. 4–5" value={targets.servingsPPG} onChange={servingsPPG => onTargetsChange({ ...targets, servingsPPG })} />
        {validGuests && <CoverageBar label="Total entrée servings" have={coverage.haveEntrees} need={coverage.needEntrees} unit="servings" />}
      </div>}
    </div>
    {(excludedCount > 0 || assumedCount > 0) && <p className="text-xs text-muted-foreground" role="note">
      {excludedCount > 0 && `${excludedCount} selection${excludedCount === 1 ? " has" : "s have"} no usable serving yield and ${excludedCount === 1 ? "is" : "are"} not counted. `}
      {assumedCount > 0 && `For ${assumedCount} item${assumedCount === 1 ? "" : "s"} without a listed yield, the planner assumes one piece or serving per unit.`}
    </p>}
  </section>;
}