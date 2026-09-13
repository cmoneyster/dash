import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bandwidth-accounting regression for task #211.
//
// The "actual measured bytes/poll over the last hour" indicator on the
// admin Idle Activity page is fed by recordEjoinPoll() in idle-metrics.
// fetchInbound() (the listing-page poll) has always recorded its
// bodyBytes; what was missing — and what the Idle Activity vs SMS
// Settings comparison silently undercounted — is the per-port detail
// fetch that runs on every escalated poll cycle (cold start, count
// growth, latest-id flip). This test pins down that BOTH fetches
// contribute to the rolling counter so the operator's "actual" hourly
// figure is honest and directly comparable to the SMS Settings
// estimate.

// We spy on recordEjoinPoll without replacing it — the real function
// must still run so its rolling counter advances; we just need to
// observe the calls.
vi.mock("../idle-metrics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../idle-metrics")>();
  return {
    ...actual,
    recordEjoinPoll: vi.fn(actual.recordEjoinPoll),
  };
});

import * as idleMetrics from "../idle-metrics";
import {
  clearEjoinSessionCache,
  fetchInbound,
  fetchInboundSmsForPort,
} from "../sms-ejoin";

const recordSpy = idleMetrics.recordEjoinPoll as unknown as ReturnType<typeof vi.fn>;

const ORIGINAL_GATEWAY_URL = process.env.EJOIN_GATEWAY_URL;
const ORIGINAL_ADMIN_USER = process.env.EJOIN_ADMIN_USER;
const ORIGINAL_ADMIN_PASS = process.env.EJOIN_ADMIN_PASS;

// Minimal HTML for the login GET: must include a Set-Cookie header that
// matches one of SESSION_COOKIE_PATTERNS and a `cookies_nonce = "..."`
// snippet inside the body so getSessionCookie() can complete step 1.
const LOGIN_GET_BODY =
  '<html><head><script>var cookies_nonce = "deadbeef0123";</script></head><body>login</body></html>';

// Minimal HTML for the login POST: must contain `value="0"` so the
// success-marker check in getSessionCookie() returns true.
const LOGIN_POST_BODY = '<input name="loginStatus" value="0" />';

// A per-port detail page body of known length — we'll assert the
// recorded byte count matches this exact length.
const DETAIL_BODY = "<html><body>" + "X".repeat(2048) + "</body></html>";

// A listing page body — different known length so we can distinguish
// listing bytes from detail bytes in the assertion.
const LISTING_BODY = "<html><body>" + "Y".repeat(1024) + "</body></html>";

function makeResponse(body: string, opts?: { setCookie?: string[] }): Response {
  const headers = new Headers();
  // node fetch's Headers does support multiple values for Set-Cookie via
  // the `set-cookie` key; tests only need a single cookie. Casting to
  // any since the standard Headers type doesn't expose getSetCookie() in
  // older lib.dom.d.ts, but our runtime supports it (used by the real
  // ejoin code).
  const resp = new Response(body, { status: 200, headers });
  if (opts?.setCookie) {
    // Override getSetCookie() to return our injected cookies. The real
    // ejoin code calls resp.headers.getSetCookie() to parse them.
    Object.defineProperty(resp.headers, "getSetCookie", {
      value: () => opts.setCookie,
      configurable: true,
    });
  } else {
    Object.defineProperty(resp.headers, "getSetCookie", {
      value: () => [],
      configurable: true,
    });
  }
  return resp;
}

beforeEach(() => {
  process.env.EJOIN_GATEWAY_URL = "http://gateway.test";
  process.env.EJOIN_ADMIN_USER = "admin";
  process.env.EJOIN_ADMIN_PASS = "password";
  clearEjoinSessionCache();
  idleMetrics._resetIdleMetricsForTests();
  recordSpy.mockClear();
});

