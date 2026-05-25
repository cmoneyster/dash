import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { db } from "@workspace/db";
import { printersTable, printJobsTable, type PrintTemplate } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

const sectionStyleSchema = z.object({
  visible:      z.boolean().optional(),
  bold:         z.boolean().optional(),
  align:        z.enum(["left", "center", "right"]).optional(),
  size:         z.enum(["normal", "double"]).optional(),
  dividerAfter: z.boolean().optional(),
});

const ticketLayoutSchema = z.object({
  sectionOrder: z.array(z.string()).optional(),
  sections:     z.record(z.string(), sectionStyleSchema).optional(),
});

const printTemplateSchema = z.object({
  businessName:    z.string().nullable().optional(),
  footer:          z.string().nullable().optional(),
  dividerChar:     z.string().max(1).nullable().optional(),
  headerText:      z.string().nullable().optional(),
  logoUrl:         z.string().nullable().optional(),
  logoPosition:    z.enum(["before_name", "after_name"]).nullable().optional(),
  kitchen_ticket:  ticketLayoutSchema.nullable().optional(),
  customer_receipt: ticketLayoutSchema.nullable().optional(),
  item_label:      ticketLayoutSchema.nullable().optional(),
  plate_label:     ticketLayoutSchema.nullable().optional(),
});
import {
  cancelJob,
  enqueuePrintJob,
  recentJobs,
  recentJobsForPrinter,
  requeueJob,
} from "../lib/printQueue";
import { renderJob } from "../lib/printRenderer";
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
        lanIp: typeof b.lanIp === "string" && b.lanIp.trim() ? b.lanIp.trim() : null,
        printMode: "lan_browser",
        location: typeof b.location === "string" && b.location.trim() ? b.location.trim() : null,
        printsKitchenTicket: !!b.printsKitchenTicket,
        printsCustomerReceipt: !!b.printsCustomerReceipt,
        printsItemLabels: !!b.printsItemLabels,
        autoPrintOnNewOrder: b.autoPrintOnNewOrder !== false,
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
    if (typeof b.printMode === "string" && ["lan_browser", "cloudprnt", "cloudprnt_lan_fallback"].includes(b.printMode)) {
      updates.printMode = b.printMode;
    }
    if (b.printTemplate !== undefined) {
      if (b.printTemplate == null) {
        updates.printTemplate = null;
      } else {
        const parsed = printTemplateSchema.safeParse(b.printTemplate);
        if (!parsed.success) {
          res.status(400).json({ error: "Invalid printTemplate", issues: parsed.error.issues });
          return;
        }
        updates.printTemplate = parsed.data as PrintTemplate;
      }
    }
    for (const k of [
      "printsKitchenTicket",
      "printsCustomerReceipt",
      "printsItemLabels",
      "autoPrintOnNewOrder",
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
    const job = await enqueuePrintJob({
      printerId: printer.id,
      jobType: "test",
      payload: {
        type: "test",
        printerName: printer.name,
        message: "LAN browser agent test — delivered via WebPRNT.",
      } as unknown as Record<string, unknown>,
    });
    res.json({ jobId: job.id, lanIp: printer.lanIp, message: "Test job queued — the LAN print agent on your local device will deliver it." });
  } catch (err) {
    req.log.error({ err }, "test-lan enqueue failed");
    res.status(500).json({ error: "Failed to enqueue LAN test job" });
  }
});

/**
 * POST /admin/printers/:id/preview-template
 *
 * Renders a sample ticket with the provided template and returns stripped
 * printable text so the frontend can display a live thermal paper preview.
 */
router.post("/admin/printers/:id/preview-template", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [printer] = await db.select().from(printersTable).where(eq(printersTable.id, id));
    if (!printer) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const b = req.body as Record<string, unknown>;
    const ticketType = typeof b.ticketType === "string" ? b.ticketType : "customer_receipt";
    const template = (b.template && typeof b.template === "object" ? b.template : null) as PrintTemplate | null;
    const now = new Date().toISOString();

    let payload: RenderablePayload;
    if (ticketType === "kitchen_ticket") {
      payload = {
        type: "kitchen_ticket",
        header: { orderNumber: "1042", guestName: "Jane Smith", source: "event_taker", placedAt: now, tableNumber: "12" },
        lines: [
          { name: "Orange Chicken", quantity: 2, modifiers: ["extra sauce"], notes: "well done" },
          { name: "Spring Rolls", quantity: 5 },
          { name: "Steamed Rice", quantity: 2 },
        ],
      };
    } else if (ticketType === "item_label") {
      payload = {
        type: "item_label",
        orderNumber: "1042",
        guestName: "Jane Smith",
        itemName: "Orange Chicken",
        quantity: 2,
        modifiers: ["extra sauce"],
        notes: "well done",
        placedAt: now,
      };
    } else if (ticketType === "plate_label") {
      payload = {
        type: "plate_label",
        orderNumber: "1042",
        guestName: "Jane Smith",
        plateLabel: "Plate 1",
        lines: [
          { name: "Orange Chicken", quantity: 1 },
          { name: "Steamed Rice", quantity: 1 },
        ],
        placedAt: now,
      };
    } else {
      payload = {
        type: "customer_receipt",
        header: { orderNumber: "1042", guestName: "Jane Smith", source: "event_taker", placedAt: now, tableNumber: "12" },
        lines: [
          { name: "Orange Chicken", quantity: 2, unitPrice: 12.5 },
          { name: "Spring Rolls", quantity: 5, unitPrice: 2.5 },
          { name: "Steamed Rice", quantity: 2, unitPrice: 3.0 },
        ],
        subtotal: 43.5,
        tax: 2.61,
        total: 46.11,
        businessName: "dash by Hollywood East Cafe",
        footer: "Thank you for your order!",
      };
    }

    const { bytes } = renderJob(payload, template ?? undefined);
    const text = Buffer.from(
      bytes.filter((b: number) => b === 0x0a || (b >= 0x20 && b <= 0x7e)),
    )
      .toString("ascii")
      .trimEnd();

    res.json({ ticketType, text });
  } catch (err) {
    req.log.error({ err }, "preview-template failed");
    res.status(500).json({ error: "Failed to render preview" });
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
    const [printer] = await db.select().from(printersTable).where(eq(printersTable.id, job.printerId));
    const template = printer?.printTemplate ?? undefined;
    const { bytes } = renderJob(job.payload as unknown as RenderablePayload, template);
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

export default router;
