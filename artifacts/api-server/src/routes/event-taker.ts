import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { menuItemsTable, eventOrdersTable, eventSettingsTable, printersTable } from "@workspace/db/schema";
import { eq, sql, inArray, and, desc, isNull } from "drizzle-orm";
import { sendOrderConfirmation } from "../lib/sms";
import { getOrderingChannelStates } from "./event-ordering";
import { detectAndMarkLowStockCrossings, fireLowStockAlertIfAny, DEFAULT_LOW_STOCK_THRESHOLD } from "../lib/lowStockAlerts";
import { fanoutPrintForEventOrder } from "../lib/printFanout";
import {
  getTerminalSquareConfig,
  isTerminalSquareConfigured,
  createTerminalCheckout,
  getTerminalCheckout,
  cancelTerminalCheckout,
  SquareApiError,
} from "../lib/square";
import { randomUUID } from "crypto";

const router: IRouter = Router();

function serializeOrder(o: typeof eventOrdersTable.$inferSelect) {
  return {
    ...o,
    subtotal: o.subtotal != null ? parseFloat(o.subtotal) : null,
    taxRate: o.taxRate != null ? parseFloat(o.taxRate) : null,
    taxAmount: o.taxAmount != null ? parseFloat(o.taxAmount) : null,
    total: o.total != null ? parseFloat(o.total) : null,
    cashReceived: o.cashReceived != null ? parseFloat(o.cashReceived) : null,
    changeDue: o.changeDue != null ? parseFloat(o.changeDue) : null,
    plateGroups: o.plateGroups ?? null,
    kitchenProgress: o.kitchenProgress ?? null,
    firedItemIds: o.firedItemIds ?? [],
  };
}

// Validate a staff-supplied plating layout against the order's items list.
// Returns the cleaned plate array (empty plates dropped, item lines with
// quantity 0 stripped) or throws an error tagged with status=400.
type PlateGroupInput = { label?: unknown; items?: unknown };
type CartLine = { itemId: number; name: string; quantity: number };
function validateAndCleanPlateGroups(
  raw: unknown,
  cartItems: CartLine[],
): { label: string; items: { itemId: number; quantity: number }[] }[] | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) {
    throw Object.assign(new Error("plateGroups must be an array"), { status: 400 });
  }
  const cartByItem = new Map(cartItems.map(c => [c.itemId, c]));
  // Track running per-item allocation so we can index errors precisely.
  const allocByItem = new Map<number, number>();
  const cleaned: { label: string; items: { itemId: number; quantity: number }[] }[] = [];
  raw.forEach((p, plateIdx) => {
    const plate = p as PlateGroupInput;
    const labelRaw = typeof plate.label === "string" ? plate.label.trim() : "";
    const label = labelRaw || `Plate ${plateIdx + 1}`;
    if (!Array.isArray(plate.items)) {
      throw Object.assign(new Error(`Plate ${plateIdx + 1} items must be an array`), { status: 400 });
    }
    // Aggregate within a single plate so duplicate item lines collapse cleanly.
    const perPlate = new Map<number, number>();
    for (const ln of plate.items as unknown[]) {
      const line = ln as { itemId?: unknown; quantity?: unknown };
      const itemId = Number(line?.itemId);
      const qty = Number(line?.quantity);
      if (!Number.isInteger(itemId) || itemId <= 0) {
        throw Object.assign(new Error(`Plate ${plateIdx + 1} has an invalid itemId`), { status: 400 });
      }
      if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty < 0) {
        throw Object.assign(new Error(`Plate ${plateIdx + 1} quantities must be whole numbers`), { status: 400 });
      }
      if (qty === 0) continue;
      if (!cartByItem.has(itemId)) {
        throw Object.assign(new Error(`Plate ${plateIdx + 1} references an item not in the order`), { status: 400 });
      }
      perPlate.set(itemId, (perPlate.get(itemId) ?? 0) + qty);
    }
    const items: { itemId: number; quantity: number }[] = [];
    for (const [itemId, qty] of perPlate) {
      const cart = cartByItem.get(itemId)!;
      const next = (allocByItem.get(itemId) ?? 0) + qty;
      if (next > cart.quantity) {
        throw Object.assign(
          new Error(`Plate ${plateIdx + 1} has too many of "${cart.name}" (only ${cart.quantity} in cart)`),
          { status: 400 },
        );
      }
      allocByItem.set(itemId, next);
      items.push({ itemId, quantity: qty });
    }
    if (items.length === 0) return; // drop empty plates
    cleaned.push({ label, items });
  });
  return cleaned.length > 0 ? cleaned : null;
}

async function getSettings() {
  const [settings] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
  return settings ?? null;
}

// Resolve taker password — falls back to guest event password if not set
async function resolveTakerPassword(): Promise<string | null> {
  const s = await getSettings();
  if (s?.eventTakerPassword) return s.eventTakerPassword;
  if (s?.eventPassword) return s.eventPassword;
  return process.env.EVENT_PASSWORD ?? null;
}

const verifyTakerPassword = async function (req: Request, res: Response, next: NextFunction) {
  const password = await resolveTakerPassword();
  if (!password) {
    res.status(503).json({ error: "Event Order Taker is not configured" });
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

// ── Scoped printer settings (Staff Order Taker) ─────────────────────────
// Staff Order Taker can configure per-printer toggles for the kinds it is
// authorized to send: kitchen_ticket and customer_receipt. Admin's
// /admin/printers remains the canonical surface; this endpoint reads from
// the same printers table and writes back an allow-listed subset of fields,
// so admin and the Taker stay in sync automatically.
router.get("/event-taker/printers", verifyTakerPassword, async (req, res) => {
  try {
    const rows = await db.select().from(printersTable).orderBy(printersTable.id);
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "taker list printers failed");
    res.status(500).json({ error: "Failed to list printers" });
  }
});

router.patch("/event-taker/printers/:id", verifyTakerPassword, async (req, res): Promise<void> => {
  try {
    const id = parseInt(String(req.params.id));
    const b = req.body as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    // Allow-list: only the fields a Taker surface is allowed to influence.
    for (const k of [
      "enabled",
      "autoPrintOnNewOrder",
      "printsKitchenTicket",
      "printsCustomerReceipt",
    ] as const) {
      if (b[k] !== undefined) updates[k] = !!b[k];
    }
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "no allowed fields supplied" });
      return;
    }
    const [row] = await db
      .update(printersTable)
      .set(updates)
      .where(eq(printersTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "taker update printer failed");
    res.status(500).json({ error: "Failed to update printer" });
  }
});

