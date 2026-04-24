import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { menuItemsTable, eventOrdersTable, eventSettingsTable, eventSessionsTable, menuCategoriesTable } from "@workspace/db/schema";
import { eq, desc, and, or, sql, inArray } from "drizzle-orm";
import { sendOrderConfirmation, sendOrderReady } from "../lib/sms";
import {
  detectAndMarkLowStockCrossings,
  maybeResetLowStockFlag,
  fireLowStockAlertIfAny,
  DEFAULT_LOW_STOCK_THRESHOLD,
} from "../lib/lowStockAlerts";

const router: IRouter = Router();

async function getEventSettings() {
  const [settings] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
  return settings ?? null;
}

// Guest ordering password — stored as eventPassword in DB
async function resolveOrderPassword(): Promise<string | null> {
  const settings = await getEventSettings();
  if (settings?.eventPassword) return settings.eventPassword;
  return process.env.EVENT_PASSWORD ?? null;
}

// Kitchen display password — uses kitchenPassword if set, falls back to order password
async function resolveKitchenPassword(): Promise<string | null> {
  const settings = await getEventSettings();
  if (settings?.kitchenPassword) return settings.kitchenPassword;
  if (settings?.eventPassword) return settings.eventPassword;
  return process.env.EVENT_PASSWORD ?? null;
}

function makeAuthMiddleware(resolvePwd: () => Promise<string | null>) {
  return async function (req: Request, res: Response, next: NextFunction) {
    const password = await resolvePwd();
    if (!password) {
      res.status(503).json({ error: "Event ordering is not configured" });
      return;
    }
    const authHeader = req.headers["authorization"];
    const supplied = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!supplied || supplied !== password) {
      res.status(401).json({ error: "Invalid password" });
      return;
    }
    next();
  };
}

const verifyOrderPassword = makeAuthMiddleware(resolveOrderPassword);
const verifyKitchenPassword = makeAuthMiddleware(resolveKitchenPassword);

// Resolve the live-effective ordering state for one channel. If state is 'paused' but
// the pausedUntil deadline has passed, treat it as 'accepting' (the timer expired).
type ChannelState = "accepting" | "paused" | "closed";
function resolveChannelState(
  rawState: string | null | undefined,
  pausedUntil: Date | null | undefined,
  pausedMessage?: string | null,
): {
  state: ChannelState; pausedUntil: string | null; remainingSec: number | null; pausedMessage: string | null;
} {
  const raw = (rawState as ChannelState | null | undefined) ?? "accepting";
  const msg = pausedMessage?.trim() ? pausedMessage.trim() : null;
  if (raw === "paused" && pausedUntil) {
    const ms = pausedUntil.getTime() - Date.now();
    if (ms > 0) return { state: "paused", pausedUntil: pausedUntil.toISOString(), remainingSec: Math.ceil(ms / 1000), pausedMessage: msg };
    return { state: "accepting", pausedUntil: null, remainingSec: null, pausedMessage: null };
  }
  if (raw === "closed") return { state: "closed", pausedUntil: null, remainingSec: null, pausedMessage: null };
  return { state: "accepting", pausedUntil: null, remainingSec: null, pausedMessage: null };
}

// Read both channels in their resolved/effective form for client display + gating.
export async function getOrderingChannelStates() {
  const s = await getEventSettings();
  return {
    guest: resolveChannelState(s?.guestOrderingState, s?.guestOrderingPausedUntil ?? null, s?.guestOrderingPausedMessage ?? null),
    taker: resolveChannelState(s?.takerOrderingState, s?.takerOrderingPausedUntil ?? null, s?.takerOrderingPausedMessage ?? null),
  };
}

