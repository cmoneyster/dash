/**
 * LAN direct-print via raw TCP (port 9100).
 *
 * Star TSP-series printers expose a raw-socket interface on port 9100.
 * We open a TCP connection, write the ESC/POS bytes, and close — the
 * printer interprets and prints them exactly as it would via CloudPRNT.
 *
 * Used for two purposes:
 *   1. Admin test button — instant connectivity check without queuing.
 *   2. LAN fallback — when a printer has `allowLanFallback` + `lanIp` set,
 *      each newly-enqueued job is also pushed over TCP in the background.
 *      If TCP delivery succeeds first, the job is marked `printed` via
 *      `lan_fallback` so CloudPRNT sees nothing left to serve.
 */

import * as net from "net";
import { renderJob, type RenderablePayload } from "./printRenderer";
import { markJobPrinted } from "./printQueue";
import { logger } from "./logger";

/** Send raw bytes to a Star printer on port 9100. Resolves when the socket closes cleanly. */
export async function sendViaLanTcp(
  lanIp: string,
  bytes: Buffer,
  timeoutMs = 5_000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;

    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };

    const timer = setTimeout(
      () => done(new Error(`LAN print timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );

    socket.on("error", done);
    socket.on("close", () => done());

    socket.connect(9100, lanIp, () => {
      socket.write(bytes, (writeErr) => {
        if (writeErr) { done(writeErr); return; }
        socket.end();
      });
    });
  });
}

/**
 * Fire-and-forget LAN fallback after a job has been enqueued.
 *
 * If the printer has `allowLanFallback` + `lanIp`, render the payload
 * and attempt direct TCP delivery.  On success the job is marked
 * `printed` via `lan_fallback` so CloudPRNT skips it.  On failure we
 * log a warning and leave the job for CloudPRNT to deliver normally.
 *
 * Intentionally swallows errors so callers can `void tryLanFallback(...)`.
 */
export async function tryLanFallback(
  printer: { id: number; lanIp: string | null; allowLanFallback: boolean },
  jobId: number,
  payload: RenderablePayload,
): Promise<void> {
  if (!printer.allowLanFallback || !printer.lanIp) return;
  try {
    const { bytes } = renderJob(payload);
    await sendViaLanTcp(printer.lanIp, bytes);
    await markJobPrinted(jobId, "lan_fallback");
    logger.info(
      { printerId: printer.id, jobId, lanIp: printer.lanIp },
      "[lan-print] delivered via LAN ✓",
    );
  } catch (err) {
    logger.warn(
      { err, printerId: printer.id, jobId, lanIp: printer.lanIp },
      "[lan-print] LAN fallback failed — CloudPRNT will handle it",
    );
  }
}
