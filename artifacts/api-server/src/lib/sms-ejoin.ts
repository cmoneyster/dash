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

    // Step 1: GET login page — grab session cookie + nonce embedded in JS
    let getResp: Response;
    try {
      getResp = await fetch(loginUrl, { signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      attempts.push({
        path,
        status: 0,
        cookies: `(network error: ${err instanceof Error ? err.message : String(err)})`,
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

    const postResp = await fetch(loginUrl, {
      method:  "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie:         `${pick.cookie.name}=${pick.cookie.value}`,
      },
      body:   body.toString(),
      signal: AbortSignal.timeout(10_000),
    });

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
      if (pick.source === "matched") {
        throw new Error(
          `ejointech: admin login failed at ${path} (HTTP ${postResp.status}) — check EJOIN_ADMIN_USER / EJOIN_ADMIN_PASS`,
        );
      }
      attempts.push({
        path,
        status: postResp.status,
        cookies: `${pick.cookie.name} (fallback pick, login rejected)`,
        bodyHead: postText.slice(0, 200).replace(/\s+/g, " ").trim(),
      });
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
  const cfg = getCredentials();
  if (!cfg) return [];
  const cookie = await getSessionCookie(cfg);
  // Try the documented inbox page; firmware typically exposes one of
  // these. Configurable via EJOIN_SMS_INBOX_PATH for unusual firmware.
  const candidates = [
    process.env.EJOIN_SMS_INBOX_PATH?.trim().replace(/^\//, ""),
    "goip_sms_inbox_en.html",
    "goip_sms_recv_en.html",
    "goip_sms_inbox.html",
  ].filter((p): p is string => !!p);
  let html: string | null = null;
  let lastErr: unknown = null;
  for (const path of candidates) {
    try {
      const resp = await fetch(`${cfg.baseUrl}/${path}`, {
        headers: { Cookie: cookie, Referer: `${cfg.baseUrl}/${path}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (resp.ok) {
        html = await resp.text();
        if (html && html.length > 0) break;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  if (!html) {
    if (lastErr) console.warn("[ejoin] inbound poll failed", lastErr);
    return [];
  }
  return parseInboundSmsHtml(html, opts);
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