router.get("/event-ordering/settings", async (req, res) => {
  try {
    const settings = await getEventSettings();
    let activeSessionName: string | null = null;
    if (settings?.activeEventSessionId) {
      const [session] = await db
        .select({ name: eventSessionsTable.name })
        .from(eventSessionsTable)
        .where(eq(eventSessionsTable.id, settings.activeEventSessionId));
      activeSessionName = session?.name ?? null;
    }
    const guest = resolveChannelState(settings?.guestOrderingState, settings?.guestOrderingPausedUntil ?? null, settings?.guestOrderingPausedMessage ?? null);
    res.json({
      eventName: settings?.eventName ?? "",
      activeSessionId: settings?.activeEventSessionId ?? null,
      activeSessionName,
      orderingState: guest.state,
      orderingPausedUntil: guest.pausedUntil,
      orderingRemainingSec: guest.remainingSec,
      orderingPausedMessage: guest.pausedMessage,
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching event settings");
    res.status(500).json({ error: "Failed to fetch event settings" });
  }
});

// Kitchen can create a new session (uses kitchen password, not admin token)
router.post("/event-ordering/create-session", verifyKitchenPassword, async (req, res) => {
  try {
    const settings = await getEventSettings();
    const name = settings?.eventName?.trim() || "Unnamed Event";
    const today = new Date().toISOString().split("T")[0];

    const [session] = await db
      .insert(eventSessionsTable)
      .values({ name, date: today })
      .returning();

    if (settings) {
      await db
        .update(eventSettingsTable)
        .set({ activeEventSessionId: session.id, updatedAt: new Date() })
        .where(eq(eventSettingsTable.id, 1));
    } else {
      await db.insert(eventSettingsTable).values({ id: 1, eventName: name, activeEventSessionId: session.id });
    }

    res.status(201).json(session);
  } catch (err) {
    req.log.error({ err }, "Error creating session from kitchen");
    res.status(500).json({ error: "Failed to create session" });
  }
});

router.post("/event-ordering/verify", async (req, res) => {
  const { password, role } = req.body as { password?: string; role?: string };
  const resolve = role === "kitchen" ? resolveKitchenPassword : resolveOrderPassword;
  const expected = await resolve();
  if (!expected) {
    res.status(503).json({ error: "Event ordering is not configured" });
    return;
  }
  if (!password || password !== expected) {
    res.status(401).json({ error: "Invalid password" });
    return;
  }
  res.json({ ok: true });
});

// Public read of both channel states for polling on the kitchen + ordering pages.
router.get("/event-ordering/ordering-state", async (_req, res) => {
  try {
    const channels = await getOrderingChannelStates();
    res.json({ guest: channels.guest, taker: channels.taker });
  } catch {
    res.status(500).json({ error: "Failed to load ordering state" });
  }
});

// Kitchen-controlled toggle for the two ordering channels (guest + staff taker).
// Body: { channel: 'guest'|'taker', state: 'accepting'|'paused'|'closed', pauseMinutes?: number }
router.put("/event-ordering/ordering-state", verifyKitchenPassword, async (req, res) => {
  try {
    const { channel, state, pauseMinutes, pausedMessage } = req.body as {
      channel?: "guest" | "taker"; state?: ChannelState; pauseMinutes?: number; pausedMessage?: string | null;
    };
    if (channel !== "guest" && channel !== "taker") {
      res.status(400).json({ error: "channel must be 'guest' or 'taker'" });
      return;
    }
    if (state !== "accepting" && state !== "paused" && state !== "closed") {
      res.status(400).json({ error: "state must be 'accepting', 'paused', or 'closed'" });
      return;
    }
    let pausedUntil: Date | null = null;
    if (state === "paused") {
      const mins = Number(pauseMinutes);
      if (!Number.isFinite(mins) || mins <= 0 || mins > 24 * 60) {
        res.status(400).json({ error: "pauseMinutes must be a positive number (max 1440)" });
        return;
      }
      pausedUntil = new Date(Date.now() + mins * 60_000);
    }
    // Custom note shown to guests/staff. Only persisted when pausing; cleared
    // otherwise so old notes don't leak into a future pause. Cap length so a
    // typo'd paste can't blow up the banner layout.
    let pausedMessageNormalized: string | null = null;
    if (state === "paused" && typeof pausedMessage === "string") {
      const trimmed = pausedMessage.trim();
      if (trimmed.length > 200) {
        res.status(400).json({ error: "pausedMessage must be 200 characters or fewer" });
        return;
      }
      pausedMessageNormalized = trimmed.length > 0 ? trimmed : null;
    }

    const [existing] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
    if (existing) {
      const updatedAt = new Date();
      if (channel === "guest") {
        await db.update(eventSettingsTable)
          .set({ guestOrderingState: state, guestOrderingPausedUntil: pausedUntil, guestOrderingPausedMessage: pausedMessageNormalized, updatedAt })
          .where(eq(eventSettingsTable.id, 1));
      } else {
        await db.update(eventSettingsTable)
          .set({ takerOrderingState: state, takerOrderingPausedUntil: pausedUntil, takerOrderingPausedMessage: pausedMessageNormalized, updatedAt })
          .where(eq(eventSettingsTable.id, 1));
      }
    } else {
      if (channel === "guest") {
        await db.insert(eventSettingsTable).values({
          id: 1, eventName: "",
          guestOrderingState: state, guestOrderingPausedUntil: pausedUntil, guestOrderingPausedMessage: pausedMessageNormalized,
        });
      } else {
        await db.insert(eventSettingsTable).values({
          id: 1, eventName: "",
          takerOrderingState: state, takerOrderingPausedUntil: pausedUntil, takerOrderingPausedMessage: pausedMessageNormalized,
        });
      }
    }

    const channels = await getOrderingChannelStates();
    res.json({ guest: channels.guest, taker: channels.taker });
  } catch (err) {
    req.log.error({ err }, "Error updating ordering state");
    res.status(500).json({ error: "Failed to update ordering state" });
  }
});

router.get("/event-ordering/menu", async (req, res) => {
  try {
    const items = await db
      .select()
      .from(menuItemsTable)
      .where(eq(menuItemsTable.eventActive, true));
    const cats = await db.select().from(menuCategoriesTable);
    const hidden = new Set(cats.filter((c) => !c.visible).map((c) => c.name));
    const visibleItems = hidden.size > 0 ? items.filter((i) => !hidden.has(i.category)) : items;
    // Strip staff-only fields before sending to guests
    const safe = visibleItems.map(({ internalNotes: _notes, ...item }) => item);
    res.json(safe);
  } catch (err) {
    req.log.error({ err }, "Error fetching event menu");
    res.status(500).json({ error: "Failed to fetch event menu" });
  }
});

router.post("/event-ordering/orders", verifyOrderPassword, async (req, res) => {
  try {
    const { guestName, phoneNumber, items, statusUrlBase } = req.body;
    if (!guestName || !items?.length) {
      res.status(400).json({ error: "guestName and items are required" });
      return;
    }

    // Gate: kitchen may have paused or stopped guest ordering.
    const channels = await getOrderingChannelStates();
    if (channels.guest.state !== "accepting") {
      res.status(423).json({
        error: channels.guest.state === "paused"
          ? (channels.guest.pausedMessage ?? "Ordering is paused — please try again shortly.")
          : "We're not accepting orders right now.",
        state: channels.guest.state,
        pausedUntil: channels.guest.pausedUntil,
        remainingSec: channels.guest.remainingSec,
        pausedMessage: channels.guest.pausedMessage,
      });
      return;
    }

    type OrderItem = { itemId: number; name: string; quantity: number; price: number };

    const { order, lowStockCrossings, lowStockSettings } = await db.transaction(async (tx) => {
      // Re-check the kitchen toggle inside the transaction to close the small
      // window between the gate above and committing the row.
      const [s] = await tx.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1)).for("update");
      const live = resolveChannelState(s?.guestOrderingState, s?.guestOrderingPausedUntil ?? null, s?.guestOrderingPausedMessage ?? null);
      if (live.state !== "accepting") {
        throw Object.assign(new Error(live.state === "paused"
          ? (live.pausedMessage ?? "Ordering is paused — please try again shortly.")
          : "We're not accepting orders right now."),
          { status: 423, channelState: live });
      }
      // Track newly-decremented stock per item so we can run one batched
      // low-stock crossing check after all updates land.
      const stockChanges: Array<{ itemId: number; name: string; newStock: number }> = [];
      for (const item of items as OrderItem[]) {
        const [row] = await tx
          .select({ id: menuItemsTable.id, name: menuItemsTable.name, eventStock: menuItemsTable.eventStock })
          .from(menuItemsTable)
          .where(eq(menuItemsTable.id, item.itemId))
          .for("update");
        if (!row) throw Object.assign(new Error(`Item ${item.itemId} not found`), { status: 404 });
        if (row.eventStock !== null) {
          if (row.eventStock < item.quantity) {
            throw Object.assign(
              new Error(`Only ${row.eventStock} of "${row.name}" remaining`),
              { status: 409, remaining: row.eventStock, itemId: item.itemId }
            );
          }
          await tx
            .update(menuItemsTable)
            .set({ eventStock: sql`event_stock - ${item.quantity}` })
            .where(eq(menuItemsTable.id, item.itemId));
          stockChanges.push({ itemId: row.id, name: row.name, newStock: row.eventStock - item.quantity });
        }
      }

      const activeSettings = await tx.select({ activeEventSessionId: eventSettingsTable.activeEventSessionId }).from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
      const activeEventSessionId = activeSettings[0]?.activeEventSessionId ?? null;

      const [created] = await tx
        .insert(eventOrdersTable)
        .values({
          guestName,
          phoneNumber: phoneNumber?.trim() || null,
          items,
          status: "pending",
          eventSessionId: activeEventSessionId,
        })
        .returning();

      // Atomically flag any items that just crossed the low-stock threshold
      // so concurrent orders don't double-fire the SMS. The actual SMS is
      // sent after commit (rollback ⇒ no phantom alert).
      const threshold = s?.lowStockAlertThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
      const crossings = await detectAndMarkLowStockCrossings(tx, stockChanges, threshold);

      return {
        order: created,
        lowStockCrossings: crossings,
        lowStockSettings: { phone: s?.lowStockAlertPhone ?? null, eventName: s?.eventName ?? "", threshold },
      };
    });

    if (order.phoneNumber) {
      const settings = await getEventSettings();
      const eventName = settings?.eventName ?? "";
      const orderStatusUrl = statusUrlBase
        ? `${statusUrlBase}/event/order/${order.id}`
        : `${req.protocol}://${req.get("host")}/event/order/${order.id}`;
      sendOrderConfirmation({
        guestName: order.guestName,
        orderId: order.id,
        phoneNumber: order.phoneNumber,
        eventName,
        orderStatusUrl,
      }).catch(() => {});
    }

    fireLowStockAlertIfAny(req, lowStockCrossings, lowStockSettings);

    res.status(201).json(order);
  } catch (err: any) {
    if (err?.status === 409) {
      res.status(409).json({ error: err.message, remaining: err.remaining, itemId: err.itemId });
      return;
    }
    if (err?.status === 423 && err?.channelState) {
      res.status(423).json({
        error: err.message,
        state: err.channelState.state,
        pausedUntil: err.channelState.pausedUntil,
        remainingSec: err.channelState.remainingSec,
        pausedMessage: err.channelState.pausedMessage,
      });
      return;
    }
    req.log.error({ err }, "Error creating event order");
    res.status(500).json({ error: "Failed to create event order" });
  }
});

