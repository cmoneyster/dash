import { db } from "@workspace/db";
import {
  menuItemsTable,
  menuCategoriesTable,
  recommendedMenuItemsTable,
  blackoutDatesTable,
} from "@workspace/db/schema";
import { asc } from "drizzle-orm";

// Per-session snapshot of the menu the chat bot is allowed to talk about.
// Built once at first message of a session, then reused for the rest of
// that conversation so that admin changes mid-chat don't shift the bot's
// answers under the guest. Pricing fields are deliberately stripped here
// so the model has no way to read prices aloud — pricing always routes
// the guest back to the menu page.

const TTL_MS = 60 * 60 * 1000; // 60 minutes
const MAX_SESSIONS = 1000;

export type SnapshotItem = {
  id: number;
  name: string;
  category: string;
  description: string;
  servingSize: number;
  unit: string;
  allergens: string[];
};

export type Snapshot = {
  items: SnapshotItem[];
  categoryOrder: string[];
  recommendedItemIds: number[];
  createdAt: number;
};

const cache = new Map<string, Snapshot>();
// Tracks in-flight snapshot builds so concurrent first-message requests
// for the same session don't trigger duplicate DB queries.
const inflight = new Map<string, Promise<Snapshot>>();

// Links exposed to the model are kept relative (`/menu?category=...`) so
// the chat widget's safe-link renderer (which only allows same-origin
// `/...` URLs) can turn them into real <a> tags. Returning absolute
// URLs would defeat that filter and the links would render as plain
// text.
export function buildMenuLink(category: string): string {
  return `/menu?category=${encodeURIComponent(category)}`;
}

function evictExpiredAndCap(now: number) {
  for (const [k, v] of cache) {
    if (now - v.createdAt > TTL_MS) cache.delete(k);
  }
  while (cache.size >= MAX_SESSIONS) {
    const firstKey = cache.keys().next().value;
    if (firstKey === undefined) break;
    cache.delete(firstKey);
  }
}

export async function getOrCreateSnapshot(sessionId: string): Promise<Snapshot> {
  const now = Date.now();
  evictExpiredAndCap(now);
  const existing = cache.get(sessionId);
  if (existing && now - existing.createdAt <= TTL_MS) return existing;

  const pending = inflight.get(sessionId);
  if (pending) return pending;

  const promise = (async (): Promise<Snapshot> => {
    const [items, cats, recs] = await Promise.all([
      db.select().from(menuItemsTable).orderBy(asc(menuItemsTable.sortOrder), asc(menuItemsTable.id)),
      db.select().from(menuCategoriesTable).orderBy(asc(menuCategoriesTable.sortOrder)),
      db
        .select({ menuItemId: recommendedMenuItemsTable.menuItemId })
        .from(recommendedMenuItemsTable)
        .orderBy(
          asc(recommendedMenuItemsTable.sortOrder),
          asc(recommendedMenuItemsTable.menuItemId),
        ),
    ]);
    const hidden = new Set(cats.filter((c) => !c.visible).map((c) => c.name));
    const filtered: SnapshotItem[] = items
      .filter((i) => i.available && !hidden.has(i.category))
      .map((i) => ({
        id: i.id,
        name: i.name,
        category: i.category,
        description: i.description,
        servingSize: i.servingSize,
        unit: i.unit,
        allergens: i.allergens ?? [],
      }));
    const present = new Set(filtered.map((i) => i.category));
    const orderedFromCats = cats
      .filter((c) => c.visible && present.has(c.name))
      .map((c) => c.name);
    const categoryOrder = [
      ...orderedFromCats,
      ...Array.from(present).filter((c) => !orderedFromCats.includes(c)),
    ];

    const visibleIds = new Set(filtered.map((i) => i.id));
    const recommendedItemIds = recs
      .map((r) => r.menuItemId)
      .filter((id) => visibleIds.has(id));

    const snap: Snapshot = {
      items: filtered,
      categoryOrder,
      recommendedItemIds,
      createdAt: Date.now(),
    };
    cache.set(sessionId, snap);
    return snap;
  })().finally(() => {
    inflight.delete(sessionId);
  });

  inflight.set(sessionId, promise);
  return promise;
}

