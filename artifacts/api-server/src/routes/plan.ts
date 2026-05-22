import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { planItemsTable, menuItemsTable, sharedPlansTable, cateringInquiriesTable, menuCategoriesTable, type QuoteLineItem } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { sendNewInquiryAlert } from "../lib/sms";
const router: IRouter = Router();

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

function expiresAt60Days() {
  return new Date(Date.now() + SIXTY_DAYS_MS);
}

async function getPlanData(sessionId: string) {
  const items = await db
    .select()
    .from(planItemsTable)
    .innerJoin(menuItemsTable, eq(planItemsTable.menuItemId, menuItemsTable.id))
    .where(eq(planItemsTable.sessionId, sessionId));

  return {
    sessionId,
    items: items.map((row) => ({
      id: row.plan_items.id,
      menuItemId: row.plan_items.menuItemId,
      menuItem: {
        ...row.menu_items,
        price: parseFloat(row.menu_items.price),
        allergens: row.menu_items.allergens ?? [],
      },
    })),
  };
}

async function resolveSharedPlan(token: string) {
  const [record] = await db
    .select()
    .from(sharedPlansTable)
    .where(eq(sharedPlansTable.shareToken, token));
  return record ?? null;
}

async function touchSharedPlan(token: string) {
  const now = new Date();
  const expires = expiresAt60Days();
  await db
    .update(sharedPlansTable)
    .set({ lastModifiedAt: now, expiresAt: expires })
    .where(eq(sharedPlansTable.shareToken, token));
}

// ── Regular plan CRUD ──────────────────────────────────────────────────────

router.get("/plan", async (req, res): Promise<void> => {
  try {
    const { sessionId } = req.query as { sessionId: string };
    if (!sessionId) {
      res.status(400).json({ error: "sessionId required" });
      return;
    }
    res.json(await getPlanData(sessionId));
  } catch (err) {
    req.log.error({ err }, "Error getting plan");
    res.status(500).json({ error: "Failed to get plan" });
  }
});

router.post("/plan", async (req, res): Promise<void> => {
  try {
    const { sessionId, menuItemId } = req.body;
    if (!sessionId || !menuItemId) {
      res.status(400).json({ error: "sessionId and menuItemId required" });
      return;
    }

    const [existing] = await db
      .select()
      .from(planItemsTable)
      .where(and(eq(planItemsTable.sessionId, sessionId), eq(planItemsTable.menuItemId, menuItemId)));

    if (!existing) {
      await db.insert(planItemsTable).values({ sessionId, menuItemId });
    }

    res.json(await getPlanData(sessionId));
  } catch (err) {
    req.log.error({ err }, "Error adding to plan");
    res.status(500).json({ error: "Failed to add to plan" });
  }
});

router.delete("/plan", async (req, res): Promise<void> => {
  try {
    const sessionId = req.body?.sessionId || req.query.sessionId;
    if (!sessionId) {
      res.status(400).json({ error: "sessionId required" });
      return;
    }
    await db.delete(planItemsTable).where(eq(planItemsTable.sessionId, sessionId as string));
    res.json({ sessionId, items: [] });
  } catch (err) {
    req.log.error({ err }, "Error clearing plan");
    res.status(500).json({ error: "Failed to clear plan" });
  }
});

router.delete("/plan/:itemId", async (req, res): Promise<void> => {
  try {
    const itemId = parseInt(req.params.itemId);
    const sessionId = req.body?.sessionId || req.query.sessionId;
    if (!sessionId) {
      res.status(400).json({ error: "sessionId required" });
      return;
    }

    await db.delete(planItemsTable).where(and(eq(planItemsTable.id, itemId), eq(planItemsTable.sessionId, sessionId as string)));

    res.json(await getPlanData(sessionId as string));
  } catch (err) {
    req.log.error({ err }, "Error removing from plan");
    res.status(500).json({ error: "Failed to remove from plan" });
  }
});

// ── Shared plan ────────────────────────────────────────────────────────────

