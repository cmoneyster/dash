import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { eventSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

router.get("/admin/event-settings", async (req, res) => {
  try {
    const [settings] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
    res.json({
      eventName: settings?.eventName ?? "",
      hasPassword: !!(settings?.eventPassword),
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching event settings");
    res.status(500).json({ error: "Failed to fetch event settings" });
  }
});

router.put("/admin/event-settings", async (req, res) => {
  try {
    const { eventName, eventPassword } = req.body as { eventName?: string; eventPassword?: string };
    const [existing] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));

    if (existing) {
      const updates: Record<string, any> = { updatedAt: new Date() };
      if (eventName !== undefined) updates.eventName = eventName.trim();
      if (eventPassword !== undefined && eventPassword !== "") updates.eventPassword = eventPassword;
      const [updated] = await db.update(eventSettingsTable).set(updates).where(eq(eventSettingsTable.id, 1)).returning();
      res.json({ eventName: updated.eventName, hasPassword: !!updated.eventPassword });
    } else {
      const [created] = await db.insert(eventSettingsTable).values({
        id: 1,
        eventName: eventName?.trim() ?? "",
        eventPassword: eventPassword ?? process.env.EVENT_PASSWORD ?? "",
      }).returning();
      res.json({ eventName: created.eventName, hasPassword: !!created.eventPassword });
    }
  } catch (err) {
    req.log.error({ err }, "Error updating event settings");
    res.status(500).json({ error: "Failed to update event settings" });
  }
});

export default router;
