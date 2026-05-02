import { Router, type IRouter } from "express";
import { snapshot } from "../lib/idle-metrics";
import { getSmsPollerStatus } from "../lib/sms-scheduler";
import { getInstagramPollerStatus } from "../lib/instagramPoller";

const router: IRouter = Router();

router.get("/admin/idle-activity", async (_req, res) => {
  // Compose the live snapshot from in-memory counters plus the latest
  // operator-tunable poller status. Reading from the scheduler modules
  // here keeps `idle-metrics` ignorant of those imports (no circular
  // dependency between metrics and the modules that record into it).
  // The poller-status getters are async because they read the persisted
  // DB settings directly so this card always shows what the admin just
  // saved (rather than the cached in-memory value from the last tick,
  // which can be up to one full interval stale — minutes-to-hours for
  // the Instagram poller).
  const [sms, ig] = await Promise.all([
    getSmsPollerStatus(),
    getInstagramPollerStatus(),
  ]);
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
