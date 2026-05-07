import { db } from "@workspace/db";
import {
  menuItemsTable,
  menuCategoriesTable,
  recommendedMenuItemsTable,
  cateringInquiriesTable,
  contactRequestsTable,
  eventSettingsTable,
} from "@workspace/db/schema";
import { asc, eq } from "drizzle-orm";
import {
  computeDayLoad,
  findOpenAlternates,
  isRealCalendarDate,
  SERVICE_STYLE_KEYS,
  type ServiceStyleKey,
} from "./dayLoad";
import { sendNewInquiryAlert, sendSms } from "./sms";
import { sendMail, ALERT_TO } from "./mail";
import { sendToCustomerGuarded, normalizePhoneDigits } from "./sms-inbox";
import { getChatPort } from "./sms-ejoin";
import { logger } from "./logger";

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
      name: "request_human_contact",
      description:
        "Hand the conversation off to a real human on the catering team. Call this ONLY after the guest has explicitly asked to talk to a person AND you have collected ALL of: (1) their name, (2) a one-or-two-sentence question/reason describing what they want help with, (3) their preferred contact channel, and (4) the actual contact value. The team will be notified immediately by email and SMS, and (when channel is 'sms') a real text-message thread will be opened with the guest. Never invent a name, phone number, email, or reason — only call this with values the guest typed in this conversation. Call at most once per conversation unless the guest gives a different contact.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Guest's name as they typed it. Required so the team can greet them. Ask for it before calling this tool if it hasn't been shared.",
          },
          summary: {
            type: "string",
            description: "One or two sentences in the guest's own words describing what they want help with (event date, guest count, dietary needs, specific question, etc.). Required so the team shows up prepared. Ask for it before calling this tool if the guest hasn't already explained their question.",
          },
          channel: {
            type: "string",
            enum: ["phone", "email", "sms"],
            description: "How the guest wants to be reached. 'phone' = team will call them, 'email' = team will email them, 'sms' = open a real text-message thread now.",
          },
          contact: {
            type: "string",
            description: "The actual contact value: phone number for 'phone' or 'sms', email address for 'email'. Use what the guest typed verbatim.",
          },
        },
        required: ["name", "summary", "channel", "contact"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "check_event_date",
      description:
        "Check date availability AND day load for a specific date. Use whenever the guest mentions or asks about a date. Pass the date as YYYY-MM-DD (tool input format). The response includes both YYYY-MM-DD fields (`date`, `suggestedDates`) and pre-formatted US-style MM/DD/YYYY fields (`dateDisplay`, `suggestedDatesDisplay`) — when echoing dates back to the guest you MUST use the `*Display` fields, never the YYYY-MM-DD ones. Optionally pass guestCount and/or serviceStyle to get a tailored verdict — the tool will tell you if the day is blacked out, how full it already is, whether the guest's specific service style still has a slot, and (when full or blacked out) up to 3 nearby open dates. Use the response to either confirm cheerfully, suggest a different service style on the same day, or apologize and offer alternate dates.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "Event date in YYYY-MM-DD format." },
          guestCount: {
            type: "number",
            description: "Optional expected guest count. Used to flag when the requested headcount won't fit under the daily guest cap.",
          },
          serviceStyle: {
            type: "string",
            enum: ["drop_off", "on_the_dash"],
            description: "Optional canonical service style the guest is leaning toward. drop_off = Standard Drop-Off (pre-cooked & delivered). on_the_dash = our on-site food trailer cooking fresh. These are the ONLY two styles we offer — do not pass anything else.",
          },
        },
        required: ["date"],
        additionalProperties: false,
      },
    },
  },
];

