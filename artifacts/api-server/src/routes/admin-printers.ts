import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { db } from "@workspace/db";
import { printersTable, printJobsTable, type PrintTemplate } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

const sectionStyleSchema = z.object({
  visible:      z.boolean().optional(),
  bold:         z.boolean().optional(),
  align:        z.enum(["left", "center", "right"]).optional(),
  size:         z.number().int().min(1).max(8).optional(),
  dividerBefore: z.boolean().optional(),
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
  reverseOrder:    z.boolean().nullable().optional(),
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

    // Parse the ESC/POS byte stream into per-line metadata for HTML preview.
    // Each line tracks its size multiplier, bold state, and alignment so the
    // frontend can render it with correct CSS font-size and text-align.
    interface ParsedLine { text: string; size: number; bold: boolean; align: "left" | "center" | "right"; }
    const parsedLines: ParsedLine[] = [];
    let alignCss: "left" | "center" | "right" = "left";
    let isBold = false;
    let currentSize = 1;
    let col = "";

    let i = 0;
    while (i < bytes.length) {
      const byte = bytes[i];
      if (byte === 0x1b) {
        const next = bytes[i + 1];
        if (next === 0x61 && i + 2 < bytes.length) {
          // ESC a n — set justification
          const n = bytes[i + 2];
          alignCss = n === 0x01 ? "center" : n === 0x02 ? "right" : "left";
          i += 3;
        } else if (next === 0x45 && i + 2 < bytes.length) {
          // ESC E n — bold on/off
          isBold = bytes[i + 2] !== 0;
          i += 3;
        } else if (next === 0x40) {
          i += 2; // ESC @ — init (skip)
        } else if (next === 0x64 && i + 2 < bytes.length) {
          i += 3; // ESC d n — feed lines (skip)
        } else if (next === 0x6d) {
          i += 2; // ESC m — cut (skip)
        } else {
          i += 2;
        }
      } else if (byte === 0x1d) {
        // GS ! n — text size (n encodes width×height multiplier 1–8)
        if (bytes[i + 1] === 0x21 && i + 2 < bytes.length) {
          currentSize = (bytes[i + 2] & 0x0f) + 1; // height from low nibble
        }
        i += 3;
      } else if (byte === 0x0a) {
        parsedLines.push({ text: col, size: currentSize, bold: isBold, align: alignCss });
        col = "";
        i++;
      } else if (byte >= 0x20 && byte <= 0x7e) {
        col += String.fromCharCode(byte);
        i++;
      } else {
        i++;
      }
    }
    if (col) parsedLines.push({ text: col, size: currentSize, bold: isBold, align: alignCss });

    const escHtml = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    // Each line becomes a display:block <span> with inline CSS for size, weight, alignment.
    const text = parsedLines
      .map((line) => {
        const content = escHtml(line.text) || "&nbsp;";
        const style =
          `display:block;font-size:${line.size}em;` +
          `font-weight:${line.bold ? "bold" : "normal"};` +
          `text-align:${line.align}`;
        return `<span style="${style}">${content}</span>`;
      })
      .join("");

    res.json({ ticketType, text });
  } catch (err) {
    req.log.error({ err }, "preview-template failed");
    res.status(500).json({ error: "Failed to render preview" });
  }
});

/**
 * POST /admin/printers/:id/test-print-template
 *
 * Enqueues a real print job using the supplied (unsaved) template so the
 * operator can see a physical printout before committing the template.
 */
router.post("/admin/printers/:id/test-print-template", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [printer] = await db.select().from(printersTable).where(eq(printersTable.id, id));
    if (!printer) { res.status(404).json({ error: "not found" }); return; }
    if (!printer.lanIp) { res.status(400).json({ error: "No LAN IP configured for this printer" }); return; }

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

    // Embed the template override directly in the payload so the print agent
    // uses this template instead of the printer's saved one when rendering.
    const job = await enqueuePrintJob({
      printerId: printer.id,
      jobType: payload.type as import("@workspace/db/schema").PrintJobType,
      payload: { ...payload, _templateOverride: template ?? null } as unknown as Record<string, unknown>,
    });

    res.json({ jobId: job.id, message: "Test job queued — printing now." });
  } catch (err) {
    req.log.error({ err }, "test-print-template failed");
    res.status(500).json({ error: "Failed to enqueue test print" });
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
