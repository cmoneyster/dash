import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { ordersTable, orderItemsTable, cartItemsTable, menuItemsTable, cateringInquiriesTable, eventSettingsTable } from "@workspace/db/schema";
import { computeEffectivePrice } from "@workspace/pricing";
import { eq } from "drizzle-orm";
import { sendNewInquiryAlert } from "../lib/sms";

const router: IRouter = Router();

// Hard fallbacks if the event_settings row is somehow missing — keeps
// checkout functional even on a fresh database. Mirror the schema defaults.
const OTD_DEFAULTS = {
  setupFee: 500,
  feeWaiverThreshold: 2000,
  includedHours: 2,
  additionalHourRate: 100,
  maxAdditionalHours: 3,
};

type ServiceMode = "drop_off" | "on_the_dash";
function parseServiceMode(v: unknown): ServiceMode | null {
  if (v === undefined || v === null) return "drop_off";
  if (v === "on_the_dash" || v === "drop_off") return v;
  return null;
}

async function getOrderWithItems(orderId: number) {
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
  if (!order) return null;
  const items = await db.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, orderId));
  return {
    ...order,
    total: parseFloat(order.total),
    items: items.map((i) => ({ ...i, price: parseFloat(i.price) })),
  };
}

router.post("/orders", async (req, res): Promise<void> => {
  try {
    const {
      sessionId, customerName, customerEmail, customerPhone,
      eventDate, eventType, guestCount, serviceStyle, deliveryNotes,
      venueAddress: rawVenueAddress,
      serviceMode: rawServiceMode,
    } = req.body;

    // The cart now sends a dedicated `venueAddress` field populated by the
    // address autocomplete. Only fall back to `deliveryNotes` when the
    // venue field is *absent* from the body (legacy clients that were
    // built before the field existed). When a modern client sends
    // `venueAddress: ""` we honor that as "intentionally cleared" rather
    // than slurping the customer's dietary notes into the venue column.
    let venueAddress: string | null;
    if (rawVenueAddress === undefined) {
      venueAddress = typeof deliveryNotes === "string" && deliveryNotes.trim().length > 0
        ? deliveryNotes.trim()
        : null;
    } else {
      venueAddress = typeof rawVenueAddress === "string" && rawVenueAddress.trim().length > 0
        ? rawVenueAddress.trim()
        : null;
    }

    if (!sessionId || !customerName || !customerEmail) {
      res.status(400).json({ error: "sessionId, customerName, and customerEmail are required" });
      return;
    }

    const serviceMode = parseServiceMode(rawServiceMode);
    if (serviceMode === null) {
      res.status(400).json({ error: "serviceMode must be 'drop_off' or 'on_the_dash'" });
      return;
    }

    // Get cart items
    const cartItems = await db
      .select()
      .from(cartItemsTable)
      .innerJoin(menuItemsTable, eq(cartItemsTable.menuItemId, menuItemsTable.id))
      .where(eq(cartItemsTable.sessionId, sessionId));

    if (cartItems.length === 0) {
      res.status(400).json({ error: "Cart is empty" });
      return;
    }

    // OTD eligibility gate — server-authoritative. The Cart UI also blocks
    // submission, but we re-check here so direct API callers can't bypass
    // the rule and end up promising on-site cooking for items the trailer
    // can't actually prepare.
    if (serviceMode === "on_the_dash") {
      const ineligible = cartItems
        .filter(row => !row.menu_items.otdEligible)
        .map(row => row.menu_items.name);
      if (ineligible.length > 0) {
        res.status(400).json({
          error:
            `Some items in your cart are not available for the On the Dash Experience: ` +
            `${ineligible.join(", ")}. Please remove them or switch to Standard Drop-Off.`,
        });
        return;
      }
    }

    // Per-line effective price snapshot — reused for subtotal, order
    // items insert, and the inquiry summary so the three sources stay
    // consistent.
    const lineEffectivePrices = cartItems.map(row =>
      computeEffectivePrice(row.menu_items, row.cart_items.quantity, row.cart_items.sizePrice ?? null),
    );
    const subtotal = cartItems.reduce(
      (sum, row, i) => sum + lineEffectivePrices[i] * row.cart_items.quantity,
      0,
    );

    // Snapshot the live OTD pricing config so this inquiry's quote stays
    // stable even if admins later edit /admin/event-settings. We only
    // populate the snapshot for on_the_dash inquiries — drop_off rows
    // leave the snapshot columns null (which is what the schema expects)
    // and the admin Catering Orders panel hides them in that case.
    const [eventSettings] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
    const otdConfig = {
      setupFee: eventSettings?.otdSetupFee != null ? parseFloat(eventSettings.otdSetupFee) : OTD_DEFAULTS.setupFee,
      feeWaiverThreshold: eventSettings?.otdFeeWaiverThreshold != null ? parseFloat(eventSettings.otdFeeWaiverThreshold) : OTD_DEFAULTS.feeWaiverThreshold,
      includedHours: eventSettings?.otdIncludedHours != null ? parseFloat(eventSettings.otdIncludedHours) : OTD_DEFAULTS.includedHours,
      additionalHourRate: eventSettings?.otdAdditionalHourRate != null ? parseFloat(eventSettings.otdAdditionalHourRate) : OTD_DEFAULTS.additionalHourRate,
      maxAdditionalHours: eventSettings?.otdMaxAdditionalHours ?? OTD_DEFAULTS.maxAdditionalHours,
    };
    const isOtd = serviceMode === "on_the_dash";

    // Compute the OTD fee server-side. The setup fee is waived once the
    // food subtotal hits the configured threshold; additional staff hours
    // are billed at the per-hour rate (capped). Drop-off orders have
    // zero OTD fees by definition.
    let otdFee = 0;
    if (serviceMode === "on_the_dash") {
      const setupFee = subtotal >= otdConfig.feeWaiverThreshold ? 0 : otdConfig.setupFee;
      otdFee = setupFee; // hourly upcharge is captured separately by the admin during quoting
    }
    const total = subtotal + otdFee;

    const [order] = await db.insert(ordersTable).values({
      sessionId,
      customerName,
      customerEmail,
      customerPhone: customerPhone ?? null,
      eventDate: eventDate ?? null,
      eventType: eventType ?? null,
      guestCount: guestCount ?? null,
      serviceStyle: serviceStyle ?? null,
      deliveryNotes: deliveryNotes ?? null,
      status: "pending",
      total: String(total),
    }).returning();

    // Insert order items — store the effective per-unit price the
    // customer actually saw in their cart (size/tier-aware) so admin
    // views display the same line totals as the cart.
    await db.insert(orderItemsTable).values(
      cartItems.map((row, i) => ({
        orderId: order.id,
        menuItemId: row.menu_items.id,
        menuItemName: row.menu_items.name,
        price: lineEffectivePrices[i].toFixed(2),
        quantity: row.cart_items.quantity,
      }))
    );

    // Clear the cart
    await db.delete(cartItemsTable).where(eq(cartItemsTable.sessionId, sessionId));

    // Dual-write: create a catering inquiry for this cart order
    try {
      const orderItemsForInquiry = cartItems.map((row, i) => ({
        name: row.menu_items.name,
        quantity: row.cart_items.quantity,
        price: lineEffectivePrices[i],
      }));
      const orderTotalStr = `$${total.toFixed(2)}`;

      const [inquiryRow] = await db.insert(cateringInquiriesTable).values({
        clientName: customerName,
        clientEmail: customerEmail ?? null,
        clientPhone: customerPhone ?? null,
        eventDate: eventDate ?? null,
        guestCount: guestCount ?? null,
        venueAddress,
        source: "cart",
        orderItems: orderItemsForInquiry,
        orderTotal: orderTotalStr,
        status: "inquiry",
        // Service mode + per-inquiry fee snapshot (see comment in
        // lib/db/src/schema/catering-inquiries.ts). Snapshot only on
        // OTD inquiries — drop_off rows leave these columns null.
        serviceMode,
        otdSetupFee: isOtd ? String(otdConfig.setupFee.toFixed(2)) : null,
        otdFeeWaiverThreshold: isOtd ? String(otdConfig.feeWaiverThreshold.toFixed(2)) : null,
        otdIncludedHours: isOtd ? String(otdConfig.includedHours.toFixed(2)) : null,
        otdAdditionalHourRate: isOtd ? String(otdConfig.additionalHourRate.toFixed(2)) : null,
        otdMaxAdditionalHours: isOtd ? otdConfig.maxAdditionalHours : null,
      }).returning();

      // Build a deep link to the admin inquiry editor for the SMS alert.
      const envBase = process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "");
      const fwd = req.headers["x-forwarded-proto"];
      const proto = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0] || req.protocol || "https";
      const baseUrl = envBase || `${proto}://${req.get("host")}`;
      const link = `${baseUrl}/admin/catering?inquiry=${inquiryRow.id}`;

      // Fire-and-forget SMS alert
      sendNewInquiryAlert({
        clientName: customerName,
        source: "cart",
        eventDate: eventDate ?? null,
        guestCount: guestCount ?? null,
        total: orderTotalStr,
        clientPhone: customerPhone ?? null,
        link,
      }).catch(() => {});
    } catch (inquiryErr) {
      req.log.error({ err: inquiryErr }, "Failed to create catering inquiry from cart order — order was still created");
    }

    const result = await getOrderWithItems(order.id);
    res.status(201).json(result);
  } catch (err) {
    req.log.error({ err }, "Error creating order");
    res.status(500).json({ error: "Failed to create order" });
  }
});

router.get("/admin/orders", async (req, res) => {
  try {
    const orders = await db.select().from(ordersTable).orderBy(ordersTable.createdAt);
    const result = await Promise.all(orders.map((o) => getOrderWithItems(o.id)));
    res.json(result.filter(Boolean));
  } catch (err) {
    req.log.error({ err }, "Error listing orders");
    res.status(500).json({ error: "Failed to list orders" });
  }
});

router.put("/admin/orders/:id", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    const { status } = req.body;
    if (!status) {
      res.status(400).json({ error: "status required" });
      return;
    }

    const [updated] = await db.update(ordersTable).set({ status }).where(eq(ordersTable.id, id)).returning();
    if (!updated) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    const result = await getOrderWithItems(id);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Error updating order status");
    res.status(500).json({ error: "Failed to update order status" });
  }
});

export default router;
