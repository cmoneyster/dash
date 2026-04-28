// ejointech SMS via web UI session auth
// Uses EJOIN_ADMIN_USER / EJOIN_ADMIN_PASS for web login, then POSTs to goip_sms_en.html
// Port pool is loaded from event_settings.sms_active_ports (round-robin) so admins
// can opt into spreading load across SIMs without redeploying. Per-call port
// override is supported for the "Send test" flow on the SMS settings page.
//
// In addition to the round-robin sender, this module exposes:
//   - sendSmsToCustomer(): always resolves to the saved chat port from
//     event_settings.sms_chat_port. Used for every client-bound send.
//   - fetchInboundSms(): polls the gateway's SMS inbox page and returns
//     parsed messages on the chat port. The inbound ingester calls this on
//     a short interval when push-mode (EJOIN_INBOUND_MODE=push) isn't
//     configured.

import { createHash } from "crypto";
import { db } from "@workspace/db";
import { eventSettingsTable, cateringInquiriesTable, phoneBlocklistTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

// Sentinel error so callers (and the guarded customer-send wrapper)
// can distinguish "blocklisted recipient" from generic gateway errors
// without tying themselves to a string match.
export class BlocklistedRecipientError extends Error {
  readonly reason: "customer-opt-out" | "admin-blocked";
  constructor(reason: "customer-opt-out" | "admin-blocked") {
    super(`Recipient is on the SMS blocklist (${reason}); send refused.`);
    this.name = "BlocklistedRecipientError";
    this.reason = reason;
  }
}

// Small inline lookup so this module doesn't have to import sms-inbox
// (which would create a circular dependency: sms-inbox imports from
// here). The query is cheap — single row lookup on a unique key.
async function lookupBlocklistReason(
  phoneDigits: string,
): Promise<"customer-opt-out" | "admin-blocked" | null> {
  if (!phoneDigits) return null;
  try {
    const [row] = await db
      .select({ reason: phoneBlocklistTable.reason })
      .from(phoneBlocklistTable)
      .where(eq(phoneBlocklistTable.phone, phoneDigits));
    if (!row) return null;
    return (row.reason as "customer-opt-out" | "admin-blocked") ?? null;
  } catch {
    // If the lookup fails we fall through to allow — losing the safety
    // net is preferable to silently dropping owner notifications when
    // the DB is briefly unavailable.
    return null;
  }
}

const PORT_CACHE_TTL_MS = 10_000;
let portCache: { ports: number[]; expiresAt: number } | null = null;
let chatPortCache: { port: number | null; expiresAt: number } | null = null;
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
  chatPortCache = null;
}