router.get("/event-taker/settings", async (req, res) => {
  try {
    const s = await getSettings();
    const resolved = await resolveTakerPassword();
    const channels = await getOrderingChannelStates();
    res.json({
      eventName: s?.eventName ?? "",
      taxEnabled: s?.eventTakerTaxEnabled ?? false,
      taxRate: s?.eventTakerTaxRate != null ? parseFloat(s.eventTakerTaxRate) : null,
      staffNotesEnabled: s?.staffNotesEnabled ?? false,
      hasPassword: !!resolved,
      venmoHandle: s?.venmoHandle ?? null,
      venmoQrImageUrl: s?.venmoQrImageUrl ?? null,
      // True when both Square is configured AND a Terminal device ID is set.
      // The frontend uses this to decide whether card taps auto-fire the
      // Terminal or fall back to the manual instruction screen.
      terminalEnabled: !!(s?.squareTerminalDeviceId) && isTerminalSquareConfigured(),
      orderingState: channels.taker.state,
      orderingPausedUntil: channels.taker.pausedUntil,
      orderingRemainingSec: channels.taker.remainingSec,
      orderingPausedMessage: channels.taker.pausedMessage,
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching taker settings");
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

router.post("/event-taker/verify", async (req, res) => {
  const { password } = req.body as { password?: string };
  const expected = await resolveTakerPassword();
  if (!expected) {
    res.status(503).json({ error: "Event Order Taker is not configured" });
    return;
  }
  if (!password || password !== expected) {
    res.status(401).json({ error: "Invalid password" });
    return;
  }
  res.json({ ok: true });
});

router.get("/event-taker/menu", verifyTakerPassword, async (req, res) => {
  try {
    const settings = await getSettings();
    // Layout is the raw (number|null)[] from event_settings. Null entries are
    // intentional empty cells; the frontend uses them to build the fixed-slot grid.
    const rawLayout = Array.isArray(settings?.takerMenuOrder)
      ? (settings.takerMenuOrder as (number | null)[])
      : [];

    const items = await db
      .select({
        id: menuItemsTable.id,
        name: menuItemsTable.name,
        description: menuItemsTable.description,
        category: menuItemsTable.category,
        price: menuItemsTable.price,
        eventTakerPrice: menuItemsTable.eventTakerPrice,
        unit: menuItemsTable.unit,
        servingSize: menuItemsTable.servingSize,
        imageUrl: menuItemsTable.imageUrl,
        eventStock: menuItemsTable.eventStock,
        internalNotes: menuItemsTable.internalNotes,
        isCombo: menuItemsTable.isCombo,
        comboSlots: menuItemsTable.comboSlots,
      })
      .from(menuItemsTable)
      .where(eq(menuItemsTable.eventTakerVisible, true))
      .orderBy(menuItemsTable.category, menuItemsTable.name);

    // Strict: only items with an explicit event_taker_price are sellable on the POS.
    const formatted = items
      .filter(item => item.eventTakerPrice != null)
      .map(item => {
        const taker = parseFloat(item.eventTakerPrice as string);
        const base = parseFloat(item.price);
        return {
          ...item,
          price: base,
          eventTakerPrice: taker,
          effectivePrice: taker,
          isCombo: item.isCombo ?? false,
          comboSlots: item.comboSlots ?? null,
        };
      });

    // Build the `items` array in slot order: slots in rawLayout that contain a
    // valid item ID, nulls skipped. Items not present in the layout append at
    // the end in default alpha order so new menu additions are never lost.
    const formattedById = new Map(formatted.map(f => [f.id, f]));
    const validIds = new Set(formatted.map(f => f.id));
    const placed = new Set<number>();
    const orderedItems = rawLayout
      .filter((id): id is number => id !== null && validIds.has(id) && !placed.has(id))
      .map(id => { placed.add(id); return formattedById.get(id)!; });
    const unplaced = formatted.filter(f => !placed.has(f.id));
    const sortedItems = [...orderedItems, ...unplaced];

    // Return both the ordered items list (for normal mode) and the raw layout
    // array (for the arrange-mode fixed-slot grid). The frontend keeps them
    // in separate state variables.
    res.json({ items: sortedItems, layout: rawLayout });
  } catch (err) {
    req.log.error({ err }, "Error fetching taker menu");
    res.status(500).json({ error: "Failed to fetch menu" });
  }
});

router.put("/event-taker/menu-order", verifyTakerPassword, async (req, res) => {
  try {
    const { order } = req.body as { order?: unknown };
    if (!Array.isArray(order)) {
      res.status(400).json({ error: "order must be an array" });
      return;
    }
    // Each entry is either null (empty cell) or a positive integer (item ID).
    const invalid = order.some(v => v !== null && (!Number.isInteger(v) || v <= 0));
    if (invalid) {
      res.status(400).json({ error: "order entries must be null or positive integers" });
      return;
    }
    // Disallow duplicate item IDs (nulls may repeat — they're empty cells).
    const ids = order.filter((v): v is number => v !== null);
    if (new Set(ids).size !== ids.length) {
      res.status(400).json({ error: "duplicate item IDs in order" });
      return;
    }
    await db
      .update(eventSettingsTable)
      .set({ takerMenuOrder: order as (number | null)[] })
      .where(eq(eventSettingsTable.id, 1));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Error saving taker menu order");
    res.status(500).json({ error: "Failed to save menu order" });
  }
});

router.post("/event-taker/orders", verifyTakerPassword, async (req, res) => {
  try {
    const { guestName, phoneNumber, items, statusUrlBase, plateGroups, notes } = req.body as {
      guestName?: string;
      phoneNumber?: string | null;
      items?: {
        itemId: number;
        quantity: number;
        comboSelections?: Array<{ slotId: string; slotName: string; menuItemId: number; name: string; quantity: number }>;
      }[];
      statusUrlBase?: string;
      plateGroups?: unknown;
      notes?: string | null;
    };
    if (!guestName?.trim() || !items?.length) {
      res.status(400).json({ error: "guestName and items are required" });
      return;
    }

    // Gate: kitchen may have paused or stopped staff order taking.
    const channels = await getOrderingChannelStates();
    if (channels.taker.state !== "accepting") {
      res.status(423).json({
        error: channels.taker.state === "paused"
          ? "Order taking is paused — try again shortly."
          : "Order taking is currently stopped.",
        state: channels.taker.state,
        pausedUntil: channels.taker.pausedUntil,
        remainingSec: channels.taker.remainingSec,
      });
      return;
    }

    // Validate quantities and aggregate duplicate item lines up-front.
    // Items submitted with comboSelections are kept as individual combo lines
    // so their slot selections are preserved; regular items aggregate by itemId.
    type ComboLineInput = {
      itemId: number;
      quantity: number;
      comboSelections: Array<{ slotId: string; slotName: string; menuItemId: number; name: string; quantity: number }>;
    };
    const aggregated = new Map<number, number>();
    const comboLineInputs: ComboLineInput[] = [];
    for (const i of items) {
      const id = Number(i?.itemId);
      const q = Number(i?.quantity);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: "Invalid itemId" });
        return;
      }
      if (!Number.isFinite(q) || !Number.isInteger(q) || q <= 0) {
        res.status(400).json({ error: "Quantity must be a positive integer" });
        return;
      }
      if (Array.isArray(i.comboSelections) && i.comboSelections.length > 0) {
        // Validate each selection quantity is a positive integer up-front.
        for (const sel of i.comboSelections) {
          if (!Number.isInteger(sel.quantity) || sel.quantity <= 0) {
            res.status(400).json({ error: "Each combo selection quantity must be a positive integer" });
            return;
          }
        }
        comboLineInputs.push({ itemId: id, quantity: q, comboSelections: i.comboSelections });
      } else {
        aggregated.set(id, (aggregated.get(id) ?? 0) + q);
      }
    }

    // Pre-aggregate total combo quantity per itemId so stock checks cover all
    // combo lines for the same item and cannot be defeated by splitting lines.
    const comboTotalQtyByItemId = new Map<number, number>();
    for (const c of comboLineInputs) {
      comboTotalQtyByItemId.set(c.itemId, (comboTotalQtyByItemId.get(c.itemId) ?? 0) + c.quantity);
    }

    const settings = await getSettings();
    const taxEnabled = !!settings?.eventTakerTaxEnabled;
    const taxRate = settings?.eventTakerTaxRate != null ? parseFloat(settings.eventTakerTaxRate) : 0;

    const { order } = await db.transaction(async (tx) => {
      // Re-check the kitchen toggle inside the transaction to avoid a race
      // between the gate above and the row commit.
      const [s] = await tx.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1)).for("update");
      // Recompute the effective channel state from the row we just locked, so a
      // concurrent toggle write blocks behind us instead of slipping orders through.
      const liveTaker = (function () {
        const raw = (s?.takerOrderingState ?? "accepting") as "accepting" | "paused" | "closed";
        const pu = s?.takerOrderingPausedUntil ?? null;
        if (raw === "paused" && pu) {
          const ms = pu.getTime() - Date.now();
          if (ms > 0) return { state: "paused" as const, pausedUntil: pu.toISOString(), remainingSec: Math.ceil(ms / 1000) };
          return { state: "accepting" as const, pausedUntil: null, remainingSec: null };
        }
        if (raw === "closed") return { state: "closed" as const, pausedUntil: null, remainingSec: null };
        return { state: "accepting" as const, pausedUntil: null, remainingSec: null };
      })();
      if (liveTaker.state !== "accepting") {
        throw Object.assign(new Error(liveTaker.state === "paused"
          ? "Order taking is paused — try again shortly."
          : "Order taking is currently stopped."),
          { status: 423, channelState: liveTaker });
      }
      // Collect all unique item IDs across regular + combo lines.
      const allItemIds = Array.from(
        new Set([
          ...Array.from(aggregated.keys()),
          ...comboLineInputs.map(c => c.itemId),
        ])
      );
      const rows = await tx
        .select()
        .from(menuItemsTable)
        .where(inArray(menuItemsTable.id, allItemIds))
        .for("update");
      const byId = new Map(rows.map(r => [r.id, r]));

      const orderItems: {
        itemId: number;
        name: string;
        quantity: number;
        price: number;
        unitPrice: number;
        lineTotal: number;
        comboName?: string;
        comboSelections?: Array<{ slotId: string; slotName: string; menuItemId: number; name: string; quantity: number }>;
      }[] = [];
      let subtotal = 0;
      // Track post-decrement stock per item so we can run one batched
      // low-stock crossing check after all updates land.
      const stockChanges: Array<{ itemId: number; name: string; newStock: number }> = [];

      const round2 = (n: number) => Math.round(n * 100) / 100;

      // ── Regular (non-combo) items ─────────────────────────────────────
      for (const [itemId, qty] of aggregated) {
        const row = byId.get(itemId);
        if (!row) throw Object.assign(new Error(`Item ${itemId} not found`), { status: 404 });
        if (!row.eventTakerVisible) throw Object.assign(new Error(`Item "${row.name}" is not available on the order taker`), { status: 400 });
        // Combo items submitted without comboSelections land here — block them so
        // required slot min/max rules cannot be bypassed by omitting selections.
        if (row.isCombo) {
          throw Object.assign(
            new Error(`"${row.name}" is a combo item — combo slot selections are required`),
            { status: 400 }
          );
        }
        // Strict: an item without an event_taker_price cannot be sold on the POS.
        if (row.eventTakerPrice == null) {
          throw Object.assign(
            new Error(`Item "${row.name}" has no Order Taker price set`),
            { status: 400 }
          );
        }
        // Stock enforcement against the aggregated quantity.
        if (row.eventStock !== null) {
          if (row.eventStock < qty) {
            throw Object.assign(
              new Error(`Only ${row.eventStock} of "${row.name}" remaining`),
              { status: 409, remaining: row.eventStock, itemId: row.id }
            );
          }
          await tx
            .update(menuItemsTable)
            .set({ eventStock: sql`event_stock - ${qty}` })
            .where(eq(menuItemsTable.id, row.id));
          stockChanges.push({ itemId: row.id, name: row.name, newStock: row.eventStock - qty });
        }
        const unitPrice = parseFloat(row.eventTakerPrice);
        const lineTotal = round2(unitPrice * qty);
        subtotal += lineTotal;
        orderItems.push({
          itemId: row.id,
          name: row.name,
          quantity: qty,
          price: unitPrice,
          unitPrice,
          lineTotal,
        });
      }

      // ── Combo items ───────────────────────────────────────────────────
      // Track which itemIds have had their stock checked+decremented so we do it
      // exactly once per item even if it appears across multiple combo lines.
      const comboStockCheckedIds = new Set<number>();
      for (const comboInput of comboLineInputs) {
        const row = byId.get(comboInput.itemId);
        if (!row) throw Object.assign(new Error(`Item ${comboInput.itemId} not found`), { status: 404 });
        if (!row.eventTakerVisible) throw Object.assign(new Error(`Item "${row.name}" is not available on the order taker`), { status: 400 });
        if (row.eventTakerPrice == null) {
          throw Object.assign(
            new Error(`Item "${row.name}" has no Order Taker price set`),
            { status: 400 }
          );
        }
        // Reject non-combo items that were submitted with comboSelections —
        // they must not bypass regular aggregation/validation logic.
        if (!row.isCombo) {
          throw Object.assign(
            new Error(`Item "${row.name}" is not a combo item — do not submit comboSelections for it`),
            { status: 400 }
          );
        }
        // Validate combo slot selections against the item's comboSlots definition.
        if (Array.isArray(row.comboSlots) && row.comboSlots.length > 0) {
          type SlotDef = { slotId: string; slotName: string; minQty: number; maxQty: number; options: Array<{ menuItemId: number }> };
          const slotDefs = row.comboSlots as SlotDef[];
          const validSlotIds = new Set(slotDefs.map(s => s.slotId));
          // Reject any submitted slotId that isn't in the item's configuration.
          for (const sel of comboInput.comboSelections) {
            if (!validSlotIds.has(sel.slotId)) {
              throw Object.assign(
                new Error(`Unknown slot "${sel.slotId}" is not defined for "${row.name}"`),
                { status: 400 }
              );
            }
          }
          for (const slot of slotDefs) {
            const slotSelections = comboInput.comboSelections.filter(s => s.slotId === slot.slotId);
            const slotTotal = slotSelections.reduce((sum, s) => sum + s.quantity, 0);
            if (slotTotal < slot.minQty) {
              throw Object.assign(
                new Error(`Slot "${slot.slotName}" requires at least ${slot.minQty} item(s) — got ${slotTotal}`),
                { status: 400 }
              );
            }
            if (slotTotal > slot.maxQty) {
              throw Object.assign(
                new Error(`Slot "${slot.slotName}" allows at most ${slot.maxQty} item(s) — got ${slotTotal}`),
                { status: 400 }
              );
            }
            // Validate that all selected menuItemIds are in the slot's options list.
            const validOptionIds = new Set(slot.options.map((o: { menuItemId: number }) => o.menuItemId));
            for (const sel of slotSelections) {
              if (!validOptionIds.has(sel.menuItemId)) {
                throw Object.assign(
                  new Error(`Item "${sel.name}" is not a valid option for slot "${slot.slotName}"`),
                  { status: 400 }
                );
              }
            }
          }
        }
        // Stock check + decrement: use the pre-aggregated total across all combo
        // lines for this item so that splitting one item across multiple lines
        // cannot bypass stock enforcement.
        if (row.eventStock !== null && !comboStockCheckedIds.has(row.id)) {
          comboStockCheckedIds.add(row.id);
          const totalNeeded = comboTotalQtyByItemId.get(row.id)!;
          if (row.eventStock < totalNeeded) {
            throw Object.assign(
              new Error(`Only ${row.eventStock} of "${row.name}" remaining`),
              { status: 409, remaining: row.eventStock, itemId: row.id }
            );
          }
          await tx
            .update(menuItemsTable)
            .set({ eventStock: sql`event_stock - ${totalNeeded}` })
            .where(eq(menuItemsTable.id, row.id));
          stockChanges.push({ itemId: row.id, name: row.name, newStock: row.eventStock - totalNeeded });
        }
        const qty = comboInput.quantity;
        const unitPrice = parseFloat(row.eventTakerPrice);
        const lineTotal = round2(unitPrice * qty);
        subtotal += lineTotal;
        orderItems.push({
          itemId: row.id,
          name: row.name,
          quantity: qty,
          price: unitPrice,
          unitPrice,
          lineTotal,
          comboName: row.name,
          comboSelections: comboInput.comboSelections,
        });
      }

      // ── Component stock deduction for combo items ─────────────────────
      // Aggregate component quantities across all combo lines. A component
      // may appear in multiple combos or multiple slots; accumulate totals.
      // Each selection quantity is multiplied by the combo line quantity
      // (e.g. 2× Lunch Combo with 1× Beef each → Beef drops by 2).
      const componentQtyByItemId = new Map<number, number>();
      for (const comboInput of comboLineInputs) {
        for (const sel of comboInput.comboSelections) {
          componentQtyByItemId.set(
            sel.menuItemId,
            (componentQtyByItemId.get(sel.menuItemId) ?? 0) + sel.quantity * comboInput.quantity,
          );
        }
      }
      if (componentQtyByItemId.size > 0) {
        const componentIds = Array.from(componentQtyByItemId.keys());
        const componentRows = await tx
          .select({ id: menuItemsTable.id, name: menuItemsTable.name, eventStock: menuItemsTable.eventStock })
          .from(menuItemsTable)
          .where(inArray(menuItemsTable.id, componentIds))
          .for("update");
        for (const compRow of componentRows) {
          const qtyNeeded = componentQtyByItemId.get(compRow.id)!;
          if (compRow.eventStock === null) continue; // no stock tracking — skip silently
          await tx
            .update(menuItemsTable)
            .set({ eventStock: sql`event_stock - ${qtyNeeded}` })
            .where(eq(menuItemsTable.id, compRow.id));
          stockChanges.push({ itemId: compRow.id, name: compRow.name, newStock: compRow.eventStock - qtyNeeded });
        }
      }

      subtotal = round2(subtotal);
      const taxAmount = taxEnabled && taxRate > 0 ? round2(subtotal * (taxRate / 100)) : 0;
      const total = round2(subtotal + taxAmount);

      const activeEventSessionId = settings?.activeEventSessionId ?? null;

      // Validate plating against the just-priced items so the indexed errors
      // match what staff are looking at on screen. Throws status=400 on bad data.
      const cleanedPlateGroups = validateAndCleanPlateGroups(plateGroups, orderItems);

      // Detect low-stock crossings before inserting so we can store them on
      // the order row. Doing it inside the transaction keeps the atomic
      // lowStockAlertSent flag flip, preventing duplicate alerts across
      // concurrent orders. The SMS fires only after payment is confirmed (or
      // override is invoked) — not here — so Terminal charges that later fail
      // don't produce a phantom low-stock alert.
      const threshold = s?.lowStockAlertThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
      const crossings = await detectAndMarkLowStockCrossings(tx, stockChanges, threshold);

      const [created] = await tx
        .insert(eventOrdersTable)
        .values({
          guestName: guestName.trim(),
          phoneNumber: phoneNumber?.trim() || null,
          items: orderItems,
          plateGroups: cleanedPlateGroups,
          notes: typeof notes === "string" ? notes.trim().slice(0, 500) || null : null,
          status: "pending",
          eventSessionId: activeEventSessionId,
          orderSource: "staff",
          subtotal: String(subtotal),
          taxRate: taxEnabled && taxRate > 0 ? String(taxRate) : null,
          taxAmount: String(taxAmount),
          total: String(total),
          // Staff orders start unpaid — kitchen feed filters these out until
          // payment is confirmed or staff explicitly overrides.
          paymentStatus: "unpaid",
          // Stored so the SMS fires at payment/override time, not now.
          pendingLowStockCrossings: crossings.length > 0 ? crossings : null,
        })
        .returning();

      return { order: created };
    });

    // Intentionally do NOT send the order confirmation SMS here — it fires
    // once payment is recorded (or override is invoked). The low-stock SMS
    // likewise fires at payment/override time so it doesn't go out for
    // Terminal charges that later fail.

    // NOTE: The print fan-out intentionally does NOT fire here.
    // For staff (POS) orders, the kitchen ticket must only print after payment
    // is confirmed or the cashier explicitly overrides. Printing at order
    // creation caused tickets to appear for Terminal charges that later failed
    // (or any payment that the cashier ultimately voids). The fan-out fires in
    // PATCH /orders/:id/payment (unpaid→paid) and PATCH /orders/:id/override.
    res.status(201).json(serializeOrder(order));
  } catch (err: any) {
    if (err?.status === 409) {
      res.status(409).json({ error: err.message, remaining: err.remaining, itemId: err.itemId });
      return;
    }
    if (err?.status === 400 || err?.status === 404) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err?.status === 423 && err?.channelState) {
      res.status(423).json({
        error: err.message,
        state: err.channelState.state,
        pausedUntil: err.channelState.pausedUntil,
        remainingSec: err.channelState.remainingSec,
      });
      return;
    }
    req.log.error({ err }, "Error creating taker order");
    res.status(500).json({ error: "Failed to create order" });
  }
});

