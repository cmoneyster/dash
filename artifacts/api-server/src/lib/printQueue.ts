import { randomBytes } from "crypto";
import { db } from "@workspace/db";
import {
  printersTable,
  printJobsTable,
  type Printer,
  type PrintJob,
  type PrintJobType,
  type PrintJobPayload,
} from "@workspace/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { logger } from "./logger";

export function generateCloudPrntToken(): string {
  return randomBytes(24).toString("hex");
}

/** Resolve a printer by its CloudPRNT token. */
export async function findPrinterByToken(token: string): Promise<Printer | null> {
  const rows = await db.select().from(printersTable).where(eq(printersTable.cloudprntToken, token)).limit(1);
  return rows[0] ?? null;
}

/** Mark a printer as having just polled (used for online detection). */
export async function recordPrinterPoll(printerId: number, status: "online" | "offline" | "disabled" = "online"): Promise<void> {
  await db
    .update(printersTable)
    .set({ lastPolledAt: new Date(), status, lastError: null })
    .where(eq(printersTable.id, printerId));
}

/** Record an error for a printer (used when it reports a job failed). */
export async function recordPrinterError(printerId: number, error: string): Promise<void> {
  await db
    .update(printersTable)
    .set({ status: "error", lastError: error, lastPolledAt: new Date() })
    .where(eq(printersTable.id, printerId));
}

/** Insert a new print job in `queued` state. */
export async function enqueuePrintJob(args: {
  printerId: number;
  jobType: PrintJobType;
  payload: PrintJobPayload;
  orderSource?: "order" | "event_order" | null;
  orderId?: number | null;
  contentType?: string;
}): Promise<PrintJob> {
  const [row] = await db
    .insert(printJobsTable)
    .values({
      printerId: args.printerId,
      jobType: args.jobType,
      payload: args.payload,
      orderSource: args.orderSource ?? null,
      orderId: args.orderId ?? null,
      contentType: args.contentType ?? "text/plain",
    })
    .returning();
  return row;
}

/**
 * Find printers that should receive a given job type.
 * `mode: "auto"` (default) requires `auto_print_on_new_order` to be on —
 * used by the order-submission fan-out.
 * `mode: "manual"` ignores that toggle — used by explicit reprint actions
 * from the kitchen/admin UI, which staff have already opted into.
 */
export async function selectPrintersFor(
  jobType: PrintJobType,
  mode: "auto" | "manual" = "auto",
): Promise<Printer[]> {
  const where = mode === "auto"
    ? and(eq(printersTable.enabled, true), eq(printersTable.autoPrintOnNewOrder, true))
    : eq(printersTable.enabled, true);
  const rows = await db.select().from(printersTable).where(where);

  return rows.filter((p) => {
    if (jobType === "kitchen_ticket") return p.printsKitchenTicket;
    if (jobType === "customer_receipt") return p.printsCustomerReceipt;
    if (jobType === "item_label" || jobType === "plate_label") return p.printsItemLabels;
    return false;
  });
}

/**
 * Atomically claim the oldest queued job for a printer. Marks it `delivered`
 * and increments `attempts`. Returns null if the queue is empty.
 *
 * Uses an UPDATE...RETURNING with a subquery picking one row by created_at
 * so concurrent polls (CloudPRNT + browser agent) can't grab the same job.
 */
