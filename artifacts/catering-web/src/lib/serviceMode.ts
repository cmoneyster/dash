// Shared helpers for the dual service-mode flow ("Standard Drop-Off"
// vs "On the Dash Experience"). The toggle lives on the Menu, Plan,
// SharedPlan, and Cart pages and is persisted in localStorage so the
// customer's choice survives navigation. The Plan/SharedPlan pages
// also mirror it into the shared plannerState so the choice is shared
// with anyone collaborating on the same plan.

export type ServiceMode = "drop_off" | "on_the_dash";

export const SERVICE_MODE_KEY = "catering.serviceMode";

export function loadServiceMode(): ServiceMode {
  try {
    const v = localStorage.getItem(SERVICE_MODE_KEY);
    return v === "on_the_dash" ? "on_the_dash" : "drop_off";
  } catch {
    return "drop_off";
  }
}

export function saveServiceMode(mode: ServiceMode): void {
  try {
    localStorage.setItem(SERVICE_MODE_KEY, mode);
  } catch {
    // localStorage may be unavailable in some browsing modes — silently
    // ignore so the UI still toggles for the current session.
  }
}

export type OtdConfig = {
  setupFee: number;
  feeWaiverThreshold: number;
  includedHours: number;
  additionalHourRate: number;
  maxAdditionalHours: number;
};

export const OTD_DEFAULTS: OtdConfig = {
  setupFee: 500,
  feeWaiverThreshold: 2000,
  includedHours: 2,
  additionalHourRate: 100,
  maxAdditionalHours: 3,
};

// The setup fee is waived once the food subtotal hits the configured
// threshold (currently $2,000). Mirrors the server-side logic in
// orders.ts so the cart preview matches what the server will compute.
export function computeOtdSetupFee(subtotal: number, cfg: OtdConfig): number {
  return subtotal >= cfg.feeWaiverThreshold ? 0 : cfg.setupFee;
}
