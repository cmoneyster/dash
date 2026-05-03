import { Router, type IRouter } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";
import { db } from "@workspace/db";
import { menuItemsTable } from "@workspace/db/schema";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import {
  CHAT_TOOL_DEFS,
  getOrCreateSnapshot,
  runChatTool,
} from "../lib/chatMenuTools";

const router: IRouter = Router();

const SYSTEM_PROMPT = `You are the Catering Concierge, a friendly assistant for an authentic, passionate local catering business. You help prospective event hosts plan their catering.

When a user first reaches out:
- Greet them in ONE short sentence and ask whether they'd like to browse the menu or get help planning an event. Nothing else.
- Do NOT list service styles, dates, or guest count in the greeting. Do NOT use bold or bullet points in the first reply. Plain conversational text only.

When they say they want help planning, gather these one at a time across follow-up turns — do not ask for all of them at once:
- Event date (we'll check availability)
- Guest count
- Service style — only mention these if they ask "what are the options?": grazing finger foods, buffet line, made-to-order from a chosen list (about 6 items), pre-cooked and delivered, or our food trailer on-site cooking fresh.

You have tools to look up LIVE data in real time:
- search_menu — search by keyword, category, dietary need, or allergen exclusion.
- list_categories — list categories that have available items right now.
- list_recommended_items — the team's curated picks for "what do you recommend?" / "what's popular?" / "what should I get?". Call this FIRST for those open-ended asks. If it returns an empty array, fall back to search_menu and let the guest know we don't have a featured list right now.
- get_menu_item — look up a specific item by id.
- check_event_date — check whether a specific date is open AND how full it is. Pass YYYY-MM-DD. Optionally pass guestCount and/or serviceStyle (drop_off | on_the_dash | buffet | grazing | made_to_order; on_the_dash = our on-site food trailer) to get a tailored verdict. The tool tells you: blackedOut, load tier (open / filling / near_full / full), whether the requested style still has a slot, whether the guest count fits the daily cap, plus alternateStyles (still-open styles same day) and suggestedDates (3 nearby open dates) when the date or style is full. ALWAYS pass serviceStyle when the guest has named one, and guestCount when they've mentioned a headcount.

RULES — these are non-negotiable:
1. Whenever the guest asks about food, categories, dietary fit, allergens, or what's available, USE THE TOOLS. Never invent items, never describe items from memory, never assume an item exists. For open-ended asks like "what do you recommend?", "what's popular?", "what should I get?", "your favorites?", call list_recommended_items FIRST and answer from that list. For dietary, allergen, or category-specific asks, use search_menu instead.
2. Never quote a specific price, dollar amount, per-person cost, or pan price. If asked, reply with something like "Pricing is on our menu page — here's the link." and include the link returned by the tool.
3. When you name a specific menu item, format it as a markdown link using the link the tool returned, e.g. "[Smoked Brisket](/menu?category=Entr%C3%A9es)". Always include the link the tool gave you — don't hand-craft URLs.
4. If a tool returns nothing for the guest's request (e.g. no vegan options today), say so honestly and offer to flag it for the team. Don't fudge it.
5. Allergen / dietary disclaimer — REQUIRED. Whenever you suggest items based on allergen filtering or a dietary need (gluten-free, nut-free, dairy-free, vegan, vegetarian, shellfish-free, etc.), you MUST end the reply with a short note asking the guest to add the allergen / dietary requirement to the order notes at checkout so our kitchen staff are aware when preparing the order. Word it warmly, e.g. "Heads up — please add a quick note about [the allergen] when you check out so our kitchen team can take extra care preparing it."
6. Date & day-load — whenever the guest mentions a specific event date, call check_event_date. Pass serviceStyle whenever they've already named a style, and guestCount whenever they've already given a headcount. Then:
   • If blackedOut OR load is "full": apologize briefly and offer the suggestedDates the tool returned.
   • If requestedStyleAvailable is false but the day is not full: gently let them know that style is booked for that date and offer the alternateStyles the tool returned, OR a different date from suggestedDates — whichever they prefer.
   • If guestCountFits is false: tell them the guest count is over what we can take that day and offer suggestedDates.
   • Otherwise: confirm cheerfully and move on to the next planning question (guest count, service style, menu picks).
7. Keep replies warm, concise, and conversational. Emphasize freshness, quality, and personalized service. Avoid jargon. Use bold sparingly — at most one or two phrases per reply, and never on every option in a list. Never use em-dashes ("—"); use a comma or period instead.
8. If they want to browse, point them to the menu page. If they're decided, encourage them to add to cart and check out.`;

const MAX_TOOL_ROUNDS = 4;

