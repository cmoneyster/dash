import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { menuItemsTable, eventOrdersTable, eventSettingsTable, eventSessionsTable, menuCategoriesTable } from "@workspace/db/schema";
import type { EventOrderItem, EventOrderPlate, EventOrderKitchenProgress, EventOrderKitchenProgressLine } from "@workspace/db/schema";
import { eq, desc, and, or, sql, inArray } from "drizzle-orm";
import { sendOrderConfirmation, sendOrderReady } from "../lib/sms";
import {
  detectAndMarkLowStockCrossings,
  maybeResetLowStockFlag,
  fireLowStockAlertIfAny,
  DEFAULT_LOW_STOCK_THRESHOLD,
} from "../lib/lowStockAlerts";
import { fanoutPrintForEventOrder } from "../lib/printFanout";

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
        lowStockSettings: { phones: s?.lowStockAlertPhones ?? [], eventName: s?.eventName ?? "", threshold },
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

    // Fire-and-forget fan-out to network printers. Demo orders use a
    // separate route and never reach this path.
    fanoutPrintForEventOrder({ order, source: "event_order" }).catch((err) => {
      req.log.error({ err, orderId: order.id }, "print fan-out failed");
    });

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
      .where(sql`NOT (${eventOrdersTable.orderSource} = 'staff' AND ${eventOrdersTable.paymentStatus} = 'unpaid')
                 AND ${eventOrdersTable.voidedAt} IS NULL`)
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
      plateGroups: order.plateGroups ?? null,
      kitchenProgress: order.kitchenProgress ?? null,
      firedItemIds: order.firedItemIds ?? [],
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

// Recently voided orders surfaced to every kitchen device so the cooks
// notice when a sent ticket is pulled back. Scoped to the active event
// session and the last 30 minutes (capped at 50 rows) so a long-running
// kitchen tab doesn't accumulate unbounded history. Each row carries the
// full items snapshot, the cook's "fired" check-off state at void time,
// and (for plated orders) the per-plate packing progress so the kitchen
// can react precisely — pulling the right items off the heat and
// removing the right assembled plates from the line.
router.get("/event-ordering/recent-voids", verifyKitchenPassword, async (req, res) => {
  try {
    const settings = await getEventSettings();
    const activeId = settings?.activeEventSessionId ?? null;
    // Strict active-session scoping. With no active session there's no
    // event in progress, so don't surface stale voids from a previous
    // event — return empty so the kitchen banner stays clean.
    if (activeId == null) {
      res.json([]);
      return;
    }
    const cutoff = new Date(Date.now() - 30 * 60 * 1000);
    const conditions = [
      sql`${eventOrdersTable.voidedAt} IS NOT NULL`,
      sql`${eventOrdersTable.voidedAt} >= ${cutoff}`,
      eq(eventOrdersTable.eventSessionId, activeId),
    ];
    const rows = await db
      .select()
      .from(eventOrdersTable)
      .where(and(...conditions))
      .orderBy(desc(eventOrdersTable.voidedAt))
      .limit(50);
    res.json(rows.map(o => ({
      id: o.id,
      guestName: o.guestName,
      orderSource: o.orderSource,
      status: o.status,
      voidedAt: o.voidedAt,
      voidedBy: o.voidedBy,
      voidReason: o.voidReason,
      refundRequired: o.refundRequired,
      items: o.items,
      firedItemIds: o.firedItemIds ?? [],
      plateGroups: o.plateGroups ?? null,
      kitchenProgress: o.kitchenProgress ?? null,
    })));
  } catch (err) {
    req.log.error({ err }, "Error fetching kitchen recent voids");
    res.status(500).json({ error: "Failed to fetch recent voids" });
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
    // All status reads + writes happen inside a row-locked transaction so
    // a concurrent /kitchen-progress auto-advance can't double-fire the
    // Ready SMS or trample the readyAt stamp.
    const result = await db.transaction(async tx => {
      const [existing] = await tx
        .select()
        .from(eventOrdersTable)
        .where(eq(eventOrdersTable.id, id))
        .for("update");
      if (!existing) throw Object.assign(new Error("Order not found"), { status: 404 });
      // Soft-voided orders are dead to the kitchen — refuse stale taps so
      // a kitchen device that hadn't polled yet can't resurrect the row.
      if (existing.voidedAt) {
        throw Object.assign(new Error("Order has been voided"), { status: 409 });
      }
      // Plated orders advance preparing→ready exclusively through the
      // per-plate packing endpoint. Reject a manual Mark-Ready unless the
      // packing UI is fully checked, otherwise tickets can sneak past
      // unfinished plates.
      const plateGroups = (existing.plateGroups as EventOrderPlate[] | null) ?? null;
      if (status === "ready" && plateGroups && plateGroups.length > 0) {
        const progress = normalizeKitchenProgress(
          existing.kitchenProgress as EventOrderKitchenProgress | null,
          existing.items as EventOrderItem[],
          plateGroups,
        );
        if (!progress || !isFullyPacked(progress)) {
          throw Object.assign(
            new Error("Plated orders advance via per-plate packing — finish packing every plate before marking Ready"),
            { status: 409 },
          );
        }
      }
      const updates: Record<string, unknown> = { status };
      const now = new Date();
      // Stamp service-time milestones the first time we reach each step so
      // re-flipping status (e.g. ready → preparing → ready) doesn't reset
      // the original timestamps the Sales Report depends on.
      if (status === "ready" && !existing.readyAt) updates.readyAt = now;
      if (status === "picked_up" && !existing.pickedUpAt) updates.pickedUpAt = now;
      // Backward transition → wipe per-plate packing progress so when the
      // cook re-enters the active queue they start with a clean ticket.
      // Covers Undo on a Preparing card (preparing→pending) and Undo on a
      // plated Ready card (ready→preparing).
      if (
        (status === "pending" && existing.status !== "pending") ||
        (status === "preparing" && existing.status === "ready")
      ) {
        updates.kitchenProgress = null;
      }
      // Server-synced "Fire totals" check-off state lives only while the
      // order is in the active queue. Wipe it when the cook sends the
      // order forward (preparing→ready, or any jump to done/picked_up)
      // so a re-opened ticket starts clean. Also wipe on a back-revert
      // to pending so the next fire pass is fresh.
      if (status === "ready" || status === "done" || status === "picked_up") {
        updates.firedItemIds = [];
      } else if (status === "pending" && existing.status !== "pending") {
        updates.firedItemIds = [];
      }
      const wasReady = existing.status === "ready";
      const [updated] = await tx
        .update(eventOrdersTable)
        .set(updates)
        .where(eq(eventOrdersTable.id, id))
        .returning();
      return { updated, wasReady };
    });

    // Idempotent Ready SMS: only fire on a true transition into "ready"
    // (existing.status !== "ready"). Auto-advance via /kitchen-progress
    // takes the same lock, so two devices can't both produce a notice.
    if (status === "ready" && !result.wasReady && result.updated.phoneNumber) {
      const settings = await getEventSettings();
      sendOrderReady({
        guestName: result.updated.guestName,
        orderId: result.updated.id,
        phoneNumber: result.updated.phoneNumber,
        eventName: settings?.eventName ?? "",
      }).catch(() => {});
    }

    res.json(result.updated);
  } catch (err: any) {
    if (err?.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "Error updating event order status");
    res.status(500).json({ error: "Failed to update order status" });
  }
});

