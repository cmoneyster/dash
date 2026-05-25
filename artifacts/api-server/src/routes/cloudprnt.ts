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
import { renderJob, buildWebPrntXml, type RenderablePayload } from "../lib/printRenderer";

const router: IRouter = Router();

/**
 * Star CloudPRNT protocol — observed printer cycle:
 *
 *   1. DELETE /cloudprnt/:token          ← acknowledge/clear previous job
 *   2. POST   /cloudprnt/:token          ← status check-in, get jobReady
 *   3. GET    /cloudprnt/:token          ← fetch job bytes (Accept: text/plain)
 *      POST   /cloudprnt/:token          ← report print result (jobToken in body)
 *
 * The GET handler must detect whether the printer wants a JSON status poll
 * (Accept: application/json, no mediaType param) or the actual print bytes
 * (Accept: text/plain or ?mediaType=... query param). Both paths hit the
 * same URL; the Accept header is the differentiator.
 */

/**
 * Polling interval returned with every idle response.
 * Overrides the printer's built-in default (which can be 300–600 s on some
 * TSP143IV firmware) so the printer checks back every 10 seconds instead.
 */
const POLL_INTERVAL_SECONDS = 10;

/** Idle response — no job waiting. Includes pollingInterval so the printer
 *  doesn't fall back to its (potentially very long) factory default. */
function idlePayload() {
  return { jobReady: false, pollingInterval: POLL_INTERVAL_SECONDS };
}

/**
 * Media types offered to the printer, in preference order.
 * The printer picks the first type from this list that it also supports
 * and then requests content via GET ?type=<chosen>.
 *
 * Priority order:
 *  1. starprntcore  — binary ESC/POS, works in any emulation mode (preferred)
 *  2. starwebprnt+xml — high-level XML; confirmed working on this TSP143IV
 *     (jobs 43–48 all printed via the browser LAN path using this format)
 *  3. text/plain; charset=utf-8 — ESC/POS text fallback
 */
const OFFERED_MEDIA_TYPES = [
  "application/vnd.star.starprntcore",
  "application/vnd.star.starwebprnt+xml",
  "text/plain; charset=utf-8",
];

/** Build the standard jobReady payload used in both GET and POST poll responses. */
function jobReadyPayload(jobId: number) {
  return {
    jobReady: true,
    mediaTypes: OFFERED_MEDIA_TYPES,
    jobToken: String(jobId),
    clientAction: [],          // must be an array per spec; empty = no special actions
    pollingInterval: POLL_INTERVAL_SECONDS,
  };
}

/**
 * Serve raw print bytes for the next queued job, marking it delivered.
 * Used by both the GET (Accept-header) and /content/:jobId paths.
 *
 * requestedType: the ?type= value the printer sent, or null.
 * When provided we echo it back as Content-Type so the printer knows we
 * honoured its choice.  The rendered bytes are identical regardless of
 * which type was picked — our ESC/POS-compatible StarPRNT command set
 * works for both starprntcore and text/plain.
 */
async function serveJobBytes(
  req: Parameters<Parameters<typeof router.get>[1]>[0],
  res: Parameters<Parameters<typeof router.get>[1]>[1],
  printerId: number,
  jobId: number,
  requestedType?: string | null,
): Promise<void> {
  const job = await claimJobForPrinterById(printerId, jobId);
  if (!job) {
    // Job was already claimed (e.g. by LAN fallback race) — tell the printer nothing to print.
    res.status(204).end();
    return;
  }
  try {
    const payload = job.payload as unknown as RenderablePayload;
    const isWebPrnt = requestedType?.includes("starwebprnt");

    let body: Buffer | string;
    let serveAs: string;

    if (isWebPrnt) {
      // Printer chose StarWebPRNT XML — the same high-level format used by the
      // browser LAN path (confirmed working on this TSP143IV, jobs 43–48).
      body = buildWebPrntXml(payload);
      serveAs = "application/vnd.star.starwebprnt+xml";
    } else {
      const { bytes, contentType } = renderJob(payload);
      body = bytes;
      serveAs = requestedType ?? contentType;
    }

    res.setHeader("Content-Type", serveAs);
    res.setHeader("Cache-Control", "no-store");
    req.log.info(
      { printerId, jobId, requestedType, serveAs, size: typeof body === "string" ? body.length : body.length },
      "[cloudprnt] serving job bytes",
    );
    res.send(body);
  } catch (err) {
    req.log.error({ err, jobId: job.id }, "[cloudprnt] render failed");
    await markJobFailed(job.id, err instanceof Error ? err.message : "render failed");
    res.status(500).end();
  }
}

/**
 * GET /cloudprnt/:token
 *
 * The printer's observed cycle is: DELETE → POST → GET.
 * The POST already returns jobReady status; the GET that immediately follows
 * is the content-fetch — the printer expects raw print bytes, not another
 * JSON poll response. So the rule is simple:
 *
 *   job in queue  → serve bytes (content fetch, regardless of Accept header)
 *   queue empty   → return { jobReady: false } JSON (idle poll)
 *
 * Exception: if ?mediaType=... is absent AND Accept explicitly requests
 * application/json, honour it as a pure poll (some integrations poll via GET).
 */