// ── Plate groups (plating layout) ──────────────────────────────────────
// Set/clear the optional plating layout while the order is still unpaid.
// Once payment is recorded (or override sent), the layout is locked — kitchen
// has already started reading it. PATCH with `plateGroups: null` (or omitted)
// to clear; otherwise the array is validated against the order's items.
router.patch("/event-taker/orders/:id/plate-groups", verifyTakerPassword, async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }
    const body = (req.body ?? {}) as { plateGroups?: unknown };
    const [existing] = await db.select().from(eventOrdersTable).where(eq(eventOrdersTable.id, id));
    if (!existing) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    if (existing.orderSource !== "staff") {
      res.status(400).json({ error: "Only staff (POS) orders accept plating" });
      return;
    }
    if (existing.voidedAt) {
      res.status(409).json({ error: "Order has been voided" });
      return;
    }
    if (existing.paymentStatus !== "unpaid") {
      res.status(409).json({ error: "Plating is locked — order has already been sent to the kitchen" });
      return;
    }
    const settings = await getSettings();
    const activeId = settings?.activeEventSessionId ?? null;
    if (activeId != null && existing.eventSessionId !== activeId) {
      res.status(409).json({ error: "Order belongs to a different event session" });
      return;
    }
    const cartItems = (existing.items ?? []).map(i => ({
      itemId: i.itemId, name: i.name, quantity: i.quantity,
    }));
    const cleaned = validateAndCleanPlateGroups(body.plateGroups ?? null, cartItems);
    // Atomic guarded update: re-assert "staff" + "unpaid" in the WHERE clause so
    // a concurrent payment/override can't slip past our earlier read-check.
    const [updated] = await db
      .update(eventOrdersTable)
      .set({ plateGroups: cleaned })
      .where(and(
        eq(eventOrdersTable.id, id),
        eq(eventOrdersTable.orderSource, "staff"),
        eq(eventOrdersTable.paymentStatus, "unpaid"),
      ))
      .returning();
    if (!updated) {
      // Re-read to disambiguate: missing row vs lock fired between read and update.
      const [after] = await db.select().from(eventOrdersTable).where(eq(eventOrdersTable.id, id));
      if (!after) {
        res.status(404).json({ error: "Order not found" });
        return;
      }
      res.status(409).json({ error: "Plating is locked — order has already been sent to the kitchen" });
      return;
    }
    res.json(serializeOrder(updated));
  } catch (err: any) {
    if (err?.status === 400) {
      res.status(400).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "Error updating plate groups");
    res.status(500).json({ error: "Failed to update plating" });
  }
});