// Build a fresh "nothing packed yet" progress object from an order's plate
// layout and cart items. Each plate carries the lines defined on it; any
// remaining cart units (not assigned to a plate) become the `unassigned`
// group. Returns null when the order has no plating.
function buildEmptyKitchenProgress(
  items: EventOrderItem[],
  plateGroups: EventOrderPlate[] | null,
): EventOrderKitchenProgress | null {
  if (!plateGroups || plateGroups.length === 0) return null;
  const plates = plateGroups.map(p => ({
    items: p.items.map(i => ({ itemId: i.itemId, quantity: i.quantity, packed: 0 })),
  }));
  const platedTotals: Record<number, number> = {};
  for (const p of plateGroups) {
    for (const i of p.items) platedTotals[i.itemId] = (platedTotals[i.itemId] ?? 0) + i.quantity;
  }
  const unassigned: EventOrderKitchenProgressLine[] = [];
  for (const line of items) {
    const remaining = line.quantity - (platedTotals[line.itemId] ?? 0);
    if (remaining > 0) {
      unassigned.push({ itemId: line.itemId, quantity: remaining, packed: 0 });
    }
  }
  return { plates, unassigned };
}

// Reconcile a stored progress object against the order's current plate
// layout — defends against plate edits between writes by trimming/adding
// lines and clamping `packed` into [0, quantity].
function normalizeKitchenProgress(
  stored: EventOrderKitchenProgress | null,
  items: EventOrderItem[],
  plateGroups: EventOrderPlate[] | null,
): EventOrderKitchenProgress | null {
  const fresh = buildEmptyKitchenProgress(items, plateGroups);
  if (!fresh) return null;
  if (!stored) return fresh;
  const lookup = (lines: EventOrderKitchenProgressLine[], itemId: number) =>
    lines.find(l => l.itemId === itemId);
  const merged: EventOrderKitchenProgress = {
    plates: fresh.plates.map((plate, idx) => ({
      items: plate.items.map(line => {
        const prev = stored.plates?.[idx] ? lookup(stored.plates[idx].items, line.itemId) : undefined;
        const packed = Math.max(0, Math.min(line.quantity, prev?.packed ?? 0));
        return { ...line, packed };
      }),
    })),
    unassigned: fresh.unassigned.map(line => {
      const prev = stored.unassigned ? lookup(stored.unassigned, line.itemId) : undefined;
      const packed = Math.max(0, Math.min(line.quantity, prev?.packed ?? 0));
      return { ...line, packed };
    }),
  };
  return merged;
}