router.get("/cloudprnt/:token", async (req, res) => {
  const printer = await findPrinterByToken(req.params.token);
  if (!printer) {
    res.status(404).json(idlePayload());
    return;
  }
  if (!printer.enabled) {
    await recordPrinterPoll(printer.id, "disabled");
    res.json(idlePayload());
    return;
  }
  await recordPrinterPoll(printer.id, "online");

  const next = await peekNextJobForPrinter(printer.id);
  if (!next) {
    res.json(idlePayload());
    return;
  }

  // If the caller explicitly only accepts JSON it's a programmatic poll
  // (e.g. LAN fallback check), not the printer's content-fetch GET.
  const acceptHeader = (req.headers.accept ?? "").toLowerCase();
  const isPurePoll =
    acceptHeader.includes("application/json") &&
    !acceptHeader.includes("text/plain") &&
    req.query.mediaType == null;

  if (isPurePoll) {
    req.log.info({ printerId: printer.id, jobId: next.id }, "[cloudprnt] GET JSON poll → jobReady");
    res.json(jobReadyPayload(next.id));
    return;
  }

  // Printer tells us the exact format it wants via ?type= query param.
  const requestedType = typeof req.query.type === "string" ? req.query.type : null;
  req.log.info(
    { printerId: printer.id, jobId: next.id, requestedType, query: req.query },
    "[cloudprnt] GET content fetch → serving bytes",
  );
  await serveJobBytes(req, res, printer.id, next.id, requestedType);
});

/**
 * GET /cloudprnt/:token/content/:jobId
 *
 * Kept as an explicit content URL for LAN-fallback / older firmware that
 * follows the clientAction.url path instead of the Accept-header approach.
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
  req.log.info({ printerId: printer.id, jobId }, "[cloudprnt] GET content/:jobId");
  await serveJobBytes(req, res, printer.id, jobId);
});

/**
 * POST /cloudprnt/:token
 *
 * Dual-purpose per Star CloudPRNT spec:
 *  (a) Status report — body contains { jobToken, status/statusCode } after a job
 *  (b) Poll check-in — body is empty or status-only; response carries jobReady
 */
router.post("/cloudprnt/:token", async (req, res) => {
  const printer = await findPrinterByToken(req.params.token);
  if (!printer) {
    res.status(404).end();
    return;
  }
  if (!printer.enabled) {
    await recordPrinterPoll(printer.id, "disabled");
    res.json(idlePayload());
    return;
  }
  await recordPrinterPoll(printer.id, "online");

  const body = (req.body ?? {}) as Record<string, unknown>;
  req.log.info({ printerId: printer.id, body }, "[cloudprnt] POST body from printer");
  const jobToken = body.jobToken;
  const status = typeof body.status === "string" ? body.status : null;
  const statusCode = typeof body.statusCode === "string" ? body.statusCode : null;

  // If the printer is reporting the result of a previously-claimed job, mark it.
  if (jobToken !== undefined && jobToken !== null) {
    const jobId = Number(jobToken);
    if (!Number.isNaN(jobId)) {
      const job = await getJobById(jobId);
      if (job && job.printerId === printer.id) {
        const failed =
          (status && /error|fail/i.test(status)) ||
          (statusCode && statusCode !== "200");
        if (failed) {
          await markJobFailed(jobId, `${status ?? statusCode ?? "printer error"}`);
          await recordPrinterError(printer.id, `${status ?? statusCode ?? "error"}`);
          req.log.warn({ printerId: printer.id, jobId, status, statusCode }, "[cloudprnt] job failed");
        } else {
          await markJobPrinted(jobId, "cloudprnt");
          req.log.info({ printerId: printer.id, jobId }, "[cloudprnt] job printed ✓");
        }
      } else if (job && job.printerId !== printer.id) {
        req.log.warn(
          { tokenPrinterId: printer.id, jobId, jobPrinterId: job.printerId },
          "[cloudprnt] cross-printer status update rejected",
        );
      }
    }
  }

  // Always respond with the next pending job (if any) so the printer doesn't
  // need an extra round-trip after receiving a status-only POST.
  const next = await peekNextJobForPrinter(printer.id);
  if (!next) {
    res.json(idlePayload());
    return;
  }
  req.log.info({ printerId: printer.id, jobId: next.id }, "[cloudprnt] POST poll → jobReady");
  res.json(jobReadyPayload(next.id));
});

/**
 * DELETE /cloudprnt/:token
 *
 * Printer sends DELETE to acknowledge job completion (clears its internal
 * job state). We accept it gracefully — job status is already tracked via
 * POST status reports, so we just return 200 here.
 */
router.delete("/cloudprnt/:token", async (req, res) => {
  const printer = await findPrinterByToken(req.params.token);
  if (!printer) {
    res.status(404).end();
    return;
  }
  // Some firmware (including certain TSP143IV versions) acks via DELETE rather
  // than a POST with jobToken.  Treat DELETE as "last delivered job printed OK."
  const { getLastDeliveredJobForPrinter } = await import("../lib/printQueue");
  const lastJob = await getLastDeliveredJobForPrinter(printer.id);
  if (lastJob) {
    await markJobPrinted(lastJob.id, "cloudprnt");
    req.log.info({ printerId: printer.id, jobId: lastJob.id }, "[cloudprnt] DELETE ack → job printed ✓");
  } else {
    req.log.info({ printerId: printer.id }, "[cloudprnt] DELETE ack (no delivered job to mark)");
  }
  res.status(200).json({ ok: true });
});

export default router;