// ── Pending payments queue ─────────────────────────────────────────────
// Returns staff orders awaiting payment (held off the kitchen feed).
router.get("/event-taker/orders/pending", verifyTakerPassword, async (req, res) => {
  try {
    // Scope to the active event session so stale unpaid orders from prior
    // events don't leak into the current POS queue.
    const settings = await getSettings();
    const activeId = settings?.activeEventSessionId ?? null;
    // Include both 'unpaid' (parked off the kitchen) and 'override' (already
    // fired to the kitchen but still owed) so staff can come back later and
    // record real payment on either. Override rows are tagged in the UI so
    // they're visually distinct from parked tabs.
    const conditions = [
      eq(eventOrdersTable.orderSource, "staff"),
      inArray(eventOrdersTable.paymentStatus, ["unpaid", "override"]),
      // Voided orders stay in the database for reconciliation but should
      // not surface in any active queue.
      sql`${eventOrdersTable.voidedAt} IS NULL`,
    ];
    if (activeId != null) conditions.push(eq(eventOrdersTable.eventSessionId, activeId));
    const rows = await db
      .select()
      .from(eventOrdersTable)
      .where(and(...conditions))
      .orderBy(desc(eventOrdersTable.createdAt));
    res.json(rows.map(serializeOrder));
  } catch (err) {
    req.log.error({ err }, "Error listing pending payments");
    res.status(500).json({ error: "Failed to load pending payments" });
  }
});

