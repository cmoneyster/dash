import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Drives the live ingest pipeline against the real DB with a fully
// mocked gateway-send layer to lock down the two new owner-forward
// gates added under task #200:
//
//   1. Recency gate: any inbound older than FORWARD_RECENCY_MS is
//      ingested but never forwarded. Stops the per-port detail-page
//      walk's stale backlog from spamming the owner with N old
//      messages every time a single new one arrives.
//
//   2. Unmatched-sender gate: when the inbound has no inquiry, the
//      dedicated smsOwnerForwardUnmatchedEnabled toggle must also be
//      ON for a forward to fire. Matched inquiries still forward
//      under the primary toggle alone.
//
// The tests pin both gates through the real ingestInbound entry
// point — exactly the same call site the poller and the webhook use
// — so any regression in the gate ordering shows up here.

vi.mock("../sms-ejoin", () => ({
  isEjoinConfigured: vi.fn(() => true),
  getChatPort: vi.fn(async () => 7),
  getInboundMode: vi.fn(async () => "poll"),
  fetchInbound: vi.fn(),
  fetchInboundSmsForPort: vi.fn(),
  sendSmsViaEjoin: vi.fn(async () => ({ port: 7, gatewayResponse: "ok" })),
  sendSmsViaChatPort: vi.fn(async () => ({ port: 7, gatewayResponse: "ok" })),
  sendSmsToCustomer: vi.fn(async () => ({ port: 7, gatewayResponse: "ok" })),
  BlocklistedRecipientError: class BlocklistedRecipientError extends Error {
    reason: "customer-opt-out" | "admin-blocked";
    constructor(reason: "customer-opt-out" | "admin-blocked") {
      super("blocked");
      this.reason = reason;
    }
  },
}));

import { db } from "@workspace/db";
import {
  smsMessagesTable,
  eventSettingsTable,
  cateringInquiriesTable,
  ownerForwardsTable,
} from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";
import * as ejoin from "../sms-ejoin";
import {
  ingestInbound,
  clearSmsInboxSettingsCache,
  FORWARD_RECENCY_MS,
} from "../sms-inbox";

const sendSmsViaChatPortMock = ejoin.sendSmsViaChatPort as unknown as ReturnType<typeof vi.fn>;

// Phones chosen to be obviously synthetic so they never collide with
// a real number an admin might have in their dev DB.
const CUSTOMER_DIGITS_MATCHED = "5550100201";
const CUSTOMER_DIGITS_UNMATCHED = "5550100202";
const CHAT_OWNER_DIGITS = "5550100203";
const GID_PREFIX = "test-task200:";

let originalSettings: typeof eventSettingsTable.$inferSelect | null = null;
let createdInquiryId: number | null = null;

async function clearTestRows() {
  await db.delete(smsMessagesTable).where(like(smsMessagesTable.gatewayMessageId, `${GID_PREFIX}%`));
}

beforeAll(async () => {
  let [snap] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
  if (!snap) {
    [snap] = await db.insert(eventSettingsTable).values({ id: 1 }).returning();
  }
  originalSettings = snap;
  // Set up the test world: forwarding ON, owner-reply OFF, unmatched
  // forwarding OFF (the new default). chat-owner phone routes forwards
  // to a synthetic number we can assert on.
  await db
    .update(eventSettingsTable)
    .set({
      smsChatOwnerPhone: CHAT_OWNER_DIGITS,
      smsOwnerForwardEnabled: true,
      smsOwnerForwardUnmatchedEnabled: false,
      smsOwnerReplyEnabled: false,
      smsOwnerForwardCapPer24h: 10,
      // No need to set ownerNotificationPhone — chat-owner takes
      // precedence in the chat-port resolution chain.
    })
    .where(eq(eventSettingsTable.id, 1));

  // Create a real inquiry whose clientPhone matches CUSTOMER_DIGITS_MATCHED
  // so findInquiryForPhone returns its id on the matched-sender tests.
  const [inq] = await db
    .insert(cateringInquiriesTable)
    .values({
      clientName: "Task 200 Test Customer",
      clientPhone: CUSTOMER_DIGITS_MATCHED,
    })
    .returning();
  createdInquiryId = inq.id;
});

