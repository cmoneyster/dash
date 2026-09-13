import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Drives the live SMS poller through a sequence of cycles with a fully
// mocked gateway-fetch layer + ingest stub. Locks in the regression for
// task #185: every customer text on the chat SIM must reach the chat
// thread, even when several arrived in quick succession (so the listing
// only shows the latest) and especially after a process restart (where
// the boot-time backfill won't auto-rerun and the live poller's first
// cycle is the only thing pulling messages in).

vi.mock("../sms-ejoin", () => ({
  isEjoinConfigured: vi.fn(() => true),
  getChatPort: vi.fn(async () => 7),
  getInboundMode: vi.fn(async () => "poll"),
  fetchInbound: vi.fn(),
  fetchInboundSmsForPortResult: vi.fn(),
}));

vi.mock("../sms-inbox", () => ({
  ingestInbound: vi.fn(async () => ({ status: "stored" as const })),
}));

vi.mock("../../routes/admin-sms-messages", () => ({
  runSmsBackfill: vi.fn(async () => null),
}));

import { _pollOnceForTests, _resetSmsPollerStateForTests } from "../sms-scheduler";
import * as ejoin from "../sms-ejoin";
import * as inbox from "../sms-inbox";

const fetchInboundMock = ejoin.fetchInbound as unknown as ReturnType<typeof vi.fn>;
const fetchDetailMock = ejoin.fetchInboundSmsForPortResult as unknown as ReturnType<typeof vi.fn>;
const ingestMock = inbox.ingestInbound as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetSmsPollerStateForTests();
  fetchInboundMock.mockReset();
  fetchDetailMock.mockReset();
  ingestMock.mockReset();
  ingestMock.mockResolvedValue({ status: "stored" });
});

afterEach(() => {
  vi.clearAllMocks();
});

function listingRow(opts: { gid: string; body: string }) {
  return {
    gatewayMessageId: opts.gid,
    port: 7,
    fromPhone: "12405158960",
    body: opts.body,
    occurredAt: new Date("2026-04-28T01:50:00Z"),
  };
}

