import { db } from "@workspace/db";
import {
  blackoutDatesTable,
  eventSettingsTable,
  ordersTable,
} from "@workspace/db/schema";
import { and, eq, inArray } from "drizzle-orm";

// Canonical service-style keys used by the day-load shape.
// `unknown` is the catch-all for orders whose freeform serviceStyle text
// doesn't map to one of the known modes (older rows, custom labels,
// future modes the chat bot mentions but the cart doesn't capture yet).
export type ServiceStyleKey =
  | "drop_off"
  | "on_the_dash"
  | "buffet"
  | "grazing"
  | "made_to_order"
  | "unknown";

export const SERVICE_STYLE_KEYS: ReadonlyArray<ServiceStyleKey> = [
  "drop_off",
  "on_the_dash",
  "buffet",
  "grazing",
  "made_to_order",
  "unknown",
];

// Turn the freeform `orders.serviceStyle` text the cart stamps in into a
// canonical key. Matches the labels Cart.tsx writes today, plus a few
// looser fallbacks for the chat-bot styles in case checkout starts
// capturing them before this helper is updated.
export function canonicalServiceStyle(raw: string | null | undefined): ServiceStyleKey {
  if (!raw) return "unknown";
  const s = raw.toLowerCase();
  if (s.includes("on the dash") || s.includes("food trailer") || s.includes("trailer")) return "on_the_dash";
  if (s.includes("drop") && s.includes("off")) return "drop_off";
  if (s.includes("standard")) return "drop_off";
  if (s.includes("buffet")) return "buffet";
  if (s.includes("grazing") || s.includes("graze")) return "grazing";
  if (s.includes("made-to-order") || s.includes("made to order")) return "made_to_order";
  return "unknown";
}

export type DayLoad = {
  date: string;
  blackedOut: boolean;
  bookings: Array<{
    id: number;
    serviceStyle: ServiceStyleKey;
    rawServiceStyle: string | null;
    guestCount: number | null;
    status: string;
    isSoft: boolean;
  }>;
  totals: {
    confirmedGuestCount: number;
    pendingGuestCount: number;
    confirmedCount: number;
    pendingCount: number;
    byServiceStyle: Record<ServiceStyleKey, { confirmed: number; pending: number }>;
  };
  capacity: {
    dailyGuestCap: number | null;
    slotsByServiceStyle: Partial<Record<ServiceStyleKey, number>>;
  };
  remaining: {
    guestCount: number | null;
    slotsByServiceStyle: Partial<Record<ServiceStyleKey, number>>;
  };
  load: "open" | "filling" | "near_full" | "full";
  conflicts: string[];
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isRealCalendarDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().split("T")[0] === date;
}

function emptyByStyle(): Record<ServiceStyleKey, { confirmed: number; pending: number }> {
  return {
    drop_off: { confirmed: 0, pending: 0 },
    on_the_dash: { confirmed: 0, pending: 0 },
    buffet: { confirmed: 0, pending: 0 },
    grazing: { confirmed: 0, pending: 0 },
    made_to_order: { confirmed: 0, pending: 0 },
    unknown: { confirmed: 0, pending: 0 },
  };
}

// Statuses that count toward load. "confirmed" is hard load, "pending" is
// soft. Anything else (e.g. cancelled) is excluded entirely.
const HARD_STATUSES = ["confirmed"];
const SOFT_STATUSES = ["pending"];
const COUNTING_STATUSES = [...HARD_STATUSES, ...SOFT_STATUSES];

