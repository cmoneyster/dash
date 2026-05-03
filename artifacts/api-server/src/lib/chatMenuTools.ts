import { db } from "@workspace/db";
import { menuItemsTable, menuCategoriesTable } from "@workspace/db/schema";
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
  createdAt: number;
};

const cache = new Map<string, Snapshot>();
// Tracks in-flight snapshot builds so concurrent first-message requests
// for the same session don't trigger duplicate DB queries.
const inflight = new Map<string, Promise<Snapshot>>();

export function trustedPublicOrigin(): string {
  const explicit = process.env.PUBLIC_APP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const first = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (first) return `https://${first}`;
  const dev = process.env.REPLIT_DEV_DOMAIN?.trim();
  if (dev) return `https://${dev}`;
  return "http://localhost";
}

export function buildMenuLink(publicOrigin: string, category: string): string {
  return `${publicOrigin}/menu?category=${encodeURIComponent(category)}`;
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
    const [items, cats] = await Promise.all([
      db.select().from(menuItemsTable).orderBy(asc(menuItemsTable.sortOrder), asc(menuItemsTable.id)),
      db.select().from(menuCategoriesTable).orderBy(asc(menuCategoriesTable.sortOrder)),
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

    const snap: Snapshot = { items: filtered, categoryOrder, createdAt: Date.now() };
    cache.set(sessionId, snap);
    return snap;
  })().finally(() => {
    inflight.delete(sessionId);
  });

  inflight.set(sessionId, promise);
  return promise;
}

// Conservative dietary-to-allergen mapping. The bot is told to use this
// to filter, but is also told not to over-claim — if the snapshot has
// nothing matching, we'd rather it say so than guess.
const DIETARY_EXCLUDES: Record<string, string[]> = {
  vegetarian: ["meat", "beef", "pork", "chicken", "poultry", "lamb", "fish", "seafood", "shellfish"],
  vegan: [
    "meat", "beef", "pork", "chicken", "poultry", "lamb", "fish", "seafood", "shellfish",
    "dairy", "milk", "cheese", "egg", "eggs", "honey",
  ],
  gluten_free: ["gluten", "wheat"],
  nut_free: ["nuts", "tree nuts", "peanut", "peanuts"],
  dairy_free: ["dairy", "milk", "cheese"],
};

export type SearchArgs = {
  query?: string;
  category?: string;
  dietary?: string[];
  excludeAllergens?: string[];
  limit?: number;
};

export function searchMenu(snap: Snapshot, args: SearchArgs, publicOrigin: string) {
  const q = args.query?.trim().toLowerCase() ?? "";
  const cat = args.category?.trim().toLowerCase() ?? "";
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 25);
  const excludes = new Set<string>();
  for (const d of args.dietary ?? []) {
    for (const a of DIETARY_EXCLUDES[d] ?? []) excludes.add(a.toLowerCase());
  }
  for (const a of args.excludeAllergens ?? []) excludes.add(a.toLowerCase());

  const matches = snap.items.filter((item) => {
    if (cat && item.category.toLowerCase() !== cat) return false;
    if (q) {
      const hay = `${item.name} ${item.description} ${item.category}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (excludes.size > 0) {
      const itemAllergens = item.allergens.map((a) => a.toLowerCase());
      for (const x of excludes) {
        if (itemAllergens.includes(x)) return false;
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
    link: buildMenuLink(publicOrigin, item.category),
  }));
}

export function listCategories(snap: Snapshot): string[] {
  return snap.categoryOrder;
}

export function getMenuItem(snap: Snapshot, id: number, publicOrigin: string) {
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
    link: buildMenuLink(publicOrigin, item.category),
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
];

export function runChatTool(name: string, args: unknown, snap: Snapshot, publicOrigin: string): unknown {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (name) {
    case "search_menu":
      return searchMenu(snap, a as SearchArgs, publicOrigin);
    case "list_categories":
      return listCategories(snap);
    case "get_menu_item": {
      const id = Number(a.id);
      if (!Number.isFinite(id)) return null;
      return getMenuItem(snap, id, publicOrigin);
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