// Resolve the dedicated customer chat port from event_settings. Returns
// null if the admin hasn't picked one yet — callers should treat that
// as "feature not configured" and short-circuit gracefully.
export async function getChatPort(): Promise<number | null> {
  const now = Date.now();
  if (chatPortCache && chatPortCache.expiresAt > now) return chatPortCache.port;
  let port: number | null = null;
  try {
    const [row] = await db
      .select({ smsChatPort: eventSettingsTable.smsChatPort })
      .from(eventSettingsTable)
      .where(eq(eventSettingsTable.id, 1));
    const raw = row?.smsChatPort ?? null;
    if (raw != null && Number.isInteger(raw) && raw >= 1 && raw <= EJOIN_PORT_COUNT) {
      port = raw;
    }
  } catch (err) {
    console.warn("[ejoin] failed to read chat port — chat send will be skipped", err);
  }
  chatPortCache = { port, expiresAt: now + PORT_CACHE_TTL_MS };
  return port;
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

// GoIP-class firmware uses a few different session cookie names depending
// on the build. Default firmware ships `auth_XXXX=hex`; rebadged
// revisions have been observed using `WEBCC_*`, `goip_*`, plain
// `JSESSIONID`/`PHPSESSID`, or `SESSION`/`SID`. The original cookie
// regex pinned both the name (`auth_*`) and the value shape (`[a-f0-9]+`),
// so any non-default firmware silently fell out as "no session cookie
// from login page". We accept any of these patterns now, and stop
// constraining the value at all — we just hand the cookie back through
// the exact `name=value` pair the gateway sent.
const SESSION_COOKIE_PATTERNS: RegExp[] = [
  /^auth_\w+$/i,
  /^WEBCC[_-]?\w*$/i,
  /^goip[_-]?\w*$/i,
  /^(?:JSESSIONID|PHPSESSID|SESSION(?:ID)?|SID|sid)$/i,
];

// Login page paths we'll try, in order. Most firmware exposes
// `login_en.html`; some Chinese-only / older builds drop the `_en` or
// serve the login form directly off the index. EJOIN_LOGIN_PATH lets the
// admin override without redeploying when none of the defaults match.
const LOGIN_PATH_CANDIDATES: string[] = [
  process.env.EJOIN_LOGIN_PATH?.trim().replace(/^\//, ""),
  "login_en.html",
  "login.html",
  "index_en.html",
  "index.html",
].filter((p): p is string => !!p);

type CookieKV = { name: string; value: string };

// Parse the array of full Set-Cookie header values into the leading
// name=value pair (cookie attributes after `;` are dropped — we don't
// need Path/Domain/Expires for session reuse on the same origin).
function parseSetCookies(setCookies: string[]): CookieKV[] {
  const out: CookieKV[] = [];
  for (const raw of setCookies) {
    const semi = raw.indexOf(";");
    const pair = (semi === -1 ? raw : raw.slice(0, semi)).trim();
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name && value) out.push({ name, value });
  }
  return out;
}

// Pick the cookie that's most likely the gateway's session token. Walks
// the allow-list in order so the most specific match (auth_*) wins over
// generic ones. When a server emits multiple Set-Cookie headers with the
// same name we keep the LAST one — that mirrors how browsers resolve
// duplicates and matches the common rotate-token pattern.
//
// `source` distinguishes a confident allow-list match from the
// last-resort fallback so the caller can decide whether a downstream
// failure (e.g. login rejected) is a credential problem (matched cookie)
// or a wrong-cookie problem worth retrying on another login path.
type SessionPick = { cookie: CookieKV; source: "matched" | "fallback" };

function pickSessionCookie(cookies: CookieKV[]): SessionPick | null {
  for (const pattern of SESSION_COOKIE_PATTERNS) {
    let hit: CookieKV | null = null;
    for (const c of cookies) if (pattern.test(c.name)) hit = c; // last wins
    if (hit) return { cookie: hit, source: "matched" };
  }
  // Fallback only when there's exactly one cookie — multiple unknown
  // cookies are too ambiguous to guess. Single-cookie responses are
  // common on stripped-down firmware so this still helps the long tail.
  if (cookies.length === 1) return { cookie: cookies[0], source: "fallback" };
  return null;
}

function summarizeCookieNames(cookies: CookieKV[]): string {
  if (cookies.length === 0) return "(none)";
  return cookies.map(c => c.name).join(", ");
}

async function getSessionCookie(cfg: {
  baseUrl: string;
  adminUser: string;
  adminPass: string;
}): Promise<string> {
  // Per-attempt diagnostic context. When every candidate path fails we
  // throw an error containing the whole array so the admin sees exactly
  // what the gateway returned (status code, cookie names, body snippet)
  // without needing to crack open the api-server log.
  type Attempt = { path: string; status: number; cookies: string; bodyHead: string };
  const attempts: Attempt[] = [];

  for (const path of LOGIN_PATH_CANDIDATES) {
    const loginUrl = `${cfg.baseUrl}/${path}`;

    // Step 1: GET login page — grab session cookie + nonce embedded in JS.
    //
    // GoIP firmware soft-rate-limits its login form: when too many
    // logins land in a short window it returns HTTP 503 ("Server Busy")
    // for ~minutes before clearing on its own. That same window also
    // catches us when our own inbound poller is doing the hammering.
    // So when we see a 503 (or a network timeout / reset) on the GET,
    // wait briefly and try the same path once more before recording it
    // as failed. Real config errors (404 = wrong path, malformed HTML,
    // missing cookie) still bail out immediately.
    let getResp: Response | null = null;
    let getErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      getErr = null;
      try {
        getResp = await fetch(loginUrl, { signal: AbortSignal.timeout(10_000) });
      } catch (err) {
        getResp = null;
        getErr = err;
      }
      const transient = getErr != null || (getResp != null && getResp.status === 503);
      if (!transient || attempt === 1) break;
      await new Promise(r => setTimeout(r, 400));
    }
    if (!getResp) {
      attempts.push({
        path,
        status: 0,
        cookies: `(network error: ${getErr instanceof Error ? getErr.message : String(getErr)})`,
        bodyHead: "",
      });
      continue;
    }

    const cookies = parseSetCookies(getResp.headers.getSetCookie());
    const pick = pickSessionCookie(cookies);
    const pageText = await getResp.text();

    if (!pick) {
      attempts.push({
        path,
        status: getResp.status,
        cookies: summarizeCookieNames(cookies),
        bodyHead: pageText.slice(0, 200).replace(/\s+/g, " ").trim(),
      });
      continue;
    }

    const nonceMatch = pageText.match(/cookies_nonce\s*=\s*"([a-f0-9]+)"/);
    if (!nonceMatch) {
      attempts.push({
        path,
        status: getResp.status,
        cookies: `${pick.cookie.name} (got cookie, but no cookies_nonce in page)`,
        bodyHead: pageText.slice(0, 200).replace(/\s+/g, " ").trim(),
      });
      continue;
    }
    const nonce = nonceMatch[1];

    // Step 2: POST login — hex_md5(user:pass:nonce)
    const hash    = createHash("md5").update(`${cfg.adminUser}:${cfg.adminPass}:${nonce}`).digest("hex");
    const encoded = `${cfg.adminUser}:${hash}`;

    const body = new URLSearchParams({ encoded, nonce: "", loginStatus: "-1" });

    // Mirror the GET stage: the login POST hits the same rate-limited
    // endpoint, so it can also return 503 (or hang the connection) when
    // we land inside a lockout window. One-shot retry with a short
    // backoff lets us shake off a transient blip without surfacing the
    // failure; auth/credential failures still fall through to the
    // success-marker check below.
    let postResp: Response | null = null;
    let postErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      postErr = null;
      try {
        postResp = await fetch(loginUrl, {
          method:  "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie:         `${pick.cookie.name}=${pick.cookie.value}`,
          },
          body:   body.toString(),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        postResp = null;
        postErr = err;
      }
      const transient = postErr != null || (postResp != null && postResp.status === 503);
      if (!transient || attempt === 1) break;
      await new Promise(r => setTimeout(r, 400));
    }
    if (!postResp) {
      attempts.push({
        path,
        status: 0,
        cookies: `${pick.cookie.name} (login POST network error: ${postErr instanceof Error ? postErr.message : String(postErr)})`,
        bodyHead: "",
      });
      continue;
    }

    const postText = await postResp.text();

    // loginStatus="0" in the response page means success.
    if (!postText.includes('value="0"') && !postText.includes("initStatus==\"0\"")) {
      // Distinguish two failure modes:
      //   - We picked a cookie via the allow-list (`matched`) and the
      //     gateway still rejected the login → credentials are wrong;
      //     no point retrying with another path that has the same
      //     login form and the same secrets.
      //   - We guessed via the single-cookie `fallback` → the cookie
      //     we sent probably wasn't the session at all; record and
      //     keep trying other paths before giving up.
      const bodyHead = postText.slice(0, 200).replace(/\s+/g, " ").trim();
      const attempt: Attempt = {
        path,
        status: postResp.status,
        cookies: pick.source === "matched"
          ? `${pick.cookie.name} (login rejected)`
          : `${pick.cookie.name} (fallback pick, login rejected)`,
        bodyHead,
      };
      attempts.push(attempt);
      if (pick.source === "matched") {
        // Same warn shape as the all-paths-failed terminal branch so
        // ops sees consistent context regardless of which branch fires.
        console.warn(
          "[ejoin] login rejected — credentials look wrong",
          { attempts },
        );
        throw new Error(
          `ejointech: admin login failed at ${path} (HTTP ${postResp.status}, cookie ${pick.cookie.name}) — ` +
          `check EJOIN_ADMIN_USER / EJOIN_ADMIN_PASS. Body head: ${bodyHead || "(empty)"}`,
        );
      }
      continue;
    }

    // Prefer the post-login Set-Cookie if the gateway rotated the
    // session token; otherwise reuse the cookie we got on the GET.
    const postCookies = parseSetCookies(postResp.headers.getSetCookie());
    const postPick = pickSessionCookie(postCookies);
    const finalCookie = postPick?.cookie ?? pick.cookie;

    return `${finalCookie.name}=${finalCookie.value}`;
  }

  // Every path returned without a usable session cookie. Build a single
  // human-readable summary so it surfaces both in the api-server log
  // and verbatim on the SMS settings page.
  const summary = attempts
    .map(a => `${a.path}: HTTP ${a.status}, cookies=[${a.cookies}]`)
    .join(" | ");
  console.warn("[ejoin] login failed — no session cookie from any login path", { attempts });
  throw new Error(
    `ejointech: gateway login failed — no recognized session cookie from any login path. ` +
    `Confirm EJOIN_GATEWAY_URL points at the GoIP web UI (not the SMS API or a reverse proxy that strips Set-Cookie). ` +
    `Tried: ${summary}`,
  );
}

