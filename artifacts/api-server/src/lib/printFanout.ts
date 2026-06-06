import { db } from "@workspace/db";
import { menuItemsTable, eventOrdersTable } from "@workspace/db/schema";
import type { EventOrderItem } from "@workspace/db/schema";
import { inArray, eq } from "drizzle-orm";
import { logger } from "./logger";
import {
  enqueuePrintJob,
  selectPrintersFor,
} from "./printQueue";
import type {
  KitchenTicketPayload,
  CustomerReceiptPayload,
  ItemLabelPayload,
  ComboLabelPayload,
  PlateLabelPayload,
  OrderLine,
} from "./printRenderer";
import { expandItemLabels, expandAllItemLabels, type LabelLineInput, type LabelPolicy } from "./labelExpand";

type EventOrderRow = typeof eventOrdersTable.$inferSelect;

export type FanoutSource =
  | "event_order"     // guest /event submission
  | "event_taker"     // staff POS submission
  | "kitchen_send"    // explicit kitchen "send to printer"
  | "demo";           // demo flow — never prints

/**
 * Per-surface allowed-kind matrix. Each surface may only enqueue jobs of
 * its allowed kinds — even if a printer is configured to accept a kind
 * that isn't on this list. Admin/manual paths use `kitchen_send`.
 *
 * Staff Order Taker:    kitchen ticket + customer receipt + item/plate labels
 * Guest Event Ordering: kitchen ticket + item/plate labels
 * Kitchen (manual):     kitchen ticket + item/plate labels
 * Demo:                 nothing (hard-blocked above)
 */
type JobKind = "kitchen_ticket" | "customer_receipt" | "item_label" | "plate_label";
const ALLOWED_KINDS_BY_SOURCE: Record<FanoutSource, ReadonlySet<JobKind>> = {
  event_taker: new Set<JobKind>(["kitchen_ticket", "customer_receipt", "item_label", "plate_label"]),
  event_order: new Set<JobKind>(["kitchen_ticket", "item_label", "plate_label"]),
  kitchen_send: new Set<JobKind>(["kitchen_ticket", "item_label", "plate_label"]),
  demo: new Set<JobKind>(),
};

/**
 * Fan an event-order out to all enabled printers per their toggles.
 *
 * Demo orders are hard-blocked at the door (logged + early-return), so
 * even an accidental call from a demo path can't enqueue a job.
 *
 * Returns the number of jobs enqueued. The caller doesn't need to await
 * delivery — lan_browser printers are served by the browser-based print agent.
 */
