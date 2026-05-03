import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { blackoutDatesTable, eventSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { computeDayLoad, findOpenAlternates, isRealCalendarDate } from "../lib/dayLoad";

const router: IRouter = Router();

// Day-load: combined blackout + per-service-style + global guest-cap view
// for a single date. Powers the chat bot's date-aware reasoning and any
// future calendar UI that wants to render load tiers. No auth — same
// posture as /events/availability above.
router.get("/events/day-load", async (req, res): Promise<void> => {
  try {
    const { date } = req.query as { date?: string };
    if (!date || !isRealCalendarDate(date)) {
      res.status(400).json({ error: "date must be a real calendar date in YYYY-MM-DD format" });
      return;
    }
    const load = await computeDayLoad(date);
    let suggestedDates: string[] = [];
    if (load.blackedOut || load.load === "full") {
      suggestedDates = await findOpenAlternates(date, 3);
    }
    // Public response: aggregates only. Intentionally strip the raw
    // `bookings` array and any per-row identifiers — the bot's
    // tailored verdict is computed server-side via computeDayLoad and
    // doesn't need to leak order IDs / individual statuses to anyone
    // who hits this endpoint.
    const { bookings: _drop, ...publicShape } = load;
    void _drop;
    res.json({ ...publicShape, suggestedDates });
  } catch (err) {
    req.log.error({ err }, "Error computing day load");
    res.status(500).json({ error: "Failed to compute day load" });
  }
});

// Public OTD pricing config — read by Cart and Plan toggles to render
// the live setup-fee summary, waiver hint, and explainer copy without
// admin auth. Mirrors the OTD subset of /admin/event-settings. Returns
// schema defaults when the row is missing so a fresh database doesn't
// break checkout.
router.get("/event-settings/otd-config", async (_req, res) => {
  try {
    const [settings] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
    res.json({
      setupFee: settings?.otdSetupFee != null ? parseFloat(settings.otdSetupFee) : 500,
      feeWaiverThreshold: settings?.otdFeeWaiverThreshold != null ? parseFloat(settings.otdFeeWaiverThreshold) : 2000,
      includedHours: settings?.otdIncludedHours != null ? parseFloat(settings.otdIncludedHours) : 2,
      additionalHourRate: settings?.otdAdditionalHourRate != null ? parseFloat(settings.otdAdditionalHourRate) : 100,
      maxAdditionalHours: settings?.otdMaxAdditionalHours ?? 3,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load OTD config" });
  }
});

router.get("/events/availability", async (req, res): Promise<void> => {
  try {
    const { startDate, endDate } = req.query as { startDate: string; endDate: string };
    if (!startDate || !endDate) {
      res.status(400).json({ error: "startDate and endDate are required" });
      return;
    }

    const allBlackouts = await db.select().from(blackoutDatesTable);
    const blackoutSet = new Set(allBlackouts.map((b) => b.date));

    const rangeBlackouts: string[] = [];
    const start = new Date(startDate);
    const end = new Date(endDate);

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split("T")[0];
      if (blackoutSet.has(dateStr)) {
        rangeBlackouts.push(dateStr);
      }
    }

    const isAvailable = rangeBlackouts.length === 0;

    // Suggest 3 alternate dates after endDate if unavailable
    const suggestedDates: string[] = [];
    if (!isAvailable) {
      const check = new Date(end);
      check.setDate(check.getDate() + 1);
      while (suggestedDates.length < 3) {
        const ds = check.toISOString().split("T")[0];
        if (!blackoutSet.has(ds)) {
          suggestedDates.push(ds);
        }
        check.setDate(check.getDate() + 1);
      }
    }

    res.json({ available: isAvailable, blackoutDates: rangeBlackouts, suggestedDates });
  } catch (err) {
    req.log.error({ err }, "Error checking availability");
    res.status(500).json({ error: "Failed to check availability" });
  }
});

// Public blackout dates — no auth required (used in customer-facing checkout)
router.get("/blackout-dates", async (req, res) => {
  try {
    const dates = await db.select().from(blackoutDatesTable).orderBy(blackoutDatesTable.date);
    res.json(dates);
  } catch (err) {
    req.log.error({ err }, "Error listing blackout dates (public)");
    res.status(500).json({ error: "Failed to list blackout dates" });
  }
});

// Admin blackout date routes
router.get("/admin/blackout-dates", async (req, res) => {
  try {
    const dates = await db.select().from(blackoutDatesTable).orderBy(blackoutDatesTable.date);
    res.json(dates);
  } catch (err) {
    req.log.error({ err }, "Error listing blackout dates");
    res.status(500).json({ error: "Failed to list blackout dates" });
  }
});

router.post("/admin/blackout-dates", async (req, res): Promise<void> => {
  try {
    const { date, reason } = req.body;
    if (!date) {
      res.status(400).json({ error: "date is required" });
      return;
    }
    const [created] = await db.insert(blackoutDatesTable).values({ date, reason: reason ?? null }).returning();
    res.status(201).json(created);
  } catch (err) {
    req.log.error({ err }, "Error creating blackout date");
    res.status(500).json({ error: "Failed to create blackout date" });
  }
});

router.delete("/admin/blackout-dates/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.delete(blackoutDatesTable).where(eq(blackoutDatesTable.id, id));
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Error deleting blackout date");
    res.status(500).json({ error: "Failed to delete blackout date" });
  }
});

export default router;