router.get("/event-ordering/orders", verifyKitchenPassword, async (req, res) => {
  try {
    // Hide staff (POS) orders that are still awaiting payment.
    // Guests are 'paid' by default, and staff orders flip from 'unpaid' →
    // 'paid' / 'override' once the cashier confirms or overrides at the POS.
    const orders = await db
      .select()
      .from(eventOrdersTable)
      .where(sql`NOT (${eventOrdersTable.orderSource} = 'staff' AND ${eventOrdersTable.paymentStatus} = 'unpaid')`)
      .orderBy(desc(eventOrdersTable.createdAt));

    // Collect all unique itemIds across all orders
    const itemIds = [...new Set(orders.flatMap(o => (o.items as { itemId: number }[]).map(i => i.itemId)))];

    // Fetch internalNotes for those menu items (if any)
    const notesMap: Record<number, string | null> = {};
    if (itemIds.length > 0) {
      const menuItems = await db
        .select({ id: menuItemsTable.id, internalNotes: menuItemsTable.internalNotes })
        .from(menuItemsTable)
        .where(inArray(menuItemsTable.id, itemIds));
      for (const m of menuItems) notesMap[m.id] = m.internalNotes ?? null;
    }

    // Augment order items with internalNotes; coerce numeric fields
    const enriched = orders.map(order => ({
      ...order,
      subtotal: order.subtotal != null ? parseFloat(order.subtotal) : null,
      taxRate: order.taxRate != null ? parseFloat(order.taxRate) : null,
      taxAmount: order.taxAmount != null ? parseFloat(order.taxAmount) : null,
      total: order.total != null ? parseFloat(order.total) : null,
      items: (order.items as { itemId: number }[]).map(item => ({
        ...item,
        internalNotes: notesMap[item.itemId] ?? null,
      })),
    }));

    res.json(enriched);
  } catch (err) {
    req.log.error({ err }, "Error fetching event orders");
    res.status(500).json({ error: "Failed to fetch event orders" });
  }
});