// ── Session cookie cache ──────────────────────────────────────────────────────
//
// Without caching, every outbound send and every inbound poll cycle calls
// getSessionCookie() and re-authenticates from scratch. That's fine for
// one-off sends, but ruinous for the inbound poller: it fires every 3s
// whenever a customer chat port is set, which works out to ~20 gateway
// logins per minute around the clock. GoIP firmware silently rate-limits
// its login form (HTTP 503 "Server Busy") once it sees that volume, which
// then breaks every SMS feature in the app — quote sends, owner alerts,
// low-stock alerts, customer chat — for several minutes at a time.
//
// We hold one authenticated cookie per process for SESSION_TTL_MS
// (default 10 min, overridable via EJOIN_SESSION_TTL_SECONDS). Concurrent
// cache misses are deduped through an in-flight promise so a burst of
// poller + outbound calls only triggers one login. Callers that detect a
// stale session (response shows the login page or 401/403) call
// invalidateSessionCache() and retry once with a fresh cookie before
// surfacing the failure.
const SESSION_TTL_MS: number = (() => {
  const raw = process.env.EJOIN_SESSION_TTL_SECONDS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n * 1000);
  }
  return 10 * 60_000;
})();

let sessionCache: { cookie: string; expiresAt: number } | null = null;
let sessionInflight: Promise<string> | null = null;