// Confirm payment for a previously-created unpaid order.
// On success: marks paid, fires SMS confirmation (if phone present),
// and returns the updated order so the POS can print/receipt it.
router.patch("/event-taker/orders/:id/payment", verifyTakerPassword, async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }
    const { method, cashReceived, statusUrlBase } = req.body as {
      method?: "cash" | "card" | "venmo";
      cashReceived?: number | string | null;
      statusUrlBase?: string;
    };
    if (method !== "cash" && method !== "card" && method !== "venmo") {
      res.status(400).json({ error: "Invalid payment method" });
      return;
    }

    const [existing] = await db.select().from(eventOrdersTable).where(eq(eventOrdersTable.id, id));
    if (!existing) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    // Refuse to mutate orders from a different (older) event session — keeps
    // POS actions consistent with the session-scoped pending queue.
    const settings = await getSettings();
    const activeId = settings?.activeEventSessionId ?? null;
    if (activeId != null && existing.eventSessionId !== activeId) {
      res.status(409).json({ error: "Order belongs to a different event session" });
      return;
    }
    if (existing.orderSource !== "staff") {
      res.status(400).json({ error: "Only staff (POS) orders accept payment recording" });
      return;
    }
    if (existing.voidedAt) {
      res.status(409).json({ error: "Order has been voided" });
      return;
    }
    if (existing.paymentStatus === "paid") {
      // Idempotent — already recorded; just return current state. We
      // surface wasOverride: false here because any auto-print should
      // already have happened the first time payment was recorded; the
      // client shouldn't reprint from this idempotent reply.
      res.json({ ...serializeOrder(existing), wasOverride: false });
      return;
    }
    if (existing.paymentStatus !== "unpaid" && existing.paymentStatus !== "override") {
      res.status(409).json({ error: "Order is not awaiting payment" });
      return;
    }

    const total = existing.total != null ? parseFloat(existing.total) : 0;
    const updates: Record<string, unknown> = {
      paymentStatus: "paid",
      paymentMethod: method,
      paymentRecordedAt: new Date(),
      cashReceived: null,
      changeDue: null,
      // Preserve paymentOverrideReason when transitioning override→paid so the
      // audit trail of why the order was fired unpaid stays on the row.
      // Clear stored crossings — we fire the SMS below and don't want a retry.
      pendingLowStockCrossings: null,
    };

    if (method === "cash") {
      const received = Number(cashReceived);
      if (!Number.isFinite(received)) {
        res.status(400).json({ error: "cashReceived is required for cash payments" });
        return;
      }
      if (received < total) {
        res.status(400).json({ error: `Cash received ($${received.toFixed(2)}) is less than total ($${total.toFixed(2)})` });
        return;
      }
      const change = Math.round((received - total) * 100) / 100;
      updates.cashReceived = String(received.toFixed(2));
      updates.changeDue = String(change.toFixed(2));
    }

    // Race-safe two-phase atomic transition. We try 'unpaid' → 'paid' first,
    // and only if that fails fall back to 'override' → 'paid'. Whichever
    // WHERE clause actually matched tells us the *true* prior status at the
    // moment of the write, with no read-then-update window. We use this to
    // decide whether SMS should fire (override orders already SMS'd at
    // override time, so we must not double-text).
    let updated = (await db
      .update(eventOrdersTable)
      .set(updates)
      .where(and(
        eq(eventOrdersTable.id, id),
        eq(eventOrdersTable.orderSource, "staff"),
        eq(eventOrdersTable.paymentStatus, "unpaid"),
        isNull(eventOrdersTable.voidedAt),
      ))
      .returning())[0];
    let wasOverride = false;
    if (!updated) {
      const overrideRows = await db
        .update(eventOrdersTable)
        .set(updates)
        .where(and(
          eq(eventOrdersTable.id, id),
          eq(eventOrdersTable.orderSource, "staff"),
          eq(eventOrdersTable.paymentStatus, "override"),
          isNull(eventOrdersTable.voidedAt),
        ))
        .returning();
      updated = overrideRows[0];
      if (updated) wasOverride = true;
    }
    if (!updated) {
      // Lost the race. If the row still exists and is already finalized,
      // return it idempotently (no extra SMS). If it's gone (e.g. canceled
      // concurrently), surface a 409 so the client doesn't print a receipt.
      const [current] = await db.select().from(eventOrdersTable).where(eq(eventOrdersTable.id, id));
      if (!current) {
        res.status(409).json({ error: "Order no longer exists (was it canceled?)" });
        return;
      }
      res.json({ ...serializeOrder(current), wasOverride: false });
      return;
    }

    // Fire SMS confirmation now that payment is recorded — same shape as the
    // original POST flow, but only after the customer has actually paid. When
    // the order was already in override state the SMS already fired at the
    // time of override, so we don't re-send and double-text the customer.
    if (updated.phoneNumber && !wasOverride) {
      const settings = await getSettings();
      const orderStatusUrl = statusUrlBase
        ? `${statusUrlBase}/event/order/${updated.id}`
        : `${req.protocol}://${req.get("host")}/event/order/${updated.id}`;
      sendOrderConfirmation({
        guestName: updated.guestName,
        orderId: updated.id,
        phoneNumber: updated.phoneNumber,
        eventName: settings?.eventName ?? "",
        orderStatusUrl,
      }).catch(() => {});
    }

    // Fan-out to network printers on payment confirmation.
    // Only fires for the unpaid→paid path (wasOverride === false) because
    // the override route already fired the kitchen ticket at override time.
    // For override→paid the receipt is handled by the manual print button
    // on the confirmation screen, avoiding a double kitchen-ticket print.
    if (!wasOverride) {
      fanoutPrintForEventOrder({ order: updated, source: "event_taker" }).catch((err) => {
        req.log.error({ err, orderId: updated.id }, "print fan-out failed (payment)");
      });
    }

    // Fire low-stock SMS now that payment is confirmed. The crossings were
    // detected and the lowStockAlertSent flag was set atomically at order
    // creation; we only deferred the SMS until here so that a Terminal charge
    // that later fails (and whose stock gets restored on void) doesn't produce
    // a phantom alert. For override→paid the SMS already fired at override
    // time, so pendingLowStockCrossings will be null on existing here.
    // Read from `existing` (pre-update snapshot) because the UPDATE set the
    // column to null — updated.pendingLowStockCrossings is always null.
    const pendingCrossings = existing.pendingLowStockCrossings;
    if (pendingCrossings && pendingCrossings.length > 0) {
      fireLowStockAlertIfAny(req, pendingCrossings, {
        phones: settings?.lowStockAlertPhones ?? [],
        eventName: settings?.eventName ?? "",
        threshold: settings?.lowStockAlertThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD,
      });
    }

    // Surface wasOverride so the client can suppress kitchen-ticket
    // auto-print on override→paid transitions (kitchen already got the
    // ticket when the order was overridden).
    res.json({ ...serializeOrder(updated), wasOverride });
  } catch (err) {
    req.log.error({ err }, "Error recording payment");
    res.status(500).json({ error: "Failed to record payment" });
  }
});

