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
    ports = (row?.smsActivePorts ?? [])
      .map(p => Number(p))
      .filter(p => Number.isFinite(p) && Number.isInteger(p) && p >= 1 && p <= 32);
  } catch (err) {
    console.warn("[ejoin] failed to read active port pool — falling back to env", err);
  }
  if (ports.length === 0) {
    const envPort = Number(process.env.EJOIN_SMS_PORT ?? "7");
    ports = Number.isFinite(envPort) && envPort >= 1 && envPort <= 32 ? [envPort] : [7];
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

// Returns the port that was actually used to send (so callers like the
// admin test-send endpoint can surface the round-robin choice to the UI).
export async function sendSmsViaEjoin(
  to: string,
  message: string,
  opts?: { portOverride?: number },
): Promise<number> {
  const cfg = getCredentials();
  if (!cfg) throw new Error("ejointech gateway not configured");

  // Resolve the gateway port: explicit override (test send) bypasses the
  // round-robin, otherwise pick the next port from the configured pool.
  let port: number;
  if (opts?.portOverride != null) {
    const p = Number(opts.portOverride);
    if (!Number.isInteger(p) || p < 1 || p > 32) {
      throw new Error(`Invalid port override: ${opts.portOverride}`);
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

  console.info(`[ejoin] SMS sent to ${phone} via port ${port}`);
  return port;
}