function isFullyPacked(p: EventOrderKitchenProgress): boolean {
  for (const plate of p.plates) {
    for (const line of plate.items) if (line.packed < line.quantity) return false;
  }
  for (const line of p.unassigned) if (line.packed < line.quantity) return false;
  return true;
}

// Per-plate / per-line packing progress. Kitchen-only; mutations are
// rejected (409) once the order leaves the active queue (preparing /
// pending) so a stale tap can't reset a Ready ticket. When all plate
// lines are fully packed we auto-advance preparing→ready in the same
// transaction (mirrors the SMS-on-ready behaviour of /status).
router.patch("/event-ordering/orders/:id/kitchen-progress", verifyKitchenPassword, async (req, res): Promise<void> => {
  try {
    const id = parseInt(String(req.params.id));
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }
    const body = (req.body ?? {}) as {
      plateIdx?: unknown;
      itemId?: unknown;
      packed?: unknown;
      allPacked?: unknown;
    };
    const isUnassigned = body.plateIdx === "unassigned";
    const plateIdx = isUnassigned ? -1 : Number(body.plateIdx);
    if (!isUnassigned && (!Number.isInteger(plateIdx) || plateIdx < 0)) {
      res.status(400).json({ error: "plateIdx must be a non-negative integer or 'unassigned'" });
      return;
    }
    const isWholePlate = typeof body.allPacked === "boolean";
    const isSingleLine = typeof body.packed === "boolean" && typeof body.itemId === "number";
    if (!isWholePlate && !isSingleLine) {
      res.status(400).json({ error: "Provide either {itemId, packed} or {allPacked}" });
      return;
    }
    if (isWholePlate && isUnassigned) {
      res.status(400).json({ error: "allPacked is only valid for plate indices" });
      return;
    }

    const result = await db.transaction(async tx => {
      const [row] = await tx
        .select()
        .from(eventOrdersTable)
        .where(eq(eventOrdersTable.id, id))
        .for("update");
      if (!row) throw Object.assign(new Error("Order not found"), { status: 404 });
      if (row.voidedAt) {
        throw Object.assign(new Error("Order has been voided"), { status: 409 });
      }
      if (row.status !== "preparing" && row.status !== "pending") {
        throw Object.assign(new Error(`Order is ${row.status}; progress is locked`), { status: 409 });
      }
      const plateGroups = (row.plateGroups as EventOrderPlate[] | null) ?? null;
      if (!plateGroups || plateGroups.length === 0) {
        throw Object.assign(new Error("Order has no plating"), { status: 400 });
      }
      const progress = normalizeKitchenProgress(
        row.kitchenProgress as EventOrderKitchenProgress | null,
        row.items as EventOrderItem[],
        plateGroups,
      );
      if (!progress) throw Object.assign(new Error("Order has no plating"), { status: 400 });

      if (isWholePlate) {
        if (plateIdx >= progress.plates.length) {
          throw Object.assign(new Error("Plate index out of range"), { status: 400 });
        }
        const target = body.allPacked ? "full" : "empty";
        progress.plates[plateIdx].items = progress.plates[plateIdx].items.map(l => ({
          ...l,
          packed: target === "full" ? l.quantity : 0,
        }));
      } else {
        const lines = isUnassigned
          ? progress.unassigned
          : progress.plates[plateIdx]?.items;
        if (!lines) {
          throw Object.assign(new Error("Plate index out of range"), { status: 400 });
        }
        const line = lines.find(l => l.itemId === Number(body.itemId));
        if (!line) {
          throw Object.assign(new Error("Item not found on this plate"), { status: 400 });
        }
        line.packed = body.packed ? line.quantity : 0;
      }

      const updates: Record<string, unknown> = { kitchenProgress: progress };
      let advanced = false;
      if (row.status === "preparing" && isFullyPacked(progress)) {
        updates.status = "ready";
        if (!row.readyAt) updates.readyAt = new Date();
        // Fire totals belong to the active queue — wipe so a re-opened
        // ticket via Undo on Ready starts fresh.
        updates.firedItemIds = [];
        advanced = true;
      }
      const [updated] = await tx
        .update(eventOrdersTable)
        .set(updates)
        .where(eq(eventOrdersTable.id, id))
        .returning();
      return { updated, advanced };
    });

    if (result.advanced && result.updated.phoneNumber) {
      const settings = await getEventSettings();
      sendOrderReady({
        guestName: result.updated.guestName,
        orderId: result.updated.id,
        phoneNumber: result.updated.phoneNumber,
        eventName: settings?.eventName ?? "",
      }).catch(() => {});
    }

    res.json({
      ...result.updated,
      subtotal: result.updated.subtotal != null ? parseFloat(result.updated.subtotal) : null,
      taxRate: result.updated.taxRate != null ? parseFloat(result.updated.taxRate) : null,
      taxAmount: result.updated.taxAmount != null ? parseFloat(result.updated.taxAmount) : null,
      total: result.updated.total != null ? parseFloat(result.updated.total) : null,
      plateGroups: result.updated.plateGroups ?? null,
      kitchenProgress: result.updated.kitchenProgress ?? null,
      firedItemIds: result.updated.firedItemIds ?? [],
    });
  } catch (err: any) {
    if (err?.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "Error updating kitchen progress");
    res.status(500).json({ error: "Failed to update kitchen progress" });
  }
});