// Override — send an unpaid order to the kitchen anyway.
router.patch("/event-taker/orders/:id/override", verifyTakerPassword, async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }
    const { reason, statusUrlBase } = req.body as { reason?: string; statusUrlBase?: string };

    const [existing] = await db.select().from(eventOrdersTable).where(eq(eventOrdersTable.id, id));
    if (!existing) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    const settings = await getSettings();
    const activeId = settings?.activeEventSessionId ?? null;
    if (activeId != null && existing.eventSessionId !== activeId) {
      res.status(409).json({ error: "Order belongs to a different event session" });
      return;
    }
    if (existing.orderSource !== "staff") {
      res.status(400).json({ error: "Only staff (POS) orders can be overridden" });
      return;
    }
    if (existing.voidedAt) {
      res.status(409).json({ error: "Order has been voided" });
      return;
    }
    if (existing.paymentStatus !== "unpaid") {
      res.json(serializeOrder(existing));
      return;
    }

    // Atomic transition (see /payment for rationale): only flip 'unpaid' →
    // 'override'. If the row was already finalized by another device, return
    // the current state without re-sending SMS.
    const updatedRows = await db
      .update(eventOrdersTable)
      .set({
        paymentStatus: "override",
        paymentMethod: null,
        paymentRecordedAt: new Date(),
        paymentOverrideReason: reason?.trim() ? reason.trim().slice(0, 500) : null,
        // Clear stored crossings — we fire the SMS below and don't want a retry
        // if the order later transitions override→paid.
        pendingLowStockCrossings: null,
      })
      .where(and(
        eq(eventOrdersTable.id, id),
        eq(eventOrdersTable.orderSource, "staff"),
        eq(eventOrdersTable.paymentStatus, "unpaid"),
        isNull(eventOrdersTable.voidedAt),
      ))
      .returning();
    if (updatedRows.length === 0) {
      const [current] = await db.select().from(eventOrdersTable).where(eq(eventOrdersTable.id, id));
      if (!current) {
        res.status(409).json({ error: "Order no longer exists (was it canceled?)" });
        return;
      }
      res.json(serializeOrder(current));
      return;
    }
    const updated = updatedRows[0];

    const overrideSettings = await getSettings();
    if (updated.phoneNumber) {
      const orderStatusUrl = statusUrlBase
        ? `${statusUrlBase}/event/order/${updated.id}`
        : `${req.protocol}://${req.get("host")}/event/order/${updated.id}`;
      sendOrderConfirmation({
        guestName: updated.guestName,
        orderId: updated.id,
        phoneNumber: updated.phoneNumber,
        eventName: overrideSettings?.eventName ?? "",
        orderStatusUrl,
      }).catch(() => {});
    }

    // Fire low-stock SMS now that the order is being sent to the kitchen.
    // The order is confirmed even though payment comes later, so this is the
    // right moment. Read from `existing` (pre-update snapshot) because the
    // UPDATE set pendingLowStockCrossings to null — updated has null there.
    const overrideCrossings = existing.pendingLowStockCrossings;
    if (overrideCrossings && overrideCrossings.length > 0) {
      fireLowStockAlertIfAny(req, overrideCrossings, {
        phones: overrideSettings?.lowStockAlertPhones ?? [],
        eventName: overrideSettings?.eventName ?? "",
        threshold: overrideSettings?.lowStockAlertThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD,
      });
    }

    // Fan-out to network printers now that the order is being sent to the
    // kitchen. This is the correct trigger point for override orders — the
    // kitchen should only receive the ticket once the cashier has explicitly
    // decided to send it, not at order creation time.
    fanoutPrintForEventOrder({ order: updated, source: "event_taker" }).catch((err) => {
      req.log.error({ err, orderId: updated.id }, "print fan-out failed (override)");
    });

    res.json(serializeOrder(updated));
  } catch (err) {
    req.log.error({ err }, "Error overriding payment gate");
    res.status(500).json({ error: "Failed to override payment" });
  }
});

