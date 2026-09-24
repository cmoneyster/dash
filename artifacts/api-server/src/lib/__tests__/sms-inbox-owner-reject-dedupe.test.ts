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
  // Corrective texts (and customer-bound sends) now route through the
  // dedicated chat-port wrapper so the owner's chat-port thread stays
  // coherent — the test asserts on this mock rather than the raw
  // sendSmsViaEjoin to pin the chat-port routing in place.
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
import { smsMessagesTable, eventSettingsTable } from "@workspace/db/schema";
import { and, eq, like } from "drizzle-orm";
import * as ejoin from "../sms-ejoin";
import { ingestInbound, _resetOwnerRejectRateLimitForTests } from "../sms-inbox";

const sendSmsViaEjoinMock = ejoin.sendSmsViaEjoin as unknown as ReturnType<typeof vi.fn>;
const sendSmsViaChatPortMock = ejoin.sendSmsViaChatPort as unknown as ReturnType<typeof vi.fn>;

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
  // OWNER_PHONE env var the developer may have set locally. The chat
  // owner phone is cleared too: it takes precedence over both, and a DB
  // copied from production has it set.
  await db
    .update(eventSettingsTable)
    .set({ ownerNotificationPhone: OWNER_DIGITS, smsChatOwnerPhone: null, smsOwnerReplyEnabled: false })
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
        smsChatOwnerPhone: originalSettings.smsChatOwnerPhone ?? null,
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
  sendSmsViaChatPortMock.mockClear();
  sendSmsViaChatPortMock.mockResolvedValue({ port: 7, gatewayResponse: "ok" });
  // The owner-phone read goes through a 5-second cache inside
  // sms-inbox; pause briefly so the freshly-written settings row is
  // picked up by the next ingest call.
  await new Promise(r => setTimeout(r, 10));
});

afterEach(() => {
  vi.clearAllMocks();
});

function makeRejectInput(suffix: string, occurredAt: Date = new Date("2026-04-28T01:50:00Z")) {
  // owner_reply_enabled is false in the seeded settings, so any owner
  // inbound (with or without the #<id> tag) hits the
  // "owner-reply-disabled" reject branch — exactly the branch that
  // sent ~900 corrective texts in the production incident.
  return {
    gatewayMessageId: `${GID_PREFIX}${suffix}`,
    fromPhone: OWNER_DIGITS,
    body: "#5 hello",
    occurredAt,
    port: 7,
  };
}

