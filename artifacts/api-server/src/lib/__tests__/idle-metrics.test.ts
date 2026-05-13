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

    const snap = snapshot({ smsPoller: { enabled: true, intervalSeconds: 3, inboundMode: "poll" }, instagramPoller: { enabled: true, intervalMinutes: 30 } });

    // Only the T = +25h event lives in the last hour.
    expect(snap.ejoinPolls.lastHour.count).toBe(1);
    expect(snap.ejoinPolls.lastHour.bytes).toBe(500);
    // 500 bytes / 1 poll = 500 avg.
    expect(snap.ejoinPolls.lastHour.avgBytesPerPoll).toBe(500);
    expect(snap.outboundSms.lastHour).toBe(1);

    // Last 24h includes T = +2h and T = +25h, but NOT T = 0.
    expect(snap.ejoinPolls.last24h.count).toBe(2);
    expect(snap.ejoinPolls.last24h.bytes).toBe(2500);
    // 2500 bytes / 2 polls = 1250 avg.
    expect(snap.ejoinPolls.last24h.avgBytesPerPoll).toBe(1250);
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

    const snap = snapshot({ smsPoller: { enabled: true, intervalSeconds: 3, inboundMode: "poll" }, instagramPoller: { enabled: true, intervalMinutes: 30 } });
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
    const snap = snapshot({ smsPoller: { enabled: true, intervalSeconds: 3, inboundMode: "poll" }, instagramPoller: { enabled: true, intervalMinutes: 30 } });
    expect(snap.ejoinPolls.last24h.count).toBe(24 * 60);
    expect(snap.ejoinPolls.last24h.bytes).toBe(24 * 60 * 10);
    // Every poll recorded exactly 10 bytes, so the rolling average is 10.
    expect(snap.ejoinPolls.last24h.avgBytesPerPoll).toBe(10);
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

    const snap = snapshot({ smsPoller: { enabled: true, intervalSeconds: 3, inboundMode: "poll" }, instagramPoller: { enabled: true, intervalMinutes: 30 } });
    expect(snap.ejoinPolls.last24h.count).toBe(4);
    // 1234 + 0 + max(0, -50) + floor(7.9) = 1234 + 0 + 0 + 7 = 1241
    expect(snap.ejoinPolls.last24h.bytes).toBe(1241);
    // 1241 / 4 = 310.25, rounded to 310 for stable display.
    expect(snap.ejoinPolls.last24h.avgBytesPerPoll).toBe(310);
    expect(snap.outboundSms.last24h).toBe(0);
    expect(snap.instagramPolls.last24h).toBe(0);
    expect(snap.instagramPolls.lastRunAt).toBeNull();
  });

  it("avgBytesPerPoll is null when no polls landed inside the window", () => {
    // No recordEjoinPoll calls — count is 0, so the derived average
    // must be null instead of NaN/0 so the UI can render a "no data
    // yet" placeholder.
    recordOutboundSms();
    const snap = snapshot({ smsPoller: { enabled: true, intervalSeconds: 3, inboundMode: "poll" }, instagramPoller: { enabled: true, intervalMinutes: 30 } });
    expect(snap.ejoinPolls.lastHour.count).toBe(0);
    expect(snap.ejoinPolls.lastHour.avgBytesPerPoll).toBeNull();
    expect(snap.ejoinPolls.last24h.count).toBe(0);
    expect(snap.ejoinPolls.last24h.avgBytesPerPoll).toBeNull();
  });

  it("recordOutboundSms only touches smsOutbound", () => {
    recordOutboundSms();
    recordOutboundSms();
    recordOutboundSms();

    const snap = snapshot({ smsPoller: { enabled: true, intervalSeconds: 3, inboundMode: "poll" }, instagramPoller: { enabled: true, intervalMinutes: 30 } });
    expect(snap.outboundSms.lastHour).toBe(3);
    expect(snap.outboundSms.last24h).toBe(3);
    expect(snap.ejoinPolls.last24h.count).toBe(0);
    expect(snap.ejoinPolls.last24h.bytes).toBe(0);
    expect(snap.instagramPolls.last24h).toBe(0);
  });

  it("recordInstagramPoll updates the count and lastRunAt timestamp", () => {
    recordInstagramPoll();
    recordInstagramPoll();

    const snap = snapshot({ smsPoller: { enabled: true, intervalSeconds: 3, inboundMode: "poll" }, instagramPoller: { enabled: true, intervalMinutes: 30 } });
    expect(snap.instagramPolls.last24h).toBe(2);
    expect(snap.instagramPolls.lastRunAt).toBe(new Date(START).toISOString());
    expect(snap.outboundSms.last24h).toBe(0);
    expect(snap.ejoinPolls.last24h.count).toBe(0);
  });

  it("recordHttpRequest aggregates per family inside the 5-minute window", () => {
    recordHttpRequest("kitchen-display", "/event-ordering/items");
    recordHttpRequest("kitchen-display", "/event-ordering/items");
    recordHttpRequest("catering-admin", "/admin/catering/menu");

    const snap = snapshot({ smsPoller: { enabled: true, intervalSeconds: 3, inboundMode: "poll" }, instagramPoller: { enabled: true, intervalMinutes: 30 } });
    const byFamily = new Map(
      snap.clientPolls.last5min.map((f) => [f.family, f.count]),
    );
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
    recordHttpRequest("kitchen-display", "/event-ordering/items");

    // 1 minute ago: inside the 5-minute window.
    vi.setSystemTime(START + 9 * MS_PER_MINUTE);
    recordHttpRequest("kitchen-display", "/event-ordering/items");

    // "now" = T = +10m.
    vi.setSystemTime(START + 10 * MS_PER_MINUTE);
    recordHttpRequest("kitchen-display", "/event-ordering/items");

    const snap = snapshot({ smsPoller: { enabled: true, intervalSeconds: 3, inboundMode: "poll" }, instagramPoller: { enabled: true, intervalMinutes: 30 } });
    const kd = snap.clientPolls.last5min.find(
      (f) => f.family === "kitchen-display",
    );
    expect(kd?.count).toBe(2);
  });

  it("recordHttpRequest groups hits by normalized endpoint within each family", () => {
    // Two different order IDs under the same template, plus a separate
    // settings endpoint. After normalization the per-endpoint breakdown
    // should show 2 hits for /event-taker/orders/:id/payment and 1 hit
    // for /event-taker/settings — not three distinct rows.
    recordHttpRequest("staff-order-taker", "/event-taker/orders/:id/payment");
    recordHttpRequest("staff-order-taker", "/event-taker/orders/:id/payment");
    recordHttpRequest("staff-order-taker", "/event-taker/settings");

    const snap = snapshot({ smsPoller: { enabled: true, intervalSeconds: 3, inboundMode: "poll" }, instagramPoller: { enabled: true, intervalMinutes: 30 } });
    const taker = snap.clientPolls.last5min.find((f) => f.family === "staff-order-taker");
    expect(taker?.count).toBe(3);
    expect(taker?.endpoints).toEqual([
      { path: "/event-taker/orders/:id/payment", count: 2 },
      { path: "/event-taker/settings", count: 1 },
    ]);

    // Zero-count families surface an empty endpoints array so the UI
    // can still render a stable row without conditional logic.
    const publicFam = snap.clientPolls.last5min.find((f) => f.family === "public");
    expect(publicFam?.count).toBe(0);
    expect(publicFam?.endpoints).toEqual([]);
  });
});

describe("idle-metrics normalizePath", () => {
  it("collapses numeric and UUID segments to :id and strips /api prefix", async () => {
    const { normalizePath } = await import("../idle-metrics");
    expect(normalizePath("/api/event-taker/orders/47")).toBe("/event-taker/orders/:id");
    expect(normalizePath("/api/admin/messages/by-inquiry/123")).toBe(
      "/admin/messages/by-inquiry/:id",
    );
    expect(normalizePath("/api/admin/messages/unmatched/123/block-sender")).toBe(
      "/admin/messages/unmatched/:id/block-sender",
    );
    expect(normalizePath("/api/event-taker/settings")).toBe("/event-taker/settings");
    expect(
      normalizePath("/api/admin/messages/by-inquiry/01923f00-1234-4567-8abc-0123456789ab"),
    ).toBe("/admin/messages/by-inquiry/:id");
    // Non-/api paths are passed through unchanged so public site
    // requests keep their full path in the breakdown.
    expect(normalizePath("/about")).toBe("/about");
    // Empty / root paths render as "/" rather than "".
    expect(normalizePath("/api")).toBe("/");
  });
});
