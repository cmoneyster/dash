import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  menuItemsTable,
  cartItemsTable,
  ordersTable,
  cateringInquiriesTable,
  eventSettingsTable,
} from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";
import app from "../../app";

// Guard rail: cart.ts (the customer-facing preview) and orders.ts (the
// server-authoritative checkout) compute effective prices for tier and
// pan-size pricing. They must agree — otherwise the customer sees one
// number and gets charged another, and the OTD setup-fee waiver
// decision drifts.
//
// This test seeds an isolated menu item with both tier2/tier3 and
// pan-size pricing, drives both routes through the real Express app,
// and asserts the totals + persisted line prices line up. The test
// fails if a future edit re-introduces the divergence.

const TEST_NAME_TAG = "__pricing-contract-test__";
const TEST_SESSION_TAG = "test-session-pricing-contract-";
const TEST_EMAIL_TAG = "pricing-contract-test@example.invalid";

let perUnitItemId = 0; // tier2/tier3 + base
let panSizeItemId = 0; // pan_sizes pricing
let originalEventSettings: typeof eventSettingsTable.$inferSelect | null = null;

async function cleanup() {
  // Orders + order_items (cascade)
  const orders = await db
    .select()
    .from(ordersTable)
    .where(eq(ordersTable.customerEmail, TEST_EMAIL_TAG));
  for (const o of orders) {
    await db.delete(ordersTable).where(eq(ordersTable.id, o.id));
  }
  // Catering inquiries created by the order route
  await db
    .delete(cateringInquiriesTable)
    .where(eq(cateringInquiriesTable.clientEmail, TEST_EMAIL_TAG));
  // Cart rows tied to test sessions
  const cartRows = await db.select().from(cartItemsTable);
  for (const c of cartRows) {
    if (c.sessionId.startsWith(TEST_SESSION_TAG)) {
      await db.delete(cartItemsTable).where(eq(cartItemsTable.id, c.id));
    }
  }
}

beforeAll(async () => {
  await cleanup();

  // Snapshot OTD settings so we can flip the waiver threshold to a low
  // value for the OTD test, then restore the original. If the row is
  // missing (e.g. fresh test DB before seed runs), insert a defaults
  // row so the test is self-contained.
  let [snap] = await db
    .select()
    .from(eventSettingsTable)
    .where(eq(eventSettingsTable.id, 1));
  if (!snap) {
    [snap] = await db
      .insert(eventSettingsTable)
      .values({ id: 1 })
      .returning();
  }
  originalEventSettings = snap;

  // Per-unit item with tier2/tier3 pricing and OTD eligibility
  const [perUnit] = await db
    .insert(menuItemsTable)
    .values({
      name: `${TEST_NAME_TAG} per_unit`,
      description: "test",
      category: "Small Bites - Savory",
      price: "10.00",
      servingSize: 1,
      unit: "each",
      pricingTemplate: "per_unit",
      tier2Qty: 5,
      tier2Price: "8.00",
      tier3Qty: 10,
      tier3Price: "6.00",
      otdEligible: true,
      available: true,
    })
    .returning();
  perUnitItemId = perUnit.id;

  // Pan-size item — sizePrice should win over tiers / base
  const [panSize] = await db
    .insert(menuItemsTable)
    .values({
      name: `${TEST_NAME_TAG} pan_sizes`,
      description: "test",
      category: "Entrées - Meat",
      price: "999.00", // base price intentionally wrong to prove sizePrice wins
      servingSize: 30,
      unit: "tray",
      pricingTemplate: "pan_sizes",
      size1Label: "Small Pan",
      size1Servings: 15,
      size1Price: "40.00",
      size2Label: "Medium Pan",
      size2Servings: 30,
      size2Price: "75.00",
      size3Label: "Large Pan",
      size3Servings: 45,
      size3Price: "100.00",
      otdEligible: true,
      available: true,
    })
    .returning();
  panSizeItemId = panSize.id;
});