export async function fanoutPrintForEventOrder(args: {
  order: EventOrderRow;
  source: FanoutSource;
  /** When set, only enqueue jobs of this kind (used by manual per-kind reprint buttons). */
  kindFilter?: "kitchen_ticket" | "customer_receipt";
  /** When true, treat as a manual reprint — ignores auto_print_on_new_order toggle. */
  manual?: boolean;
}): Promise<number> {
  const { order, source, kindFilter, manual = false } = args;

  if (source === "demo") {
    logger.warn(
      { orderId: order.id },
      "[print-fanout] demo source blocked — no jobs enqueued"
    );
    return 0;
  }

  // Manual reprint paths (from the kitchen/admin UI) ignore the
  // `auto_print_on_new_order` toggle — staff have already opted in by
  // pressing the button. Auto fan-out from order submission still
  // respects the toggle so quiet hours / event-only printers stay quiet.
  const selectMode: "auto" | "manual" = (source === "kitchen_send" || manual) ? "manual" : "auto";

  // Per-surface allowed-kind matrix. A surface that isn't authorized
  // for a kind cannot enqueue it, even if a printer would accept it.
  const allowed = ALLOWED_KINDS_BY_SOURCE[source];

  const itemIds = (order.items ?? []).map((i) => i.itemId);
  if (itemIds.length === 0) return 0;

  // Pull label policy + display info + combo flags for the items in this order.
  const menuRows = await db
    .select({
      id: menuItemsTable.id,
      labelPolicy: menuItemsTable.labelPolicy,
      labelBoxSize: menuItemsTable.labelBoxSize,
      isCombo: menuItemsTable.isCombo,
      comboComponentLabels: menuItemsTable.comboComponentLabels,
    })
    .from(menuItemsTable)
    .where(inArray(menuItemsTable.id, itemIds));

  type MenuPolicy = {
    policy: LabelPolicy;
    boxSize: number | null;
    isCombo: boolean;
    comboComponentLabels: boolean;
  };
  const policyById = new Map<number, MenuPolicy>();
  for (const r of menuRows) {
    policyById.set(r.id, {
      policy: (r.labelPolicy as LabelPolicy) ?? "per_unit",
      boxSize: r.labelBoxSize ?? null,
      isCombo: r.isCombo ?? false,
      comboComponentLabels: r.comboComponentLabels ?? false,
    });
  }

  // Collect component item IDs from combo selections so we can fetch their
  // label policies for component label fan-out.
  const componentItemIds = new Set<number>();
  for (const it of order.items as EventOrderItem[]) {
    if (it.comboSelections) {
      for (const sel of it.comboSelections) {
        componentItemIds.add(sel.menuItemId);
      }
    }
  }
  const componentPolicyById = new Map<number, { policy: LabelPolicy; boxSize: number | null }>();
  if (componentItemIds.size > 0) {
    const compRows = await db
      .select({
        id: menuItemsTable.id,
        labelPolicy: menuItemsTable.labelPolicy,
        labelBoxSize: menuItemsTable.labelBoxSize,
      })
      .from(menuItemsTable)
      .where(inArray(menuItemsTable.id, Array.from(componentItemIds)));
    for (const r of compRows) {
      componentPolicyById.set(r.id, {
        policy: (r.labelPolicy as LabelPolicy) ?? "per_unit",
        boxSize: r.labelBoxSize ?? null,
      });
    }
  }

  const placedAt = (order.createdAt ?? new Date()).toISOString();
  const orderNumber = String(order.id);
  const guestName = order.guestName;
  const tableNumber = order.tableNumber ?? null;
  const orderLines: OrderLine[] = (order.items as EventOrderItem[]).map((it) => ({
    name: it.name,
    quantity: it.quantity,
    unitPrice: it.price,
    comboSelections: it.comboSelections,
  }));

  // ── Kitchen ticket ─────────────────────────────────────────────────────
  let enqueued = 0;
  const kitchenPrinters = allowed.has("kitchen_ticket") && (!kindFilter || kindFilter === "kitchen_ticket")
    ? await selectPrintersFor("kitchen_ticket", selectMode)
    : [];
  if (kitchenPrinters.length > 0) {
    const payload: KitchenTicketPayload = {
      type: "kitchen_ticket",
      header: {
        orderNumber,
        guestName,
        tableNumber,
        source: source === "event_taker" || source === "kitchen_send" ? "event_taker" : "event_ordering",
        placedAt,
        notes: order.notes ?? null,
      },
      lines: (order.items as EventOrderItem[]).map((it) => ({
        name: it.name,
        quantity: it.quantity,
        comboSelections: it.comboSelections,
      })),
    };
    for (const p of kitchenPrinters) {
      await enqueuePrintJob({
        printerId: p.id,
        jobType: "kitchen_ticket",
        payload: payload as unknown as Record<string, unknown>,
        orderSource: "event_order",
        orderId: order.id,
      });
      enqueued++;
    }
  }

  // ── Customer receipt (only when totals are present, i.e. staff orders) ─
  const receiptPrinters = allowed.has("customer_receipt") && (!kindFilter || kindFilter === "customer_receipt")
    ? await selectPrintersFor("customer_receipt", selectMode)
    : [];
  if (receiptPrinters.length > 0 && order.subtotal != null && order.total != null) {
    const payload: CustomerReceiptPayload = {
      type: "customer_receipt",
      header: {
        orderNumber,
        guestName,
        tableNumber,
        source: "event_taker",
        placedAt,
      },
      lines: orderLines,
      subtotal: parseFloat(String(order.subtotal)),
      tax: order.taxAmount != null ? parseFloat(String(order.taxAmount)) : 0,
      total: parseFloat(String(order.total)),
      businessName: "dash by Hollywood East Cafe",
      footer: "Thank you!",
    };
    for (const p of receiptPrinters) {
      await enqueuePrintJob({
        printerId: p.id,
        jobType: "customer_receipt",
        payload: payload as unknown as Record<string, unknown>,
        orderSource: "event_order",
        orderId: order.id,
      });
      enqueued++;
    }
  }

  // ── Item labels / combo labels (per_unit / combined / per_box) ──────────
  // Plate labels piggyback on item-label printers + the same allowed-kind
  // gate, so we treat them as a single conceptual kind here.
  const labelPrinters = (allowed.has("item_label") || allowed.has("plate_label")) && !kindFilter
    ? await selectPrintersFor("item_label", selectMode)
    : [];
  if (labelPrinters.length > 0) {
    // Compute the set of item-quantities that are part of a plate. Those
    // get a single plate-label per plate group; we subtract them from
    // per-item label expansion when the printer asks us to.
    const plateQtyByItem = new Map<number, number>();
    for (const plate of order.plateGroups ?? []) {
      for (const pi of plate.items) {
        plateQtyByItem.set(pi.itemId, (plateQtyByItem.get(pi.itemId) ?? 0) + pi.quantity);
      }
    }

    for (const printer of labelPrinters) {
      // Split items into regular vs. combo for separate handling.
      const regularLines: LabelLineInput[] = [];
      const comboItems: EventOrderItem[] = [];

      for (const it of order.items as EventOrderItem[]) {
        const policy = policyById.get(it.itemId);
        const isComboItem = policy?.isCombo ?? false;

        if (isComboItem) {
          comboItems.push(it);
        } else {
          // Regular item — existing per-unit / combined / per_box expansion.
          const plateQty = plateQtyByItem.get(it.itemId) ?? 0;
          const qty = printer.suppressItemLabelsForPlateLines
            ? Math.max(0, it.quantity - plateQty)
            : it.quantity;
          if (qty > 0) {
            regularLines.push({
              itemId: it.itemId,
              itemName: it.name,
              quantity: qty,
              labelPolicy: policy?.policy ?? "per_unit",
              labelBoxSize: policy?.boxSize ?? null,
            });
          }
        }
      }

      // ── Regular item labels ─────────────────────────────────────────
      if (regularLines.length > 0) {
        for (const line of regularLines) {
          const lineExpanded = expandItemLabels(line).length;
          logger.info(
            {
              orderId: order.id,
              printerId: printer.id,
              itemId: line.itemId,
              policy: line.labelPolicy,
              boxSize: line.labelBoxSize,
              qty: line.quantity,
              expanded: lineExpanded,
            },
            "[print-fanout] item-label expansion"
          );
        }
        const expanded = expandAllItemLabels(regularLines);
        for (let i = 0; i < expanded.length; i++) {
          const lbl = expanded[i];
          const payload: ItemLabelPayload = {
            type: "item_label",
            orderNumber,
            guestName,
            itemName: lbl.itemName,
            quantity: lbl.quantity,
            notes: lbl.notes ?? null,
            modifiers: lbl.modifiers,
            isFullBox: lbl.isFullBox,
            placedAt,
            labelIndex: i + 1,
            labelTotal: expanded.length,
          };
          await enqueuePrintJob({
            printerId: printer.id,
            jobType: "item_label",
            payload: payload as unknown as Record<string, unknown>,
            orderSource: "event_order",
            orderId: order.id,
          });
          enqueued++;
        }
      }

      // ── Combo labels ────────────────────────────────────────────────
      for (const it of comboItems) {
        const policy = policyById.get(it.itemId);
        const comboName = it.comboName ?? it.name;
        const selections = it.comboSelections ?? [];

        // Expand combo labels using the combo item's own labelPolicy/labelBoxSize.
        const comboLine: LabelLineInput = {
          itemId: it.itemId,
          itemName: comboName,
          quantity: it.quantity,
          labelPolicy: policy?.policy ?? "per_unit",
          labelBoxSize: policy?.boxSize ?? null,
        };
        const comboExpanded = expandItemLabels(comboLine);

        for (let i = 0; i < comboExpanded.length; i++) {
          const lbl = comboExpanded[i];
          const payload: ComboLabelPayload = {
            type: "combo_label",
            orderNumber,
            guestName,
            comboName,
            comboSelections: selections,
            placedAt,
            labelIndex: i + 1,
            labelTotal: comboExpanded.length,
          };
          await enqueuePrintJob({
            printerId: printer.id,
            jobType: "item_label",
            payload: payload as unknown as Record<string, unknown>,
            orderSource: "event_order",
            orderId: order.id,
          });
          enqueued++;
        }

        // ── Per-component labels (if enabled) ───────────────────────
        if ((policy?.comboComponentLabels ?? false) && selections.length > 0) {
          // Collapse same-menuItemId picks within the selections so we
          // expand labels per unique component, scaled by combo qty.
          const byComponentId = new Map<number, { name: string; totalQty: number }>();
          for (const sel of selections) {
            const existing = byComponentId.get(sel.menuItemId);
            if (existing) {
              existing.totalQty += sel.quantity * it.quantity;
            } else {
              byComponentId.set(sel.menuItemId, {
                name: sel.name,
                totalQty: sel.quantity * it.quantity,
              });
            }
          }

          for (const [compItemId, { name, totalQty }] of byComponentId) {
            const compPolicy = componentPolicyById.get(compItemId);
            const compLine: LabelLineInput = {
              itemId: compItemId,
              itemName: name,
              quantity: totalQty,
              labelPolicy: compPolicy?.policy ?? "per_unit",
              labelBoxSize: compPolicy?.boxSize ?? null,
            };
            const compExpanded = expandItemLabels(compLine);

            for (let i = 0; i < compExpanded.length; i++) {
              const lbl = compExpanded[i];
              const payload: ItemLabelPayload = {
                type: "item_label",
                orderNumber,
                guestName,
                itemName: lbl.itemName,
                quantity: lbl.quantity,
                notes: lbl.notes ?? null,
                modifiers: lbl.modifiers,
                isFullBox: lbl.isFullBox,
                placedAt,
                labelIndex: i + 1,
                labelTotal: compExpanded.length,
                partOfCombo: comboName,
              };
              await enqueuePrintJob({
                printerId: printer.id,
                jobType: "item_label",
                payload: payload as unknown as Record<string, unknown>,
                orderSource: "event_order",
                orderId: order.id,
              });
              enqueued++;
            }
          }
        }
      }

      // ── Plate labels ────────────────────────────────────────────────
      const plates = order.plateGroups ?? [];
      for (let i = 0; i < plates.length; i++) {
        const plate = plates[i];
        const lines = plate.items
          .map((pi) => {
            const oi = (order.items as EventOrderItem[]).find((x) => x.itemId === pi.itemId);
            return oi ? { name: oi.name, quantity: pi.quantity } : null;
          })
          .filter((l): l is { name: string; quantity: number } => l != null);
        const plPayload: PlateLabelPayload = {
          type: "plate_label",
          orderNumber,
          guestName,
          plateLabel: plate.label || `Plate ${i + 1}`,
          lines,
          placedAt,
        };
        await enqueuePrintJob({
          printerId: printer.id,
          jobType: "plate_label",
          payload: plPayload as unknown as Record<string, unknown>,
          orderSource: "event_order",
          orderId: order.id,
        });
        enqueued++;
      }
    }
  }

  logger.info(
    { orderId: order.id, source, enqueued },
    "[print-fanout] enqueued jobs for event order"
  );
  return enqueued;
}