// Create or update a share token for a session
router.post("/plan/share", async (req, res): Promise<void> => {
  try {
    const { sessionId, planName, plannerState } = req.body as {
      sessionId: string; planName?: string; plannerState?: unknown;
    };
    if (!sessionId) {
      res.status(400).json({ error: "sessionId required" });
      return;
    }

    // Re-use an existing token for this session if one exists
    const [existing] = await db
      .select()
      .from(sharedPlansTable)
      .where(eq(sharedPlansTable.sessionId, sessionId));

    if (existing) {
      const expires = expiresAt60Days();
      await db
        .update(sharedPlansTable)
        .set({
          planName: planName ?? existing.planName,
          plannerState: plannerState !== undefined ? plannerState : existing.plannerState,
          lastModifiedAt: new Date(),
          expiresAt: expires,
        })
        .where(eq(sharedPlansTable.shareToken, existing.shareToken));

      res.json({ shareToken: existing.shareToken, expiresAt: expires });
      return;
    }

    const expires = expiresAt60Days();
    const [created] = await db
      .insert(sharedPlansTable)
      .values({ sessionId, planName: planName ?? null, plannerState: plannerState ?? null, expiresAt: expires })
      .returning();

    res.json({ shareToken: created.shareToken, expiresAt: created.expiresAt });
  } catch (err) {
    req.log.error({ err }, "Error creating shared plan");
    res.status(500).json({ error: "Failed to create shared plan" });
  }
});

// Look up existing share record by sessionId (no auth — customer's own session)
router.get("/plan/share/by-session", async (req, res): Promise<void> => {
  try {
    const { sessionId } = req.query as { sessionId?: string };
    if (!sessionId) {
      res.status(400).json({ error: "sessionId required" });
      return;
    }

    const [existing] = await db
      .select()
      .from(sharedPlansTable)
      .where(eq(sharedPlansTable.sessionId, sessionId));

    if (!existing || new Date() > existing.expiresAt) {
      res.json({ found: false });
      return;
    }

    res.json({
      found: true,
      shareToken: existing.shareToken,
      planName: existing.planName ?? null,
      plannerState: existing.plannerState ?? null,
      expiresAt: existing.expiresAt,
    });
  } catch (err) {
    req.log.error({ err }, "Error looking up plan by session");
    res.status(500).json({ error: "Failed to look up plan" });
  }
});

// Get shared plan
router.get("/plan/share/:token", async (req, res): Promise<void> => {
  try {
    const record = await resolveSharedPlan(req.params.token);
    if (!record) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    if (new Date() > record.expiresAt) {
      res.status(410).json({ error: "This plan link has expired" });
      return;
    }

    await touchSharedPlan(req.params.token);
    const plan = await getPlanData(record.sessionId);
    res.json({
      ...plan,
      shareToken: record.shareToken,
      planName: record.planName,
      plannerState: record.plannerState ?? null,
      expiresAt: record.expiresAt,
    });
  } catch (err) {
    req.log.error({ err }, "Error getting shared plan");
    res.status(500).json({ error: "Failed to get shared plan" });
  }
});

// Update planner state on a shared plan
router.patch("/plan/share/:token/planner", async (req, res): Promise<void> => {
  try {
    const record = await resolveSharedPlan(req.params.token);
    if (!record) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    if (new Date() > record.expiresAt) {
      res.status(410).json({ error: "This plan link has expired" });
      return;
    }

    const { plannerState } = req.body as { plannerState: unknown };
    if (plannerState === undefined) {
      res.status(400).json({ error: "plannerState required" });
      return;
    }

    await db
      .update(sharedPlansTable)
      .set({ plannerState, lastModifiedAt: new Date(), expiresAt: expiresAt60Days() })
      .where(eq(sharedPlansTable.shareToken, req.params.token));

    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Error updating planner state");
    res.status(500).json({ error: "Failed to update planner state" });
  }
});