afterAll(async () => {
  await cleanup();
  if (perUnitItemId)
    await db.delete(menuItemsTable).where(eq(menuItemsTable.id, perUnitItemId));
  if (panSizeItemId)
    await db.delete(menuItemsTable).where(eq(menuItemsTable.id, panSizeItemId));

  // Restore OTD settings
  if (originalEventSettings) {
    await db
      .update(eventSettingsTable)
      .set({
        otdSetupFee: originalEventSettings.otdSetupFee,
        otdFeeWaiverThreshold: originalEventSettings.otdFeeWaiverThreshold,
        otdIncludedHours: originalEventSettings.otdIncludedHours,
        otdAdditionalHourRate: originalEventSettings.otdAdditionalHourRate,
        otdMaxAdditionalHours: originalEventSettings.otdMaxAdditionalHours,
      })
      .where(eq(eventSettingsTable.id, 1));
  }

  // Also clean up any other test rows that might have leaked in
  await db
    .delete(menuItemsTable)
    .where(like(menuItemsTable.name, `${TEST_NAME_TAG}%`));
});

beforeEach(async () => {
  await cleanup();
});

async function addToCart(
  sessionId: string,
  menuItemId: number,
  quantity: number,
  sizeSlot?: number,
) {
  const res = await request(app)
    .post("/api/cart")
    .send({ sessionId, menuItemId, quantity, sizeSlot })
    .expect(200);
  return res.body;
}

async function getCart(sessionId: string) {
  const res = await request(app)
    .get("/api/cart")
    .query({ sessionId })
    .expect(200);
  return res.body;
}

async function submitOrder(
  sessionId: string,
  serviceMode: "drop_off" | "on_the_dash" = "drop_off",
) {
  const res = await request(app)
    .post("/api/orders")
    .send({
      sessionId,
      customerName: "Pricing Contract Test",
      customerEmail: TEST_EMAIL_TAG,
      serviceMode,
    })
    .expect(201);
  return res.body;
}

