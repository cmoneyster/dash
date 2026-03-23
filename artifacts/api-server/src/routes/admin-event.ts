import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { eventSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

async function isTwilioConfigured(): Promise<boolean> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
    ? "depl " + process.env.WEB_REPL_RENEWAL
    : null;
  if (!hostname || !xReplitToken) return false;
  try {
    const data: any = await fetch(
      "https://" + hostname + "/api/v2/connection?include_secrets=true&connector_names=twilio",
      { headers: { Accept: "application/json", "X-Replit-Token": xReplitToken } }
    ).then(r => r.json()).then((d: any) => d.items?.[0]);
    return !!(data?.settings?.account_sid && data?.settings?.api_key);
  } catch {
    return false;
  }
}

router.get("/admin/event-settings", async (req, res) => {
  try {
    const [settings] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
    const twilioConfigured = await isTwilioConfigured();
    res.json({
      eventName: settings?.eventName ?? "",
      hasOrderPassword: !!(settings?.eventPassword),
      hasKitchenPassword: !!(settings?.kitchenPassword),
      twilioConfigured,
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching event settings");
    res.status(500).json({ error: "Failed to fetch event settings" });
  }
});

router.put("/admin/event-settings", async (req, res) => {
  try {
    const { eventName, orderPassword, kitchenPassword } = req.body as {
      eventName?: string;
      orderPassword?: string;
      kitchenPassword?: string;
    };
    const [existing] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
    const twilioConfigured = await isTwilioConfigured();

    if (existing) {
      const updates: Record<string, any> = { updatedAt: new Date() };
      if (eventName !== undefined) updates.eventName = eventName.trim();
      if (orderPassword !== undefined && orderPassword !== "") updates.eventPassword = orderPassword;
      if (kitchenPassword !== undefined) {
        // Allow clearing kitchen password (empty string → null)
        updates.kitchenPassword = kitchenPassword.trim() || null;
      }
      const [updated] = await db.update(eventSettingsTable).set(updates).where(eq(eventSettingsTable.id, 1)).returning();
      res.json({
        eventName: updated.eventName,
        hasOrderPassword: !!updated.eventPassword,
        hasKitchenPassword: !!updated.kitchenPassword,
        twilioConfigured,
      });
    } else {
      const [created] = await db.insert(eventSettingsTable).values({
        id: 1,
        eventName: eventName?.trim() ?? "",
        eventPassword: orderPassword ?? process.env.EVENT_PASSWORD ?? "",
        kitchenPassword: kitchenPassword?.trim() || null,
      }).returning();
      res.json({
        eventName: created.eventName,
        hasOrderPassword: !!created.eventPassword,
        hasKitchenPassword: !!created.kitchenPassword,
        twilioConfigured,
      });
    }
  } catch (err) {
    req.log.error({ err }, "Error updating event settings");
    res.status(500).json({ error: "Failed to update event settings" });
  }
});

export default router;
