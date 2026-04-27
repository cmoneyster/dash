// ejointech SMS via web UI session auth
// Uses EJOIN_ADMIN_USER / EJOIN_ADMIN_PASS for web login, then POSTs to goip_sms_en.html
// Port pool is loaded from event_settings.sms_active_ports (round-robin) so admins
// can opt into spreading load across SIMs without redeploying. Per-call port
// override is supported for the "Send test" flow on the SMS settings page.

import { createHash } from "crypto";
import { db } from "@workspace/db";
import { eventSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

const PORT_CACHE_TTL_MS = 10_000;
let portCache: { ports: number[]; expiresAt: number } | null = null;
// Module-scoped counter so successive sends across requests round-robin
// through the configured ports. Reset on cache invalidation isn't needed —
// modulo by current pool length keeps it correct after pool changes.
let rrCounter = 0;

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

function getCredentials() {
  const baseUrl   = process.env.EJOIN_GATEWAY_URL?.trim();
  const adminUser = process.env.EJOIN_ADMIN_USER?.trim();
  const adminPass = process.env.EJOIN_ADMIN_PASS?.trim();
  if (!baseUrl || !adminUser || !adminPass) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), adminUser, adminPass };
}

export function isEjoinConfigured(): boolean {
  return getCredentials() !== null;
}

// Invalidate the port cache after admins save changes so the next send
// picks up the new pool without waiting for the TTL.
export function clearEjoinPortCache(): void {
  portCache = null;
}

// Read the active port pool from event_settings (id=1). Falls back to env
// EJOIN_SMS_PORT (or 7) when the DB has no rows / the column is empty so
// pre-rollout deployments still send. The result is cached briefly to avoid
// hammering the DB on burst sends (e.g. multi-recipient low-stock alerts).
async function getActivePorts(): Promise<number[]> {
  const now = Date.now();
  if (portCache && portCache.expiresAt > now) return portCache.ports;
  let ports: number[] = [];
  try {
    const [row] = await db
      .select({ smsActivePorts: eventSettingsTable.smsActivePorts })
      .from(eventSettingsTable)
      .where(eq(eventSettingsTable.id, 1));
    // Defensive clamp to the 8-port hardware envelope. Legacy DB rows or
    // env values referencing ports 9–32 (from older multi-gateway setups)
    // are silently dropped rather than dispatched to non-existent SIMs.
    ports = (row?.smsActivePorts ?? [])
      .map(p => Number(p))
      .filter(p => Number.isFinite(p) && Number.isInteger(p) && p >= 1 && p <= EJOIN_PORT_COUNT);
  } catch (err) {
    console.warn("[ejoin] failed to read active port pool — falling back to env", err);
  }
  if (ports.length === 0) {
    const envPort = Number(process.env.EJOIN_SMS_PORT ?? "7");
    ports = Number.isFinite(envPort) && envPort >= 1 && envPort <= EJOIN_PORT_COUNT ? [envPort] : [7];
  }
  portCache = { ports, expiresAt: now + PORT_CACHE_TTL_MS };
  return ports;
}

function nextPort(pool: number[]): number {
  const idx = rrCounter % pool.length;
  // Wrap before MAX_SAFE_INTEGER to keep the counter bounded forever.
  rrCounter = (rrCounter + 1) % 1_000_000;
  return pool[idx];
}

async function getSessionCookie(cfg: {
  baseUrl: string;
  adminUser: string;
  adminPass: string;
}): Promise<string> {
  const loginUrl = `${cfg.baseUrl}/login_en.html`;

  // Step 1: GET login page — grab session cookie + nonce embedded in JS
  const getResp = await fetch(loginUrl, { signal: AbortSignal.timeout(10_000) });

  const setCookie   = getResp.headers.get("set-cookie") ?? "";
  const nameMatch   = setCookie.match(/(auth_[^=]+)=([a-f0-9]+)/);
  if (!nameMatch) throw new Error("ejointech: no session cookie from login page");
  const [, cookieName, cookieVal] = nameMatch;

  const pageText  = await getResp.text();
  const nonceMatch = pageText.match(/cookies_nonce\s*=\s*"([a-f0-9]+)"/);
  if (!nonceMatch) throw new Error("ejointech: no nonce found in login page");
  const nonce = nonceMatch[1];

  // Step 2: POST login — hex_md5(user:pass:nonce)
  const hash    = createHash("md5").update(`${cfg.adminUser}:${cfg.adminPass}:${nonce}`).digest("hex");
  const encoded = `${cfg.adminUser}:${hash}`;

  const body = new URLSearchParams({ encoded, nonce: "", loginStatus: "-1" });

  const postResp = await fetch(loginUrl, {
    method:  "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie:         `${cookieName}=${cookieVal}`,
    },
    body:   body.toString(),
    signal: AbortSignal.timeout(10_000),
  });

  const postText = await postResp.text();

  // loginStatus="0" in the response page means success
  if (!postText.includes('value="0"') && !postText.includes("initStatus==\"0\"")) {
    throw new Error("ejointech: admin login failed — check EJOIN_ADMIN_USER / EJOIN_ADMIN_PASS");
  }

  // The post-login Set-Cookie is the authenticated session token
  const postCookie = postResp.headers.get("set-cookie") ?? "";
  const postMatch  = postCookie.match(/(auth_[^=]+)=([a-f0-9]+)/);
  const authCookie = postMatch
    ? `${postMatch[1]}=${postMatch[2]}`
    : `${cookieName}=${cookieVal}`;

  return authCookie;
}

