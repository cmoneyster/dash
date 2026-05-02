import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  classifyPath,
  recordEjoinPoll,
  recordOutboundSms,
  recordInstagramPoll,
  recordHttpRequest,
  snapshot,
  _resetIdleMetricsForTests,
  _getBucketCountForTests,
} from "../idle-metrics";

// Pure unit tests for the in-memory idle-activity counters. The module
// powers the admin "Idle Activity" page and runs entirely off Date.now()
// + a Map of 1-minute buckets, so it lends itself to fast fake-timer
// tests without booting the Express app.
//
// We lock down four contracts here:
//   1. The 60-min and 24-h windows are exclusive at the lower edge — old
//      events must not leak into "last hour" or "last 24h".
//   2. Long-running processes don't grow the Map indefinitely; pruning
//      keeps it at ~24h+grace regardless of how many minutes elapse.
//   3. classifyPath() routes admin sub-trees correctly — and the
//      catch-all "/api/admin" only fires for paths that didn't already
//      match a more specific admin family.
//   4. Each record* helper increments only its own counter so a future
//      refactor can't silently double-count or cross-wire metrics.

const MS_PER_MINUTE = 60_000;
const START = new Date("2026-01-01T00:00:00Z").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  _resetIdleMetricsForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("idle-metrics windowing", () => {
  it("60-min and 24-h totals only include events inside their window", () => {
    // T = 0h: 25h before "now". Outside both windows (and old enough to
    // be pruned by the write at T = +25h below).
    vi.setSystemTime(START);
    recordEjoinPoll(1000);
    recordOutboundSms();

    // T = +2h: 23h before "now". Inside 24h window, outside 1h window.
    vi.setSystemTime(START + 2 * 60 * MS_PER_MINUTE);
    recordEjoinPoll(2000);
    recordOutboundSms();

    // T = +25h: "now". Inside both windows.
    vi.setSystemTime(START + 25 * 60 * MS_PER_MINUTE);
    recordEjoinPoll(500);
    recordOutboundSms();

    const snap = snapshot();

    // Only the T = +25h event lives in the last hour.
    expect(snap.ejoinPolls.lastHour.count).toBe(1);
    expect(snap.ejoinPolls.lastHour.bytes).toBe(500);
    expect(snap.outboundSms.lastHour).toBe(1);

    // Last 24h includes T = +2h and T = +25h, but NOT T = 0.
    expect(snap.ejoinPolls.last24h.count).toBe(2);
    expect(snap.ejoinPolls.last24h.bytes).toBe(2500);
    expect(snap.outboundSms.last24h).toBe(2);
  });

  it("events at exactly the window boundary are excluded (cutoff is exclusive)", () => {
    // Record an event 60 minutes ago and one right now. The 60-min one
    // is exactly on the cutoff — the implementation uses `> cutoff`, so
    // it must NOT be counted in lastHour.
    vi.setSystemTime(START);
    recordOutboundSms();

    vi.setSystemTime(START + 60 * MS_PER_MINUTE);
    recordOutboundSms();

    const snap = snapshot();
    expect(snap.outboundSms.lastHour).toBe(1);
    // But it's still inside the 24h window.
    expect(snap.outboundSms.last24h).toBe(2);
  });
});

describe("idle-metrics pruning", () => {
  it("keeps the bucket Map bounded after a multi-day simulated run", () => {
    // Simulate 7 days of one event per minute (10080 writes). Without
    // pruning the Map would grow to 10080 entries; with pruning it
    // should stay at roughly 24h + the small grace window.
    const MINUTES = 7 * 24 * 60;
    for (let m = 0; m < MINUTES; m++) {
      vi.setSystemTime(START + m * MS_PER_MINUTE);
      recordEjoinPoll(1);
    }

    const size = _getBucketCountForTests();
    // 24h = 1440 buckets, plus the 10-minute grace window the module
    // intentionally retains. Allow a tiny slack (current minute can sit
    // just inside or just outside the grace edge depending on rounding).
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(24 * 60 + 11);
  });

  it("snapshot after a long run reflects only the last 24h", () => {
    // Same long simulation, but assert via the snapshot: the 24h totals
    // should equal exactly the events that fall inside the trailing 24h
    // window relative to the final "now".
    const MINUTES = 3 * 24 * 60; // 3 days
    for (let m = 0; m < MINUTES; m++) {
      vi.setSystemTime(START + m * MS_PER_MINUTE);
      recordEjoinPoll(10);
    }

    // "now" is the last-recorded minute. Last 24h = the 1439 prior
    // buckets (cutoff is exclusive) + the current bucket = 1440 events
    // worth of bytes. Each event recorded 10 bytes.
    const snap = snapshot();
    expect(snap.ejoinPolls.last24h.count).toBe(24 * 60);
    expect(snap.ejoinPolls.last24h.bytes).toBe(24 * 60 * 10);
  });
});