describe("cart ↔ order pricing contract", () => {
  it("drop-off: tier3 effective price flows from cart preview through to order total and order_items", async () => {
    const sessionId = `${TEST_SESSION_TAG}tier3`;
    // qty 12 ≥ tier3Qty(10) → effective price 6.00 each
    await addToCart(sessionId, perUnitItemId, 12);

    const cart = await getCart(sessionId);
    const expectedLine = 12 * 6.0;
    expect(cart.total).toBeCloseTo(expectedLine, 2);
    expect(cart.items[0].effectivePrice).toBeCloseTo(6.0, 2);

    const order = await submitOrder(sessionId, "drop_off");

    // Cart preview total must equal the server-computed order total.
    expect(order.total).toBeCloseTo(cart.total, 2);
    expect(order.total).toBeCloseTo(expectedLine, 2);

    // The persisted per-unit price on order_items must be the
    // effective tier3 price, not the $10 base.
    expect(order.items).toHaveLength(1);
    expect(order.items[0].price).toBeCloseTo(6.0, 2);
    expect(order.items[0].quantity).toBe(12);
  });

  it("drop-off: tier2 effective price flows through end-to-end", async () => {
    const sessionId = `${TEST_SESSION_TAG}tier2`;
    // qty 6 ≥ tier2Qty(5) but < tier3Qty(10) → 8.00 each
    await addToCart(sessionId, perUnitItemId, 6);

    const cart = await getCart(sessionId);
    expect(cart.items[0].effectivePrice).toBeCloseTo(8.0, 2);
    expect(cart.total).toBeCloseTo(48.0, 2);

    const order = await submitOrder(sessionId, "drop_off");
    expect(order.total).toBeCloseTo(cart.total, 2);
    expect(order.items[0].price).toBeCloseTo(8.0, 2);
  });

  it("drop-off: pan-size sizePrice wins over base/tier prices", async () => {
    const sessionId = `${TEST_SESSION_TAG}pan`;
    // sizeSlot=2 → size2Price = 75.00 (base price is intentionally 999)
    await addToCart(sessionId, panSizeItemId, 2, 2);

    const cart = await getCart(sessionId);
    expect(cart.items[0].effectivePrice).toBeCloseTo(75.0, 2);
    expect(cart.total).toBeCloseTo(150.0, 2);

    const order = await submitOrder(sessionId, "drop_off");
    expect(order.total).toBeCloseTo(cart.total, 2);
    expect(order.items[0].price).toBeCloseTo(75.0, 2);
    // Definitely not the base price
    expect(order.items[0].price).not.toBeCloseTo(999.0, 2);
  });

  it("OTD: setup fee is applied when subtotal is below the waiver threshold", async () => {
    // Set a low waiver threshold so we can test both sides without
    // having to seed huge orders.
    await db
      .update(eventSettingsTable)
      .set({
        otdSetupFee: "500.00",
        otdFeeWaiverThreshold: "200.00",
      })
      .where(eq(eventSettingsTable.id, 1));

    const sessionId = `${TEST_SESSION_TAG}otd-below`;
    // qty 6 → tier2 price 8.00 → subtotal 48.00 (below 200 threshold)
    await addToCart(sessionId, perUnitItemId, 6);

    const cart = await getCart(sessionId);
    expect(cart.total).toBeCloseTo(48.0, 2);

    const order = await submitOrder(sessionId, "on_the_dash");
    // Order total = cart subtotal + setup fee
    expect(order.total).toBeCloseTo(48.0 + 500.0, 2);
    // order_items still records the tier-effective price, not base
    expect(order.items[0].price).toBeCloseTo(8.0, 2);
  });

  it("OTD: setup fee is waived once the effective subtotal hits the threshold", async () => {
    await db
      .update(eventSettingsTable)
      .set({
        otdSetupFee: "500.00",
        otdFeeWaiverThreshold: "60.00",
      })
      .where(eq(eventSettingsTable.id, 1));

    const sessionId = `${TEST_SESSION_TAG}otd-above`;
    // qty 12 → tier3 price 6.00 → subtotal 72.00 (≥ 60 threshold)
    await addToCart(sessionId, perUnitItemId, 12);

    const cart = await getCart(sessionId);
    expect(cart.total).toBeCloseTo(72.0, 2);

    const order = await submitOrder(sessionId, "on_the_dash");
    // Waiver triggers off the SAME effective subtotal the cart shows.
    // If orders.ts ever falls back to base price (10 * 12 = 120), the
    // waiver decision would still go through here — but the assertion
    // below catches the divergence in the line price + order total.
    expect(order.total).toBeCloseTo(72.0, 2);
    expect(order.items[0].price).toBeCloseTo(6.0, 2);
  });

  it("OTD waiver hinges on the effective (not base) subtotal", async () => {
    // Threshold sits BETWEEN the base-price subtotal and the tier3 subtotal.
    // - Effective subtotal = 12 * 6 = 72
    // - Base subtotal would be 12 * 10 = 120
    // Threshold = 100 → waiver should NOT trigger (72 < 100). If
    // orders.ts ever reverts to base pricing, the waiver would
    // incorrectly trigger (120 ≥ 100) and this test fails.
    await db
      .update(eventSettingsTable)
      .set({
        otdSetupFee: "500.00",
        otdFeeWaiverThreshold: "100.00",
      })
      .where(eq(eventSettingsTable.id, 1));

    const sessionId = `${TEST_SESSION_TAG}otd-effective`;
    await addToCart(sessionId, perUnitItemId, 12);

    const cart = await getCart(sessionId);
    expect(cart.total).toBeCloseTo(72.0, 2);

    const order = await submitOrder(sessionId, "on_the_dash");
    // Setup fee should still apply because effective subtotal (72) < threshold (100)
    expect(order.total).toBeCloseTo(72.0 + 500.0, 2);
  });
});