function invalidateSessionCache(): void {
  sessionCache = null;
}

// Public escape hatch (mirrors clearEjoinPortCache) so future callers
// can force a re-login — e.g. an admin "rotate session" button or a
// settings save that rotates EJOIN_ADMIN_PASS.
export function clearEjoinSessionCache(): void {
  invalidateSessionCache();
}

async function getCachedSessionCookie(cfg: {
  baseUrl: string;
  adminUser: string;
  adminPass: string;
}): Promise<string> {
  const now = Date.now();
  if (sessionCache && sessionCache.expiresAt > now) return sessionCache.cookie;
  if (sessionInflight) return sessionInflight;
  sessionInflight = (async () => {
    try {
      const cookie = await getSessionCookie(cfg);
      sessionCache = { cookie, expiresAt: Date.now() + SESSION_TTL_MS };
      return cookie;
    } finally {
      sessionInflight = null;
    }
  })();
  return sessionInflight;
}

// Heuristic: a gateway response that contains login-form markup means
// our session cookie is no longer valid (idle timeout, gateway reboot,
// admin password rotation, etc). Used by sendSmsViaEjoin and
// fetchInboundSms to invalidate the cached cookie and retry once with
// a fresh login before surfacing the error to the user.
//
// We match a STRUCTURAL HTML signal — an unescaped <form> element
// whose action attribute points at a login_*.html path — never plain
// substrings of body text. This matters because the inbox response
// embeds user-supplied SMS content; if we matched against substrings
// like "Login restricted" or "cookies_nonce", an attacker could text
// the gateway one of those strings and the 3-second poller would
// flap into a re-auth loop on every cycle, recreating the very rate-
// limit lockout this cache is meant to prevent. The gateway HTML-
// escapes message bodies into inbox table cells, so a raw `<form>`
// tag with that action attribute cannot appear inside a user's
// message — it only appears when the gateway itself is serving the
// login page. We also lean on 401/403 status codes (handled at the
// call sites) as a second, content-independent signal.
const LOGIN_FORM_RE = /<form[^>]+action\s*=\s*["']?[^"' >]*login[^"' >]*\.html/i;

