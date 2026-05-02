import { Router, type IRouter } from "express";
import { snapshot } from "../lib/idle-metrics";
import { getSmsPollerStatus } from "../lib/sms-scheduler";
import { getInstagramPollerStatus } from "../lib/instagramPoller";

const router: IRouter = Router();

router.get("/admin/idle-activity", (_req, res) => {
  // Compose the live snapshot from in-memory counters plus the latest
  // operator-tunable poller status. Reading from the scheduler modules
  // here keeps `idle-metrics` ignorant of those imports (no circular
  // dependency between metrics and the modules that record into it).
  const sms = getSmsPollerStatus();
  const ig = getInstagramPollerStatus();
  res.json(
    snapshot({
      smsPoller: {
        enabled: sms.enabled,
        intervalSeconds: sms.intervalSeconds,
        inboundMode: sms.inboundMode,
      },
      instagramPoller: {
        enabled: ig.enabled,
        intervalMinutes: ig.intervalMinutes,
      },
    }),
  );
});

export default router;