describe("ingestInbound — owner reject dedupe (task #188)", () => {
  it("replays of the same gateway-message-id text the owner ONCE", async () => {
    const input = makeRejectInput("dedupe-1");

    for (let i = 0; i < 20; i++) {
      await ingestInbound(input);
    }

    // Corrective text rides the chat-port wrapper; the unguarded
    // sendSmsViaEjoin must NOT be touched on the owner-reject branch.
    expect(sendSmsViaChatPortMock).toHaveBeenCalledTimes(1);
    expect(sendSmsViaChatPortMock.mock.calls[0]?.[0]).toBe(OWNER_DIGITS);
    expect(sendSmsViaEjoinMock).not.toHaveBeenCalled();

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
    // Each message is 10 minutes apart so the soft dedup's ±5-minute
    // window does not cross-match genuinely distinct owner texts.
    for (let i = 0; i < 5; i++) {
      const occurredAt = new Date(Date.UTC(2026, 3, 28, 1, 50 + i * 10, 0));
      await ingestInbound(makeRejectInput(`cap-${i}`, occurredAt));
    }

    expect(sendSmsViaChatPortMock).toHaveBeenCalledTimes(3);
    expect(sendSmsViaEjoinMock).not.toHaveBeenCalled();

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

  it("env-fallback owner phone (OWNER_PHONE) also dedups on replays", async () => {
    // Production root cause: when the DB owner phone column is blank,
    // sms-inbox falls back to the OWNER_PHONE env var. Confirm the
    // sentinel claim runs and dedups in that fallback path too —
    // otherwise a deploy where OWNER_PHONE is set and the DB column
    // is empty would still storm.
    const ENV_OWNER = "5550199002";

    // Clear the DB owner column so the env fallback path runs, and
    // bust the in-module 5-second settings cache so the next ingest
    // sees the change.
    await db
      .update(eventSettingsTable)
      .set({ ownerNotificationPhone: null })
      .where(eq(eventSettingsTable.id, 1));
    const { clearSmsInboxSettingsCache } = await import("../sms-inbox");
    clearSmsInboxSettingsCache();

    const prevEnv = process.env.OWNER_PHONE;
    process.env.OWNER_PHONE = ENV_OWNER;

    try {
      const input = {
        gatewayMessageId: `${GID_PREFIX}env-fallback`,
        fromPhone: ENV_OWNER,
        body: "#5 hello",
        occurredAt: new Date("2026-04-28T01:50:00Z"),
        port: 7,
      };

      for (let i = 0; i < 10; i++) {
        await ingestInbound(input);
      }

      expect(sendSmsViaChatPortMock).toHaveBeenCalledTimes(1);
      expect(sendSmsViaChatPortMock.mock.calls[0]?.[0]).toBe(ENV_OWNER);
      expect(sendSmsViaEjoinMock).not.toHaveBeenCalled();

      const rows = await db
        .select()
        .from(smsMessagesTable)
        .where(eq(smsMessagesTable.gatewayMessageId, input.gatewayMessageId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.source).toBe("owner_reject_marker");
    } finally {
      // Restore the env var and the DB owner column for the rest of
      // the file so subsequent tests run against the DB-owner path.
      if (prevEnv === undefined) delete process.env.OWNER_PHONE;
      else process.env.OWNER_PHONE = prevEnv;
      await db
        .update(eventSettingsTable)
        .set({ ownerNotificationPhone: OWNER_DIGITS })
        .where(eq(eventSettingsTable.id, 1));
      clearSmsInboxSettingsCache();
    }
  });

  it("backfilled rows are not re-rejected on the next poll", async () => {
    // Simulate the production failure mode: the gateway returns a
    // batch of 25 historical owner-rejected rows. The first poll
    // should text the owner exactly RATE_CAP times (3) and claim
    // every gid; a subsequent poll over the same window must NOT
    // text again at all.
    // Each message is 10 minutes apart so the soft dedup's ±5-minute
    // window does not cross-match genuinely distinct historical rows.
    function backfillInput(i: number) {
      return makeRejectInput(`backfill-${i}`, new Date(Date.UTC(2026, 3, 28, 0, i * 10, 0)));
    }
    for (let i = 0; i < 25; i++) {
      await ingestInbound(backfillInput(i));
    }
    const firstPassCalls = sendSmsViaChatPortMock.mock.calls.length;
    expect(firstPassCalls).toBeLessThanOrEqual(3);

    sendSmsViaChatPortMock.mockClear();
    sendSmsViaEjoinMock.mockClear();
    for (let i = 0; i < 25; i++) {
      await ingestInbound(backfillInput(i));
    }
    expect(sendSmsViaChatPortMock).not.toHaveBeenCalled();
    expect(sendSmsViaEjoinMock).not.toHaveBeenCalled();
  });
});

// ── Cross-format soft dedup (dual push+poll mode) ──────────────────────────────
//
// When the gateway runs in push+poll dual mode the same owner message
// arrives under two completely different gateway IDs:
//   webhook:12405158960:2026-07-27T02:27:54.294Z:#21 yes   (webhook path)
//   listdata:7:2405158960:07-27 02:27:#21 yes              (safety-net poller)
//
// The gatewayMessageId unique index can't cross-match these, so the
// poller would previously re-fire owner processing and send a spurious
// rejection / second relay. The content-based ±5-minute window check
// added to ingestInboundImpl must catch the duplicate and return
// status:"owner-cross-dedup" without any outbound SMS.
describe("ingestInbound — cross-format soft dedup (push+poll dual mode, task #462)", () => {
  const BASE_OCCURRED_AT = new Date("2026-07-27T02:27:54Z");

  it("safety-net poller duplicate (different gatewayMessageId) is silently dropped", async () => {
    // owner_reply_enabled is still false from beforeAll, so the webhook
    // pass hits the reject branch and records an owner_reject_marker.
    // The poller pass arrives with a listdata:... GID — the content-based
    // dedup must fire BEFORE the reject branch and return without sending.
    const webhookInput = {
      gatewayMessageId: `${GID_PREFIX}dual:webhook:12405158960:2026-07-27T02:27:54Z:#99 yes`,
      fromPhone: OWNER_DIGITS,
      body: "#99 yes",
      occurredAt: BASE_OCCURRED_AT,
      port: 7,
    };
    const pollerInput = {
      gatewayMessageId: `${GID_PREFIX}dual:listdata:7:2405158960:07-27 02:27:#99 yes`,
      fromPhone: OWNER_DIGITS,
      body: "#99 yes",
      occurredAt: BASE_OCCURRED_AT,
      port: 7,
    };

    // Webhook pass — processes normally, records marker, may send text.
    await ingestInbound(webhookInput);
    const webhookSendCount = sendSmsViaChatPortMock.mock.calls.length;
    sendSmsViaChatPortMock.mockClear();
    sendSmsViaEjoinMock.mockClear();

    // Poller pass — must be a complete no-op due to soft dedup.
    const result = await ingestInbound(pollerInput);

    expect(result.status).toBe("owner-cross-dedup");
    expect(sendSmsViaChatPortMock).not.toHaveBeenCalled();
    expect(sendSmsViaEjoinMock).not.toHaveBeenCalled();

    // Only the webhook marker exists; no second row from the poller pass.
    const markers = await db
      .select()
      .from(smsMessagesTable)
      .where(
        and(
          eq(smsMessagesTable.customerPhone, OWNER_DIGITS),
          eq(smsMessagesTable.body, "#99 yes"),
          like(smsMessagesTable.gatewayMessageId, `${GID_PREFIX}dual:%`),
        ),
      );
    expect(markers).toHaveLength(1);
    expect(markers[0]?.gatewayMessageId).toBe(webhookInput.gatewayMessageId);

    // Suppress TS unused warning on webhookSendCount.
    void webhookSendCount;
  });

  it("messages with the same body but different ports are not cross-deduped", async () => {
    // Two owner messages on different ports must each be independent —
    // the port is part of the matching key.
    const port7Input = {
      gatewayMessageId: `${GID_PREFIX}port-7`,
      fromPhone: OWNER_DIGITS,
      body: "#99 same body",
      occurredAt: BASE_OCCURRED_AT,
      port: 7,
    };
    const port8Input = {
      gatewayMessageId: `${GID_PREFIX}port-8`,
      fromPhone: OWNER_DIGITS,
      body: "#99 same body",
      occurredAt: BASE_OCCURRED_AT,
      port: 8,
    };

    await ingestInbound(port7Input);
    _resetOwnerRejectRateLimitForTests();
    sendSmsViaChatPortMock.mockClear();

    // Different port → no soft dedup → processes as a fresh message.
    const result = await ingestInbound(port8Input);
    expect(result.status).not.toBe("owner-cross-dedup");
  });

  it("messages with the same body but timestamps > 5 minutes apart are not cross-deduped", async () => {
    // Two distinct owner messages with the same body but 6 minutes apart
    // must each be processed independently — they are real separate texts.
    const input1 = {
      gatewayMessageId: `${GID_PREFIX}time-gap:1`,
      fromPhone: OWNER_DIGITS,
      body: "#99 same body far apart",
      occurredAt: new Date("2026-07-27T02:00:00Z"),
      port: 7,
    };
    const input2 = {
      gatewayMessageId: `${GID_PREFIX}time-gap:2`,
      fromPhone: OWNER_DIGITS,
      body: "#99 same body far apart",
      occurredAt: new Date("2026-07-27T02:06:00Z"), // 6 minutes later — outside ±5 min
      port: 7,
    };

    await ingestInbound(input1);
    _resetOwnerRejectRateLimitForTests();
    sendSmsViaChatPortMock.mockClear();

    const result = await ingestInbound(input2);
    expect(result.status).not.toBe("owner-cross-dedup");
  });
});
