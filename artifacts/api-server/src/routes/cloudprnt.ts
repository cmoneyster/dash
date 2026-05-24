import { Router, type IRouter } from "express";
import {
  findPrinterByToken,
  recordPrinterPoll,
  recordPrinterError,
  claimJobForPrinterById,
  peekNextJobForPrinter,
  getJobById,
  markJobPrinted,
  markJobFailed,
} from "../lib/printQueue";
import { renderJob, type RenderablePayload } from "../lib/printRenderer";

const router: IRouter = Router();

/**
 * Star CloudPRNT polling endpoint. The printer hits this every few seconds
 * with GET (asking if there's work) and POST (status updates). Spec:
 * https://www.starmicronics.com/support/cloudprnt/
 *
 * GET response shape:
 *   { jobReady: false }                              when queue is empty
 *   { jobReady: true, mediaTypes: ["..."],
 *     jobToken: "...", clientAction: [] }            when there's a job
 *
 * The printer then GETs the job content (text/plain bytes here) and POSTs
 * back its status.
 */
router.get("/cloudprnt/:token", async (req, res) => {
  const printer = await findPrinterByToken(req.params.token);
  if (!printer) {
    res.status(404).json({ jobReady: false });
    return;
  }
  if (!printer.enabled) {
    await recordPrinterPoll(printer.id, "disabled");
    res.json({ jobReady: false });
    return;
  }
  await recordPrinterPoll(printer.id, "online");

  const next = await peekNextJobForPrinter(printer.id);
  if (!next) {
    res.json({ jobReady: false });
    return;
  }

  // Star CloudPRNT poll response. `clientAction.url` tells the printer
  // exactly where to GET the bytes — including the `jobId` lets us claim
  // the specific job (FOR UPDATE SKIP LOCKED) and lets the LAN fallback
  // race the CloudPRNT poll without double-printing.
  const base = `${req.protocol}://${req.get("host")}`;
  const contentUrl = `${base}/api/cloudprnt/${req.params.token}/content/${next.id}`;
  res.json({
    jobReady: true,
    mediaTypes: [next.contentType],
    jobToken: String(next.id),
    clientAction: { url: contentUrl },
  });
});

/**
 * The printer fetches the actual bytes here. We claim the job atomically so
 * concurrent polls (CloudPRNT + WebPRNT fallback) can't both grab it.
 * `:jobId` is the same number returned as `jobToken` from the poll above.
 */
router.get("/cloudprnt/:token/content/:jobId", async (req, res) => {
  const printer = await findPrinterByToken(req.params.token);
  if (!printer) {
    res.status(404).end();
    return;
  }
  const jobId = parseInt(req.params.jobId);
  if (Number.isNaN(jobId)) {
    res.status(400).end();
    return;
  }
  const job = await claimJobForPrinterById(printer.id, jobId);
  if (!job) {
    res.status(204).end();
    return;
  }
  try {
    const { bytes, contentType } = renderJob(job.payload as unknown as RenderablePayload);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-store");
    res.send(bytes);
  } catch (err) {
    req.log.error({ err, jobId: job.id }, "print render failed");
    await markJobFailed(job.id, err instanceof Error ? err.message : "render failed");
    res.status(500).end();
  }
});

/**
 * Status update from the printer. Star CloudPRNT uses POST for both
 * status reporting *and* job polling — the printer POSTs its current state
 * and the server responds with job-readiness in the same response body.
 * (Some firmware variants also GET separately, but POST is the primary path.)
 */
router.post("/cloudprnt/:token", async (req, res) => {
  const printer = await findPrinterByToken(req.params.token);
  if (!printer) {
    res.status(404).end();
    return;
  }

  if (!printer.enabled) {
    await recordPrinterPoll(printer.id, "disabled");
    res.json({ jobReady: false });
    return;
  }

  await recordPrinterPoll(printer.id, "online");

  const body = (req.body ?? {}) as Record<string, unknown>;
  const jobToken = body.jobToken;
  const status = typeof body.status === "string" ? body.status : null;
  const statusCode = typeof body.statusCode === "string" ? body.statusCode : null;

  // If the printer is reporting the result of a previously-claimed job, mark it.
  // Verify the referenced job belongs to this printer before touching it.
  if (jobToken !== undefined && jobToken !== null) {
    const jobId = Number(jobToken);
    if (!Number.isNaN(jobId)) {
      const job = await getJobById(jobId);
      if (job && job.printerId === printer.id) {
        const failed = (status && /error|fail/i.test(status)) || (statusCode && statusCode !== "200");
        if (failed) {
          await markJobFailed(jobId, `${status ?? statusCode ?? "printer error"}`);
          await recordPrinterError(printer.id, `${status ?? statusCode ?? "error"}`);
        } else {
          await markJobPrinted(jobId, "cloudprnt");
        }
      } else if (job && job.printerId !== printer.id) {
        req.log.warn(
          { tokenPrinterId: printer.id, jobId, jobPrinterId: job.printerId },
          "[cloudprnt] cross-printer status update rejected"
        );
      }
    }
  }

  // Always include job-readiness in the POST response — this is the primary
  // polling mechanism for most Star CloudPRNT firmware versions.
  const next = await peekNextJobForPrinter(printer.id);
  if (!next) {
    res.json({ jobReady: false });
    return;
  }

  const base = `${req.protocol}://${req.get("host")}`;
  const contentUrl = `${base}/api/cloudprnt/${req.params.token}/content/${next.id}`;
  res.json({
    jobReady: true,
    mediaTypes: [next.contentType],
    jobToken: String(next.id),
    clientAction: { url: contentUrl },
  });
});

export default router;
