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
import { logger } from "../logger";

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
    // Spy on the shared logger so we can prove the suppression event is
    // observable in production logs — operators rely on this exact
    // string to grep for "did dev silently no-op a real send?".
    const loggerSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    const result = await sendSmsViaEjoin("+15551234567", "hello world");
    expect(result.gatewayResponse).toBe("suppressed:shadow-mode");
    // Port falls back to 0 when no override was passed (no DB lookup
    // is performed in shadow mode — we don't pretend to have resolved
    // the round-robin pool).
    expect(typeof result.port).toBe("number");
    expect(fetchSpy).not.toHaveBeenCalled();
    // Lock down the suppression log line itself: pino-style
    // (objectPayload, message). The message string is the operator-
    // facing contract grep'd for in deployment logs.
    expect(loggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ fn: "sendSmsViaEjoin", bodyLen: "hello world".length }),
      "[sms-outbound] suppressed (SMS_OUTBOUND_MODE=shadow)",
    );
  });

  it("respects portOverride for the logged port even in shadow mode", async () => {
    process.env.SMS_OUTBOUND_MODE = "shadow";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));
    const loggerSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    const result = await sendSmsViaEjoin("+15551234567", "hi", { portOverride: 7 });
    // The send-test admin button passes a port — surface it back so
    // any UI that displays "sent on port N" still sees the right N.
    expect(result.port).toBe(7);
    expect(result.gatewayResponse).toBe("suppressed:shadow-mode");
    expect(fetchSpy).not.toHaveBeenCalled();
    // Suppression log must reflect the override port so a "sent on
    // port N" admin display matches the log line.
    expect(loggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ fn: "sendSmsViaEjoin", port: 7 }),
      "[sms-outbound] suppressed (SMS_OUTBOUND_MODE=shadow)",
    );
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
    const loggerSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    const result = await sendSmsViaChatPort("+15551234567", "rejection text body");
    expect(result.gatewayResponse).toBe("suppressed:shadow-mode");
    expect(fetchSpy).not.toHaveBeenCalled();
    // Same operator-facing log contract as sendSmsViaEjoin, but
    // tagged with the chat-port function name so an operator can
    // tell which entry point suppressed the send.
    expect(loggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ fn: "sendSmsViaChatPort", bodyLen: "rejection text body".length }),
      "[sms-outbound] suppressed (SMS_OUTBOUND_MODE=shadow)",
    );
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

// End-to-end-shaped lock for the actual hazard that triggered task #203.
//
// In sms-inbox.ts, when an inbound text comes from the owner phone but
// owner-reply routing is disabled (the dev workspace's setting), the
// `notifyOwnerOfRejection` path calls:
//
//     await sendSmsViaChatPort(ownerDigits, OWNER_REJECT_MESSAGES[reason]);
//
// (see sms-inbox.ts ~line 458). That single call was the source of the
// "couldn't relay your reply" texts dev was sending over the shared SIM
// while prod was already relaying the same inbound correctly. Locking
// down the call site here means: even if a future refactor moves the
// rejection logic, as long as it still funnels through
// sendSmsViaChatPort, the shadow gate will continue to suppress it.
describe("owner-reply-disabled rejection path under shadow mode", () => {
  it("suppresses the rejection text the way notifyOwnerOfRejection in sms-inbox.ts would call it", async () => {
    process.env.SMS_OUTBOUND_MODE = "shadow";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope"));
    const loggerSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    // Mirror the exact call signature from sms-inbox.ts:
    //   sendSmsViaChatPort(ownerDigits, OWNER_REJECT_MESSAGES[reason])
    // We pass a representative owner-reply-disabled rejection body so
    // bodyLen in the suppression log matches what would appear in
    // production deployment logs.
    const ownerDigits = "12405551212";
    const rejectionBody =
      "Owner replies aren't relayed right now. Reply with #<id> <message> to send to a specific inquiry.";
    const result = await sendSmsViaChatPort(ownerDigits, rejectionBody);
    expect(result.gatewayResponse).toBe("suppressed:shadow-mode");
    // The exact assertion that would have prevented the original
    // incident: the gateway is never contacted for a rejection text
    // when shadow mode is on.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(loggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ fn: "sendSmsViaChatPort", bodyLen: rejectionBody.length }),
      "[sms-outbound] suppressed (SMS_OUTBOUND_MODE=shadow)",
    );
  });
});
