import { Router } from "express";
import { db } from "@workspace/db";
import { printersTable, eventSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import {
  getQueuedJobsForLanAgent,
  getActiveLanPrinterIds,
  claimJobForAgent,
  markJobPrinted,
  markJobFailed,
  getJobById,
} from "../lib/printQueue";
import { renderJobWebPrnt, renderJob } from "../lib/printRenderer";
import type { RenderablePayload } from "../lib/printRenderer";
import type { PrintTemplate } from "@workspace/db/schema";
import { heartbeatStore } from "../lib/printAgentHeartbeat";

const router = Router();

/**
 * GET /api/print-agent/active-printers
 *
 * Returns the distinct set of LAN printers that currently have at least one
 * queued job. No row cap is applied so the browser agent always discovers
 * every printer with work regardless of total queue depth.
 *
 * Response: Array of { printerId: number; lanIp: string }
 */
router.get("/print-agent/active-printers", async (req, res) => {
  try {
    const printers = await getActiveLanPrinterIds();
    res.json(printers);
  } catch (err) {
    req.log.error({ err }, "print-agent: failed to fetch active printers");
    res.status(500).json({ error: "Failed to fetch active printers" });
  }
});

/**
 * GET /api/print-agent/queued
 *
 * Returns queued jobs eligible for browser-based WebPRNT delivery.
 * Only lan_browser printers with a LAN IP configured are included.
 * Requires a `printerId` query param to scope results to one printer.
 */
router.get("/print-agent/queued", async (req, res) => {
  try {
    const printerIdParam = req.query.printerId;
    const printerId =
      printerIdParam != null && !isNaN(parseInt(String(printerIdParam), 10))
        ? parseInt(String(printerIdParam), 10)
        : undefined;
    const jobs = await getQueuedJobsForLanAgent(printerId);
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
      .select({ lanIp: printersTable.lanIp })
      .from(printersTable)
      .where(eq(printersTable.id, job.printerId));

    if (!printer?.lanIp) {
      res.status(422).json({ error: "Printer has no LAN IP" });
      return;
    }

    // If a _templateOverride was embedded by test-print-template, use it
    // so the template builder's "Test Print" sends the current (unsaved) template.
    // Otherwise use the global template from event_settings.
    const payloadObj = job.payload as Record<string, unknown>;
    const hasOverride = "_templateOverride" in payloadObj;
    let effectiveTemplate: PrintTemplate | undefined;
    if (hasOverride) {
      effectiveTemplate = (payloadObj._templateOverride as PrintTemplate | null) ?? undefined;
    } else {
      const [settings] = await db.select({ printTemplate: eventSettingsTable.printTemplate }).from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
      effectiveTemplate = (settings?.printTemplate as PrintTemplate | null) ?? undefined;
    }

    const webPrntXml = renderJobWebPrnt(
      job.payload as unknown as RenderablePayload,
      effectiveTemplate,
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
 * GET /api/print-agent/jobs/:id/bytes
 *
 * Atomically claims a job and returns the rendered ESC/POS bytes as
 * application/octet-stream, ready to be piped to nc <ip> 9100.
 */
router.get("/print-agent/jobs/:id/bytes", async (req, res) => {
  const jobId = parseInt(req.params.id);
  if (isNaN(jobId)) {
    res.status(400).json({ error: "Invalid job id" });
    return;
  }

  try {
    const job = await claimJobForAgent(jobId);
    if (!job) {
      res.status(409).json({ error: "Job not available (already claimed or not queued)" });
      return;
    }

    const [printer] = await db
      .select({ lanIp: printersTable.lanIp })
      .from(printersTable)
      .where(eq(printersTable.id, job.printerId));

    if (!printer?.lanIp) {
      res.status(422).json({ error: "Printer has no LAN IP" });
      return;
    }

    // A template_test job may embed a _templateOverride in the payload so the
    // operator can proof a template before saving it to the printer record.
    // Otherwise use the global template from event_settings.
    const rawPayload = job.payload as unknown as Record<string, unknown>;
    const { _templateOverride, ...cleanPayload } = rawPayload;
    let effectiveTemplate: PrintTemplate | undefined;
    if (_templateOverride && typeof _templateOverride === "object") {
      effectiveTemplate = _templateOverride as PrintTemplate;
    } else {
      const [settings] = await db.select({ printTemplate: eventSettingsTable.printTemplate }).from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
      effectiveTemplate = (settings?.printTemplate as PrintTemplate | null) ?? undefined;
    }

    const { bytes } = renderJob(
      cleanPayload as unknown as RenderablePayload,
      effectiveTemplate,
    );

    res.set("Content-Type", "application/octet-stream");
    res.send(bytes);
  } catch (err) {
    req.log.error({ err, jobId }, "print-agent: bytes fetch failed");
    res.status(500).json({ error: "Failed to render job" });
  }
});

/**
 * POST /api/print-agent/jobs/:id/complete
 *
 * Called by the router agent after the printer accepted the job.
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
  const error = typeof req.body?.error === "string" ? req.body.error
    : typeof req.query.error === "string" ? req.query.error
    : "Unknown error";
  try {
    await markJobFailed(jobId, error);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err, jobId }, "print-agent: fail report failed");
    res.status(500).json({ error: "Failed to mark job failed" });
  }
});

/**
 * GET /api/print-agent/heartbeat
 *
 * Returns the last-seen heartbeat for the token in the Authorization header.
 * Called by the admin UI to display live agent status.
 */
router.get("/print-agent/heartbeat", (req, res) => {
  const authHeader = req.headers.authorization ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const entry = heartbeatStore.get(token);
  res.json({
    lastSeenAt: entry ? entry.lastSeenAt.toISOString() : null,
    serverUrl: entry ? entry.serverUrl : null,
  });
});

export default router;
