import { Router, type IRouter } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";
import { db } from "@workspace/db";
import { menuItemsTable } from "@workspace/db/schema";

const router: IRouter = Router();

const SYSTEM_PROMPT = `You are a friendly and helpful AI assistant for a catering business. Your job is to help prospective event hosts plan their catering.

When a user first reaches out:
1. Warmly greet them and ask if they'd like to browse the menu or get help planning their specific event.

When helping them plan:
- Ask for their event date (we'll check availability)
- Ask how many guests they're expecting
- Ask what type of service they'd prefer:
  * Finger foods / appetizers (grazing style)
  * Buffet line (sit-down with buffet)
  * Made-to-order (guests order from the menu, up to ~6 items chosen by host)
  * Pre-cooked and delivered (we cook ahead and deliver everything)
  * Food trailer on-site (we bring our trailer and cook fresh for guests)
- Based on their answers, suggest appropriate menu items with quantities
- If a date is unavailable, be empathetic and suggest alternative dates

Keep responses warm, conversational, and concise. Use casual but professional language.
If they want to browse the menu, encourage them to visit the Menu page.
If they've decided on items, encourage them to add to cart and check out.

IMPORTANT: You represent an authentic, passionate local catering business. Emphasize freshness, quality, and personalized service.`;

router.post("/chat/message", async (req, res): Promise<void> => {
  const { sessionId, message, history } = req.body;

  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const chatHistory = (history ?? []).map((h: { role: string; content: string }) => ({
      role: h.role as "user" | "assistant",
      content: h.content,
    }));

    const stream = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 8192,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...chatHistory,
        { role: "user", content: message },
      ],
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

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

    // Get all available menu items
    const items = await db
      .select()
      .from(menuItemsTable)
      .where(menuItemsTable.available ? undefined : undefined); // get all available

    const availableItems = items.filter((i) => i.available);

    if (availableItems.length === 0) {
      res.json({ suggestions: [] });
      return;
    }

    // Use AI to suggest items and quantities
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

    // Enrich with full menu item data
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
