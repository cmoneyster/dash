import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { blackoutDatesTable } from "@workspace/db/schema";
import { eq, between } from "drizzle-orm";

const router: IRouter = Router();

router.get("/events/availability", async (req, res) => {
  try {
    const { startDate, endDate } = req.query as { startDate: string; endDate: string };
    if (!startDate || !endDate) {
      return res.status(400).json({ error: "startDate and endDate are required" });
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

router.post("/admin/blackout-dates", async (req, res) => {
  try {
    const { date, reason } = req.body;
    if (!date) return res.status(400).json({ error: "date is required" });
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
