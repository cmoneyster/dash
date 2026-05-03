// Public webhook for the ejointech gateway's "push" delivery mode.
// When EJOIN_INBOUND_MODE=push, the gateway is configured (in its own
// admin UI) to forward every received SMS to {API_BASE}/api/sms/inbound,
// optionally including a shared-secret so we can authenticate the call
// without sitting behind the admin auth middleware.
//
// Two transports are supported on the same route:
//
//   POST /api/sms/inbound  (JSON or form body)
//   GET  /api/sms/inbound  (query string)
//
// EJOIN's "SMS to HTTP" panel typically forwards as an HTTP GET with
// template variables in the URL (e.g. $port, $sn / $phone, $sm / $sms,
// $tm / $time). Use a URL like:
//
//   https://<host>/api/sms/inbound?secret=<SMS_WEBHOOK_SECRET>&port=$port&from=$sn&body=$sm&ts=$tm
//
// Some firmwares also expose an HTTP-Push (POST) mode; both shapes hit
// the same handler.
//
// Authentication: either the `X-Sms-Webhook-Secret` header OR a
// `secret` query/body param must equal env SMS_WEBHOOK_SECRET. If the
// env is unset the webhook 401s every request — push mode requires a
// configured secret. The query-param form exists specifically because
// EJOIN's GET-mode URL template cannot set custom headers.
//
// Field names accepted (case-insensitive, first match wins):
//   - id    : id, messageId, msgid, sms_id, smsid
//   - port  : port, sim, line, channel, slot
//   - from  : from, src, sender, phone, sn
//   - body  : body, content, text, message, sm, sms
//   - ts    : ts, time, date, occurredAt, tm
//
// Only messages on the configured chat port are ingested; others are
// acknowledged with 200 + status='ignored-port' so the gateway won't
// retry forever.

import { Router, type IRouter, type Request, type Response } from "express";
import { timingSafeEqual } from "crypto";
import { ingestInbound } from "../lib/sms-inbox";
import { getChatPort } from "../lib/sms-ejoin";

function secretsMatch(a: string, b: string): boolean {
  // Constant-time equality so attackers can't probe the secret one
  // byte at a time via response-latency differences.
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

const router: IRouter = Router();

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
    const lower = k.toLowerCase();
    for (const ok of Object.keys(obj)) {
      if (ok.toLowerCase() === lower && obj[ok] !== undefined && obj[ok] !== null && obj[ok] !== "") {
        return obj[ok];
      }
    }
  }
  return undefined;
}

function asString(v: unknown): string | null {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (Array.isArray(v) && v.length > 0) return asString(v[0]);
  return null;
}

function parseTs(v: unknown): Date {
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v);
  if (typeof v === "string") {
    // Accept ISO and "yyyy-MM-dd HH:mm:ss" with optional ms / TZ.
    const iso = new Date(v);
    if (!Number.isNaN(iso.getTime())) return iso;
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})[\sT](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) {
      const [, y, mo, d, h, mi, s] = m;
      const d2 = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s ?? "00"}Z`);
      if (!Number.isNaN(d2.getTime())) return d2;
    }
  }
  return new Date();
}

/**
 * Shared handler for POST (JSON/form body) and GET (query string).
 * `raw` is the merged params bag — the caller picks which Express
 * source to pass in.
 */
async function handleInbound(req: Request, res: Response, raw: Record<string, unknown>): Promise<void> {
  try {
    const secret = process.env.SMS_WEBHOOK_SECRET?.trim();
    if (!secret) {
      // Refuse to act as an open relay. Setting the env var is a
      // deliberate operator action that flips push-mode on.
      res.status(401).json({ error: "Webhook secret not configured" });
      return;
    }
    // Accept the secret either as a header (preferred for POST) or as a
    // `secret` query/body param (required for EJOIN's GET-mode URL
    // template, which cannot set custom headers).
    const headerSecret = (req.header("X-Sms-Webhook-Secret") ?? "").trim();
    const paramSecret = asString(pick(raw, ["secret", "token", "key"])) ?? "";
    const supplied = headerSecret || paramSecret;
    if (!supplied || !secretsMatch(supplied, secret)) {
      res.status(401).json({ error: "Invalid webhook secret" });
      return;
    }

    const id = asString(pick(raw, ["id", "messageId", "msgid", "sms_id", "smsid"]));
    const portRaw = pick(raw, ["port", "sim", "line", "channel", "slot"]);
    const from = asString(pick(raw, ["from", "src", "sender", "phone", "sn"]));
    const body = asString(pick(raw, ["body", "content", "text", "message", "sm", "sms"]));
    const ts = parseTs(pick(raw, ["ts", "time", "date", "occurredAt", "tm"]));

    const port = Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 8) {
      res.status(400).json({ error: "Invalid or missing port" });
      return;
    }
    if (!from || !body) {
      res.status(400).json({ error: "Missing 'from' or 'body'" });
      return;
    }
    const chatPort = await getChatPort();
    if (chatPort == null) {
      // No customer-chat port configured. Per spec we MUST NOT ingest
      // arbitrary inbound from any port — owner-alert SIMs share the
      // gateway and would leak unrelated traffic into the catering
      // chat threads. Acknowledge with 200 so the gateway doesn't
      // retry forever, but mark the result so operators can spot the
      // misconfiguration in their gateway logs.
      res.json({ ok: true, status: "ignored-chat-port-unset" });
      return;
    }
    if (port !== chatPort) {
      // Other ports are owned by the round-robin staff pool — we don't
      // ingest those. Acknowledge so the gateway stops retrying.
      res.json({ ok: true, status: "ignored-port" });
      return;
    }
    const gatewayMessageId = id ?? `webhook:${from}:${ts.toISOString()}:${body.slice(0, 24)}`;
    const result = await ingestInbound({
      gatewayMessageId,
      fromPhone: from,
      body,
      occurredAt: ts,
      port,
    });
    res.json({ ok: true, ...result });
  } catch (err: unknown) {
    req.log.error({ err }, "Error in /api/sms/inbound webhook");
    res.status(500).json({ error: "Webhook processing failed" });
  }
}

// Mounted under /api in app.ts, so the public path is /api/sms/inbound.
router.post("/sms/inbound", async (req, res) => {
  await handleInbound(req, res, (req.body ?? {}) as Record<string, unknown>);
});

// EJOIN "SMS to HTTP" forwards as a GET with template vars in the URL
// (and no custom headers). The secret travels as `?secret=...`.
router.get("/sms/inbound", async (req, res) => {
  await handleInbound(req, res, (req.query ?? {}) as Record<string, unknown>);
});

export default router;