// Public endpoint — no auth required — to check a single order's status
router.get("/event-ordering/orders/:id/public", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    const [order] = await db
      .select({
        id: eventOrdersTable.id,
        guestName: eventOrdersTable.guestName,
        status: eventOrdersTable.status,
        items: eventOrdersTable.items,
        createdAt: eventOrdersTable.createdAt,
      })
      .from(eventOrdersTable)
      .where(eq(eventOrdersTable.id, id));
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    const settings = await getEventSettings();
    res.json({ ...order, eventName: settings?.eventName ?? "" });
  } catch (err) {
    req.log.error({ err }, "Error fetching public order");
    res.status(500).json({ error: "Failed to fetch order" });
  }
});

router.patch("/event-ordering/orders/:id/status", verifyKitchenPassword, async (req, res): Promise<void> => {
  try {
    const id = parseInt(String(req.params.id));
    const { status } = req.body as { status: string };
    const valid = ["pending", "preparing", "ready", "done", "picked_up"];
    if (!valid.includes(status)) {
      res.status(400).json({ error: "Invalid status" });
      return;
    }
    // Stamp service-time milestones the first time we reach each step so
    // re-flipping status (e.g. ready → preparing → ready) doesn't reset the
    // original timestamps the Sales Report depends on.
    const [existing] = await db
      .select({ readyAt: eventOrdersTable.readyAt, pickedUpAt: eventOrdersTable.pickedUpAt })
      .from(eventOrdersTable)
      .where(eq(eventOrdersTable.id, id));
    const updates: Record<string, unknown> = { status };
    const now = new Date();
    if (status === "ready" && existing && !existing.readyAt) updates.readyAt = now;
    if (status === "picked_up" && existing && !existing.pickedUpAt) updates.pickedUpAt = now;
    const [updated] = await db
      .update(eventOrdersTable)
      .set(updates)
      .where(eq(eventOrdersTable.id, id))
      .returning();

    if (status === "ready" && updated.phoneNumber) {
      const settings = await getEventSettings();
      sendOrderReady({
        guestName: updated.guestName,
        orderId: updated.id,
        phoneNumber: updated.phoneNumber,
        eventName: settings?.eventName ?? "",
      }).catch(() => {});
    }

    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Error updating event order status");
    res.status(500).json({ error: "Failed to update order status" });
  }
});