export async function computeDayLoad(date: string): Promise<DayLoad> {
  const [blackouts, settingsRow, orders] = await Promise.all([
    db
      .select()
      .from(blackoutDatesTable)
      .where(eq(blackoutDatesTable.date, date)),
    db
      .select()
      .from(eventSettingsTable)
      .where(eq(eventSettingsTable.id, 1)),
    db
      .select({
        id: ordersTable.id,
        serviceStyle: ordersTable.serviceStyle,
        guestCount: ordersTable.guestCount,
        status: ordersTable.status,
      })
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.eventDate, date),
          inArray(ordersTable.status, COUNTING_STATUSES),
        ),
      ),
  ]);

  const blackedOut = blackouts.length > 0;
  const settings = settingsRow[0];

  const byStyle = emptyByStyle();
  let confirmedGuestCount = 0;
  let pendingGuestCount = 0;
  let confirmedCount = 0;
  let pendingCount = 0;

  const bookings = orders.map((o) => {
    const key = canonicalServiceStyle(o.serviceStyle);
    const isSoft = SOFT_STATUSES.includes(o.status);
    const guests = o.guestCount ?? 0;
    if (isSoft) {
      pendingGuestCount += guests;
      pendingCount += 1;
      byStyle[key].pending += 1;
    } else {
      confirmedGuestCount += guests;
      confirmedCount += 1;
      byStyle[key].confirmed += 1;
    }
    return {
      id: o.id,
      serviceStyle: key,
      rawServiceStyle: o.serviceStyle,
      guestCount: o.guestCount,
      status: o.status,
      isSoft,
    };
  });

  const slots: Partial<Record<ServiceStyleKey, number>> = {};
  if (settings?.dailyDropOffSlots != null) slots.drop_off = settings.dailyDropOffSlots;
  if (settings?.dailyOnTheDashSlots != null) slots.on_the_dash = settings.dailyOnTheDashSlots;
  if (settings?.dailyBuffetSlots != null) slots.buffet = settings.dailyBuffetSlots;
  if (settings?.dailyGrazingSlots != null) slots.grazing = settings.dailyGrazingSlots;
  if (settings?.dailyMadeToOrderSlots != null) slots.made_to_order = settings.dailyMadeToOrderSlots;

  const dailyGuestCap = settings?.dailyGuestCap ?? null;

  const remainingSlots: Partial<Record<ServiceStyleKey, number>> = {};
  for (const k of Object.keys(slots) as ServiceStyleKey[]) {
    const cap = slots[k]!;
    // Hard load uses confirmed only; pending stays "soft" so a stalled
    // pending row never permanently consumes a slot.
    const used = byStyle[k].confirmed;
    remainingSlots[k] = Math.max(0, cap - used);
  }

  const remainingGuests =
    dailyGuestCap == null ? null : Math.max(0, dailyGuestCap - confirmedGuestCount);

  // Conflicts: any per-style cap that is met or exceeded by confirmed
  // bookings. Surface as human-readable strings the bot can reuse.
  const conflicts: string[] = [];
  for (const k of Object.keys(slots) as ServiceStyleKey[]) {
    if (byStyle[k].confirmed >= slots[k]!) {
      conflicts.push(`${k} is fully booked (${byStyle[k].confirmed}/${slots[k]})`);
    }
  }
  if (dailyGuestCap != null && confirmedGuestCount >= dailyGuestCap) {
    conflicts.push(
      `daily guest cap reached (${confirmedGuestCount}/${dailyGuestCap})`,
    );
  }

  // Overall load tier. Blackouts override everything to "full". The day
  // itself is only "full" when the global guest cap is hit — per-style
  // saturation is "near_full" so the bot can still offer the other
  // styles. (If every style has a cap and they're all at cap, that's
  // also "full" — but only when *every* configured style is full AND
  // there are no uncapped styles left as fallback.)
  const allConfiguredStylesFull =
    Object.keys(slots).length > 0 &&
    Object.keys(slots).every(
      (k) => byStyle[k as ServiceStyleKey].confirmed >= slots[k as ServiceStyleKey]!,
    );
  // Are there any non-"unknown" styles without a configured cap? Those
  // are implicitly unlimited and keep the day from being "full".
  const realStyleKeys = SERVICE_STYLE_KEYS.filter((k) => k !== "unknown");
  const hasUncappedStyle = realStyleKeys.some((k) => slots[k] == null);
  let load: DayLoad["load"];
  if (blackedOut) {
    load = "full";
  } else if (dailyGuestCap != null && confirmedGuestCount >= dailyGuestCap) {
    load = "full";
  } else if (allConfiguredStylesFull && !hasUncappedStyle) {
    load = "full";
  } else if (conflicts.length > 0) {
    // At least one style is full, but other paths remain.
    load = "near_full";
  } else if (
    dailyGuestCap != null &&
    confirmedGuestCount / dailyGuestCap >= 0.7
  ) {
    load = "filling";
  } else if (confirmedCount + pendingCount > 0) {
    load = "filling";
  } else {
    load = "open";
  }

  return {
    date,
    blackedOut,
    bookings,
    totals: {
      confirmedGuestCount,
      pendingGuestCount,
      confirmedCount,
      pendingCount,
      byServiceStyle: byStyle,
    },
    capacity: {
      dailyGuestCap,
      slotsByServiceStyle: slots,
    },
    remaining: {
      guestCount: remainingGuests,
      slotsByServiceStyle: remainingSlots,
    },
    load,
    conflicts,
  };
}

// Walk forward from `date` and return up to `count` upcoming dates
// that aren't blacked out and aren't fully loaded.
export async function findOpenAlternates(
  date: string,
  count = 3,
  maxLookAhead = 60,
): Promise<string[]> {
  const out: string[] = [];
  const start = new Date(`${date}T00:00:00Z`);
  let safety = 0;
  while (out.length < count && safety < maxLookAhead) {
    safety++;
    start.setUTCDate(start.getUTCDate() + 1);
    const ds = start.toISOString().split("T")[0]!;
    const load = await computeDayLoad(ds);
    if (!load.blackedOut && load.load !== "full") {
      out.push(ds);
    }
  }
  return out;
}
