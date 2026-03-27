// ejointech SMS via web UI session auth
// Uses EJOIN_ADMIN_USER / EJOIN_ADMIN_PASS for web login, then POSTs to goip_sms_en.html
// Port selection via EJOIN_SMS_PORT (default "7")

import { createHash } from "crypto";

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

function getConfig() {
  const baseUrl   = process.env.EJOIN_GATEWAY_URL?.trim();
  const adminUser = process.env.EJOIN_ADMIN_USER?.trim();
  const adminPass = process.env.EJOIN_ADMIN_PASS?.trim();
  const port      = process.env.EJOIN_SMS_PORT?.trim() || "7";
  if (!baseUrl || !adminUser || !adminPass) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), adminUser, adminPass, port };
}

export function isEjoinConfigured(): boolean {
  return getConfig() !== null;
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

export async function sendSmsViaEjoin(to: string, message: string): Promise<void> {
  const cfg = getConfig();
  if (!cfg) throw new Error("ejointech gateway not configured");

  const cookie = await getSessionCookie(cfg);
  const phone  = normalizePhone(to);

  const body = new URLSearchParams({
    command:           "goip_send_sms",
    goip_cmd_port:     cfg.port,
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

  console.info(`[ejoin] SMS sent to ${phone} via port ${cfg.port}`);
}
