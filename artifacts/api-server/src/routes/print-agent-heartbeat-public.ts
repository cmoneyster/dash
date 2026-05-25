import { Router } from "express";
import { heartbeatStore } from "../lib/printAgentHeartbeat";

const router = Router();

/**
 * POST /api/print-agent/heartbeat
 *
 * Public — no admin auth. The router agent carries its token in the request
 * body and POSTs this every 30 s so the admin UI can show a live "last seen"
 * status without requiring inbound firewall access to the router.
 */
router.post("/print-agent/heartbeat", (req, res) => {
  // Accept token/serverUrl from query params (busybox wget) or JSON body (other clients)
  const token = (typeof req.query.token === "string" && req.query.token) ? req.query.token
    : (typeof req.body?.token === "string" && req.body.token) ? req.body.token : null;
  const serverUrl = (typeof req.query.serverUrl === "string" && req.query.serverUrl) ? req.query.serverUrl
    : (typeof req.body?.serverUrl === "string" && req.body.serverUrl) ? req.body.serverUrl : null;
  if (!token) {
    res.status(400).json({ error: "Missing token" });
    return;
  }
  if (!serverUrl) {
    res.status(400).json({ error: "Missing serverUrl" });
    return;
  }
  heartbeatStore.set(token, { lastSeenAt: new Date(), serverUrl });
  res.json({ ok: true });
});

export default router;