function looksLikeLoginPage(body: string): boolean {
  return LOGIN_FORM_RE.test(body);
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

  const phone  = normalizePhone(to);

  // App-wide blocklist enforcement at the actual send boundary. Every
  // SMS path eventually funnels through here, so this is the single
  // checkpoint that guarantees we never text a phone the admin (or
  // the recipient via STOP) has told us not to. Callers that want a
  // structured response can catch BlocklistedRecipientError; the
  // guarded customer-send wrapper does this and converts it to a
  // {status:'blocked'} result for the API.
  const blockedReason = await lookupBlocklistReason(phone);
  if (blockedReason) {
    throw new BlocklistedRecipientError(blockedReason);
  }

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

  // One inner POST attempt with a given cookie. We hand the response
  // back as a structured result so the outer wrapper can decide whether
  // to invalidate the cached cookie and re-login (HTTP 401/403 or the
  // gateway returning the login HTML inside a 200 response are all
  // session-rejection signals).
  const attemptSend = async (cookie: string): Promise<{
    text: string;
    status: number;
    rejected: boolean;
  }> => {
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
    // Genuine non-auth gateway errors (500, 502, 503 from the SMS form
    // itself) should fail fast — those aren't fixable by re-logging in.
    if (!resp.ok && resp.status !== 401 && resp.status !== 403) {
      throw new Error(`ejointech SMS POST failed: HTTP ${resp.status}`);
    }
    const text = await resp.text();
    // SEND-path detection can be more permissive than the inbox path:
    // this response is the gateway's own reply to a SEND form POST and
    // never embeds inbound SMS content, so substring markers cannot be
    // smuggled in via a malicious text. We add the literal "Login
    // restricted" / "login_en.html" markers as a backup signal in case
    // a firmware variant emits the lockout page without the structural
    // <form action="login_*.html"> element our shared detector keys on.
    const rejected =
      !resp.ok ||
      looksLikeLoginPage(text) ||
      text.includes("Login restricted") ||
      text.includes("login_en.html");
    return { text, status: resp.status, rejected };
  };

  let cookie = await getCachedSessionCookie(cfg);
  let result = await attemptSend(cookie);
  if (result.rejected) {
    // Cached session looks stale (idle timeout, gateway reboot, or
    // creds rotated). Re-authenticate once and retry; if it still
    // rejects after a fresh login, surface the failure.
    invalidateSessionCache();
    cookie = await getCachedSessionCookie(cfg);
    result = await attemptSend(cookie);
    if (result.rejected) {
      throw new Error(
        "ejointech: session rejected after fresh login — gateway may be IP-blocking the app or admin credentials are wrong",
      );
    }
  }

  // Distill the gateway's HTML response into a one-liner the admin UI can
  // surface. The send page typically embeds a status hint we can grep for;
  // when nothing matches we fall back to a generic "accepted" string with
  // the HTTP status so the admin still gets useful feedback.
  const gatewayResponse = summarizeGatewayResponse(result.text, result.status);

  console.info(`[ejoin] SMS sent to ${phone} via port ${port}: ${gatewayResponse}`);

  // Regression sanity log: if this send went out on the round-robin
  // pool (no portOverride) but the destination phone matches a known
  // catering customer, that's almost certainly a bug — every customer-
  // facing send should funnel through sendSmsToCustomer / the chat
  // port so threads stay coherent. We don't block the send (legitimate
  // use cases like owner notifications happen to share helpers) but we
  // log loudly so the regression shows up in production logs. Done as
  // fire-and-forget so the DB lookup never blocks the actual send.
  if (opts?.portOverride == null) {
    const chatPort = await getChatPort().catch(() => null);
    if (port !== chatPort) {
      void warnIfKnownCustomer(phone, port);
    }
  }

  return { port, gatewayResponse };
}

// Best-effort lookup. Errors are swallowed — the log is diagnostic, not
// load-bearing, and we don't want an unrelated DB hiccup to surface as
// SMS-send failures.
async function warnIfKnownCustomer(phone: string, usedPort: number): Promise<void> {
  try {
    const candidates = await db
      .select({ id: cateringInquiriesTable.id, clientPhone: cateringInquiriesTable.clientPhone })
      .from(cateringInquiriesTable)
      .limit(500);
    const match = candidates.find(c => normalizePhone(c.clientPhone ?? "") === phone);
    if (match) {
      console.warn(
        `[sms-sanity] Sent to known catering customer ${phone} (inquiry #${match.id}) on port ${usedPort} — not the chat port. Use sendSmsToCustomer() so the thread stays consistent.`,
      );
    }
  } catch {
    // best-effort
  }
}

// Convenience wrapper for every client-bound send. Resolves the saved
// chat port and forwards to sendSmsViaEjoin with that as a port override.
// Throws when no chat port is configured so call sites surface a clear
// error instead of silently degrading to the round-robin pool.
export async function sendSmsToCustomer(
  to: string,
  message: string,
): Promise<{ port: number; gatewayResponse: string }> {
  const port = await getChatPort();
  if (port == null) {
    throw new Error(
      "No customer chat port configured. Pick one in Admin → SMS → Customer Chat Port.",
    );
  }
  return sendSmsViaEjoin(to, message, { portOverride: port });
}

// ── Inbound: gateway-mode detection ───────────────────────────────────────────

