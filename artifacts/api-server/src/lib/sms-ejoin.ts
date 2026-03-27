// ejointech SMS via web UI session
// Auth: GET /login_en.html → nonce → POST MD5 hash → session cookie
// Send: POST /goip_sms_en.html with command=goip_send_sms

import { createHash } from "crypto";

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1); // strip +1
  return digits;
}

function getConfig() {
  const baseUrl = process.env.EJOIN_GATEWAY_URL?.trim();
  const user    = process.env.EJOIN_USER?.trim();
  const pass    = process.env.EJOIN_PASS?.trim();
  const port    = process.env.EJOIN_SMS_PORT?.trim() || "7";
  if (!baseUrl || !user || !pass) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), user, pass, port };
}

export function isEjoinConfigured(): boolean {
  return getConfig() !== null;
}

async function getSessionCookie(cfg: {
  baseUrl: string;
  user: string;
  pass: string;
}): Promise<string> {
  const loginUrl = `${cfg.baseUrl}/login_en.html`;

  // Step 1: GET login page — captures nonce from embedded JS and session cookie
  const getResp = await fetch(loginUrl, { signal: AbortSignal.timeout(10_000) });

  const setCookie = getResp.headers.get("set-cookie") ?? "";
  const nameMatch = setCookie.match(/(auth_[^=]+)=([a-f0-9]+)/);
  if (!nameMatch) throw new Error("ejointech: no session cookie from login page");
  const [, cookieName, cookieVal] = nameMatch;

  const pageText = await getResp.text();
  const nonceMatch = pageText.match(/cookies_nonce\s*=\s*"([a-f0-9]+)"/);
  if (!nonceMatch) throw new Error("ejointech: no nonce found in login page");
  const nonce = nonceMatch[1];

  // Step 2: POST login — MD5(user:pass:nonce)
  const hash    = createHash("md5").update(`${cfg.user}:${cfg.pass}:${nonce}`).digest("hex");
  const encoded = `${cfg.user}:${hash}`;

  const body = new URLSearchParams({
    encoded,
    nonce:       "",
    loginStatus: "-1",
  });

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
  if (!postText.includes("main_en.html")) {
    throw new Error("ejointech: login failed — check EJOIN_USER / EJOIN_PASS");
  }

  return `${cookieName}=${cookieVal}`;
}

export async function sendSmsViaEjoin(to: string, message: string): Promise<void> {
  const cfg = getConfig();
  if (!cfg) throw new Error("ejointech gateway not configured");

  const cookie = await getSessionCookie(cfg);
  const phone  = normalizePhone(to);

  const body = new URLSearchParams({
    command:          "goip_send_sms",
    goip_cmd_port:    cfg.port,
    selected_port:    "0",
    selected_slot:    "0",
    goip_sms_dst:     phone,
    goip_sms_send:    message,
    goip_sms_sent:    "0",
    goip_sms_sendfail:"0",
  });

  const resp = await fetch(`${cfg.baseUrl}/goip_sms_en.html`, {
    method:  "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie:         cookie,
    },
    body:   body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    throw new Error(`ejointech SMS POST failed: HTTP ${resp.status}`);
  }

  const text = await resp.text();
  if (text.includes("Login restricted") || text.includes("login_en.html")) {
    throw new Error("ejointech: session rejected — IP may be locked out");
  }

  console.info(`[ejoin] SMS sent to ${phone} via port ${cfg.port}`);
}