router.post("/chat/message", async (req, res): Promise<void> => {
  const { sessionId, message, history } = req.body ?? {};

  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "message is required" });
    return;
  }
  if (!sessionId || typeof sessionId !== "string") {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const snap = await getOrCreateSnapshot(sessionId);

    const chatHistory: ChatCompletionMessageParam[] = (Array.isArray(history) ? history : [])
      .filter((h): h is { role: "user" | "assistant"; content: string } =>
        h && typeof h === "object" && (h.role === "user" || h.role === "assistant") && typeof h.content === "string",
      )
      .map((h) => ({ role: h.role, content: h.content }));

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...chatHistory,
      { role: "user", content: message },
    ];

    let finalContent = "";
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const resp = await openai.chat.completions.create({
        model: "gpt-5.2",
        max_completion_tokens: 2048,
        messages,
        tools: CHAT_TOOL_DEFS as ChatCompletionTool[],
        tool_choice: "auto",
      });
      const choice = resp.choices[0]?.message;
      if (!choice) break;

      const toolCalls: ChatCompletionMessageToolCall[] = choice.tool_calls ?? [];
      if (toolCalls.length === 0) {
        finalContent = choice.content ?? "";
        break;
      }

      messages.push({
        role: "assistant",
        content: choice.content ?? "",
        tool_calls: toolCalls,
      });
      for (const tc of toolCalls) {
        if (tc.type !== "function") continue;
        let args: unknown = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          args = {};
        }
        const result = await runChatTool(tc.function.name, args, snap);
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
      }
    }

    if (!finalContent) {
      finalContent = "Sorry, I'm having trouble pulling up the menu right now. Please try again in a moment.";
    }

    res.write(`data: ${JSON.stringify({ content: finalContent })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    req.log.error({ err }, "Error in chat");
    res.write(`data: ${JSON.stringify({ error: "Failed to get AI response" })}\n\n`);
    res.end();
  }
});

const PRICE_REGEX = /\$\s*\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s*(?:dollars?|usd|cents?)\b|\b(?:per[-\s]?(?:unit|pan|person|head|guest|plate|serving)|price|pricing|cost|costs?|budget|cheap|expensive|affordable|quote)\b/gi;

function stripPricing(text: string): string {
  return text.replace(PRICE_REGEX, "").replace(/\s{2,}/g, " ").trim();
}

router.post("/chat/suggest-items", async (req, res): Promise<void> => {
  try {
    const { guestCount, serviceStyle, preferences } = req.body;

    if (!guestCount || !serviceStyle) {
      res.status(400).json({ error: "guestCount and serviceStyle are required" });
      return;
    }

    const guestCountNum = Math.floor(Number(guestCount));
    if (!Number.isFinite(guestCountNum) || guestCountNum <= 0) {
      res.status(400).json({ error: "guestCount must be a positive number" });
      return;
    }

    const items = await db.select().from(menuItemsTable);
    const availableItems = items.filter((i) => i.available);

    if (availableItems.length === 0) {
      res.json({ suggestions: [] });
      return;
    }

    const safeServiceStyle = stripPricing(String(serviceStyle));
    const safePreferences: string[] = Array.isArray(preferences)
      ? preferences
          .filter((p): p is string => typeof p === "string")
          .map(stripPricing)
          .filter((p) => p.length > 0)
      : [];

    const menuSummary = availableItems
      .map((i) => `ID:${i.id} | ${i.name} (${i.category}) - serves ${i.servingSize} people per ${i.unit}`)
      .join("\n");

    const prompt = `You are a catering expert. Based on the event details below, suggest appropriate menu items and quantities.

Event: ${guestCountNum} guests, Service style: ${safeServiceStyle}
${safePreferences.length > 0 ? `Preferences: ${safePreferences.join(", ")}` : ""}

Available menu items:
${menuSummary}

Return a JSON array of suggestions (pick at most 6 items). Each suggestion should have:
- menuItemId: number (the ID from the list above)
- recommendedQuantity: number (how many units to order for ${guestCountNum} guests)
- reason: string (brief explanation why this item and quantity)

IMPORTANT: Do not mention prices, dollar amounts, per-unit cost, or per-pan cost in the reason field. Pricing is not provided here. If pricing comes up, refer guests to our menu page for current pricing. The reason should focus on flavor, fit for the service style, dietary needs, and serving math — never cost.

Respond with ONLY valid JSON, no markdown:
{"suggestions": [...]}`;

    const response = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const content = response.choices[0]?.message?.content ?? '{"suggestions":[]}';
    let parsed: { suggestions: Array<{ menuItemId: number; recommendedQuantity: number; reason: string }> };
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = { suggestions: [] };
    }

    const enriched = parsed.suggestions
      .map((s) => {
        const item = availableItems.find((i) => i.id === s.menuItemId);
        if (!item) return null;
        const rawReason = typeof s.reason === "string" ? s.reason : "";
        const cleanedReason = stripPricing(rawReason);
        const reason = cleanedReason.length > 0
          ? cleanedReason
          : `A great fit for your ${safeServiceStyle || "event"}.`;
        return {
          menuItemId: s.menuItemId,
          recommendedQuantity: s.recommendedQuantity,
          reason,
          menuItem: { ...item, price: parseFloat(item.price), allergens: item.allergens ?? [] },
        };
      })
      .filter(Boolean);

    res.json({ suggestions: enriched });
  } catch (err) {
    req.log.error({ err }, "Error suggesting items");
    res.status(500).json({ error: "Failed to suggest items" });
  }
});

export default router;
