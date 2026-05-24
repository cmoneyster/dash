import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { printersTable, printJobsTable } from "@workspace/db/schema";
import { and, desc, eq } from "drizzle-orm";
import {
  cancelJob,
  enqueuePrintJob,
  generateCloudPrntToken,
  recentJobs,
  recentJobsForPrinter,
  requeueJob,
} from "../lib/printQueue";
import { renderJob } from "../lib/printRenderer";
import { sendViaLanTcp } from "../lib/lanPrint";
import type {
  KitchenTicketPayload,
  CustomerReceiptPayload,
  ItemLabelPayload,
  RenderablePayload,
  TestPayload,
} from "../lib/printRenderer";

const router: IRouter = Router();

router.get("/admin/printers", async (req, res) => {
  try {
    const rows = await db.select().from(printersTable).orderBy(printersTable.id);
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "list printers failed");
    res.status(500).json({ error: "Failed to list printers" });
  }
});

router.post("/admin/printers", async (req, res) => {
  try {
    const b = req.body as Record<string, unknown>;
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name) {
      res.status(400).json({ error: "name required" });
      return;
    }
    const [row] = await db
      .insert(printersTable)
      .values({
        name,
        model: typeof b.model === "string" && b.model ? b.model : "TSP143IV",
        cloudprntToken: generateCloudPrntToken(),
        lanIp: typeof b.lanIp === "string" && b.lanIp.trim() ? b.lanIp.trim() : null,
        location: typeof b.location === "string" && b.location.trim() ? b.location.trim() : null,
        printsKitchenTicket: !!b.printsKitchenTicket,
        printsCustomerReceipt: !!b.printsCustomerReceipt,
        printsItemLabels: !!b.printsItemLabels,
        autoPrintOnNewOrder: b.autoPrintOnNewOrder !== false,
        allowLanFallback: b.allowLanFallback !== false,
        suppressItemLabelsForPlateLines: b.suppressItemLabelsForPlateLines !== false,
        enabled: b.enabled !== false,
      })
      .returning();
    res.status(201).json(row);
  } catch (err) {
    req.log.error({ err }, "create printer failed");
    res.status(500).json({ error: "Failed to create printer" });
  }
});

router.patch("/admin/printers/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const b = req.body as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    if (typeof b.name === "string") updates.name = b.name.trim();
    if (typeof b.model === "string") updates.model = b.model;
    if (b.lanIp !== undefined) updates.lanIp = typeof b.lanIp === "string" && b.lanIp.trim() ? b.lanIp.trim() : null;
    if (b.location !== undefined) updates.location = typeof b.location === "string" && b.location.trim() ? b.location.trim() : null;
    for (const k of [
      "printsKitchenTicket",
      "printsCustomerReceipt",
      "printsItemLabels",
      "autoPrintOnNewOrder",
      "allowLanFallback",
      "suppressItemLabelsForPlateLines",
      "enabled",
    ] as const) {
      if (b[k] !== undefined) updates[k] = !!b[k];
    }
    const [row] = await db.update(printersTable).set(updates).where(eq(printersTable.id, id)).returning();
    if (!row) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "update printer failed");
    res.status(500).json({ error: "Failed to update printer" });
  }
});

router.delete("/admin/printers/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.delete(printersTable).where(eq(printersTable.id, id));
    res.status(204).end();
  } catch (err) {
    req.log.error({ err }, "delete printer failed");
    res.status(500).json({ error: "Failed to delete printer" });
  }
});

router.post("/admin/printers/:id/test-print", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [printer] = await db.select().from(printersTable).where(eq(printersTable.id, id));
    if (!printer) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const jobType = typeof req.body?.jobType === "string" ? req.body.jobType : "test";
    const message = typeof req.body?.message === "string" ? req.body.message : undefined;
    const now = new Date().toISOString();

    let payload:
      | TestPayload
      | KitchenTicketPayload
      | CustomerReceiptPayload
      | ItemLabelPayload;
    if (jobType === "kitchen_ticket") {
      payload = {
        type: "kitchen_ticket",
        header: { orderNumber: "TEST", guestName: "Test Guest", source: "manual", placedAt: now },
        lines: [
          { name: "Orange Chicken", quantity: 2, modifiers: ["extra sauce"], notes: "well done" },
          { name: "Spring Rolls", quantity: 5 },
        ],
      };
    } else if (jobType === "customer_receipt") {
      payload = {
        type: "customer_receipt",
        header: { orderNumber: "TEST", guestName: "Test Guest", source: "manual", placedAt: now },
        lines: [
          { name: "Orange Chicken", quantity: 2, unitPrice: 12.5 },
          { name: "Spring Rolls", quantity: 5, unitPrice: 2.5 },
        ],
        subtotal: 37.5,
        tax: 2.25,
        total: 39.75,
        businessName: "dash by Hollywood East Cafe",
        footer: "Thank you!",
      };
    } else if (jobType === "item_label") {
      payload = {
        type: "item_label",
        orderNumber: "TEST",
        guestName: "Test Guest",
        itemName: "Orange Chicken",
        quantity: 1,
        modifiers: ["extra sauce"],
        notes: "well done",
        placedAt: now,
      };
    } else {
      payload = { type: "test", printerName: printer.name, message };
    }

    const job = await enqueuePrintJob({
      printerId: printer.id,
      jobType: payload.type,
      payload: payload as unknown as Record<string, unknown>,
    });
    res.json(job);
  } catch (err) {
    req.log.error({ err }, "test print failed");
    res.status(500).json({ error: "Failed to enqueue test print" });
  }
});

