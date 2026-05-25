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
  const { token, serverUrl } = req.body ?? {};
  if (typeof token !== "string" || !token) {
    res.status(400).json({ error: "Missing token" });
    return;
  }
  if (typeof serverUrl !== "string" || !serverUrl) {
    res.status(400).json({ error: "Missing serverUrl" });
    return;
  }
  heartbeatStore.set(token, { lastSeenAt: new Date(), serverUrl });
  res.json({ ok: true });
});

export default router;