// ── Human-contact handoff ────────────────────────────────────────────────────
//
// The chat bot calls request_human_contact when the guest explicitly
// asks for a real person AND provides a contact value. We:
//   1. Always log the request to contact_requests (system of record).
//   2. Always email Corey + SMS the owner so the handoff isn't missed.
//   3. For channel="sms" we ALSO create a catering_inquiries row keyed
//      to the guest's normalized phone and send a welcome SMS via the
//      chat port. From that point on, the existing customer-chat
//      pipeline (sms-inbox) routes every inbound text from that
//      number to the inquiry, owner-forwards it, and lets the owner
//      reply with `#<inquiryId> <message>`.
//
// Per-session de-dup keeps a confused model from spamming the team
// when the guest re-confirms.

type RequestHumanContactArgs = {
  channel?: unknown;
  contact?: unknown;
  name?: unknown;
  summary?: unknown;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const handoffsBySession = new Map<string, number>();
const HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;
const HANDOFF_MAX_PER_SESSION = 3;

function pruneHandoffs(now: number) {
  for (const [k, t] of handoffsBySession) {
    if (now - t > HANDOFF_TTL_MS) handoffsBySession.delete(k);
  }
}

async function requestHumanContact(
  raw: RequestHumanContactArgs,
  ctx: RunChatToolContext,
) {
  const channel = typeof raw.channel === "string" ? raw.channel.trim().toLowerCase() : "";
  const contactRaw = typeof raw.contact === "string" ? raw.contact.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 120) : "";
  const summary = typeof raw.summary === "string" ? raw.summary.trim().slice(0, 800) : "";

  if (!name) {
    return {
      ok: false,
      error:
        "Please ask the guest for their name first, then call this tool again with name set.",
    };
  }
  if (!summary || summary.length < 3) {
    return {
      ok: false,
      error:
        "Please ask the guest a one-or-two-sentence question describing what they need (event date, guest count, dietary needs, specific question, etc.), then call this tool again with summary set.",
    };
  }
  if (channel !== "phone" && channel !== "email" && channel !== "sms") {
    return { ok: false, error: "channel must be 'phone', 'email', or 'sms'." };
  }
  if (!contactRaw) {
    return { ok: false, error: "contact is required." };
  }

  let normalizedContact = contactRaw;
  if (channel === "phone" || channel === "sms") {
    const digits = normalizePhoneDigits(contactRaw);
    if (digits.length < 10) {
      return { ok: false, error: "Phone number looks incomplete — please confirm a 10-digit US number." };
    }
    normalizedContact = digits;
  } else if (channel === "email") {
    if (!EMAIL_RE.test(contactRaw) || contactRaw.length > 254) {
      return { ok: false, error: "Email address looks invalid — please double-check it." };
    }
    normalizedContact = contactRaw.toLowerCase();
  }

  // Soft per-session abuse guard. Don't let one chat trigger an
  // unbounded number of handoff alerts even if the model loops.
  const now = Date.now();
  pruneHandoffs(now);
  const sessionKey = ctx.sessionId ?? "anon";
  const recentCount = Array.from(handoffsBySession.entries()).filter(
    ([k]) => k.startsWith(`${sessionKey}|`),
  ).length;
  if (recentCount >= HANDOFF_MAX_PER_SESSION) {
    return {
      ok: false,
      error: "Already handed off to the team for this conversation. The team will reach out shortly.",
      alreadyHandedOff: true,
    };
  }
  const dedupKey = `${sessionKey}|${channel}|${normalizedContact}`;
  if (handoffsBySession.has(dedupKey)) {
    return {
      ok: true,
      duplicate: true,
      message: "We already let the team know — they'll be in touch shortly.",
    };
  }

  const channelLabel =
    channel === "phone" ? "phone call" : channel === "email" ? "email" : "text message";
  const guestName = name || "Guest";

  let inquiryId: number | null = null;

  // For SMS handoffs we bridge into the existing customer-chat
  // pipeline by creating a real inquiry row keyed to the guest's
  // phone. Future inbound texts from that number will auto-match by
  // normalizePhoneDigits and forward to the owner with the
  // [Catering #N] tag the owner already knows how to reply to.
  if (channel === "sms") {
    try {
      const adminNote = [
        "Initiated via website AI chat (handoff to text).",
        summary ? `Summary: ${summary}` : null,
      ]
        .filter(Boolean)
        .join("\n");
      const [row] = await db
        .insert(cateringInquiriesTable)
        .values({
          clientName: guestName,
          clientPhone: normalizedContact,
          adminNotes: adminNote || null,
          source: "chat",
          status: "inquiry",
        } as typeof cateringInquiriesTable.$inferInsert)
        .returning({ id: cateringInquiriesTable.id });
      inquiryId = row?.id ?? null;
    } catch (err) {
      logger.error({ err }, "[chat] failed to create inquiry for SMS handoff");
    }
  }

  // Persist the handoff request itself. Best-effort — failing to log
  // shouldn't stop the alerts.
  try {
    await db.insert(contactRequestsTable).values({
      name: guestName === "Guest" ? null : guestName,
      channel,
      contactValue: normalizedContact,
      summary: summary || null,
      chatSessionId: ctx.sessionId ?? null,
      inquiryId,
    });
  } catch (err) {
    logger.warn({ err }, "[chat] failed to persist contact_requests row");
  }

  // SMS-channel: send a welcome text to the customer via the chat
  // port so the thread is "live" the moment the bot tells them we'll
  // text. Subsequent customer texts auto-match the inquiry above.
  let smsBridgeStatus: "sent" | "blocked" | "no-chat-port" | "failed" | null = null;
  if (channel === "sms") {
    try {
      const port = await getChatPort();
      if (port == null) {
        smsBridgeStatus = "no-chat-port";
        logger.warn("[chat] SMS handoff requested but no chat port configured");
      } else {
        const firstName = guestName.split(/\s+/)[0] || "there";
        const welcome = `Hi ${firstName}, this is dash by Hollywood East Cafe. Thanks for reaching out via our website. Reply here and a team member will help plan your event. Reply STOP to opt out.`;
        const result = await sendToCustomerGuarded({
          to: normalizedContact,
          body: welcome,
          inquiryId,
          source: "system",
        });
        smsBridgeStatus = result.status === "sent" ? "sent" : "blocked";
      }
    } catch (err) {
      smsBridgeStatus = "failed";
      logger.error({ err }, "[chat] failed to send SMS handoff welcome");
    }
  }

  // Owner SMS alert. For SMS-channel we use the catering-inquiry
  // alert so the owner sees the inquiry id (and can reply to the
  // guest with #<id> <body>). For phone/email we send a leaner ad-hoc
  // alert so the owner has the contact value ready to dial / reply.
  try {
    if (channel === "sms" && inquiryId != null) {
      await sendNewInquiryAlert({
        clientName: guestName,
        source: "chat",
        clientPhone: normalizedContact,
        link: null,
      });
    } else {
      // Reuse sendNewInquiryAlert's owner-phone resolution + formatter
      // by mapping the handoff into its supported fields. clientPhone
      // already prints as "Phone: ..." for callbacks; for email we
      // stash the address into venueAddress so it prints on its own
      // line as "Venue: Email: ...". Summary is intentionally NOT
      // passed (the email below carries the full context); keeping
      // the SMS short avoids multi-segment cost.
      await sendNewInquiryAlert({
        clientName: `${guestName} (chat ${channelLabel})`,
        source: "chat",
        clientPhone: channel === "phone" ? normalizedContact : null,
        venueAddress: channel === "email" ? `Email ${normalizedContact}` : null,
      });
    }
  } catch (err) {
    logger.warn({ err }, "[chat] owner SMS handoff alert failed");
  }

  // Owner email — Corey gets a copy regardless of channel so the
  // handoff has an audit trail in the inbox even when SMS is down.
  try {
    const subjectChannel =
      channel === "phone" ? "phone callback" : channel === "email" ? "email reply" : "text message";
    const html = [
      `<p><strong>${escapeHtml(guestName)}</strong> asked the website chat to be reached by ${escapeHtml(subjectChannel)}.</p>`,
      `<p><strong>Contact:</strong> ${escapeHtml(normalizedContact)}</p>`,
      summary ? `<p><strong>Summary:</strong><br/>${escapeHtml(summary).replace(/\n/g, "<br/>")}</p>` : "",
      inquiryId != null
        ? `<p>Inquiry created: <strong>#${inquiryId}</strong>. Reply to the guest by texting <code>#${inquiryId} your message</code> to the catering chat number.</p>`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    const text = [
      `${guestName} asked the website chat to be reached by ${subjectChannel}.`,
      `Contact: ${normalizedContact}`,
      summary ? `Summary: ${summary}` : null,
      inquiryId != null ? `Inquiry #${inquiryId} created (reply with #${inquiryId} <msg>).` : null,
    ]
      .filter(Boolean)
      .join("\n");
    // Resolve recipient via the same chain the SMS Settings UI shows:
    // smsChatOwnerEmail → ownerNotificationEmail → legacy hardcoded
    // ALERT_TO (sendMail's default when `to` is omitted).
    let resolvedTo = ALERT_TO;
    try {
      const [settings] = await db
        .select({
          chatOwner: eventSettingsTable.smsChatOwnerEmail,
          owner: eventSettingsTable.ownerNotificationEmail,
        })
        .from(eventSettingsTable)
        .where(eq(eventSettingsTable.id, 1));
      resolvedTo =
        settings?.chatOwner?.trim() ||
        settings?.owner?.trim() ||
        ALERT_TO;
    } catch (err) {
      logger.warn({ err }, "[chat] failed to resolve chat-owner email; falling back to default ALERT_TO");
    }
    await sendMail({
      to: resolvedTo,
      subject: `Catering chat handoff (${subjectChannel}) — ${guestName}`,
      text,
      html,
    });
  } catch (err) {
    logger.warn({ err }, "[chat] owner email handoff alert failed");
  }

  handoffsBySession.set(dedupKey, now);

  // Reply tailored so the model can quote the right reassurance back
  // to the guest. We deliberately do NOT include phone numbers or
  // promised callback windows the team hasn't authorized.
  if (channel === "sms") {
    const successText =
      smsBridgeStatus === "sent"
        ? "We just sent you a quick text from our catering line — reply there and a team member will help plan your event."
        : smsBridgeStatus === "no-chat-port"
          ? "We have your number and the team will text you shortly."
          : "We have your number and the team will text you shortly.";
    return {
      ok: true,
      channel,
      smsBridge: smsBridgeStatus,
      inquiryId,
      message: successText,
    };
  }
  return {
    ok: true,
    channel,
    message:
      channel === "phone"
        ? "We have your number and a team member will give you a call as soon as they can."
        : "We have your email and a team member will reply as soon as they can.",
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Format an ISO YYYY-MM-DD string as US-style MM/DD/YYYY for guest-facing
// echoes from the chat bot. Falls back to the input if it isn't shaped like
// YYYY-MM-DD so we never crash on unexpected values.
function formatDateUS(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

async function checkEventDate(args: {
  date: string;
  guestCount?: number;
  serviceStyle?: ServiceStyleKey;
}) {
  const { date, guestCount, serviceStyle } = args;
  if (!isRealCalendarDate(date)) {
    return { error: "Date must be a real calendar date in YYYY-MM-DD format." };
  }
  if (
    serviceStyle !== undefined &&
    !SERVICE_STYLE_KEYS.includes(serviceStyle)
  ) {
    return { error: `Unknown serviceStyle: ${serviceStyle}` };
  }
  const load = await computeDayLoad(date);

  // Tailored verdict for the model. We summarize the salient stuff so
  // the bot doesn't have to reason about the full payload — but we also
  // include a compact `summary` block so it can quote concrete numbers
  // when helpful.
  const styleSlot =
    serviceStyle && load.capacity.slotsByServiceStyle[serviceStyle] != null
      ? {
          cap: load.capacity.slotsByServiceStyle[serviceStyle]!,
          confirmed: load.totals.byServiceStyle[serviceStyle].confirmed,
          remaining: load.remaining.slotsByServiceStyle[serviceStyle] ?? 0,
        }
      : null;

  const requestedStyleAvailable =
    serviceStyle == null
      ? null
      : styleSlot == null
        ? true // no cap configured for that style → always available
        : styleSlot.remaining > 0;

  const guestCountFits =
    guestCount == null || load.capacity.dailyGuestCap == null
      ? null
      : (load.remaining.guestCount ?? 0) >= guestCount;

  const needsAlternateDate =
    load.blackedOut ||
    load.load === "full" ||
    (requestedStyleAvailable === false && load.load === "near_full") ||
    guestCountFits === false;

  const suggestedDates = needsAlternateDate
    ? await findOpenAlternates(date, 3)
    : [];

  // Collect alternate styles that still have room when the requested
  // style is full but the day itself is not. We only ever surface the
  // two service styles we actually offer (drop_off, on_the_dash) so the
  // bot never gets handed buffet/grazing/made_to_order as a suggestion
  // even if the admin happened to leave caps unconfigured for them.
  const OFFERED_STYLES: ServiceStyleKey[] = ["drop_off", "on_the_dash"];
  const alternateStyles: ServiceStyleKey[] = [];
  if (
    serviceStyle &&
    requestedStyleAvailable === false &&
    !load.blackedOut &&
    load.load !== "full"
  ) {
    for (const k of OFFERED_STYLES) {
      if (k === serviceStyle) continue;
      const cap = load.capacity.slotsByServiceStyle[k];
      if (cap == null) {
        // No cap configured → always available.
        alternateStyles.push(k);
      } else if ((load.remaining.slotsByServiceStyle[k] ?? 0) > 0) {
        alternateStyles.push(k);
      }
    }
  }

  return {
    date,
    // Pre-formatted MM/DD/YYYY copy of `date` so the model can quote the
    // date back to the guest in US format without having to reformat it.
    dateDisplay: formatDateUS(date),
    available: !load.blackedOut && load.load !== "full",
    blackedOut: load.blackedOut,
    load: load.load,
    requestedStyle: serviceStyle ?? null,
    requestedStyleAvailable,
    requestedGuestCount: guestCount ?? null,
    guestCountFits,
    alternateStyles,
    suggestedDates,
    // Same suggested dates pre-formatted as MM/DD/YYYY for guest-facing
    // replies. The model should ALWAYS quote dates from this list, never
    // from `suggestedDates` (which stays in YYYY-MM-DD for tool calls).
    suggestedDatesDisplay: suggestedDates.map(formatDateUS),
    summary: {
      confirmedGuestCount: load.totals.confirmedGuestCount,
      dailyGuestCap: load.capacity.dailyGuestCap,
      remainingGuests: load.remaining.guestCount,
      conflicts: load.conflicts,
      styleSlot,
    },
  };
}

export type RunChatToolContext = {
  sessionId?: string;
};

export async function runChatTool(
  name: string,
  args: unknown,
  snap: Snapshot,
  ctx: RunChatToolContext = {},
): Promise<unknown> {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (name) {
    case "request_human_contact":
      return requestHumanContact(a as RequestHumanContactArgs, ctx);
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
    case "check_event_date": {
      const date = typeof a.date === "string" ? a.date : "";
      const guestCount =
        typeof a.guestCount === "number" && Number.isFinite(a.guestCount)
          ? a.guestCount
          : undefined;
      const serviceStyleRaw = typeof a.serviceStyle === "string" ? a.serviceStyle : undefined;
      const serviceStyle =
        serviceStyleRaw && (SERVICE_STYLE_KEYS as readonly string[]).includes(serviceStyleRaw)
          ? (serviceStyleRaw as ServiceStyleKey)
          : undefined;
      return checkEventDate({ date, guestCount, serviceStyle });
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