// Conservative dietary filter rules. Real-world allergen tags rarely
// list "beef" or "shrimp" — they're more likely to call out cross-cuts
// like "gluten" or "dairy". So for diet types where the underlying
// concept is "no animal flesh", we ALSO scan the item's name,
// description, and category for those terms. We'd rather miss an
// edge-case vegetarian item than hand the guest a chicken dish under
// "vegetarian".
type DietaryRule = {
  // Strings to look for inside name + description + category.
  textTerms?: string[];
  // Strings to compare to entries of the item's allergens array (case-insensitive).
  allergens?: string[];
};
const DIETARY_RULES: Record<string, DietaryRule> = {
  vegetarian: {
    textTerms: [
      "meat", "beef", "steak", "pork", "bacon", "ham", "sausage", "chorizo",
      "chicken", "poultry", "turkey", "duck", "lamb", "veal", "venison",
      "fish", "salmon", "tuna", "cod", "anchovy", "anchovies",
      "seafood", "shrimp", "prawn", "crab", "lobster", "shellfish", "mussel",
      "oyster", "scallop", "clam", "octopus", "squid", "calamari",
    ],
    allergens: ["fish", "shellfish"],
  },
  vegan: {
    textTerms: [
      // Same as vegetarian:
      "meat", "beef", "steak", "pork", "bacon", "ham", "sausage", "chorizo",
      "chicken", "poultry", "turkey", "duck", "lamb", "veal", "venison",
      "fish", "salmon", "tuna", "cod", "anchovy", "anchovies",
      "seafood", "shrimp", "prawn", "crab", "lobster", "shellfish", "mussel",
      "oyster", "scallop", "clam", "octopus", "squid", "calamari",
      // Plus animal byproducts:
      "milk", "cheese", "butter", "cream", "yogurt", "yoghurt", "ghee",
      "egg", "eggs", "honey",
    ],
    allergens: ["fish", "shellfish", "dairy", "milk", "egg", "eggs"],
  },
  gluten_free: {
    textTerms: [], // gluten is usually only reliably tagged via the allergen
    allergens: ["gluten", "wheat"],
  },
  nut_free: {
    textTerms: [],
    allergens: ["nuts", "tree nuts", "tree-nuts", "peanut", "peanuts"],
  },
  dairy_free: {
    textTerms: [],
    allergens: ["dairy", "milk", "cheese"],
  },
};

export type SearchArgs = {
  query?: string;
  category?: string;
  dietary?: string[];
  excludeAllergens?: string[];
  limit?: number;
};