afterEach(() => {
  if (ORIGINAL_GATEWAY_URL === undefined) delete process.env.EJOIN_GATEWAY_URL;
  else process.env.EJOIN_GATEWAY_URL = ORIGINAL_GATEWAY_URL;
  if (ORIGINAL_ADMIN_USER === undefined) delete process.env.EJOIN_ADMIN_USER;
  else process.env.EJOIN_ADMIN_USER = ORIGINAL_ADMIN_USER;
  if (ORIGINAL_ADMIN_PASS === undefined) delete process.env.EJOIN_ADMIN_PASS;
  else process.env.EJOIN_ADMIN_PASS = ORIGINAL_ADMIN_PASS;
  vi.unstubAllGlobals();
  clearEjoinSessionCache();
});

describe("ejoin bandwidth accounting (task #211)", () => {
  it("fetchInboundSmsForPort records the per-port detail fetch bytes", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("login")) {
        if (init?.method === "POST") return makeResponse(LOGIN_POST_BODY);
        return makeResponse(LOGIN_GET_BODY, {
          setCookie: ["WEBCC_SESSION=abc123; Path=/"],
        });
      }
      if (u.includes("goip_sms_inbox_details")) {
        return makeResponse(DETAIL_BODY);
      }
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchInboundSmsForPort(7);

    const detailCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("goip_sms_inbox_details"),
    );
    expect(detailCall?.[1]?.method).toBe("POST");
    const posted = new URLSearchParams(String(detailCall?.[1]?.body ?? ""));
    expect(posted.get("selected_port")).toBe("7");
    expect(posted.get("selected_slot")).toBe("0");
    expect(posted.get("items_per_page")).toBe("100");

    // The per-port detail page body MUST have been fed into the
    // bandwidth counter; otherwise the Idle Activity dashboard
    // understates real SIM-gateway traffic during escalated polls
    // (every cold start + every count/latest-id change).
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith(DETAIL_BODY.length);
  });

  it("an escalated poll cycle (listing + detail) records bytes from BOTH fetches", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("login")) {
        if (init?.method === "POST") return makeResponse(LOGIN_POST_BODY);
        return makeResponse(LOGIN_GET_BODY, {
          setCookie: ["WEBCC_SESSION=abc123; Path=/"],
        });
      }
      if (u.includes("goip_sms_inbox_details")) {
        return makeResponse(DETAIL_BODY);
      }
      // Listing page — every other goip_sms_*.html path.
      if (u.includes("goip_sms_")) {
        return makeResponse(LISTING_BODY);
      }
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    // Simulate one escalated cycle: scheduler calls fetchInbound() for
    // the listing pass, then fetchInboundSmsForPort() for the per-port
    // drill-in. Both should land in the rolling counter.
    await fetchInbound();
    await fetchInboundSmsForPort(7);

    expect(recordSpy).toHaveBeenCalledTimes(2);
    const recordedByteCounts = recordSpy.mock.calls.map((c) => c[0] as number);
    expect(recordedByteCounts).toContain(LISTING_BODY.length);
    expect(recordedByteCounts).toContain(DETAIL_BODY.length);

    // Sanity: the rolling counter snapshot reflects the sum, so the
    // Idle Activity "Last hour" figure equals listing + detail bytes,
    // which is the apples-to-apples comparison against the SMS
    // Settings estimate (estimated bytes/hour at the configured
    // cadence).
    const snap = idleMetrics.snapshot({
      smsPoller: { enabled: true, intervalSeconds: 3, inboundMode: "poll" },
      instagramPoller: { enabled: false, intervalMinutes: 5 },
    });
    expect(snap.ejoinPolls.lastHour.bytes).toBe(
      LISTING_BODY.length + DETAIL_BODY.length,
    );
    expect(snap.ejoinPolls.lastHour.count).toBe(2);
    expect(snap.ejoinPolls.lastHour.avgBytesPerPoll).toBe(
      Math.round((LISTING_BODY.length + DETAIL_BODY.length) / 2),
    );
  });
});