// Two ways the gateway can deliver inbound SMS:
//
//   "push" — the gateway is configured to POST inbound to a URL we own
//            (the public webhook below at /api/sms/inbound). Detected
//            by the presence of EJOIN_INBOUND_MODE=push.
//   "poll" — we periodically scrape the gateway's "SMS inbox" page
//            ourselves. Default mode when the env var is absent or set
//            to "poll".
//
// The settings card surfaces this as read-only text so the admin knows
// which path inbound is wired through without having to log into the
// gateway hardware.
export type EjoinInboundMode = "push" | "poll";
export function getInboundMode(): EjoinInboundMode {
  const v = process.env.EJOIN_INBOUND_MODE?.trim().toLowerCase();
  return v === "push" ? "push" : "poll";
}

// ── Inbound: poller ───────────────────────────────────────────────────────────

export type InboundSms = {
  // Gateway-supplied row id (stable across poll runs). We dedupe on this.
  gatewayMessageId: string;
  port: number;
  fromPhone: string;
  body: string;
  occurredAt: Date;
};

// Structured result from one inbox-fetch attempt. Carried up through
// the wrappers so both the live poller log and the diagnostics endpoint
// see exactly which path the gateway answered on, what HTTP status it
// returned, and how big the response body was.
type InboxAttemptResult = {
  html: string | null;
  rejected: boolean;
  lastErr: unknown;
  successPath: string | null;
  httpStatus: number | null;
  bodyBytes: number;
  loginPageDetected: boolean;
  triedPaths: string[];
};

