import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Drives the live ingest pipeline against the real DB with a fully
// mocked gateway-send layer. Pins down task #188's regression: the
// owner-rejection branch must claim the gateway-message-id BEFORE
// dispatching the corrective text, so a repeated poll of the same
// inbound row can never re-send to the owner.
//
// The historical bug (Apr 27 overnight) caused 900+ rejection texts
// to fire because the poller re-discovered the same gateway rows on
// every cycle and each pass invoked sendSmsViaEjoin again.

vi.mock("../sms-ejoin", () => ({
  isEjoinConfigured: vi.fn(() => true),
  getChatPort: vi.fn(async () => 7),
  getInboundMode: vi.fn(async () => "poll"),
  fetchInbound: vi.fn(),
  fetchInboundSmsForPort: vi.fn(),
  // The functions exercised by sms-inbox.
  sendSmsViaEjoin: vi.fn(async () => ({ port: 7, gatewayResponse: "ok" })),
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
import { smsMessagesTable, eventSettingsTable } from "@workspace/db/schema";
import { and, eq, like } from "drizzle-orm";
import * as ejoin from "../sms-ejoin";
import { ingestInbound, _resetOwnerRejectRateLimitForTests } from "../sms-inbox";

const sendSmsViaEjoinMock = ejoin.sendSmsViaEjoin as unknown as ReturnType<typeof vi.fn>;

// Use a digits-only phone that won't collide with real owner config.
const OWNER_DIGITS = "5550199001";
const GID_PREFIX = "test-task188:";

let originalSettings: typeof eventSettingsTable.$inferSelect | null = null;

async function clearTestRows() {
  await db.delete(smsMessagesTable).where(like(smsMessagesTable.gatewayMessageId, `${GID_PREFIX}%`));
}

beforeAll(async () => {
  let [snap] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
  if (!snap) {
    [snap] = await db.insert(eventSettingsTable).values({ id: 1 }).returning();
  }
  originalSettings = snap;
  // Force the DB owner phone path so the test never depends on the
  // OWNER_PHONE env var the developer may have set locally.
  await db
    .update(eventSettingsTable)
    .set({ ownerNotificationPhone: OWNER_DIGITS, smsOwnerReplyEnabled: false })
    .where(eq(eventSettingsTable.id, 1));
});

afterAll(async () => {
  // Restore the snapshot so this test never leaves the dev DB in a
  // state that surprises the next person who looks at SMS settings.
  if (originalSettings) {
    await db
      .update(eventSettingsTable)
      .set({
        ownerNotificationPhone: originalSettings.ownerNotificationPhone ?? null,
        smsOwnerReplyEnabled: originalSettings.smsOwnerReplyEnabled,
      })
      .where(eq(eventSettingsTable.id, 1));
  }
  await clearTestRows();
});

beforeEach(async () => {
  await clearTestRows();
  _resetOwnerRejectRateLimitForTests();
  sendSmsViaEjoinMock.mockClear();
  sendSmsViaEjoinMock.mockResolvedValue({ port: 7, gatewayResponse: "ok" });
  // The owner-phone read goes through a 5-second cache inside
  // sms-inbox; pause briefly so the freshly-written settings row is
  // picked up by the next ingest call.
  await new Promise(r => setTimeout(r, 10));
});

afterEach(() => {
  vi.clearAllMocks();
});

function makeRejectInput(suffix: string) {
  // owner_reply_enabled is false in the seeded settings, so any owner
  // inbound (with or without the #<id> tag) hits the
  // "owner-reply-disabled" reject branch — exactly the branch that
  // sent ~900 corrective texts in the production incident.
  return {
    gatewayMessageId: `${GID_PREFIX}${suffix}`,
    fromPhone: OWNER_DIGITS,
    body: "#5 hello",
    occurredAt: new Date("2026-04-28T01:50:00Z"),
    port: 7,
  };
}

describe("ingestInbound — owner reject dedupe (task #188)", () => {
  it("replays of the same gateway-message-id text the owner ONCE", async () => {
    const input = makeRejectInput("dedupe-1");

    for (let i = 0; i < 20; i++) {
      await ingestInbound(input);
    }

    expect(sendSmsViaEjoinMock).toHaveBeenCalledTimes(1);
    expect(sendSmsViaEjoinMock.mock.calls[0]?.[0]).toBe(OWNER_DIGITS);

    // And the sentinel row is parked in the table under the dedicated
    // source so the unmatched listing/badge queries skip it.
    const rows = await db
      .select()
      .from(smsMessagesTable)
      .where(eq(smsMessagesTable.gatewayMessageId, input.gatewayMessageId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("owner_reject_marker");
    expect(rows[0]?.seenByAdmin).toBe(true);
  });

  it("distinct gateway-message-ids each get their own corrective text up to the rate cap", async () => {
    // 5 distinct gids → 5 successful sentinel claims, but the per-hour
    // cap (3) kicks in so only the first 3 actually text the owner.
    for (let i = 0; i < 5; i++) {
      await ingestInbound(makeRejectInput(`cap-${i}`));
    }

    expect(sendSmsViaEjoinMock).toHaveBeenCalledTimes(3);

    // All 5 sentinels were still recorded — replays of any of them
    // remain a no-op even though the rate cap suppressed the text.
    const rows = await db
      .select()
      .from(smsMessagesTable)
      .where(
        and(
          eq(smsMessagesTable.source, "owner_reject_marker"),
          like(smsMessagesTable.gatewayMessageId, `${GID_PREFIX}cap-%`),
        ),
      );
    expect(rows).toHaveLength(5);
  });

  it("backfilled rows are not re-rejected on the next poll", async () => {
    // Simulate the production failure mode: the gateway returns a
    // batch of 25 historical owner-rejected rows. The first poll
    // should text the owner exactly RATE_CAP times (3) and claim
    // every gid; a subsequent poll over the same window must NOT
    // text again at all.
    for (let i = 0; i < 25; i++) {
      await ingestInbound(makeRejectInput(`backfill-${i}`));
    }
    const firstPassCalls = sendSmsViaEjoinMock.mock.calls.length;
    expect(firstPassCalls).toBeLessThanOrEqual(3);

    sendSmsViaEjoinMock.mockClear();
    for (let i = 0; i < 25; i++) {
      await ingestInbound(makeRejectInput(`backfill-${i}`));
    }
    expect(sendSmsViaEjoinMock).not.toHaveBeenCalled();
  });
});
