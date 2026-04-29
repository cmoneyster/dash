import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Locks down the SMS_OUTBOUND_MODE=shadow gate added under task #203.
//
// The dual-environment hazard the gate exists to fix:
//   Two api-server processes (e.g. a development workspace and a
//   published production deployment) point at the same physical SIM
//   gateway via shared EJOIN_GATEWAY_URL credentials. Each maintains
//   its own database with independent settings, so the per-DB dedupe
//   sentinel inside sms-inbox.ts cannot prevent the second process
//   from also responding to the same gateway message — including
//   sending corrective "couldn't relay your reply" texts back to the
//   owner over the same SIM the first process just relayed on.
//
// The gate's contract:
//   1. With SMS_OUTBOUND_MODE=shadow, every send entry point in
//      sms-ejoin.ts becomes a no-op that returns the same shape a
//      live send would have produced (so callers keep type-checking
//      and observe a "successful" send).
//   2. The shadow check runs BEFORE credential, port-pool, blocklist,
//      or chat-port lookups so a misconfigured dev workspace still
//      no-ops cleanly without throwing "ejointech gateway not
//      configured" or "no chat port".
//   3. Any unrecognised value (typo, empty string, "live") MUST fall
//      through to the live path. A misconfiguration must NEVER
//      silently muzzle a production deployment.

import { sendSmsViaEjoin, sendSmsViaChatPort, getSmsOutboundMode } from "../sms-ejoin";

// Capture original env so we can restore between cases. Vitest's
// process.env mutations leak across files in the same worker, so the
// afterEach restore is load-bearing.
const ORIGINAL_MODE = process.env.SMS_OUTBOUND_MODE;
const ORIGINAL_GATEWAY_URL = process.env.EJOIN_GATEWAY_URL;
const ORIGINAL_ADMIN_USER = process.env.EJOIN_ADMIN_USER;
const ORIGINAL_ADMIN_PASS = process.env.EJOIN_ADMIN_PASS;

beforeEach(() => {
  // Wipe every gateway-credential env so any test that DOESN'T set
  // shadow mode hits the "ejointech gateway not configured" guard
  // rather than reaching for the real gateway over the network. The
  // shadow-mode tests don't care about credentials because the gate
  // returns before reading them.
  delete process.env.SMS_OUTBOUND_MODE;
  delete process.env.EJOIN_GATEWAY_URL;
  delete process.env.EJOIN_ADMIN_USER;
  delete process.env.EJOIN_ADMIN_PASS;
});

afterEach(() => {
  if (ORIGINAL_MODE === undefined) delete process.env.SMS_OUTBOUND_MODE;
  else process.env.SMS_OUTBOUND_MODE = ORIGINAL_MODE;
  if (ORIGINAL_GATEWAY_URL === undefined) delete process.env.EJOIN_GATEWAY_URL;
  else process.env.EJOIN_GATEWAY_URL = ORIGINAL_GATEWAY_URL;
  if (ORIGINAL_ADMIN_USER === undefined) delete process.env.EJOIN_ADMIN_USER;
  else process.env.EJOIN_ADMIN_USER = ORIGINAL_ADMIN_USER;
  if (ORIGINAL_ADMIN_PASS === undefined) delete process.env.EJOIN_ADMIN_PASS;
  else process.env.EJOIN_ADMIN_PASS = ORIGINAL_ADMIN_PASS;
  vi.restoreAllMocks();
});