// Stock management — kitchen password required.
// Lists items visible on EITHER event channel (Guest Event page or Staff
// Order Taker), since both decrement the same shared event_stock counter.
router.get("/event-ordering/stock", verifyKitchenPassword, async (req, res) => {
  try {
    const items = await db
      .select({
        id: menuItemsTable.id,
        name: menuItemsTable.name,
        category: menuItemsTable.category,
        eventStock: menuItemsTable.eventStock,
        imageUrl: menuItemsTable.imageUrl,
        eventActive: menuItemsTable.eventActive,
        eventTakerVisible: menuItemsTable.eventTakerVisible,
      })
      .from(menuItemsTable)
      .where(or(eq(menuItemsTable.eventActive, true), eq(menuItemsTable.eventTakerVisible, true)))
      .orderBy(menuItemsTable.category, menuItemsTable.name);
    res.json(items);
  } catch (err) {
    req.log.error({ err }, "Error fetching event stock");
    res.status(500).json({ error: "Failed to fetch stock" });
  }
});

// ── Low-stock alert threshold ───────────────────────────────────────────────
// Kitchen-controlled threshold for the "Low" stock badge + toast on the
// Kitchen Display, and for the server-side SMS alert. Persisted on
// event_settings.low_stock_alert_threshold (shared with the admin Event
// Settings UI, which can set a wider 1–1000 range). The Kitchen Display
// itself is intentionally constrained to a sensible 1–20 range so a
// fat-finger tap can't push it to nonsense.
router.get("/event-ordering/low-stock-threshold", verifyKitchenPassword, async (req, res) => {
  try {
    const settings = await getEventSettings();
    const threshold = settings?.lowStockAlertThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
    res.json({ threshold, defaultThreshold: DEFAULT_LOW_STOCK_THRESHOLD });
  } catch (err) {
    req.log.error({ err }, "Error fetching low-stock threshold");
    res.status(500).json({ error: "Failed to fetch low-stock threshold" });
  }
});