// Cancel an unpaid order — restores stock and removes from queue.
// Refuses to cancel orders that are already paid or have been overridden
// to the kitchen, since those are no longer "pending".
router.delete("/event-taker/orders/:id", verifyTakerPassword, async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }

    const settings = await getSettings();
    const activeId = settings?.activeEventSessionId ?? null;
    await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(eventOrdersTable).where(eq(eventOrdersTable.id, id)).for("update");
      if (!existing) throw Object.assign(new Error("Order not found"), { status: 404 });
      if (activeId != null && existing.eventSessionId !== activeId) {
        throw Object.assign(new Error("Order belongs to a different event session"), { status: 409 });
      }
      if (existing.orderSource !== "staff") {
        throw Object.assign(new Error("Only staff orders can be cancelled here"), { status: 400 });
      }
      if (existing.paymentStatus !== "unpaid") {
        throw Object.assign(new Error("Order has already been sent to the kitchen and cannot be cancelled here"), { status: 409 });
      }

      // Restore stock for items that have a stock cap.
      const items = (existing.items ?? []) as { itemId: number; quantity: number; comboSelections?: Array<{ menuItemId: number; quantity: number }> }[];
      const itemIds = items.map(i => i.itemId);
      // Threshold for re-arming the low-stock SMS once stock climbs back up.
      const [s] = await tx.select({ t: eventSettingsTable.lowStockAlertThreshold }).from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
      const threshold = s?.t ?? DEFAULT_LOW_STOCK_THRESHOLD;
      if (itemIds.length > 0) {
        const rows = await tx
          .select({ id: menuItemsTable.id, eventStock: menuItemsTable.eventStock })
          .from(menuItemsTable)
          .where(inArray(menuItemsTable.id, itemIds))
          .for("update");
        const stockMap = new Map(rows.map(r => [r.id, r.eventStock]));
        for (const line of items) {
          const prev = stockMap.get(line.itemId);
          if (prev !== null && prev !== undefined) {
            await tx
              .update(menuItemsTable)
              .set({ eventStock: sql`event_stock + ${line.quantity}` })
              .where(eq(menuItemsTable.id, line.itemId));
            // Re-arm the low-stock alert if the restored stock now exceeds
            // the threshold (so a future dip will alert again).
            const restored = prev + line.quantity;
            if (restored > threshold) {
              await tx
                .update(menuItemsTable)
                .set({ lowStockAlertSent: false })
                .where(eq(menuItemsTable.id, line.itemId));
            }
          }
        }
      }

      // Restore component stock for any combo items in the cancelled order.
      // Reconstruct the component quantities from the stored comboSelections
      // snapshot, mirroring the deduction logic in the order-creation path.
      const componentRestoreMap = new Map<number, number>();
      for (const line of items) {
        if (Array.isArray(line.comboSelections) && line.comboSelections.length > 0) {
          for (const sel of line.comboSelections) {
            componentRestoreMap.set(
              sel.menuItemId,
              (componentRestoreMap.get(sel.menuItemId) ?? 0) + sel.quantity * line.quantity,
            );
          }
        }
      }
      if (componentRestoreMap.size > 0) {
        const compIds = Array.from(componentRestoreMap.keys());
        const compRows = await tx
          .select({ id: menuItemsTable.id, eventStock: menuItemsTable.eventStock })
          .from(menuItemsTable)
          .where(inArray(menuItemsTable.id, compIds))
          .for("update");
        const compStockMap = new Map(compRows.map(r => [r.id, r.eventStock]));
        for (const [compItemId, qtyToRestore] of componentRestoreMap) {
          const prev = compStockMap.get(compItemId);
          if (prev === null || prev === undefined) continue; // no stock tracking — skip
          await tx
            .update(menuItemsTable)
            .set({ eventStock: sql`event_stock + ${qtyToRestore}` })
            .where(eq(menuItemsTable.id, compItemId));
          const restored = prev + qtyToRestore;
          if (restored > threshold) {
            await tx
              .update(menuItemsTable)
              .set({ lowStockAlertSent: false })
              .where(eq(menuItemsTable.id, compItemId));
          }
        }
      }

      await tx.delete(eventOrdersTable).where(eq(eventOrdersTable.id, id));
    });

    res.json({ ok: true });
  } catch (err: any) {
    if (err?.status === 404 || err?.status === 400 || err?.status === 409) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "Error cancelling unpaid order");
    res.status(500).json({ error: "Failed to cancel order" });
  }
});

// ── Active kitchen orders (for the Sent-orders / void panel) ──────────
// Returns staff orders that are currently sitting on the kitchen display:
// paid or override (the kitchen has actually seen them), status in the
// active set (pending / preparing / ready), not yet voided, scoped to
// the active event session. The Cashier-side "Sent orders" panel uses
// this to surface orders that need to be voided after they were fired.
router.get("/event-taker/orders/active", verifyTakerPassword, async (req, res) => {
  try {
    const settings = await getSettings();
    const activeId = settings?.activeEventSessionId ?? null;
    const conditions = [
      eq(eventOrdersTable.orderSource, "staff"),
      inArray(eventOrdersTable.paymentStatus, ["paid", "override"]),
      inArray(eventOrdersTable.status, ["pending", "preparing", "ready"]),
      sql`${eventOrdersTable.voidedAt} IS NULL`,
    ];
    if (activeId != null) conditions.push(eq(eventOrdersTable.eventSessionId, activeId));
    const rows = await db
      .select()
      .from(eventOrdersTable)
      .where(and(...conditions))
      .orderBy(desc(eventOrdersTable.createdAt));
    res.json(rows.map(serializeOrder));
  } catch (err) {
    req.log.error({ err }, "Error listing active orders");
    res.status(500).json({ error: "Failed to load active orders" });
  }
});

// Recent voids in the active event session — used by the cashier-side
// Sent Orders panel so the staff can see who voided what without leaving
// the register. Capped to a small recent window so the payload stays
// small; the admin Sales Report is the source of truth for the full list.
router.get("/event-taker/orders/recent-voids", verifyTakerPassword, async (req, res) => {
  try {
    const settings = await getSettings();
    const activeId = settings?.activeEventSessionId ?? null;
    const conditions = [
      eq(eventOrdersTable.orderSource, "staff"),
      sql`${eventOrdersTable.voidedAt} IS NOT NULL`,
    ];
    if (activeId != null) conditions.push(eq(eventOrdersTable.eventSessionId, activeId));
    const rows = await db
      .select()
      .from(eventOrdersTable)
      .where(and(...conditions))
      .orderBy(desc(eventOrdersTable.voidedAt))
      .limit(20);
    res.json(rows.map(serializeOrder));
  } catch (err) {
    req.log.error({ err }, "Error listing recent voids");
    res.status(500).json({ error: "Failed to load recent voids" });
  }
});

// Soft-void a staff order that has already been sent to the kitchen.
// Mirrors the gating of the existing Cancel DELETE (which hard-deletes
// pure unpaid orders) but for orders the kitchen has actually seen —
// override (sent unpaid) or paid. Sets `voidedAt`, captures the staff
// reason, and (for paid orders only) flags `refundRequired` so the
// cashier knows they must process a manual refund. Stock is intentionally
// NOT restored — by the time the kitchen has the ticket, the line items
// have been consumed and adding stock back would over-count availability.
router.post("/event-taker/orders/:id/reprint", verifyTakerPassword, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid order id" });
    return;
  }
  const kind = (req.body ?? {}).kind as string | undefined;
  if (kind !== "kitchen_ticket" && kind !== "customer_receipt") {
    res.status(400).json({ error: "kind must be kitchen_ticket or customer_receipt" });
    return;
  }
  try {
    const [order] = await db.select().from(eventOrdersTable).where(eq(eventOrdersTable.id, id));
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    const enqueued = await fanoutPrintForEventOrder({
      order,
      source: "event_taker",
      kindFilter: kind,
      manual: true,
    });
    res.json({ enqueued });
  } catch (err) {
    req.log.error({ err, orderId: id, kind }, "event-taker reprint failed");
    res.status(500).json({ error: "Reprint failed" });
  }
});

