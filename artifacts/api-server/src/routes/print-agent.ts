import { Router } from "express";
import { db } from "@workspace/db";
import { printersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import {
  getQueuedJobsForLanAgent,
  claimJobForAgent,
  markJobPrinted,
  markJobFailed,
  getJobById,
} from "../lib/printQueue";
import { renderJobWebPrnt } from "../lib/printRenderer";
import type { RenderablePayload } from "../lib/printRenderer";
import type { PrintTemplate } from "@workspace/db/schema";

const router = Router();

/**
 * GET /api/print-agent/queued
 *
 * Returns queued jobs eligible for browser-based WebPRNT delivery.
 * Only lan_browser printers with a LAN IP configured are included.
 */
router.get("/print-agent/queued", async (req, res) => {
  try {
    const jobs = await getQueuedJobsForLanAgent();
    res.json(
      jobs.map((j) => ({
        id: j.id,
        printerId: j.printerId,
        jobType: j.jobType,
        lanIp: j.lanIp,
      }))
    );
  } catch (err) {
    req.log.error({ err }, "print-agent: failed to fetch queued jobs");
    res.status(500).json({ error: "Failed to fetch queued jobs" });
  }
});

/**
 * POST /api/print-agent/jobs/:id/claim
 *
 * Atomically claims a job and returns the rendered WebPRNT XML
 * ready for the browser to POST to the printer.
 */
router.post("/print-agent/jobs/:id/claim", async (req, res) => {
  const jobId = parseInt(req.params.id);
  if (isNaN(jobId)) {
    res.status(400).json({ error: "Invalid job id" });
    return;
  }

  try {
    const job = await claimJobForAgent(jobId);
    if (!job) {
      res.status(409).json({ error: "Job not available (already claimed or not lan_browser)" });
      return;
    }

    const [printer] = await db
      .select({ lanIp: printersTable.lanIp, printTemplate: printersTable.printTemplate })
      .from(printersTable)
      .where(eq(printersTable.id, job.printerId));

    if (!printer?.lanIp) {
      res.status(422).json({ error: "Printer has no LAN IP" });
      return;
    }

    const webPrntXml = renderJobWebPrnt(
      job.payload as unknown as RenderablePayload,
      printer.printTemplate as PrintTemplate | undefined ?? undefined,
    );

    res.json({
      jobId: job.id,
      printerId: job.printerId,
      jobType: job.jobType,
      lanIp: printer.lanIp,
      webPrntXml,
    });
  } catch (err) {
    req.log.error({ err, jobId }, "print-agent: claim failed");
    res.status(500).json({ error: "Failed to claim job" });
  }
});

/**
 * POST /api/print-agent/jobs/:id/complete
 *
 * Called by the browser agent after the printer accepted the job.
 */
router.post("/print-agent/jobs/:id/complete", async (req, res) => {
  const jobId = parseInt(req.params.id);
  if (isNaN(jobId)) {
    res.status(400).json({ error: "Invalid job id" });
    return;
  }
  try {
    await markJobPrinted(jobId);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err, jobId }, "print-agent: complete failed");
    res.status(500).json({ error: "Failed to mark job complete" });
  }
});

/**
 * POST /api/print-agent/jobs/:id/fail
 *
 * Called by the browser agent when WebPRNT delivery failed.
 */
router.post("/print-agent/jobs/:id/fail", async (req, res) => {
  const jobId = parseInt(req.params.id);
  if (isNaN(jobId)) {
    res.status(400).json({ error: "Invalid job id" });
    return;
  }
  const error = typeof req.body?.error === "string" ? req.body.error : "Unknown error";
  try {
    await markJobFailed(jobId, error);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err, jobId }, "print-agent: fail report failed");
    res.status(500).json({ error: "Failed to mark job failed" });
  }
});

export default router;