// The ejointech gateway hardware exposes 8 physical SIM ports (1..8).
// Centralized here so the admin UI, route validation, and runtime checks
// all stay in sync if the hardware ever changes.
export const EJOIN_PORT_COUNT = 8;
export const EJOIN_VALID_PORTS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8];

// Returns the port that was actually used and a short gateway response
// summary (so callers like the admin test-send endpoint can surface both
// the round-robin choice and the gateway acknowledgement to the UI).
export async function sendSmsViaEjoin(
  to: string,
  message: string,
  opts?: { portOverride?: number },
): Promise<{ port: number; gatewayResponse: string }> {
  const cfg = getCredentials();
  if (!cfg) throw new Error("ejointech gateway not configured");

  // Resolve the gateway port: explicit override (test send) bypasses the
  // round-robin, otherwise pick the next port from the configured pool.
  let port: number;
  if (opts?.portOverride != null) {
    const p = Number(opts.portOverride);
    if (!Number.isInteger(p) || p < 1 || p > EJOIN_PORT_COUNT) {
      throw new Error(`Invalid port override: ${opts.portOverride} (must be 1-${EJOIN_PORT_COUNT})`);
    }
    port = p;
  } else {
    const pool = await getActivePorts();
    port = nextPort(pool);
  }

  const cookie = await getSessionCookie(cfg);
  const phone  = normalizePhone(to);

  const body = new URLSearchParams({
    command:           "goip_send_sms",
    goip_cmd_port:     String(port),
    selected_port:     "0",
    selected_slot:     "0",
    goip_sms_dst:      phone,
    goip_sms_send:     message,
    goip_sms_sent:     "0",
    goip_sms_sendfail: "0",
  });

  const resp = await fetch(`${cfg.baseUrl}/goip_sms_en.html`, {
    method:  "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie:         cookie,
      Referer:        `${cfg.baseUrl}/goip_sms_en.html`,
    },
    body:   body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    throw new Error(`ejointech SMS POST failed: HTTP ${resp.status}`);
  }

  const text = await resp.text();
  if (text.includes("Login restricted") || text.includes("login_en.html")) {
    throw new Error("ejointech: session rejected after login — IP may be blocked");
  }

  // Distill the gateway's HTML response into a one-liner the admin UI can
  // surface. The send page typically embeds a status hint we can grep for;
  // when nothing matches we fall back to a generic "accepted" string with
  // the HTTP status so the admin still gets useful feedback.
  const gatewayResponse = summarizeGatewayResponse(text, resp.status);

  console.info(`[ejoin] SMS sent to ${phone} via port ${port}: ${gatewayResponse}`);
  return { port, gatewayResponse };
}

// The GoIP send-SMS page returns a full HTML document. Surface only the
// short status indicator (e.g. the value of an embedded result field, or
// a "Send..." line if present) so the admin UI doesn't have to deal with
// markup. Conservative — if we can't find a meaningful snippet, return a
// generic OK marker so callers still see *something* informative.
function summarizeGatewayResponse(html: string, httpStatus: number): string {
  // Look for explicit numeric result codes the GoIP firmware embeds, e.g.
  // <input ... value="0"> means OK.
  const result = /name=["']?send_result["']?[^>]*value=["']([^"']+)["']/i.exec(html);
  if (result) return `result=${result[1]}`;
  // Otherwise grab the first short text line that mentions "Send" or "SMS".
  const line = html
    .split(/\r?\n/)
    .map(l => l.replace(/<[^>]+>/g, "").trim())
    .find(l => l.length > 0 && l.length < 200 && /(send|sms|port)/i.test(l));
  if (line) return line.slice(0, 160);
  return `accepted (HTTP ${httpStatus})`;
}