export async function claimNextJobForPrinter(printerId: number): Promise<PrintJob | null> {
  const result = await db.execute<PrintJob>(sql`
    UPDATE print_jobs
    SET status = 'delivered',
        attempts = attempts + 1,
        delivered_at = now(),
        delivered_via = COALESCE(delivered_via, 'cloudprnt')
    WHERE id = (
      SELECT id FROM print_jobs
      WHERE printer_id = ${printerId} AND status = 'queued'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);
  const rows = (result as unknown as { rows?: PrintJob[] }).rows ?? (result as unknown as PrintJob[]);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/**
 * Atomically claim a specific job for a specific printer. Used when the
 * printer fetches the URL from `clientAction.url` (which embeds the job
 * id). Guarantees that the browser agent and CloudPRNT can't both deliver
 * the same job, and prevents one printer's token from claiming jobs that
 * belong to another printer.
 */
export async function claimJobForPrinterById(
  printerId: number,
  jobId: number,
): Promise<PrintJob | null> {
  const result = await db.execute<PrintJob>(sql`
    UPDATE print_jobs
    SET status = 'delivered',
        attempts = attempts + 1,
        delivered_at = now(),
        delivered_via = COALESCE(delivered_via, 'cloudprnt')
    WHERE id = (
      SELECT id FROM print_jobs
      WHERE id = ${jobId}
        AND printer_id = ${printerId}
        AND status = 'queued'
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);
  const rows = (result as unknown as { rows?: PrintJob[] }).rows ?? (result as unknown as PrintJob[]);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/**
 * Atomically claim a job for the browser print agent. Only claims jobs that
 * belong to LAN-capable printers (lan_browser or cloudprnt_lan_fallback) and
 * are still in queued state. Sets delivered_via = 'lan_browser'.
 *
 * Returns null (caller should respond 409) if the job was already claimed by
 * CloudPRNT or another agent instance.
 */
export async function claimJobForAgent(jobId: number): Promise<PrintJob | null> {
  const result = await db.execute<PrintJob>(sql`
    UPDATE print_jobs
    SET status = 'delivered',
        attempts = attempts + 1,
        delivered_at = now(),
        delivered_via = 'lan_browser'
    WHERE id = (
      SELECT pj.id FROM print_jobs pj
      JOIN printers p ON p.id = pj.printer_id
      WHERE pj.id = ${jobId}
        AND pj.status = 'queued'
        AND p.print_mode IN ('lan_browser', 'cloudprnt_lan_fallback')
        AND p.lan_ip IS NOT NULL
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);
  const rows = (result as unknown as { rows?: PrintJob[] }).rows ?? (result as unknown as PrintJob[]);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/**
 * Return queued jobs eligible for browser-based LAN delivery.
 * Includes:
 *   (a) all queued jobs for `lan_browser` printers
 *   (b) queued jobs for `cloudprnt_lan_fallback` printers whose created_at is
 *       older than the stale threshold (default 8 s) — these have been waiting
 *       long enough that CloudPRNT hasn't claimed them, so the agent takes over.
 *
 * Returns up to 10 jobs, oldest first, each augmented with the printer's lanIp.
 */
export async function getQueuedJobsForLanAgent(
  staleSeconds = 8,
): Promise<(PrintJob & { lanIp: string })[]> {
  const result = await db.execute<PrintJob & { lanIp: string }>(sql`
    SELECT pj.*, p.lan_ip AS "lanIp"
    FROM print_jobs pj
    JOIN printers p ON p.id = pj.printer_id
    WHERE pj.status = 'queued'
      AND p.enabled = true
      AND p.lan_ip IS NOT NULL
      AND (
        p.print_mode = 'lan_browser'
        OR (
          p.print_mode = 'cloudprnt_lan_fallback'
          AND pj.created_at < NOW() - (${staleSeconds} || ' seconds')::interval
        )
      )
    ORDER BY pj.created_at ASC
    LIMIT 10
  `);
  const rows = (result as unknown as { rows?: (PrintJob & { lanIp: string })[] }).rows
    ?? (result as unknown as (PrintJob & { lanIp: string })[]);
  return Array.isArray(rows) ? rows : [];
}

/** Peek the next queued job for a printer without claiming it. */
export async function peekNextJobForPrinter(printerId: number): Promise<PrintJob | null> {
  const rows = await db
    .select()
    .from(printJobsTable)
    .where(and(eq(printJobsTable.printerId, printerId), eq(printJobsTable.status, "queued")))
    .orderBy(printJobsTable.createdAt)
    .limit(1);
  return rows[0] ?? null;
}

export async function getJobById(jobId: number): Promise<PrintJob | null> {
  const rows = await db.select().from(printJobsTable).where(eq(printJobsTable.id, jobId)).limit(1);
  return rows[0] ?? null;
}

export async function markJobPrinted(jobId: number, deliveredVia?: "cloudprnt" | "lan_fallback" | "lan_browser"): Promise<void> {
  const updates: Record<string, unknown> = { status: "printed", printedAt: new Date(), error: null };
  if (deliveredVia) updates.deliveredVia = deliveredVia;
  await db.update(printJobsTable).set(updates).where(eq(printJobsTable.id, jobId));
}

export async function markJobFailed(jobId: number, error: string): Promise<void> {
  await db.update(printJobsTable).set({ status: "failed", error }).where(eq(printJobsTable.id, jobId));
}

/** Cancel a queued job. Only works while the job is still `queued` — jobs
 *  already delivered or printed cannot be cancelled. Returns null if not found
 *  or in a non-cancellable state. */
export async function cancelJob(jobId: number): Promise<PrintJob | null> {
  const [row] = await db
    .update(printJobsTable)
    .set({ status: "canceled" })
    .where(and(eq(printJobsTable.id, jobId), eq(printJobsTable.status, "queued")))
    .returning();
  return row ?? null;
}

export async function requeueJob(jobId: number): Promise<PrintJob | null> {
  const [row] = await db
    .update(printJobsTable)
    .set({ status: "queued", error: null, deliveredAt: null, printedAt: null, deliveredVia: null })
    .where(eq(printJobsTable.id, jobId))
    .returning();
  return row ?? null;
}

export async function recentJobsForPrinter(printerId: number, limit = 50): Promise<PrintJob[]> {
  return db
    .select()
    .from(printJobsTable)
    .where(eq(printJobsTable.printerId, printerId))
    .orderBy(desc(printJobsTable.createdAt))
    .limit(limit);
}

export async function recentJobs(limit = 100): Promise<PrintJob[]> {
  return db.select().from(printJobsTable).orderBy(desc(printJobsTable.createdAt)).limit(limit);
}

/** Log helper that's safe outside a request scope (printer fan-out). */
export function printLog(): typeof logger {
  return logger;
}