describe("idle-metrics classifyPath", () => {
  it("routes the four kitchen/staff/admin families correctly", () => {
    expect(classifyPath("/api/event-ordering/items")).toBe("kitchen-display");
    expect(classifyPath("/api/event-taker/sessions/abc")).toBe(
      "staff-order-taker",
    );
    expect(classifyPath("/api/admin/catering/menu")).toBe("catering-admin");
    expect(classifyPath("/api/admin/messages/inbox")).toBe(
      "unmatched-messages",
    );
  });

  it("falls through to other-admin only for admin paths that didn't match a more specific family", () => {
    expect(classifyPath("/api/admin/users")).toBe("other-admin");
    expect(classifyPath("/api/admin")).toBe("other-admin");
    // Specific admin branches must win over the catch-all even when the
    // suffix is empty.
    expect(classifyPath("/api/admin/catering")).toBe("catering-admin");
    expect(classifyPath("/api/admin/messages")).toBe("unmatched-messages");
  });

  it("classifies anything else as public", () => {
    expect(classifyPath("/")).toBe("public");
    expect(classifyPath("/api/menu")).toBe("public");
    expect(classifyPath("/about")).toBe("public");
    expect(classifyPath("")).toBe("public");
  });
});

describe("idle-metrics recorders increment the right fields", () => {
  it("recordEjoinPoll only touches ejoinPolls + ejoinBytes", () => {
    recordEjoinPoll(1234);
    recordEjoinPoll(0);
    // Negative or fractional bytes are clamped/floored — record them to
    // confirm we don't accidentally cross-pollute other counters.
    recordEjoinPoll(-50);
    recordEjoinPoll(7.9);

    const snap = snapshot();
    expect(snap.ejoinPolls.last24h.count).toBe(4);
    // 1234 + 0 + max(0, -50) + floor(7.9) = 1234 + 0 + 0 + 7 = 1241
    expect(snap.ejoinPolls.last24h.bytes).toBe(1241);
    expect(snap.outboundSms.last24h).toBe(0);
    expect(snap.instagramPolls.last24h).toBe(0);
    expect(snap.instagramPolls.lastRunAt).toBeNull();
  });

  it("recordOutboundSms only touches smsOutbound", () => {
    recordOutboundSms();
    recordOutboundSms();
    recordOutboundSms();

    const snap = snapshot();
    expect(snap.outboundSms.lastHour).toBe(3);
    expect(snap.outboundSms.last24h).toBe(3);
    expect(snap.ejoinPolls.last24h.count).toBe(0);
    expect(snap.ejoinPolls.last24h.bytes).toBe(0);
    expect(snap.instagramPolls.last24h).toBe(0);
  });

  it("recordInstagramPoll updates the count and lastRunAt timestamp", () => {
    recordInstagramPoll();
    recordInstagramPoll();

    const snap = snapshot();
    expect(snap.instagramPolls.last24h).toBe(2);
    expect(snap.instagramPolls.lastRunAt).toBe(new Date(START).toISOString());
    expect(snap.outboundSms.last24h).toBe(0);
    expect(snap.ejoinPolls.last24h.count).toBe(0);
  });

  it("recordHttpRequest aggregates per family inside the 5-minute window", () => {
    recordHttpRequest("kitchen-display");
    recordHttpRequest("kitchen-display");
    recordHttpRequest("catering-admin");

    const snap = snapshot();
    const byFamily = new Map(
      snap.clientPolls.byFamily.map((f) => [f.family, f.count]),
    );
    expect(snap.clientPolls.windowMinutes).toBe(5);
    expect(byFamily.get("kitchen-display")).toBe(2);
    expect(byFamily.get("catering-admin")).toBe(1);
    // Families with zero hits still appear (UI consistency).
    expect(byFamily.get("public")).toBe(0);
    expect(byFamily.get("staff-order-taker")).toBe(0);
    expect(byFamily.get("unmatched-messages")).toBe(0);
    expect(byFamily.get("other-admin")).toBe(0);
    // No SMS / instagram / ejoin side effects.
    expect(snap.outboundSms.last24h).toBe(0);
    expect(snap.ejoinPolls.last24h.count).toBe(0);
    expect(snap.instagramPolls.last24h).toBe(0);
  });

  it("HTTP totals only reflect the trailing 5-minute window", () => {
    // 10 minutes ago: should fall outside the 5-minute HTTP window.
    vi.setSystemTime(START);
    recordHttpRequest("kitchen-display");

    // 1 minute ago: inside the 5-minute window.
    vi.setSystemTime(START + 9 * MS_PER_MINUTE);
    recordHttpRequest("kitchen-display");

    // "now" = T = +10m.
    vi.setSystemTime(START + 10 * MS_PER_MINUTE);
    recordHttpRequest("kitchen-display");

    const snap = snapshot();
    const kd = snap.clientPolls.byFamily.find(
      (f) => f.family === "kitchen-display",
    );
    expect(kd?.count).toBe(2);
  });
});