/**
 * POST /admin/printers/:id/test-lan
 *
 * Send a test ticket directly to the printer's LAN IP on TCP port 9100,
 * bypassing the CloudPRNT queue entirely. Useful for verifying network
 * reachability before relying on the LAN fallback path.
 */
router.post("/admin/printers/:id/test-lan", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [printer] = await db.select().from(printersTable).where(eq(printersTable.id, id));
    if (!printer) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (!printer.lanIp) {
      res.status(400).json({ error: "No LAN IP configured for this printer" });
      return;
    }
    const { bytes } = renderJob({
      type: "test",
      printerName: printer.name,
      message: "LAN direct-print test via TCP port 9100.",
    });
    await sendViaLanTcp(printer.lanIp, bytes);
    res.json({ ok: true, lanIp: printer.lanIp });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    req.log.warn({ err }, "[lan-print] test-lan failed");
    res.status(502).json({ error: message });
  }
});

router.get("/admin/print-jobs", async (req, res) => {
  try {
    const printerId = req.query.printerId ? parseInt(String(req.query.printerId)) : null;
    const limit = req.query.limit ? Math.min(500, parseInt(String(req.query.limit))) : 100;
    const rows = printerId ? await recentJobsForPrinter(printerId, limit) : await recentJobs(limit);
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "list print jobs failed");
    res.status(500).json({ error: "Failed to list print jobs" });
  }
});

/**
 * Manual reprint trigger from Kitchen Display / Event Taker.
 * Fans the order out through the same path as auto-print, ignoring the
 * `auto_print_on_new_order` toggle (this is an explicit "send to printers"
 * request from staff). Body: { kind: "kitchen" | "receipt" | "all" }.
 */
router.post("/admin/event-orders/:id/reprint", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { fanoutPrintForEventOrderId } = await import("../lib/printFanout");
    const enqueued = await fanoutPrintForEventOrderId(id, "kitchen_send");
    res.json({ enqueued });
  } catch (err) {
    req.log.error({ err }, "reprint failed");
    res.status(500).json({ error: "Failed to reprint" });
  }
});

router.post("/admin/print-jobs/:id/retry", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const row = await requeueJob(id);
    if (!row) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "retry print job failed");
    res.status(500).json({ error: "Failed to retry print job" });
  }
});

/** Cancel a queued job. Returns 404 if not found or already past the queued state. */
router.delete("/admin/print-jobs/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const row = await cancelJob(id);
    if (!row) {
      res.status(404).json({ error: "Job not found or not in queued state" });
      return;
    }
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "cancel print job failed");
    res.status(500).json({ error: "Failed to cancel print job" });
  }
});

/**
 * Render a job's payload and return the human-readable text content.
 * Binary ESC/GS sequences are stripped so the preview is displayable in a
 * browser — only printable ASCII + newlines are kept.
 */
router.get("/admin/print-jobs/:id/preview", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const rows = await db
      .select()
      .from(printJobsTable)
      .where(eq(printJobsTable.id, id))
      .limit(1);
    const job = rows[0];
    if (!job) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const { bytes } = renderJob(job.payload as unknown as RenderablePayload);
    // Keep only LF (0x0A) and printable ASCII (0x20-0x7E); strip all binary
    // escape sequences so the output is safe to embed in JSON / display in a browser.
    const text = Buffer.from(
      bytes.filter((b: number) => b === 0x0a || (b >= 0x20 && b <= 0x7e)),
    )
      .toString("ascii")
      .trimEnd();
    res.json({ id: job.id, jobType: job.jobType, status: job.status, text });
  } catch (err) {
    req.log.error({ err }, "preview print job failed");
    res.status(500).json({ error: "Failed to preview job" });
  }
});

void and;
void desc;

export default router;