function inboxCandidatePaths(): string[] {
  return [
    process.env.EJOIN_SMS_INBOX_PATH?.trim().replace(/^\//, ""),
    "goip_sms_inbox_en.html",
    "goip_sms_recv_en.html",
    "goip_sms_inbox.html",
  ].filter((p): p is string => !!p);
}

// Try every candidate inbox path with the supplied cookie. Returns
// a structured result so the outer wrapper can detect a stale session
// (401/403, or some firmware just serves the login HTML inside a 200)
// and decide whether to invalidate the cached cookie and retry once
// with a fresh login.
async function attemptFetchInbox(
  baseUrl: string,
  cookie: string,
  candidates: string[],
): Promise<InboxAttemptResult> {
  const tried: string[] = [];
  let lastErr: unknown = null;
  // Retain the last HTTP status + body size we actually saw so that a
  // run where every candidate returned (e.g.) 404 does not surface as
  // "httpStatus:null". Operators rely on these fields to distinguish
  // "gateway is reachable but the path is wrong" from "gateway is
  // unreachable / threw network errors at every attempt".
  let lastHttpStatus: number | null = null;
  let lastBodyBytes = 0;
  for (const path of candidates) {
    tried.push(path);
    try {
      const resp = await fetch(`${baseUrl}/${path}`, {
        headers: { Cookie: cookie, Referer: `${baseUrl}/${path}` },
        signal: AbortSignal.timeout(15_000),
      });
      lastHttpStatus = resp.status;
      if (resp.status === 401 || resp.status === 403) {
        return {
          html: null, rejected: true, lastErr: null,
          successPath: null, httpStatus: resp.status, bodyBytes: 0,
          loginPageDetected: false, triedPaths: tried,
        };
      }
      if (resp.ok) {
        const body = await resp.text();
        lastBodyBytes = body?.length ?? 0;
        if (body && body.length > 0) {
          // Some firmware returns 200 + the login HTML when the
          // session is stale instead of redirecting; treat that as a
          // rejection so we re-authenticate rather than try to parse
          // the login form as an SMS table.
          if (looksLikeLoginPage(body)) {
            return {
              html: null, rejected: true, lastErr: null,
              successPath: path, httpStatus: resp.status, bodyBytes: body.length,
              loginPageDetected: true, triedPaths: tried,
            };
          }
          return {
            html: body, rejected: false, lastErr: null,
            successPath: path, httpStatus: resp.status, bodyBytes: body.length,
            loginPageDetected: false, triedPaths: tried,
          };
        }
      } else {
        // Drain a small snippet so the body buffer is freed promptly
        // and update lastBodyBytes for diagnostics. We don't keep the
        // body itself — a hard HTTP error with a multi-KB error page
        // is not interesting beyond its size.
        try {
          const body = await resp.text();
          lastBodyBytes = body?.length ?? 0;
        } catch {
          // ignore drain errors
        }
      }
    } catch (err) {
      lastErr = err;
    }
  }
  return {
    html: null, rejected: false, lastErr,
    successPath: null, httpStatus: lastHttpStatus, bodyBytes: lastBodyBytes,
    loginPageDetected: false, triedPaths: tried,
  };
}

// Top-level wrapper: handles cached cookie + one-shot retry on a
// rejected session. Returns the same structured result the diagnostics
// endpoint surfaces directly.
async function fetchInboxWithRetry(): Promise<{
  result: InboxAttemptResult;
  retried: boolean;
  rejectedAfterRetry: boolean;
} | null> {
  const cfg = getCredentials();
  if (!cfg) return null;
  const candidates = inboxCandidatePaths();
  let cookie = await getCachedSessionCookie(cfg);
  let result = await attemptFetchInbox(cfg.baseUrl, cookie, candidates);
  let retried = false;
  let rejectedAfterRetry = false;
  if (result.rejected) {
    invalidateSessionCache();
    cookie = await getCachedSessionCookie(cfg);
    result = await attemptFetchInbox(cfg.baseUrl, cookie, candidates);
    retried = true;
    if (result.rejected) rejectedAfterRetry = true;
  }
  return { result, retried, rejectedAfterRetry };
}

// Pull recent inbound SMS from the gateway's web UI. Best-effort HTML
// parser — the GoIP firmware returns an HTML table whose exact column
// order varies slightly between firmware revisions, so we look for
// recognizable shapes (E.164-ish "from" number, port digit, ISO-ish
// date, body) and skip rows we can't interpret rather than throwing.
//
// The opts let callers narrow the window (default last 24h for live
// poll, larger for backfill).
export async function fetchInboundSms(opts?: {
  sinceMs?: number;
  portFilter?: number | null;
}): Promise<InboundSms[]> {
  const wrapped = await fetchInboxWithRetry();
  if (!wrapped) return [];
  const { result, retried, rejectedAfterRetry } = wrapped;
  if (rejectedAfterRetry) {
    // Two consecutive rejections (cached cookie + brand-new login)
    // means the gateway is actively refusing us — IP-block, wrong
    // credentials, or every poll cycle will quietly produce zero
    // messages. Surface a warning so the issue is visible in the
    // log instead of silently returning an empty list forever.
    console.warn(
      "[ejoin] inbound poll: session rejected even after fresh login — gateway may be IP-blocking the app or admin credentials are wrong",
    );
  }
  if (!result.html) {
    if (result.lastErr) console.warn("[ejoin] inbound poll failed", result.lastErr);
    // One structured line per failed cycle so the operator can tell
    // "all paths returned empty bodies" apart from "every path threw"
    // apart from "session got rejected even after re-login".
    logger.warn(
      {
        triedPaths: result.triedPaths,
        rejected: result.rejected,
        retried,
        rejectedAfterRetry,
        loginPageDetected: result.loginPageDetected,
        httpStatus: result.httpStatus,
        bodyBytes: result.bodyBytes,
        lastErr: result.lastErr ? String(result.lastErr) : null,
      },
      "[ejoin] inbound fetch: no usable HTML",
    );
    return [];
  }
  const parsed = parseInboundSmsHtml(result.html, opts);
  // One structured line per successful cycle. Captures everything an
  // operator needs to tell the difference between "fetch is fine but
  // the parser dropped every row" and "gateway returned no rows".
  logger.info(
    {
      successPath: result.successPath,
      httpStatus: result.httpStatus,
      bodyBytes: result.bodyBytes,
      loginPageDetected: result.loginPageDetected,
      retried,
      portFilter: opts?.portFilter ?? null,
      sinceMs: opts?.sinceMs ?? null,
      parsedRows: parsed.length,
    },
    "[ejoin] inbound fetch",
  );
  return parsed;
}

// Read-only diagnostics view used by the admin "inbound diagnostics"
// endpoint. Returns the raw fetch metadata + parsed rows WITHOUT any
// since/port filter so the operator can see exactly what the gateway
// is serving regardless of the chat-port and backfill-window settings.
export type InboxDiagnosticsResult = {
  ejoinConfigured: boolean;
  triedPaths: string[];
  successPath: string | null;
  httpStatus: number | null;
  bodyBytes: number;
  bodyHead: string;
  loginPageDetected: boolean;
  rejected: boolean;
  retried: boolean;
  rejectedAfterRetry: boolean;
  parsedRows: InboundSms[];
  fetchError: string | null;
};

export async function fetchInboxRaw(): Promise<InboxDiagnosticsResult> {
  // Diagnostics MUST never throw — operators hit this endpoint
  // precisely when the gateway is misbehaving (wrong credentials,
  // network unreachable, login form changed, etc), so any error must
  // come back as structured JSON they can read in the admin UI rather
  // than a 500. Login failures originate inside fetchInboxWithRetry
  // (via getCachedSessionCookie) and would otherwise bubble out.
  let wrapped: Awaited<ReturnType<typeof fetchInboxWithRetry>>;
  try {
    wrapped = await fetchInboxWithRetry();
  } catch (err) {
    return {
      ejoinConfigured: true,
      triedPaths: [],
      successPath: null,
      httpStatus: null,
      bodyBytes: 0,
      bodyHead: "",
      loginPageDetected: false,
      rejected: false,
      retried: false,
      rejectedAfterRetry: false,
      parsedRows: [],
      fetchError: err instanceof Error ? err.message : String(err),
    };
  }
  if (!wrapped) {
    return {
      ejoinConfigured: false,
      triedPaths: [],
      successPath: null,
      httpStatus: null,
      bodyBytes: 0,
      bodyHead: "",
      loginPageDetected: false,
      rejected: false,
      retried: false,
      rejectedAfterRetry: false,
      parsedRows: [],
      fetchError: null,
    };
  }
  const { result, retried, rejectedAfterRetry } = wrapped;
  const parsedRows = result.html ? parseInboundSmsHtml(result.html) : [];
  return {
    ejoinConfigured: true,
    triedPaths: result.triedPaths,
    successPath: result.successPath,
    httpStatus: result.httpStatus,
    bodyBytes: result.bodyBytes,
    bodyHead: result.html ? result.html.slice(0, 400) : "",
    loginPageDetected: result.loginPageDetected,
    rejected: result.rejected,
    retried,
    rejectedAfterRetry,
    parsedRows,
    fetchError: result.lastErr ? String(result.lastErr) : null,
  };
}

// Best-effort HTML scraper. The GoIP "received SMS" page renders a
// <table> whose <tr>s look roughly like:
//   <tr><td>123</td><td>1</td><td>+15551234567</td><td>...</td>
//       <td>2026-04-27 10:15:30</td><td>hello world</td></tr>
// We pull every <tr>, then for each row try to find:
//   - a port (1..8 isolated cell)
//   - a phone number (digits with optional +/spaces, 7+ digits)
//   - an ISO-ish timestamp
//   - the longest remaining cell as the body
// Rows missing any of those are skipped. The id is taken from the
// first numeric-only cell, falling back to a hash of phone+date+body
// so cross-deploy dedupe still works for older rows.
export function parseInboundSmsHtml(
  html: string,
  opts?: { sinceMs?: number; portFilter?: number | null },
): InboundSms[] {
  const since = opts?.sinceMs ?? 0;
  const portFilter = opts?.portFilter ?? null;
  const out: InboundSms[] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      const text = cellMatch[1]
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .trim();
      cells.push(text);
    }
    if (cells.length < 3) continue;
    // Identify candidate fields.
    let id: string | null = null;
    let port: number | null = null;
    let from: string | null = null;
    let when: Date | null = null;
    let body: string | null = null;
    for (const c of cells) {
      if (id == null && /^\d{1,12}$/.test(c) && Number(c) > 8) {
        id = c;
        continue;
      }
      if (port == null && /^[1-8]$/.test(c)) {
        port = Number(c);
        continue;
      }
      if (from == null && /[+]?\d[\d\s\-().]{6,}$/.test(c.replace(/\s/g, "")) && c.replace(/\D/g, "").length >= 7 && c.length < 30) {
        from = c;
        continue;
      }
      if (when == null) {
        const m = c.match(/(\d{4})[-/](\d{2})[-/](\d{2})[\sT](\d{2}):(\d{2})(?::(\d{2}))?/);
        if (m) {
          const [, y, mo, d, h, mi, s] = m;
          when = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s ?? "00"}Z`);
          if (Number.isNaN(when.getTime())) when = null;
          else continue;
        }
      }
    }
    // Pick the longest leftover cell as the body candidate.
    const usedSet = new Set([id, String(port ?? ""), from ?? ""]);
    body = cells
      .filter((c) => !usedSet.has(c))
      .sort((a, b) => b.length - a.length)[0] ?? null;
    if (!port || !from || !body) continue;
    if (portFilter != null && port !== portFilter) continue;
    if (when && when.getTime() < since) continue;
    const fromDigits = normalizePhone(from);
    const ts = when ?? new Date();
    const stableId = id ?? `synth:${fromDigits}:${ts.toISOString()}:${body.slice(0, 24)}`;
    out.push({
      gatewayMessageId: stableId,
      port,
      fromPhone: fromDigits,
      body,
      occurredAt: ts,
    });
  }
  return out;
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
