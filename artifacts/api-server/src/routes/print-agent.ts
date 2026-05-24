/**
 * Browser-based LAN print agent API.
 *
 * The agent runs in the browser on a device that is on the same LAN as the
 * printers. It polls this endpoint every 2 s, claims jobs, delivers them via
 * Star WebPRNT (POST to the printer's HTTP/HTTPS endpoint), and reports
 * success or failure back here.
 *
 * Auth: same HMAC Bearer token as all other /admin/* routes, protected by
 * requireAdminAuth in routes/index.ts.
 *
 * Delivery modes:
 *   lan_browser          – printer only delivers via browser agent (no CloudPRNT poll)
 *   cloudprnt_lan_fallback – CloudPRNT primary; agent picks up stale jobs after N seconds
 */

import { Router, type IRouter } from "express";
import { getQueuedJobsForLanAgent, claimJobForAgent, markJobPrinted, markJobFailed, getJobById } from "../lib/printQueue";
import { buildWebPrntXml } from "../lib/printRenderer";
import type { RenderablePayload } from "../lib/printRenderer";

const router: IRouter = Router();

const DEFAULT_STALE_SECONDS = 8;

function getStaleSeconds(): number {
  const v = parseInt(process.env.LAN_FALLBACK_STALE_SECONDS ?? "");
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_STALE_SECONDS;
}

/**
 * GET /api/print-agent/queued
 *
 * Returns up to 10 queued jobs eligible for LAN browser delivery.
 * Each job includes pre-rendered base64 bytes (ESC/POS) and the
 * printer's LAN IP so the agent can POST directly to the printer.
 *
 * Jobs are NOT claimed by this call — the agent must POST to /claim.
 */
router.get("/print-agent/queued", async (req, res) => {
  try {
    const stale = getStaleSeconds();
    const jobs = await getQueuedJobsForLanAgent(stale);

    const result = jobs.flatMap((job) => {
      try {
        const webPrntXml = buildWebPrntXml(job.payload as unknown as RenderablePayload);
        return [{
          id: job.id,
          printerId: job.printerId,
          jobType: job.jobType,
          lanIp: job.lanIp,
          webPrntXml,
          createdAt: job.createdAt,
        }];
      } catch (err) {
        req.log.warn({ err, jobId: job.id }, "print-agent: failed to render job — skipping");
        return [];
      }
    });

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "print-agent: queued list failed");
    res.status(500).json({ error: "Failed to list queued jobs" });
  }
});

/**
 * POST /api/print-agent/jobs/:id/claim
 *
 * Atomically claims a job for LAN browser delivery. Returns 409 if the job
 * was already claimed by CloudPRNT or another agent instance.
 */
router.post("/print-agent/jobs/:id/claim", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const job = await claimJobForAgent(id);
    if (!job) {
      res.status(409).json({ error: "Job already claimed or not eligible for LAN delivery" });
      return;
    }
    res.json(job);
  } catch (err) {
    req.log.error({ err }, "print-agent: claim failed");
    res.status(500).json({ error: "Failed to claim job" });
  }
});

/**
 * POST /api/print-agent/jobs/:id/complete
 *
 * Mark a job as successfully printed by the browser agent.
 */
router.post("/print-agent/jobs/:id/complete", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await markJobPrinted(id, "lan_browser");
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "print-agent: complete failed");
    res.status(500).json({ error: "Failed to mark job complete" });
  }
});

/**
 * POST /api/print-agent/jobs/:id/fail
 *
 * Report a delivery failure from the browser agent. Body: { error: string }.
 */
router.post("/print-agent/jobs/:id/fail", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const errorMsg = typeof req.body?.error === "string" ? req.body.error : "Unknown LAN delivery error";
    await markJobFailed(id, errorMsg);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "print-agent: fail report failed");
    res.status(500).json({ error: "Failed to record failure" });
  }
});

/**
 * GET /api/print-agent/jobs/:id
 *
 * Fetch job status — used by the Test LAN button to poll for completion.
 */
router.get("/print-agent/jobs/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const job = await getJobById(id);
    if (!job) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(job);
  } catch (err) {
    req.log.error({ err }, "print-agent: get job failed");
    res.status(500).json({ error: "Failed to get job" });
  }
});

export default router;