router.put("/event-ordering/low-stock-threshold", verifyKitchenPassword, async (req, res) => {
  try {
    const { threshold } = req.body as { threshold?: number | string };
    const n = Number(threshold);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 20) {
      res.status(400).json({ error: "threshold must be an integer between 1 and 20" });
      return;
    }
    const [existing] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
    if (existing) {
      await db.update(eventSettingsTable)
        .set({ lowStockAlertThreshold: n, updatedAt: new Date() })
        .where(eq(eventSettingsTable.id, 1));
    } else {
      await db.insert(eventSettingsTable).values({ id: 1, eventName: "", lowStockAlertThreshold: n });
    }
    res.json({ threshold: n, defaultThreshold: DEFAULT_LOW_STOCK_THRESHOLD });
  } catch (err) {
    req.log.error({ err }, "Error updating low-stock threshold");
    res.status(500).json({ error: "Failed to update low-stock threshold" });
  }
});

router.patch("/event-ordering/stock/:itemId", verifyKitchenPassword, async (req, res): Promise<void> => {
  try {
    const itemId = parseInt(String(req.params.itemId));
    const { eventStock } = req.body as { eventStock: number | null };
    const stock = eventStock === null ? null : Math.max(0, parseInt(String(eventStock)));
    // Mirror the GET filter: allow stock edits for items visible on either channel.
    const [item] = await db
      .update(menuItemsTable)
      .set({ eventStock: stock })
      .where(and(
        eq(menuItemsTable.id, itemId),
        or(eq(menuItemsTable.eventActive, true), eq(menuItemsTable.eventTakerVisible, true)),
      ))
      .returning({
        id: menuItemsTable.id,
        name: menuItemsTable.name,
        eventStock: menuItemsTable.eventStock,
        eventActive: menuItemsTable.eventActive,
        eventTakerVisible: menuItemsTable.eventTakerVisible,
      });
    if (!item) {
      res.status(404).json({ error: "Item not found or not enabled for event ordering" });
      return;
    }

    // Re-arm the low-stock SMS for this item if the new stock no longer
    // qualifies as "low" (set to unlimited, fully sold out, or restocked
    // above the threshold). Without this, a future dip below threshold would
    // be silent because lowStockAlertSent would still be true.
    const settings = await getEventSettings();
    const threshold = settings?.lowStockAlertThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
    await maybeResetLowStockFlag(db, item.id, item.eventStock, threshold);

    res.json(item);
  } catch (err) {
    req.log.error({ err }, "Error updating event stock");
    res.status(500).json({ error: "Failed to update stock" });
  }
});

export default router;