describe("sms scheduler — per-port detail escalation", () => {
  it("first cycle after restart escalates when chat SIM has messages", async () => {
    // Cold-start scenario: the in-memory baseline is empty (we just
    // started up), the gateway already has 3 messages on the chat SIM,
    // and the listing only exposes the latest. Without first-cycle
    // escalation, the older two would never be ingested because the
    // boot-time backfill is gated on smsBackfillCompletedAt and won't
    // auto-rerun on subsequent restarts.
    fetchInboundMock.mockResolvedValueOnce({
      rows: [listingRow({ gid: "listdata:7:2405158960:04-28 01:50:newest", body: "newest" })],
      ports: [{ port: 7, count: 3, latestId: "listdata:7:2405158960:04-28 01:50:newest" }],
    });
    fetchDetailMock.mockResolvedValueOnce({ parseStatus: "parsed", parsedRowsBeforeTimeFilter: 3, rows: [
      listingRow({ gid: "listdata:7:2405158960:04-28 01:50:newest", body: "newest" }),
      listingRow({ gid: "listdata:7:2405158960:04-28 01:45:middle", body: "middle" }),
      listingRow({ gid: "listdata:7:2405158960:04-28 01:40:oldest", body: "oldest" }),
    ] });

    await _pollOnceForTests();

    expect(fetchDetailMock).toHaveBeenCalledTimes(1);
    expect(fetchDetailMock).toHaveBeenCalledWith(7, expect.any(Object));
    // All three messages from the per-port detail walk reach the
    // ingest layer — the listing's single "newest" row collapses to
    // the same id as one of the detail rows so it isn't double-fed.
    expect(ingestMock).toHaveBeenCalledTimes(3);
    const ingestedBodies = ingestMock.mock.calls.map(c => (c[0] as { body: string }).body).sort();
    expect(ingestedBodies).toEqual(["middle", "newest", "oldest"]);
  });

  it("steady-state cycle does NOT escalate when count + latest id are unchanged", async () => {
    const stableRow = listingRow({ gid: "listdata:7:2405158960:04-28 01:50:hello", body: "hello" });
    const stableSummary = { port: 7, count: 1, latestId: stableRow.gatewayMessageId };

    fetchInboundMock.mockResolvedValue({ rows: [stableRow], ports: [stableSummary] });
    fetchDetailMock.mockResolvedValue({ parseStatus: "parsed", parsedRowsBeforeTimeFilter: 1, rows: [stableRow] });

    await _pollOnceForTests(); // cycle 1: cold start escalates
    await _pollOnceForTests(); // cycle 2: nothing changed, must not escalate

    expect(fetchDetailMock).toHaveBeenCalledTimes(1); // only cycle 1
    // Both cycles ingest the row but ingestInbound's own dedupe handles
    // the no-op — we just verify we didn't burn an extra detail fetch.
    expect(fetchInboundMock).toHaveBeenCalledTimes(2);
  });

  it("escalates again when count grows on a later cycle", async () => {
    const initialRow = listingRow({ gid: "listdata:7:2405158960:04-28 01:50:m1", body: "m1" });
    fetchInboundMock.mockResolvedValueOnce({
      rows: [initialRow],
      ports: [{ port: 7, count: 1, latestId: initialRow.gatewayMessageId }],
    });
    fetchDetailMock.mockResolvedValueOnce({ parseStatus: "parsed", parsedRowsBeforeTimeFilter: 1, rows: [initialRow] });

    // Cycle 2: customer texts twice more, count jumps to 3 and a new
    // message becomes the latest. Both transitions should trigger an
    // escalation; the test pins on count growth specifically.
    const newRow = listingRow({ gid: "listdata:7:2405158960:04-28 01:55:m3", body: "m3" });
    fetchInboundMock.mockResolvedValueOnce({
      rows: [newRow],
      ports: [{ port: 7, count: 3, latestId: newRow.gatewayMessageId }],
    });
    fetchDetailMock.mockResolvedValueOnce({ parseStatus: "parsed", parsedRowsBeforeTimeFilter: 3, rows: [
      newRow,
      listingRow({ gid: "listdata:7:2405158960:04-28 01:52:m2", body: "m2" }),
      initialRow,
    ] });

    await _pollOnceForTests();
    await _pollOnceForTests();

    expect(fetchDetailMock).toHaveBeenCalledTimes(2);
    const allIngested = ingestMock.mock.calls.map(c => (c[0] as { body: string }).body);
    // m1 ingested cycle 1 (and again cycle 2 but DB dedupe collapses
    // it; here the ingest stub doesn't enforce that). The point of
    // the test is that m2 — the older-than-latest message — reaches
    // ingest because of the cycle-2 escalation, not silently dropped.
    expect(allIngested).toContain("m2");
    expect(allIngested).toContain("m3");
  });

  it("escalates when count is unchanged but latest id flipped (firmware that resets count on read)", async () => {
    const oldLatest = listingRow({ gid: "listdata:7:2405158960:04-28 01:50:old", body: "old" });
    const newLatest = listingRow({ gid: "listdata:7:2405158960:04-28 01:55:new", body: "new" });

    fetchInboundMock.mockResolvedValueOnce({
      rows: [oldLatest],
      ports: [{ port: 7, count: 1, latestId: oldLatest.gatewayMessageId }],
    });
    fetchDetailMock.mockResolvedValueOnce({ parseStatus: "parsed", parsedRowsBeforeTimeFilter: 1, rows: [oldLatest] });

    // Cycle 2: count stayed 1 (firmware marked the old one read and
    // counted the new one) but the latest id flipped. We must
    // escalate so we don't miss "new".
    fetchInboundMock.mockResolvedValueOnce({
      rows: [newLatest],
      ports: [{ port: 7, count: 1, latestId: newLatest.gatewayMessageId }],
    });
    fetchDetailMock.mockResolvedValueOnce({ parseStatus: "parsed", parsedRowsBeforeTimeFilter: 1, rows: [newLatest] });

    await _pollOnceForTests();
    await _pollOnceForTests();

    expect(fetchDetailMock).toHaveBeenCalledTimes(2);
  });

  it("does not escalate when chat SIM has zero messages, even on first cycle", async () => {
    // Empty chat SIM on a fresh start — no need to spend an HTTP
    // request on the per-port detail page when the gateway is
    // explicitly telling us there's nothing there.
    fetchInboundMock.mockResolvedValueOnce({
      rows: [],
      ports: [{ port: 7, count: 0, latestId: null }],
    });

    await _pollOnceForTests();

    expect(fetchDetailMock).not.toHaveBeenCalled();
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it("retries an unchanged listing after an unrecognized detail page", async () => {
    const stableRow = listingRow({ gid: "listdata:7:2405158960:04-28 01:50:hello", body: "hello" });
    fetchInboundMock.mockResolvedValue({
      rows: [stableRow],
      ports: [{ port: 7, count: 2, latestId: stableRow.gatewayMessageId }],
    });
    fetchDetailMock
      .mockResolvedValueOnce({
        parseStatus: "unrecognized-page",
        parsedRowsBeforeTimeFilter: 0,
        rows: [],
      })
      .mockResolvedValueOnce({
        parseStatus: "parsed",
        parsedRowsBeforeTimeFilter: 2,
        rows: [
          stableRow,
          listingRow({ gid: "listdata:7:2405158960:04-28 01:45:hidden", body: "hidden" }),
        ],
      });

    await _pollOnceForTests();
    await _pollOnceForTests();

    expect(fetchDetailMock).toHaveBeenCalledTimes(2);
    expect(ingestMock.mock.calls.map(c => (c[0] as { body: string }).body)).toContain("hidden");
  });
});