describe("getSmsOutboundMode — env parsing", () => {
  it("returns 'live' when SMS_OUTBOUND_MODE is unset", () => {
    expect(getSmsOutboundMode()).toBe("live");
  });

  it("returns 'shadow' for SMS_OUTBOUND_MODE=shadow", () => {
    process.env.SMS_OUTBOUND_MODE = "shadow";
    expect(getSmsOutboundMode()).toBe("shadow");
  });

  it("returns 'shadow' regardless of casing or surrounding whitespace", () => {
    process.env.SMS_OUTBOUND_MODE = "  SHADOW  ";
    expect(getSmsOutboundMode()).toBe("shadow");
  });

  it("returns 'live' for SMS_OUTBOUND_MODE=live (explicit)", () => {
    process.env.SMS_OUTBOUND_MODE = "live";
    expect(getSmsOutboundMode()).toBe("live");
  });

  it("fail-safe defaults to 'live' for any unrecognised value (typo guard)", () => {
    // The single most important invariant of the gate: a typo on the
    // env var must NEVER silently disable production sends. Anything
    // that isn't literally "shadow" is treated as live.
    for (const v of ["shadw", "SHADO", "off", "disabled", "dry-run", "true", "1", ""]) {
      process.env.SMS_OUTBOUND_MODE = v;
      expect(getSmsOutboundMode()).toBe("live");
    }
  });
});

describe("sendSmsViaEjoin — shadow-mode short-circuit", () => {
  it("returns a success-shape response without calling fetch in shadow mode", async () => {
    process.env.SMS_OUTBOUND_MODE = "shadow";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("should-not-be-called"));
    const result = await sendSmsViaEjoin("+15551234567", "hello world");
    expect(result.gatewayResponse).toBe("suppressed:shadow-mode");
    // Port falls back to 0 when no override was passed (no DB lookup
    // is performed in shadow mode — we don't pretend to have resolved
    // the round-robin pool).
    expect(typeof result.port).toBe("number");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("respects portOverride for the logged port even in shadow mode", async () => {
    process.env.SMS_OUTBOUND_MODE = "shadow";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));
    const result = await sendSmsViaEjoin("+15551234567", "hi", { portOverride: 7 });
    // The send-test admin button passes a port — surface it back so
    // any UI that displays "sent on port N" still sees the right N.
    expect(result.port).toBe(7);
    expect(result.gatewayResponse).toBe("suppressed:shadow-mode");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT short-circuit when SMS_OUTBOUND_MODE is unset (production default)", async () => {
    // No env, no credentials → must reach the configured-credentials
    // guard and throw the canonical error. If shadow somehow leaked
    // into the live path, this would return suppressed instead.
    await expect(sendSmsViaEjoin("+15551234567", "hi")).rejects.toThrow(/not configured/);
  });

  it("does NOT short-circuit for SMS_OUTBOUND_MODE=live (explicit live)", async () => {
    process.env.SMS_OUTBOUND_MODE = "live";
    await expect(sendSmsViaEjoin("+15551234567", "hi")).rejects.toThrow(/not configured/);
  });

  it("does NOT short-circuit for an unrecognised SMS_OUTBOUND_MODE (typo fail-safe)", async () => {
    // A typo'd env var on production must behave identically to unset
    // — never silently no-op outbound traffic.
    process.env.SMS_OUTBOUND_MODE = "shadw";
    await expect(sendSmsViaEjoin("+15551234567", "hi")).rejects.toThrow(/not configured/);
  });
});

describe("sendSmsViaChatPort — shadow-mode short-circuit", () => {
  it("returns a success-shape response without touching the chat-port lookup in shadow mode", async () => {
    // Critically, this test does NOT set up a chat port in the DB.
    // If shadow mode were checked AFTER getChatPort(), this would
    // throw "no chat port configured". The fact that it returns
    // cleanly proves the gate runs first.
    process.env.SMS_OUTBOUND_MODE = "shadow";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));
    const result = await sendSmsViaChatPort("+15551234567", "rejection text body");
    expect(result.gatewayResponse).toBe("suppressed:shadow-mode");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT short-circuit when SMS_OUTBOUND_MODE=live (explicit live)", async () => {
    // With shadow disabled and no credentials, the chat-port wrapper
    // delegates to sendSmsViaEjoin which throws "not configured".
    // (Some test environments may have a chat port saved in the DB,
    // in which case the throw will instead come from the credential
    // guard inside sendSmsViaEjoin — either way, the assertion is
    // that the wrapper does not return the suppressed shape.)
    process.env.SMS_OUTBOUND_MODE = "live";
    await expect(sendSmsViaChatPort("+15551234567", "hi")).rejects.toThrow();
  });
});
