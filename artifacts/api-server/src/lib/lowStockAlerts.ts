// Server-side detection of low-stock crossings. Used by the order POST
// endpoints (guest + staff) so a notification fires even when the Kitchen
// Display tablet is asleep.
//
// Crossing rule: an item that has a finite eventStock and crosses from
// "above the threshold" to "at-or-below the threshold (but still > 0)"
// triggers exactly one SMS. The "already alerted" state is persisted on
// menu_items.low_stock_alert_sent so concurrent orders + tablet refreshes
// don't double-fire. The flag is cleared in the stock PATCH route once
// stock climbs back above the threshold (or is set to null/0).

import { eq, sql } from "drizzle-orm";
import type { Request } from "express";
import { db } from "@workspace/db";
import { menuItemsTable } from "@workspace/db/schema";
import { sendLowStockAlert } from "./sms";

export const DEFAULT_LOW_STOCK_THRESHOLD = 5;

// Loose tx shape — drizzle's tx is essentially the same surface as db for our
// needs (update + returning). Importing the full type creates a circular
// dependency in the bundler config, so we restrict to what we actually use.
export type LowStockTxLike = Pick<typeof db, "update">;

export type LowStockCrossing = { itemId: number; name: string; eventStock: number };

/**
 * Within an existing transaction, atomically flip low_stock_alert_sent → true
 * for any of the supplied items whose new stock just crossed below the
 * threshold. Returns the items that should now be SMS-alerted.
 *
 * The caller is responsible for actually sending the SMS *after* the
 * transaction commits (so a rolled-back order doesn't generate a phantom
 * notification).
 *
 * The atomic UPDATE guards against double-alerts when two orders place
 * concurrently — only the transaction that actually flips the flag from
 * false → true gets a returned row.
 */
export async function detectAndMarkLowStockCrossings(
  tx: LowStockTxLike,
  candidates: Array<{ itemId: number; name: string; newStock: number }>,
  threshold: number,
): Promise<LowStockCrossing[]> {
  const crossings: LowStockCrossing[] = [];
  const t = Number.isFinite(threshold) && threshold > 0 ? threshold : DEFAULT_LOW_STOCK_THRESHOLD;

  for (const c of candidates) {
    if (!Number.isFinite(c.newStock)) continue;
    if (c.newStock <= 0 || c.newStock > t) continue;

    const flipped = await tx
      .update(menuItemsTable)
      .set({ lowStockAlertSent: true })
      .where(sql`${menuItemsTable.id} = ${c.itemId} AND ${menuItemsTable.lowStockAlertSent} = false`)
      .returning({ id: menuItemsTable.id });

    if (flipped.length > 0) {
      crossings.push({ itemId: c.itemId, name: c.name, eventStock: c.newStock });
    }
  }

  return crossings;
}

/**
 * Outside a transaction: clear the alert flag for an item whose stock no
 * longer qualifies as "low" (restocked above threshold, set to unlimited,
 * or fully sold out — at 0 we want a manual restock to re-arm the alert).
 */
export async function maybeResetLowStockFlag(
  database: typeof db,
  itemId: number,
  newStock: number | null,
  threshold: number,
): Promise<void> {
  const t = Number.isFinite(threshold) && threshold > 0 ? threshold : DEFAULT_LOW_STOCK_THRESHOLD;
  const shouldReset = newStock === null || newStock <= 0 || newStock > t;
  if (!shouldReset) return;
  await database
    .update(menuItemsTable)
    .set({ lowStockAlertSent: false })
    .where(eq(menuItemsTable.id, itemId));
}

/**
 * Fire-and-forget low-stock SMS, called by route handlers after the order
 * transaction commits. Skips when there's no recipient configured or no
 * crossings to report. Errors are logged via the request logger and
 * deliberately not propagated — a failed SMS must not fail the order.
 */
export function fireLowStockAlertIfAny(
  req: Request,
  crossings: LowStockCrossing[],
  settings: { phones: string[]; eventName: string; threshold: number },
): void {
  if (settings.phones.length === 0 || crossings.length === 0) return;
  sendLowStockAlert({
    phoneNumbers: settings.phones,
    eventName: settings.eventName,
    items: crossings.map(c => ({ name: c.name, eventStock: c.eventStock })),
    threshold: settings.threshold,
  }).catch(err => {
    req.log?.error({ err }, "Error sending low-stock alert SMS");
  });
}