export function searchMenu(snap: Snapshot, args: SearchArgs) {
  const q = args.query?.trim().toLowerCase() ?? "";
  const cat = args.category?.trim().toLowerCase() ?? "";
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 25);

  const dietary = args.dietary ?? [];
  const textTermExcludes = new Set<string>();
  const allergenExcludes = new Set<string>();
  for (const d of dietary) {
    const rule = DIETARY_RULES[d];
    if (!rule) continue;
    for (const t of rule.textTerms ?? []) textTermExcludes.add(t.toLowerCase());
    for (const a of rule.allergens ?? []) allergenExcludes.add(a.toLowerCase());
  }
  for (const a of args.excludeAllergens ?? []) allergenExcludes.add(a.toLowerCase());

  const matches = snap.items.filter((item) => {
    if (cat && item.category.toLowerCase() !== cat) return false;
    if (q) {
      const hay = `${item.name} ${item.description} ${item.category}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (allergenExcludes.size > 0) {
      const itemAllergens = item.allergens.map((a) => a.toLowerCase());
      for (const x of allergenExcludes) {
        if (itemAllergens.includes(x)) return false;
      }
    }
    if (textTermExcludes.size > 0) {
      const haystack = `${item.name} ${item.description} ${item.category}`.toLowerCase();
      for (const term of textTermExcludes) {
        // Word-ish boundary so "ham" doesn't strike "hamlet" but does
        // strike "ham", "ham,", "ham." etc.
        const re = new RegExp(`(?:^|[^a-z])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^a-z]|$)`);
        if (re.test(haystack)) return false;
      }
    }
    return true;
  });

  return matches.slice(0, limit).map((item) => ({
    id: item.id,
    name: item.name,
    category: item.category,
    description: item.description,
    servingSize: item.servingSize,
    unit: item.unit,
    allergens: item.allergens,
    link: buildMenuLink(item.category),
  }));
}

export function listCategories(snap: Snapshot): string[] {
  return snap.categoryOrder;
}

export function listRecommendedItems(snap: Snapshot) {
  return snap.recommendedItemIds
    .map((id) => snap.items.find((i) => i.id === id))
    .filter((i): i is SnapshotItem => i != null)
    .map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category,
      description: item.description,
      servingSize: item.servingSize,
      unit: item.unit,
      allergens: item.allergens,
      link: buildMenuLink(item.category),
    }));
}

export function getMenuItem(snap: Snapshot, id: number) {
  const item = snap.items.find((i) => i.id === id);
  if (!item) return null;
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    description: item.description,
    servingSize: item.servingSize,
    unit: item.unit,
    allergens: item.allergens,
    link: buildMenuLink(item.category),
  };
}

export const CHAT_TOOL_DEFS = [
  {
    type: "function" as const,
    function: {
      name: "search_menu",
      description:
        "Search the live, currently-available catering menu. Use this whenever the guest asks about food, categories, dietary fit, or allergens. Never invent items — only recommend things this returns.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text keyword to match against name, description, and category." },
          category: { type: "string", description: "Exact category name (e.g. 'Appetizers')." },
          dietary: {
            type: "array",
            items: { type: "string", enum: ["vegetarian", "vegan", "gluten_free", "nut_free", "dairy_free"] },
            description: "Dietary filters. Items matching any listed allergen are excluded.",
          },
          excludeAllergens: {
            type: "array",
            items: { type: "string" },
            description: "Specific allergens to exclude (case-insensitive match against the item's allergens list).",
          },
          limit: { type: "number", description: "Max items to return (default 10, max 25)." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_categories",
      description: "List the menu categories that have at least one currently-available item.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_recommended_items",
      description:
        "Return the admin-curated list of recommended menu items, in admin-set order. Use this FIRST when the guest asks open-ended things like 'what do you recommend?', 'what's popular?', 'what should I get?', 'your favorites?'. Returns an empty array if the team hasn't curated a list yet — in that case fall back to search_menu and stay honest about it.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_menu_item",
      description: "Fetch a single available menu item's full description by id. Returns null if the id isn't on the live menu.",
      parameters: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "check_event_date_availability",
      description:
        "Check whether a specific date is available for catering (i.e. not on the team's blackout list). Use whenever the guest mentions or asks about a specific date. Pass the date as YYYY-MM-DD. Returns { available: boolean, date: string, suggestedDates: string[] } — when unavailable, suggestedDates contains up to 3 nearby open dates.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Event date in YYYY-MM-DD format.",
          },
        },
        required: ["date"],
        additionalProperties: false,
      },
    },
  },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealCalendarDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().split("T")[0] === date;
}

async function checkEventDateAvailability(date: string) {
  if (!isRealCalendarDate(date)) {
    return { error: "Date must be a real calendar date in YYYY-MM-DD format." };
  }
  const all = await db.select().from(blackoutDatesTable);
  const blackoutSet = new Set(all.map((b) => b.date));
  const available = !blackoutSet.has(date);
  const suggestedDates: string[] = [];
  if (!available) {
    const start = new Date(`${date}T00:00:00Z`);
    const probe = new Date(start);
    probe.setUTCDate(probe.getUTCDate() + 1);
    let safety = 0;
    while (suggestedDates.length < 3 && safety < 365) {
      const ds = probe.toISOString().split("T")[0]!;
      if (!blackoutSet.has(ds)) suggestedDates.push(ds);
      probe.setUTCDate(probe.getUTCDate() + 1);
      safety++;
    }
  }
  return { available, date, suggestedDates };
}

export async function runChatTool(name: string, args: unknown, snap: Snapshot): Promise<unknown> {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (name) {
    case "search_menu":
      return searchMenu(snap, a as SearchArgs);
    case "list_categories":
      return listCategories(snap);
    case "list_recommended_items":
      return listRecommendedItems(snap);
    case "get_menu_item": {
      const id = Number(a.id);
      if (!Number.isFinite(id)) return null;
      return getMenuItem(snap, id);
    }
    case "check_event_date_availability": {
      const date = typeof a.date === "string" ? a.date : "";
      return checkEventDateAvailability(date);
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