afterAll(async () => {
  if (createdInquiryId != null) {
    await db.delete(cateringInquiriesTable).where(eq(cateringInquiriesTable.id, createdInquiryId));
  }
  if (originalSettings) {
    await db
      .update(eventSettingsTable)
      .set({
        smsChatOwnerPhone: originalSettings.smsChatOwnerPhone ?? null,
        smsOwnerForwardEnabled: originalSettings.smsOwnerForwardEnabled,
        smsOwnerForwardUnmatchedEnabled: originalSettings.smsOwnerForwardUnmatchedEnabled,
        smsOwnerReplyEnabled: originalSettings.smsOwnerReplyEnabled,
        smsOwnerForwardCapPer24h: originalSettings.smsOwnerForwardCapPer24h ?? null,
      })
      .where(eq(eventSettingsTable.id, 1));
  }
  await clearTestRows();
  clearSmsInboxSettingsCache();
});

beforeEach(async () => {
  await clearTestRows();
  sendSmsViaChatPortMock.mockClear();
  sendSmsViaChatPortMock.mockResolvedValue({ port: 7, gatewayResponse: "ok" });
  // Bust the 5-second settings cache so each test sees the latest
  // toggle state from the DB.
  clearSmsInboxSettingsCache();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ingestInbound — owner forward recency + unmatched gates (task #200)", () => {
  it("does NOT forward stale matched inbounds (recency gate)", async () => {
    // Matched sender (their phone is on a real inquiry) but the
    // message is 30 minutes old — well outside the FORWARD_RECENCY_MS
    // window. The poller would otherwise see this on a backfill
    // sweep and forward every old SMS to the owner.
    const stale = new Date(Date.now() - 30 * 60 * 1000);
    await ingestInbound({
      gatewayMessageId: `${GID_PREFIX}stale-matched`,
      fromPhone: CUSTOMER_DIGITS_MATCHED,
      body: "this came in 30 minutes ago",
      occurredAt: stale,
      port: 7,
    });
    expect(sendSmsViaChatPortMock).not.toHaveBeenCalled();

    // The message is still in the DB so the chat thread shows it.
    const rows = await db
      .select()
      .from(smsMessagesTable)
      .where(eq(smsMessagesTable.gatewayMessageId, `${GID_PREFIX}stale-matched`));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.inquiryId).toBe(createdInquiryId);
  });

  it("DOES forward fresh matched inbounds", async () => {
    await ingestInbound({
      gatewayMessageId: `${GID_PREFIX}fresh-matched`,
      fromPhone: CUSTOMER_DIGITS_MATCHED,
      body: "just texted",
      occurredAt: new Date(),
      port: 7,
    });
    expect(sendSmsViaChatPortMock).toHaveBeenCalledTimes(1);
    expect(sendSmsViaChatPortMock.mock.calls[0]?.[0]).toBe(CHAT_OWNER_DIGITS);
  });

  it("does NOT forward unmatched inbounds when smsOwnerForwardUnmatchedEnabled is false (new default)", async () => {
    // Default for the unmatched toggle is OFF, so a random inbound
    // from a number with no inquiry stays in the Unmatched inbox but
    // never fires an owner forward. This is the headline fix for the
    // owner-spam bug.
    await ingestInbound({
      gatewayMessageId: `${GID_PREFIX}unmatched-default`,
      fromPhone: CUSTOMER_DIGITS_UNMATCHED,
      body: "Your verification code is 123456",
      occurredAt: new Date(),
      port: 7,
    });
    expect(sendSmsViaChatPortMock).not.toHaveBeenCalled();

    const rows = await db
      .select()
      .from(smsMessagesTable)
      .where(eq(smsMessagesTable.gatewayMessageId, `${GID_PREFIX}unmatched-default`));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.inquiryId).toBeNull();
  });

  it("DOES forward unmatched inbounds when admin opts in via smsOwnerForwardUnmatchedEnabled", async () => {
    await db
      .update(eventSettingsTable)
      .set({ smsOwnerForwardUnmatchedEnabled: true })
      .where(eq(eventSettingsTable.id, 1));
    clearSmsInboxSettingsCache();

    await ingestInbound({
      gatewayMessageId: `${GID_PREFIX}unmatched-optin`,
      fromPhone: CUSTOMER_DIGITS_UNMATCHED,
      body: "stranger says hi",
      occurredAt: new Date(),
      port: 7,
    });
    expect(sendSmsViaChatPortMock).toHaveBeenCalledTimes(1);
    expect(sendSmsViaChatPortMock.mock.calls[0]?.[0]).toBe(CHAT_OWNER_DIGITS);

    // Restore the default for the rest of the suite.
    await db
      .update(eventSettingsTable)
      .set({ smsOwnerForwardUnmatchedEnabled: false })
      .where(eq(eventSettingsTable.id, 1));
    clearSmsInboxSettingsCache();
  });

  it("does NOT forward stale unmatched inbounds even when both toggles are on (recency wins)", async () => {
    // Both gates pass the unmatched toggle, but recency still blocks —
    // a backlog sweep that surfaces a 2h-old random SMS must NOT
    // wake the owner up at midnight even with the most permissive
    // settings.
    await db
      .update(eventSettingsTable)
      .set({ smsOwnerForwardUnmatchedEnabled: true })
      .where(eq(eventSettingsTable.id, 1));
    clearSmsInboxSettingsCache();

    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await ingestInbound({
      gatewayMessageId: `${GID_PREFIX}stale-unmatched-permissive`,
      fromPhone: CUSTOMER_DIGITS_UNMATCHED,
      body: "ancient stranger",
      occurredAt: stale,
      port: 7,
    });
    expect(sendSmsViaChatPortMock).not.toHaveBeenCalled();

    await db
      .update(eventSettingsTable)
      .set({ smsOwnerForwardUnmatchedEnabled: false })
      .where(eq(eventSettingsTable.id, 1));
    clearSmsInboxSettingsCache();
  });

  it("FORWARD_RECENCY_MS is wider than realistic poll jitter", async () => {
    // Sanity floor: if someone tightens this constant by accident the
    // recency gate will start dropping perfectly fresh customer
    // inbounds. 1 minute is the floor we'd consider risky; the
    // current value should be comfortably above that.
    expect(FORWARD_RECENCY_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("does NOT insert an owner_forwards row (cap counter is not ticked) when the recency gate blocks", async () => {
    // The 24h-cap row is what lets the next inbound 'remember' that we
    // already forwarded, so it MUST only be written when an owner SMS
    // actually fires. A recency-blocked inbound is silently dropped at
    // the forward leg — no owner SMS, therefore no cap row. If a
    // future refactor accidentally writes the cap row before the gate,
    // the very next legitimate fresh inbound on the same inquiry
    // would be wrongly blocked by the (1-per-24h) cap.
    //
    // Filter the assertion by sourceGatewayMessageId — earlier
    // forwarding tests in this file leave their own rows behind for
    // the same inquiry id, so a global count would be misleading.
    const gid = `${GID_PREFIX}stale-cap-not-ticked`;
    const stale = new Date(Date.now() - 30 * 60 * 1000);
    await ingestInbound({
      gatewayMessageId: gid,
      fromPhone: CUSTOMER_DIGITS_MATCHED,
      body: "stale, must not tick the cap",
      occurredAt: stale,
      port: 7,
    });
    expect(sendSmsViaChatPortMock).not.toHaveBeenCalled();
    const fwdRows = await db
      .select()
      .from(ownerForwardsTable)
      .where(eq(ownerForwardsTable.sourceGatewayMessageId, gid));
    expect(fwdRows).toHaveLength(0);
  });

  it("does NOT insert an owner_forwards row when the unmatched-disabled gate blocks", async () => {
    // Same invariant for the unmatched gate.
    const gid = `${GID_PREFIX}unmatched-cap-not-ticked`;
    await ingestInbound({
      gatewayMessageId: gid,
      fromPhone: CUSTOMER_DIGITS_UNMATCHED,
      body: "stranger, owner-forward off",
      occurredAt: new Date(),
      port: 7,
    });
    expect(sendSmsViaChatPortMock).not.toHaveBeenCalled();
    const fwdRows = await db
      .select()
      .from(ownerForwardsTable)
      .where(eq(ownerForwardsTable.sourceGatewayMessageId, gid));
    expect(fwdRows).toHaveLength(0);
  });
});