router.post("/event-taker/orders/:id/void", verifyTakerPassword, async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }
    const reasonRaw = (req.body ?? {}).reason;
    const reason = typeof reasonRaw === "string" ? reasonRaw.trim() : "";
    if (!reason) {
      res.status(400).json({ error: "A reason is required to void an order" });
      return;
    }
    // Self-reported employee name from the per-device localStorage prompt.
    // Required so the Sales Report can attribute the void to a specific
    // cashier — the POS uses a single shared password so we have no other
    // way to identify who pulled the ticket back.
    const voidedByRaw = (req.body ?? {}).voidedBy;
    const voidedBy = typeof voidedByRaw === "string" ? voidedByRaw.trim() : "";
    if (!voidedBy) {
      res.status(400).json({ error: "Employee name is required to void an order" });
      return;
    }
    if (voidedBy.length > 80) {
      res.status(400).json({ error: "Employee name is too long (max 80 characters)" });
      return;
    }
    const settings = await getSettings();
    const activeId = settings?.activeEventSessionId ?? null;
    const updated = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(eventOrdersTable)
        .where(eq(eventOrdersTable.id, id))
        .for("update");
      if (!existing) throw Object.assign(new Error("Order not found"), { status: 404 });
      if (activeId != null && existing.eventSessionId !== activeId) {
        throw Object.assign(new Error("Order belongs to a different event session"), { status: 409 });
      }
      if (existing.orderSource !== "staff") {
        throw Object.assign(new Error("Only staff orders can be voided here"), { status: 400 });
      }
      if (existing.voidedAt) {
        throw Object.assign(new Error("Order is already voided"), { status: 409 });
      }
      if (existing.paymentStatus === "unpaid") {
        // Pure unpaid tabs use the existing Cancel path which hard-deletes
        // and replenishes stock — the kitchen never saw the order.
        throw Object.assign(
          new Error("Use Cancel to remove an unpaid order before it has been sent to the kitchen"),
          { status: 409 },
        );
      }
      if (existing.status === "done" || existing.status === "picked_up") {
        throw Object.assign(new Error("Completed orders cannot be voided here"), { status: 409 });
      }
      // Refund is owed only when money actually changed hands. Override
      // orders haven't collected payment yet, so no manual-refund flag.
      const refundRequired = existing.paymentStatus === "paid" && existing.paymentMethod != null;
      const [row] = await tx
        .update(eventOrdersTable)
        .set({
          voidedAt: new Date(),
          voidReason: reason,
          voidedBy,
          refundRequired,
        })
        .where(eq(eventOrdersTable.id, id))
        .returning();
      return row;
    });
    res.json(serializeOrder(updated));
  } catch (err: any) {
    if (err?.status === 404 || err?.status === 400 || err?.status === 409) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "Error voiding order");
    res.status(500).json({ error: "Failed to void order" });
  }
});

// ── Square Terminal checkout routes ─────────────────────────────────────────
// All three routes are gated by verifyTakerPassword. The device ID comes from
// event_settings so the frontend never needs to know it directly.

router.post("/event-taker/terminal-checkout", verifyTakerPassword, async (req, res): Promise<void> => {
  try {
    const { orderId } = req.body as { orderId?: unknown };
    if (typeof orderId !== "number" || !Number.isInteger(orderId) || orderId <= 0) {
      res.status(400).json({ error: "orderId is required and must be a positive integer" });
      return;
    }
    const settings = await getSettings();
    const deviceId = settings?.squareTerminalDeviceId?.trim();
    if (!deviceId) {
      res.status(424).json({ error: "No Square Terminal device configured. Set a Device ID in Admin → Event Settings." });
      return;
    }
    if (!getTerminalSquareConfig()) {
      res.status(424).json({ error: "Square Terminal is not configured. Set SQUARE_TERMINAL_ACCESS_TOKEN on the server." });
      return;
    }

    const [order] = await db.select().from(eventOrdersTable).where(eq(eventOrdersTable.id, orderId));
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    const total = order.total != null ? parseFloat(order.total) : 0;
    if (total <= 0) {
      res.status(400).json({ error: "Order total must be greater than $0 to charge via Terminal" });
      return;
    }
    const amountCents = Math.round(total * 100);

    const { checkoutId } = await createTerminalCheckout({
      deviceId,
      amountCents,
      referenceId: `order-${orderId}`,
      idempotencyKey: `taker-checkout-${orderId}-${randomUUID()}`,
    });

    req.log.info({ orderId, checkoutId, amountCents }, "[terminal] checkout created");
    res.json({ checkoutId });
  } catch (err) {
    if (err instanceof SquareApiError) {
      const firstCode = err.errors[0]?.code;
      if (firstCode === "TERMINAL_CHECKOUT_ALREADY_QUEUED" || err.status === 409) {
        res.status(409).json({ error: "The terminal already has an active request. Complete or cancel it first." });
        return;
      }
      // Surface the actual Square diagnostic detail (from errors[].detail/code)
      // so admins can diagnose device mismatches, auth failures, etc. instead
      // of seeing a generic 500. Log the transport message for traceability.
      req.log.error({ err }, "[terminal] create checkout failed");
      res.status(502).json({ error: `Square Terminal error: ${err.userMessage}` });
      return;
    }
    req.log.error({ err }, "[terminal] create checkout failed");
    res.status(500).json({ error: "Failed to create Terminal checkout" });
  }
});

router.get("/event-taker/terminal-checkout/:checkoutId", verifyTakerPassword, async (req, res): Promise<void> => {
  try {
    if (!getTerminalSquareConfig()) {
      res.status(424).json({ error: "Square Terminal is not configured" });
      return;
    }
    const checkoutId = String(req.params.checkoutId);
    const { status } = await getTerminalCheckout(checkoutId);
    res.json({ checkoutId, status });
  } catch (err) {
    if (err instanceof SquareApiError && err.status === 404) {
      res.status(404).json({ error: "Checkout not found" });
      return;
    }
    req.log.error({ err }, "[terminal] get checkout failed");
    res.status(500).json({ error: "Failed to fetch Terminal checkout status" });
  }
});

router.post("/event-taker/terminal-checkout/:checkoutId/cancel", verifyTakerPassword, async (req, res): Promise<void> => {
  try {
    if (!getTerminalSquareConfig()) {
      res.status(424).json({ error: "Square Terminal is not configured" });
      return;
    }
    const checkoutId = String(req.params.checkoutId);
    await cancelTerminalCheckout(checkoutId);
    req.log.info({ checkoutId }, "[terminal] checkout cancelled");
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof SquareApiError && err.status === 400) {
      // Already completed or canceled — treat as success so the UI can recover.
      res.json({ ok: true });
      return;
    }
    req.log.error({ err }, "[terminal] cancel checkout failed");
    res.status(500).json({ error: "Failed to cancel Terminal checkout" });
  }
});

export default router;