/**
 * Convenience wrapper used by routes that just have an order id.
 */
export async function fanoutPrintForEventOrderId(
  orderId: number,
  source: FanoutSource
): Promise<number> {
  const [order] = await db
    .select()
    .from(eventOrdersTable)
    .where(eq(eventOrdersTable.id, orderId));
  if (!order) {
    logger.warn({ orderId, source }, "[print-fanout] order not found");
    return 0;
  }
  return fanoutPrintForEventOrder({ order, source });
}

/**
 * Print item labels for a single order, optionally restricted to one
 * line item. Used by the Kitchen Display "Print Individual Item Labels"
 * modal so cooks can re-fire labels for a specific item without
 * triggering the full kitchen ticket / plate-label fan-out.
 *
 * - Always uses `kitchen_send` source (manual mode → ignores
 *   `auto_print_on_new_order`).
 * - Skips plate labels (this path is item labels only).
 * - Honors per-printer `suppress_item_labels_for_plate_lines` so plated
 *   units stay suppressed exactly like the auto path.
 * - Returns the number of labels enqueued (0 if no label printers are
 *   configured / enabled).
 */
export async function fanoutItemLabelsForEventOrderId(args: {
  orderId: number;
  itemId?: number;
}): Promise<number> {
  const { orderId, itemId } = args;
  const [order] = await db
    .select()
    .from(eventOrdersTable)
    .where(eq(eventOrdersTable.id, orderId));
  if (!order) {
    logger.warn({ orderId }, "[print-fanout] item-labels: order not found");
    return 0;
  }

  // The kitchen_send surface IS authorized for item_label, but we still
  // honor the matrix as defense in depth.
  const allowed = ALLOWED_KINDS_BY_SOURCE.kitchen_send;
  if (!allowed.has("item_label")) return 0;

  const itemIds = (order.items ?? []).map((i: EventOrderItem) => i.itemId);
  if (itemIds.length === 0) return 0;

  // Resolve label policy + combo flags for the items we might print.
  const menuRows = await db
    .select({
      id: menuItemsTable.id,
      labelPolicy: menuItemsTable.labelPolicy,
      labelBoxSize: menuItemsTable.labelBoxSize,
      isCombo: menuItemsTable.isCombo,
      comboComponentLabels: menuItemsTable.comboComponentLabels,
    })
    .from(menuItemsTable)
    .where(inArray(menuItemsTable.id, itemIds));

  type MenuPolicy = { policy: LabelPolicy; boxSize: number | null; isCombo: boolean; comboComponentLabels: boolean };
  const policyById = new Map<number, MenuPolicy>();
  for (const r of menuRows) {
    policyById.set(r.id, {
      policy: (r.labelPolicy as LabelPolicy) ?? "per_unit",
      boxSize: r.labelBoxSize ?? null,
      isCombo: r.isCombo ?? false,
      comboComponentLabels: r.comboComponentLabels ?? false,
    });
  }

  // Collect component IDs for combo items.
  const componentItemIds = new Set<number>();
  for (const it of order.items as EventOrderItem[]) {
    if (it.comboSelections) {
      for (const sel of it.comboSelections) componentItemIds.add(sel.menuItemId);
    }
  }
  const componentPolicyById = new Map<number, { policy: LabelPolicy; boxSize: number | null }>();
  if (componentItemIds.size > 0) {
    const compRows = await db
      .select({ id: menuItemsTable.id, labelPolicy: menuItemsTable.labelPolicy, labelBoxSize: menuItemsTable.labelBoxSize })
      .from(menuItemsTable)
      .where(inArray(menuItemsTable.id, Array.from(componentItemIds)));
    for (const r of compRows) {
      componentPolicyById.set(r.id, { policy: (r.labelPolicy as LabelPolicy) ?? "per_unit", boxSize: r.labelBoxSize ?? null });
    }
  }

  // Manual mode = ignore auto_print_on_new_order.
  const labelPrinters = await selectPrintersFor("item_label", "manual");
  if (labelPrinters.length === 0) return 0;

  const placedAt = (order.createdAt ?? new Date()).toISOString();
  const orderNumber = String(order.id);
  const guestName = order.guestName;

  // Build the candidate item set, optionally narrowed to one item.
  const candidateItems = itemId != null
    ? (order.items as EventOrderItem[]).filter((it) => it.itemId === itemId)
    : (order.items as EventOrderItem[]);
  if (candidateItems.length === 0) {
    logger.warn({ orderId, itemId }, "[print-fanout] item-labels: itemId not on order — nothing enqueued");
    return 0;
  }

  // Plated qty per item — same calculation as the auto path so
  // `suppress_item_labels_for_plate_lines` behaves consistently.
  const plateQtyByItem = new Map<number, number>();
  for (const plate of order.plateGroups ?? []) {
    for (const pi of plate.items) {
      plateQtyByItem.set(pi.itemId, (plateQtyByItem.get(pi.itemId) ?? 0) + pi.quantity);
    }
  }

  let enqueued = 0;
  for (const printer of labelPrinters) {
    for (const it of candidateItems) {
      const policy = policyById.get(it.itemId);
      const isComboItem = policy?.isCombo ?? false;

      if (isComboItem) {
        // Combo: enqueue combo label + optional component labels.
        const comboName = it.comboName ?? it.name;
        const selections = it.comboSelections ?? [];
        const comboLine: LabelLineInput = {
          itemId: it.itemId,
          itemName: comboName,
          quantity: it.quantity,
          labelPolicy: policy?.policy ?? "per_unit",
          labelBoxSize: policy?.boxSize ?? null,
        };
        const comboExpanded = expandItemLabels(comboLine);
        for (let i = 0; i < comboExpanded.length; i++) {
          const lbl = comboExpanded[i];
          const payload: ComboLabelPayload = {
            type: "combo_label",
            orderNumber,
            guestName,
            comboName,
            comboSelections: selections,
            placedAt,
            labelIndex: i + 1,
            labelTotal: comboExpanded.length,
          };
          await enqueuePrintJob({
            printerId: printer.id,
            jobType: "item_label",
            payload: payload as unknown as Record<string, unknown>,
            orderSource: "event_order",
            orderId: order.id,
          });
          enqueued++;
        }

        if ((policy?.comboComponentLabels ?? false) && selections.length > 0) {
          const byComponentId = new Map<number, { name: string; totalQty: number }>();
          for (const sel of selections) {
            const existing = byComponentId.get(sel.menuItemId);
            if (existing) existing.totalQty += sel.quantity * it.quantity;
            else byComponentId.set(sel.menuItemId, { name: sel.name, totalQty: sel.quantity * it.quantity });
          }
          for (const [compItemId, { name, totalQty }] of byComponentId) {
            const compPolicy = componentPolicyById.get(compItemId);
            const compLine: LabelLineInput = {
              itemId: compItemId,
              itemName: name,
              quantity: totalQty,
              labelPolicy: compPolicy?.policy ?? "per_unit",
              labelBoxSize: compPolicy?.boxSize ?? null,
            };
            const compExpanded = expandItemLabels(compLine);
            for (let i = 0; i < compExpanded.length; i++) {
              const lbl = compExpanded[i];
              const payload: ItemLabelPayload = {
                type: "item_label",
                orderNumber,
                guestName,
                itemName: lbl.itemName,
                quantity: lbl.quantity,
                notes: lbl.notes ?? null,
                modifiers: lbl.modifiers,
                isFullBox: lbl.isFullBox,
                placedAt,
                labelIndex: i + 1,
                labelTotal: compExpanded.length,
                partOfCombo: comboName,
              };
              await enqueuePrintJob({
                printerId: printer.id,
                jobType: "item_label",
                payload: payload as unknown as Record<string, unknown>,
                orderSource: "event_order",
                orderId: order.id,
              });
              enqueued++;
            }
          }
        }
      } else {
        // Regular item.
        const plateQty = plateQtyByItem.get(it.itemId) ?? 0;
        const qty = printer.suppressItemLabelsForPlateLines
          ? Math.max(0, it.quantity - plateQty)
          : it.quantity;
        if (qty <= 0) continue;

        const linesForLabels: LabelLineInput[] = [{
          itemId: it.itemId,
          itemName: it.name,
          quantity: qty,
          labelPolicy: policy?.policy ?? "per_unit",
          labelBoxSize: policy?.boxSize ?? null,
        }];

        const expanded = expandAllItemLabels(linesForLabels);
        for (let i = 0; i < expanded.length; i++) {
          const lbl = expanded[i];
          const payload: ItemLabelPayload = {
            type: "item_label",
            orderNumber,
            guestName,
            itemName: lbl.itemName,
            quantity: lbl.quantity,
            notes: lbl.notes ?? null,
            modifiers: lbl.modifiers,
            isFullBox: lbl.isFullBox,
            placedAt,
            labelIndex: i + 1,
            labelTotal: expanded.length,
          };
          await enqueuePrintJob({
            printerId: printer.id,
            jobType: "item_label",
            payload: payload as unknown as Record<string, unknown>,
            orderSource: "event_order",
            orderId: order.id,
          });
          enqueued++;
        }
      }
    }
  }

  logger.info(
    { orderId, itemId: itemId ?? null, enqueued },
    "[print-fanout] enqueued item labels (manual, kitchen)"
  );
  return enqueued;
}
