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
import { buildWebPrntXml, renderJob } from "../lib/printRenderer";
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
        const payload = job.payload as unknown as RenderablePayload;
        const webPrntXml = buildWebPrntXml(payload);
        const { bytes } = renderJob(payload);
        return [{
          id: job.id,
          printerId: job.printerId,
          jobType: job.jobType,
          lanIp: job.lanIp,
          webPrntXml,
          // Raw ESC/POS bytes for TCP port-9100 delivery (e.g. router shell agent).
          rawBytesBase64: bytes.toString("base64"),
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
    const printerResponse = typeof req.body?.printerResponse === "string" ? req.body.printerResponse : null;
    await markJobPrinted(id, "lan_browser");
    req.log.info({ jobId: id, printerResponse }, "print-agent: job complete — printer response");
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

/**
 * GET /api/print-agent/install.sh?token=TOKEN&printer=IP
 *
 * Returns a ready-to-run shell script for the GL.iNet router agent.
 * Intentionally NOT behind admin auth middleware — registered in index.ts
 * before the /print-agent auth guard. The caller supplies their own token
 * as a query param and it gets embedded directly in the downloaded script.
 */
export function installShHandler(req: import("express").Request, res: import("express").Response): void {
  const token = typeof req.query.token === "string" ? req.query.token.trim() : "";
  const printerIp = typeof req.query.printer === "string" ? req.query.printer.trim() : "192.168.22.208";
  const serverUrl = `${req.protocol}://${req.get("host")}`;

  if (!token) {
    res.status(400).type("text/plain").send("Missing ?token= query parameter\n");
    return;
  }

  // Note: in a JS template literal only ${...} is interpolated.
  // Shell constructs like $((i+1)), $?, $JOBS etc. pass through as-is.
  const script = [
    "#!/bin/sh",
    `# dash Catering router print agent — generated ${new Date().toISOString()}`,
    `# Re-download: wget -O /root/print-agent.sh '${serverUrl}/api/print-agent/install.sh?token=${token}&printer=${printerIp}'`,
    `SERVER="${serverUrl}"`,
    `ADMIN_TOKEN="${token}"`,
    `PRINTER_IP="${printerIp}"`,
    "PRINTER_PORT=9100",
    "POLL_INTERVAL=2",
    "LOG_TAG=print-agent",
    "",
    "log() { logger -t \"$LOG_TAG\" \"$1\"; }",
    "",
    'log "starting — server=$SERVER printer=$PRINTER_IP:$PRINTER_PORT"',
    "",
    "while true; do",
    "  JOBS=$(curl -sf -H \"Authorization: Bearer $ADMIN_TOKEN\" \\",
    '    "$SERVER/api/print-agent/queued" 2>/dev/null)',
    "",
    '  if [ -z "$JOBS" ] || [ "$JOBS" = "[]" ]; then',
    "    sleep $POLL_INTERVAL; continue",
    "  fi",
    "",
    "  COUNT=$(printf '%s' \"$JOBS\" | jq 'length' 2>/dev/null)",
    '  [ -z "$COUNT" ] || [ "$COUNT" -eq 0 ] && { sleep $POLL_INTERVAL; continue; }',
    "",
    "  i=0",
    '  while [ "$i" -lt "$COUNT" ]; do',
    '    JOB_ID=$(printf \'%s\' "$JOBS"  | jq -r ".[$i].id")',
    '    JOB_TYPE=$(printf \'%s\' "$JOBS" | jq -r ".[$i].jobType")',
    '    RAW_B64=$(printf \'%s\' "$JOBS" | jq -r ".[$i].rawBytesBase64")',
    '    [ -z "$JOB_ID" ] || [ "$JOB_ID" = "null" ] && { i=$((i+1)); continue; }',
    "",
    '    log "claiming job $JOB_ID ($JOB_TYPE)"',
    '    curl -sf -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \\',
    '      "$SERVER/api/print-agent/jobs/$JOB_ID/claim" -o /dev/null || \\',
    '      { log "job $JOB_ID already claimed"; i=$((i+1)); continue; }',
    "",
    '    log "sending job $JOB_ID to $PRINTER_IP:$PRINTER_PORT"',
    "    printf '%s' \"$RAW_B64\" | openssl enc -base64 -d -A | nc \"$PRINTER_IP\" \"$PRINTER_PORT\"",
    "    STATUS=$?",
    "",
    '    if [ "$STATUS" -eq 0 ]; then',
    '      log "job $JOB_ID delivered OK"',
    '      curl -sf -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \\',
    '        -H "Content-Type: application/json" \\',
    "        -d '{\"printerResponse\":\"tcp_9100_ok\"}' \\",
    '        "$SERVER/api/print-agent/jobs/$JOB_ID/complete" -o /dev/null',
    "    else",
    '      log "job $JOB_ID FAILED (nc exit $STATUS)"',
    '      curl -sf -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \\',
    '        -H "Content-Type: application/json" -d \'{"error":"tcp_connect_failed"}\' \\',
    '        "$SERVER/api/print-agent/jobs/$JOB_ID/fail" -o /dev/null',
    "    fi",
    "",
    "    i=$((i+1))",
    "  done",
    "  sleep $POLL_INTERVAL",
    "done",
    "",
  ].join("\n");

  res.type("text/plain").send(script);
}

export default router;
