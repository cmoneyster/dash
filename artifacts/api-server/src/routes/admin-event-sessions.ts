import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { eventSessionsTable, eventOrdersTable, eventSettingsTable } from "@workspace/db/schema";
import { eq, desc, sql } from "drizzle-orm";

const router: IRouter = Router();

// List all event sessions with order count and totals
router.get("/admin/event-sessions", async (req, res) => {
  try {
    const sessions = await db
      .select()
      .from(eventSessionsTable)
      .orderBy(desc(eventSessionsTable.createdAt));

    const [settings] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
    const activeSessionId = settings?.activeEventSessionId ?? null;

    const withCounts = await Promise.all(
      sessions.map(async (session) => {
        const orders = await db
          .select({ id: eventOrdersTable.id, items: eventOrdersTable.items, status: eventOrdersTable.status })
          .from(eventOrdersTable)
          .where(eq(eventOrdersTable.eventSessionId, session.id));

        const orderCount = orders.length;
        const totalRevenue = orders.reduce((sum, o) => {
          const items = o.items as Array<{ price: number; quantity: number }>;
          return sum + items.reduce((s, i) => s + i.price * i.quantity, 0);
        }, 0);

        return { ...session, orderCount, totalRevenue, isActive: session.id === activeSessionId };
      })
    );

    res.json(withCounts);
  } catch (err) {
    req.log.error({ err }, "Error listing event sessions");
    res.status(500).json({ error: "Failed to fetch event sessions" });
  }
});

// Create a new event session
router.post("/admin/event-sessions", async (req, res) => {
  try {
    const { name, date, notes, setActive } = req.body as {
      name: string;
      date?: string;
      notes?: string;
      setActive?: boolean;
    };
    if (!name?.trim()) {
      res.status(400).json({ error: "Session name is required" });
      return;
    }
    const [session] = await db
      .insert(eventSessionsTable)
      .values({ name: name.trim(), date: date?.trim() || null, notes: notes?.trim() || null })
      .returning();

    if (setActive) {
      const [existing] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
      if (existing) {
        await db.update(eventSettingsTable).set({ activeEventSessionId: session.id, updatedAt: new Date() }).where(eq(eventSettingsTable.id, 1));
      } else {
        await db.insert(eventSettingsTable).values({ id: 1, eventName: name.trim(), activeEventSessionId: session.id });
      }
    }

    res.status(201).json(session);
  } catch (err) {
    req.log.error({ err }, "Error creating event session");
    res.status(500).json({ error: "Failed to create event session" });
  }
});

// Update an event session
router.put("/admin/event-sessions/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, date, notes, status } = req.body as {
      name?: string;
      date?: string;
      notes?: string;
      status?: string;
    };
    const updates: Record<string, any> = {};
    if (name !== undefined) updates.name = name.trim();
    if (date !== undefined) updates.date = date.trim() || null;
    if (notes !== undefined) updates.notes = notes.trim() || null;
    if (status !== undefined) {
      updates.status = status;
      if (status === "archived") updates.archivedAt = new Date();
    }
    const [updated] = await db
      .update(eventSessionsTable)
      .set(updates)
      .where(eq(eventSessionsTable.id, id))
      .returning();
    if (!updated) return res.status(404).json({ error: "Session not found" });
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Error updating event session");
    res.status(500).json({ error: "Failed to update event session" });
  }
});

// Set a session as the active event session
router.post("/admin/event-sessions/:id/activate", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [session] = await db.select().from(eventSessionsTable).where(eq(eventSessionsTable.id, id));
    if (!session) return res.status(404).json({ error: "Session not found" });

    const [existing] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
    if (existing) {
      await db.update(eventSettingsTable).set({ activeEventSessionId: id, updatedAt: new Date() }).where(eq(eventSettingsTable.id, 1));
    } else {
      await db.insert(eventSettingsTable).values({ id: 1, eventName: session.name, activeEventSessionId: id });
    }
    res.json({ ok: true, activeEventSessionId: id });
  } catch (err) {
    req.log.error({ err }, "Error activating event session");
    res.status(500).json({ error: "Failed to activate session" });
  }
});

// Clear the active session (no active event)
router.post("/admin/event-sessions/deactivate", async (req, res) => {
  try {
    await db.update(eventSettingsTable).set({ activeEventSessionId: null, updatedAt: new Date() }).where(eq(eventSettingsTable.id, 1));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Error deactivating event session");
    res.status(500).json({ error: "Failed to deactivate session" });
  }
});

// Archive a session
router.post("/admin/event-sessions/:id/archive", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [updated] = await db
      .update(eventSessionsTable)
      .set({ status: "archived", archivedAt: new Date() })
      .where(eq(eventSessionsTable.id, id))
      .returning();
    if (!updated) return res.status(404).json({ error: "Session not found" });

    // If this was the active session, clear it
    await db.update(eventSettingsTable)
      .set({ activeEventSessionId: sql`CASE WHEN active_event_session_id = ${id} THEN NULL ELSE active_event_session_id END`, updatedAt: new Date() })
      .where(eq(eventSettingsTable.id, 1));

    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Error archiving event session");
    res.status(500).json({ error: "Failed to archive session" });
  }
});

// Get all orders for a specific session
router.get("/admin/event-sessions/:id/orders", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [session] = await db.select().from(eventSessionsTable).where(eq(eventSessionsTable.id, id));
    if (!session) return res.status(404).json({ error: "Session not found" });

    const orders = await db
      .select()
      .from(eventOrdersTable)
      .where(eq(eventOrdersTable.eventSessionId, id))
      .orderBy(desc(eventOrdersTable.createdAt));

    res.json({ session, orders });
  } catch (err) {
    req.log.error({ err }, "Error fetching session orders");
    res.status(500).json({ error: "Failed to fetch session orders" });
  }
});

// Delete ALL orders for a session (keep the session)
router.delete("/admin/event-sessions/:id/orders", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [session] = await db.select().from(eventSessionsTable).where(eq(eventSessionsTable.id, id));
    if (!session) return res.status(404).json({ error: "Session not found" });
    await db.delete(eventOrdersTable).where(eq(eventOrdersTable.eventSessionId, id));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Error deleting session orders");
    res.status(500).json({ error: "Failed to delete session orders" });
  }
});

// Delete a session and all its orders
router.delete("/admin/event-sessions/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    // Unlink orders first
    await db.update(eventOrdersTable).set({ eventSessionId: null }).where(eq(eventOrdersTable.eventSessionId, id));
    // Clear active session reference if needed
    await db.update(eventSettingsTable)
      .set({ activeEventSessionId: sql`CASE WHEN active_event_session_id = ${id} THEN NULL ELSE active_event_session_id END`, updatedAt: new Date() })
      .where(eq(eventSettingsTable.id, 1));
    // Delete the session
    const [deleted] = await db
      .delete(eventSessionsTable)
      .where(eq(eventSessionsTable.id, id))
      .returning();
    if (!deleted) return res.status(404).json({ error: "Session not found" });
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Error deleting event session");
    res.status(500).json({ error: "Failed to delete session" });
  }
});

export default router;