// Server-synced "Fire totals" tap. Toggle a single cart-line itemId in
// the order's firedItemIds set; when the resulting set covers every cart
// line AND the order is still pending, auto-advance to "preparing" in
// the same transaction so all kitchen devices see the status flip on
// the next poll. Mutations are rejected (409) once the order leaves the
// active queue so a stale tap can't reset a Ready ticket.
router.patch("/event-ordering/orders/:id/fired", verifyKitchenPassword, async (req, res): Promise<void> => {
  try {
    const id = parseInt(String(req.params.id));
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }
    const body = (req.body ?? {}) as { itemId?: unknown; fired?: unknown };
    const itemId = Number(body.itemId);
    if (!Number.isInteger(itemId)) {
      res.status(400).json({ error: "itemId must be an integer" });
      return;
    }
    if (typeof body.fired !== "boolean") {
      res.status(400).json({ error: "fired must be a boolean" });
      return;
    }
    const fired = body.fired;

    const updated = await db.transaction(async tx => {
      const [row] = await tx
        .select()
        .from(eventOrdersTable)
        .where(eq(eventOrdersTable.id, id))
        .for("update");
      if (!row) throw Object.assign(new Error("Order not found"), { status: 404 });
      if (row.voidedAt) {
        throw Object.assign(new Error("Order has been voided"), { status: 409 });
      }
      if (row.status !== "preparing" && row.status !== "pending") {
        throw Object.assign(new Error(`Order is ${row.status}; fire totals are locked`), { status: 409 });
      }
      const items = (row.items as EventOrderItem[]) ?? [];
      const validIds = new Set(items.map(i => i.itemId));
      if (!validIds.has(itemId)) {
        throw Object.assign(new Error("Item not on this order"), { status: 400 });
      }
      const current = new Set((row.firedItemIds as number[] | null) ?? []);
      if (fired) current.add(itemId); else current.delete(itemId);
      // Only keep itemIds that still exist on the cart so a later cart
      // edit can't leave dangling ids in the set.
      const next = [...current].filter(x => validIds.has(x));

      const updates: Record<string, unknown> = { firedItemIds: next };
      // Auto-advance pending → preparing when every cart line is fired.
      // Plated orders advance to ready exclusively via /kitchen-progress,
      // so we never auto-advance preparing → ready here.
      if (row.status === "pending" && next.length === validIds.size && validIds.size > 0) {
        updates.status = "preparing";
      }
      const [out] = await tx
        .update(eventOrdersTable)
        .set(updates)
        .where(eq(eventOrdersTable.id, id))
        .returning();
      return out;
    });

    // Return only the fields the kitchen UI merges in; leave items[]
    // alone so the frontend keeps the per-item internalNotes it already
    // hydrated from /orders.
    res.json({
      id: updated.id,
      status: updated.status,
      firedItemIds: updated.firedItemIds ?? [],
    });
  } catch (err: any) {
    if (err?.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "Error updating fired items");
    res.status(500).json({ error: "Failed to update fired items" });
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