// Add item to shared plan
router.post("/plan/share/:token/items", async (req, res): Promise<void> => {
  try {
    const record = await resolveSharedPlan(req.params.token);
    if (!record) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    if (new Date() > record.expiresAt) {
      res.status(410).json({ error: "This plan link has expired" });
      return;
    }

    const { menuItemId } = req.body as { menuItemId: number };
    if (!menuItemId) {
      res.status(400).json({ error: "menuItemId required" });
      return;
    }

    const [existing] = await db
      .select()
      .from(planItemsTable)
      .where(and(eq(planItemsTable.sessionId, record.sessionId), eq(planItemsTable.menuItemId, menuItemId)));

    if (!existing) {
      await db.insert(planItemsTable).values({ sessionId: record.sessionId, menuItemId });
    }

    await touchSharedPlan(req.params.token);
    const plan = await getPlanData(record.sessionId);
    res.json({ ...plan, shareToken: record.shareToken, planName: record.planName, expiresAt: record.expiresAt });
  } catch (err) {
    req.log.error({ err }, "Error adding item to shared plan");
    res.status(500).json({ error: "Failed to add item" });
  }
});

// Remove item from shared plan
router.delete("/plan/share/:token/items/:itemId", async (req, res): Promise<void> => {
  try {
    const record = await resolveSharedPlan(req.params.token);
    if (!record) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    if (new Date() > record.expiresAt) {
      res.status(410).json({ error: "This plan link has expired" });
      return;
    }

    const itemId = parseInt(req.params.itemId);
    await db
      .delete(planItemsTable)
      .where(and(eq(planItemsTable.id, itemId), eq(planItemsTable.sessionId, record.sessionId)));

    await touchSharedPlan(req.params.token);
    const plan = await getPlanData(record.sessionId);
    res.json({ ...plan, shareToken: record.shareToken, planName: record.planName, expiresAt: record.expiresAt });
  } catch (err) {
    req.log.error({ err }, "Error removing item from shared plan");
    res.status(500).json({ error: "Failed to remove item" });
  }
});

