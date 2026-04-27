// Public webhook for the ejointech gateway's "push" delivery mode.
// When EJOIN_INBOUND_MODE=push, the gateway is configured (in its own
// admin UI) to POST every received SMS to {API_BASE}/api/sms/inbound,
// optionally including a shared-secret header so we can authenticate
// the call without sitting behind the admin auth middleware.
//
// Authentication: header `X-Sms-Webhook-Secret` must equal env
// SMS_WEBHOOK_SECRET. If the env is unset the webhook 401s every
// request — push mode requires a configured secret.
//
// Body shape: we accept a permissive set of field names because the
// gateway firmware is configurable (admin can pick variable names in
// the gateway's "HTTP Push" UI). We extract:
//   - id  (or messageId, msgid, sms_id)
//   - port (or sim, line, channel)
//   - from (or src, sender, phone)
//   - body (or content, text, message)
//   - ts   (or time, date, occurredAt) — ISO or yyyy-MM-dd HH:mm:ss
//
// Only messages on the configured chat port are ingested; others are
// acknowledged with 200 + status='ignored-port' so the gateway won't
// retry forever.

import { Router, type IRouter } from "express";
import { ingestInbound } from "../lib/sms-inbox";
import { getChatPort } from "../lib/sms-ejoin";

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

// Mounted under /api in app.ts, so the public path is /api/sms/inbound.
router.post("/sms/inbound", async (req, res) => {
  try {
    const secret = process.env.SMS_WEBHOOK_SECRET?.trim();
    if (!secret) {
      // Refuse to act as an open relay. Setting the env var is a
      // deliberate operator action that flips push-mode on.
      res.status(401).json({ error: "Webhook secret not configured" });
      return;
    }
    const supplied = (req.header("X-Sms-Webhook-Secret") ?? "").trim();
    if (supplied !== secret) {
      res.status(401).json({ error: "Invalid webhook secret" });
      return;
    }

    const raw = (req.body ?? {}) as Record<string, unknown>;
    const id = asString(pick(raw, ["id", "messageId", "msgid", "sms_id"]));
    const portRaw = pick(raw, ["port", "sim", "line", "channel"]);
    const from = asString(pick(raw, ["from", "src", "sender", "phone"]));
    const body = asString(pick(raw, ["body", "content", "text", "message"]));
    const ts = parseTs(pick(raw, ["ts", "time", "date", "occurredAt"]));

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
});

export default router;
