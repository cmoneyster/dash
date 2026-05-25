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
      contentType: args.contentType ?? "application/vnd.star.starprntcore",
    })
    .returning();
  return row;
}

/**
 * Find printers that should receive a given job type.
 * `mode: "auto"` (default) requires `auto_print_on_new_order` to be on.
 * `mode: "manual"` ignores that toggle — used by explicit reprint actions.
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
 * Atomically claim a job for the browser print agent. Claims any queued job
 * whose printer has a LAN IP — CloudPRNT is retired so all LAN printers use
 * the browser agent regardless of their stored print_mode value.
 * Returns null if the job was already claimed by another agent instance.
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
        AND p.lan_ip IS NOT NULL
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING
      id,
      printer_id        AS "printerId",
      job_type          AS "jobType",
      status,
      payload,
      order_source      AS "orderSource",
      order_id          AS "orderId",
      content_type      AS "contentType",
      attempts,
      created_at        AS "createdAt",
      delivered_at      AS "deliveredAt",
      printed_at        AS "printedAt",
      delivered_via     AS "deliveredVia",
      error
  `);
  const rows = (result as unknown as { rows?: PrintJob[] }).rows ?? (result as unknown as PrintJob[]);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/**
 * Return queued jobs eligible for browser-based LAN delivery.
 * Includes any enabled printer with a LAN IP — print_mode is not checked
 * since CloudPRNT is retired and all LAN printers now use the browser agent.
 */
export async function getQueuedJobsForLanAgent(): Promise<(PrintJob & { lanIp: string; printTemplate: import("@workspace/db/schema").PrintTemplate | null })[]> {
  type Row = PrintJob & { lanIp: string; printTemplate: import("@workspace/db/schema").PrintTemplate | null };
  const result = await db.execute<Row>(sql`
    SELECT pj.*, p.lan_ip AS "lanIp", p.print_template AS "printTemplate"
    FROM print_jobs pj
    JOIN printers p ON p.id = pj.printer_id
    WHERE pj.status = 'queued'
      AND p.enabled = true
      AND p.lan_ip IS NOT NULL
    ORDER BY pj.created_at ASC
    LIMIT 10
  `);
  const rows = (result as unknown as { rows?: Row[] }).rows ?? (result as unknown as Row[]);
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

export async function markJobPrinted(jobId: number, deliveredVia?: "lan_browser"): Promise<void> {
  const updates: Record<string, unknown> = { status: "printed", printedAt: new Date(), error: null };
  if (deliveredVia) updates.deliveredVia = deliveredVia;
  await db.update(printJobsTable).set(updates).where(eq(printJobsTable.id, jobId));
}

export async function markJobFailed(jobId: number, error: string): Promise<void> {
  await db.update(printJobsTable).set({ status: "failed", error }).where(eq(printJobsTable.id, jobId));
}

/** Cancel a queued job. Only works while the job is still `queued`. */
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

export async function getLastDeliveredJobForPrinter(printerId: number): Promise<PrintJob | null> {
  const [row] = await db
    .select()
    .from(printJobsTable)
    .where(and(eq(printJobsTable.printerId, printerId), eq(printJobsTable.status, "delivered")))
    .orderBy(desc(printJobsTable.deliveredAt))
    .limit(1);
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