// Submit a catering inquiry from the customer's event plan
router.post("/plan/submit-inquiry", async (req, res): Promise<void> => {
  try {
    const {
      sessionId,
      customerName,
      customerEmail,
      customerPhone,
      eventDate,
      guestCount,
      serviceMode: rawServiceMode,
      venueAddress,
      deliveryNotes,
      plannerState,
    } = req.body as {
      sessionId?: string;
      customerName?: string;
      customerEmail?: string;
      customerPhone?: string;
      eventDate?: string;
      guestCount?: number;
      serviceMode?: string;
      venueAddress?: string;
      deliveryNotes?: string;
      plannerState?: {
        piecesMap?: Record<string, number>;
        servingsMap?: Record<string, number>;
        panQtys?: Record<string, Record<string, number>>;
        guests?: number;
      };
    };

    if (!sessionId || typeof sessionId !== "string") {
      res.status(400).json({ error: "sessionId is required" });
      return;
    }
    if (!customerName?.trim() || !customerEmail?.trim()) {
      res.status(400).json({ error: "customerName and customerEmail are required" });
      return;
    }

    const planRows = await db
      .select()
      .from(planItemsTable)
      .innerJoin(menuItemsTable, eq(planItemsTable.menuItemId, menuItemsTable.id))
      .where(eq(planItemsTable.sessionId, sessionId));

    if (planRows.length === 0) {
      res.status(400).json({ error: "Plan is empty" });
      return;
    }

    const categories = await db.select().from(menuCategoriesTable);
    const catGroupMap = new Map<string, string>(
      categories.map((c) => [c.name, c.plannerGroup ?? "other"])
    );

    const pm = plannerState?.piecesMap ?? {};
    const sm = plannerState?.servingsMap ?? {};
    const pq = plannerState?.panQtys ?? {};

    const lineItems: QuoteLineItem[] = [];
    let subtotal = 0;

    for (const row of planRows) {
      const item = row.menu_items;
      const planItemId = String(row.plan_items.id);
      const isPanSizes = item.pricingTemplate === "pan_sizes";
      const plannerGroup = catGroupMap.get(item.category) ?? "other";
      const minQty = item.minimumOrderQty ?? 1;

      if (isPanSizes) {
        const slots = pq[planItemId] ?? {};
        const slotEntries = Object.entries(slots).filter(([, q]) => Number(q) > 0);
        if (slotEntries.length > 0) {
          for (const [idxStr, qty] of slotEntries) {
            const idx = Number(idxStr);
            const sizeLabel = (item as Record<string, unknown>)[`size${idx}Label`] as string | null;
            const sizePrice = (item as Record<string, unknown>)[`size${idx}Price`];
            if (sizeLabel == null || sizePrice == null) continue;
            const unitPrice = parseFloat(String(sizePrice));
            const q = Number(qty);
            subtotal += unitPrice * q;
            lineItems.push({ id: randomUUID(), menuItemId: item.id, name: item.name, quantity: q, unitPrice, pricingTemplate: "pan_sizes", sizeSlot: idx, sizeLabel });
          }
        } else {
          const sizeLabel = (item as Record<string, unknown>)[`size1Label`] as string | null;
          const sizePrice = (item as Record<string, unknown>)[`size1Price`];
          if (sizeLabel != null && sizePrice != null) {
            const unitPrice = parseFloat(String(sizePrice));
            subtotal += unitPrice;
            lineItems.push({ id: randomUUID(), menuItemId: item.id, name: item.name, quantity: 1, unitPrice, pricingTemplate: "pan_sizes", sizeSlot: 1, sizeLabel });
          }
        }
      } else {
        const isSmallBite = plannerGroup === "savory" || plannerGroup === "sweet";
        const isEntreeGroup = plannerGroup === "entree";
        const qtyFromMap = isSmallBite
          ? (pm[planItemId] ?? undefined)
          : isEntreeGroup
            ? (sm[planItemId] ?? undefined)
            : undefined;
        const qty = Math.max(minQty, Number(qtyFromMap ?? 0) || minQty);
        const unitPrice = parseFloat(item.price);
        subtotal += unitPrice * qty;
        const pt = item.pricingTemplate;
        lineItems.push({ id: randomUUID(), menuItemId: item.id, name: item.name, quantity: qty, unitPrice, pricingTemplate: (pt === "pan_sizes" || pt === "per_unit") ? pt : null });
      }
    }

    const serviceMode = (rawServiceMode === "on_the_dash" ? "on_the_dash" : "drop_off") as "drop_off" | "on_the_dash";
    const resolvedGuestCount = typeof guestCount === "number" ? guestCount : (plannerState?.guests ?? null);

    const [inquiryRow] = await db.insert(cateringInquiriesTable).values({
      clientName: customerName.trim(),
      clientEmail: customerEmail.trim(),
      clientPhone: customerPhone?.trim() || null,
      eventDate: eventDate?.trim() || null,
      guestCount: resolvedGuestCount,
      venueAddress: venueAddress?.trim() || null,
      menuNotes: deliveryNotes?.trim() || null,
      source: "plan",
      lineItems,
      fees: [],
      discounts: [],
      subtotal: subtotal.toFixed(2),
      feesTotal: "0.00",
      discountsTotal: "0.00",
      total: subtotal.toFixed(2),
      status: "inquiry",
      serviceMode,
    }).returning();

    sendNewInquiryAlert({
      clientName: customerName.trim(),
      source: "plan",
      eventDate: eventDate?.trim() || null,
      guestCount: resolvedGuestCount,
      total: `$${subtotal.toFixed(2)}`,
      clientPhone: customerPhone?.trim() || null,
      venueAddress: venueAddress?.trim() || null,
    }).catch(() => {});

    res.status(201).json({
      inquiryId: inquiryRow.id,
      quoteToken: inquiryRow.quoteToken,
    });
  } catch (err) {
    req.log.error({ err }, "Error submitting plan inquiry");
    res.status(500).json({ error: "Failed to submit inquiry" });
  }
});

export default router;
