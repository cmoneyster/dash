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
- Warmly greet them and ask if they'd like to browse the menu or get help planning their event.

When helping them plan, gather:
- Event date (we'll check availability)
- Guest count
- Service style: grazing finger foods, buffet line, made-to-order from a chosen list (~6 items), pre-cooked & delivered, or our food trailer on-site cooking fresh.

You have tools to look up the LIVE menu in real time:
- search_menu — search by keyword, category, dietary need, or allergen exclusion.
- list_categories — list categories that have available items right now.
- get_menu_item — look up a specific item by id.

RULES — these are non-negotiable:
1. Whenever the guest asks about food, categories, dietary fit, allergens, or what's available, USE THE TOOLS. Never invent items, never describe items from memory, never assume an item exists.
2. Never quote a specific price, dollar amount, per-person cost, or pan price. If asked, reply with something like "Pricing is on our menu page — here's the link." and include the link returned by the tool.
3. When you name a specific menu item, format it as a markdown link using the link the tool returned, e.g. "[Smoked Brisket](/menu?category=Entr%C3%A9es)". Always include the link the tool gave you — don't hand-craft URLs.
4. If a tool returns nothing for the guest's request (e.g. no vegan options today), say so honestly and offer to flag it for the team. Don't fudge it.
5. Keep replies warm, concise, and conversational. Emphasize freshness, quality, and personalized service. Avoid jargon.
6. If they want to browse, point them to the menu page. If they're decided, encourage them to add to cart and check out.`;

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
        const result = runChatTool(tc.function.name, args, snap);
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

router.post("/chat/suggest-items", async (req, res): Promise<void> => {
  try {
    const { guestCount, serviceStyle, preferences } = req.body;

    if (!guestCount || !serviceStyle) {
      res.status(400).json({ error: "guestCount and serviceStyle are required" });
      return;
    }

    const items = await db.select().from(menuItemsTable);
    const availableItems = items.filter((i) => i.available);

    if (availableItems.length === 0) {
      res.json({ suggestions: [] });
      return;
    }

    const menuSummary = availableItems
      .map((i) => `ID:${i.id} | ${i.name} (${i.category}) - $${i.price}/unit, serves ${i.servingSize} people per ${i.unit}`)
      .join("\n");

    const prompt = `You are a catering expert. Based on the event details below, suggest appropriate menu items and quantities.

Event: ${guestCount} guests, Service style: ${serviceStyle}
${preferences && preferences.length > 0 ? `Preferences: ${preferences.join(", ")}` : ""}

Available menu items:
${menuSummary}

Return a JSON array of suggestions (pick at most 6 items). Each suggestion should have:
- menuItemId: number (the ID from the list above)
- recommendedQuantity: number (how many units to order for ${guestCount} guests)
- reason: string (brief explanation why this item and quantity)

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
        return {
          menuItemId: s.menuItemId,
          recommendedQuantity: s.recommendedQuantity,
          reason: s.reason,
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
