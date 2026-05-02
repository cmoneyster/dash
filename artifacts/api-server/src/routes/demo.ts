import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { demoMenuItemsTable, demoOrdersTable, menuItemsTable } from "@workspace/db/schema";
import { asc, eq, inArray } from "drizzle-orm";
import { sendSms } from "../lib/sms";

const router: IRouter = Router();

// ── In-process rate limiter ──────────────────────────────────────────────
// Per-phone and per-IP submission timestamps. 5/hour and 10/day each.
// In-memory is acceptable here: this protects the SIM gateway from
// trivial demo-page spam, not from a determined attacker. The API
// server is single-process for our deployment, so a Map suffices; if
// the demo flow ever grows multi-instance the limiter should move to
// Redis or a DB-backed sliding window.
const submissions = new Map<string, number[]>();
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const HOURLY_LIMIT = 5;
const DAILY_LIMIT = 10;

function tryRecord(
  key: string,
  now: number,
): { ok: true } | { ok: false; reason: "hour" | "day" } {
  const arr = (submissions.get(key) ?? []).filter((t) => now - t < ONE_DAY_MS);
  const inLastHour = arr.filter((t) => now - t < ONE_HOUR_MS).length;
  if (inLastHour >= HOURLY_LIMIT) {
    submissions.set(key, arr);
    return { ok: false, reason: "hour" };
  }
  if (arr.length >= DAILY_LIMIT) {
    submissions.set(key, arr);
    return { ok: false, reason: "day" };
  }
  arr.push(now);
  submissions.set(key, arr);
  return { ok: true };
}

// Roll back a successful record if a later check fails — keeps the
// per-phone count honest when the per-IP cap rejects the submission.
function rollback(key: string, ts: number) {
  const arr = submissions.get(key);
  if (!arr) return;
  const i = arr.lastIndexOf(ts);
  if (i >= 0) arr.splice(i, 1);
}

// Canonical phone key for rate limiting: digits only, with a leading "1"
// stripped on 11-digit US numbers so "+1 555 123 4567", "1-555-123-4567",
// and "(555) 123-4567" all collapse to the same identity.
function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

// ── Public: read demo menu ───────────────────────────────────────────────
router.get("/demo/menu", async (req, res) => {
  try {
    const rows = await db
      .select({
        id: menuItemsTable.id,
        name: menuItemsTable.name,
        description: menuItemsTable.description,
        category: menuItemsTable.category,
        price: menuItemsTable.price,
        imageUrl: menuItemsTable.imageUrl,
        unit: menuItemsTable.unit,
        servingSize: menuItemsTable.servingSize,
        sortOrder: demoMenuItemsTable.sortOrder,
      })
      .from(demoMenuItemsTable)
      .innerJoin(menuItemsTable, eq(menuItemsTable.id, demoMenuItemsTable.menuItemId))
      .orderBy(asc(demoMenuItemsTable.sortOrder), asc(menuItemsTable.category), asc(menuItemsTable.name));
    res.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        category: r.category,
        price: parseFloat(r.price),
        imageUrl: r.imageUrl,
        unit: r.unit,
        servingSize: r.servingSize,
      })),
    );
  } catch (err) {
    req.log.error({ err }, "Error fetching demo menu");
    res.status(500).json({ error: "Failed to load demo menu" });
  }
});

// ── Public: submit demo order ────────────────────────────────────────────
router.post("/demo/orders", async (req, res) => {
  try {
    const { guestName, phoneNumber, items } = req.body as {
      guestName?: string;
      phoneNumber?: string;
      items?: { itemId: number; quantity: number }[];
    };
    if (!guestName?.trim()) {
      res.status(400).json({ error: "Please enter your name." });
      return;
    }
    if (!phoneNumber?.trim()) {
      res.status(400).json({ error: "Please enter your phone number." });
      return;
    }
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: "Please choose at least one item." });
      return;
    }
    const phoneNorm = normalizePhone(phoneNumber);
    if (phoneNorm.length < 10 || phoneNorm.length > 15) {
      res.status(400).json({ error: "Please enter a valid phone number." });
      return;
    }

    const now = Date.now();
    const ip = (req.ip || req.socket.remoteAddress || "unknown").toString();
    const phoneKey = `phone:${phoneNorm}`;
    const ipKey = `ip:${ip}`;

    const phoneCheck = tryRecord(phoneKey, now);
    if (!phoneCheck.ok) {
      res.status(429).json({
        error:
          phoneCheck.reason === "hour"
            ? "This phone number has already received 5 demo texts in the last hour. Please try again later."
            : "This phone number has already received 10 demo texts today. Please try again tomorrow.",
      });
      return;
    }
    const ipCheck = tryRecord(ipKey, now);
    if (!ipCheck.ok) {
      // Don't penalize the phone for the IP cap — roll back its counter.
      rollback(phoneKey, now);
      res.status(429).json({
        error:
          ipCheck.reason === "hour"
            ? "Demo limit reached for your network (5 per hour). Please try again later."
            : "Demo limit reached for your network (10 per day). Please try again tomorrow.",
      });
      return;
    }

    // Validate against the live demo menu — admins can add or remove items
    // between when the page loaded and when the user submits.
    const itemIds = items
      .map((i) => Number(i?.itemId))
      .filter((n) => Number.isInteger(n) && n > 0);
    const allowed = await db
      .select({
        id: menuItemsTable.id,
        name: menuItemsTable.name,
        price: menuItemsTable.price,
      })
      .from(menuItemsTable)
      .innerJoin(demoMenuItemsTable, eq(demoMenuItemsTable.menuItemId, menuItemsTable.id))
      .where(itemIds.length > 0 ? inArray(menuItemsTable.id, itemIds) : eq(menuItemsTable.id, -1));
    const byId = new Map(allowed.map((a) => [a.id, a]));

    const orderItems: { itemId: number; name: string; quantity: number; price: number }[] = [];
    for (const i of items) {
      const id = Number(i?.itemId);
      const qty = Number(i?.quantity);
      if (!Number.isInteger(id) || id <= 0) continue;
      if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty <= 0) continue;
      const row = byId.get(id);
      if (!row) {
        // Don't burn a rate-limit slot on a stale-menu rejection.
        rollback(phoneKey, now);
        rollback(ipKey, now);
        res.status(400).json({ error: "One of your selections is no longer on the demo menu. Please refresh and try again." });
        return;
      }
      orderItems.push({ itemId: row.id, name: row.name, quantity: qty, price: parseFloat(row.price) });
    }
    if (orderItems.length === 0) {
      rollback(phoneKey, now);
      rollback(ipKey, now);
      res.status(400).json({ error: "Please choose at least one item." });
      return;
    }

    const [created] = await db
      .insert(demoOrdersTable)
      .values({
        guestName: guestName.trim(),
        phoneNumber: phoneNorm,
        ipAddress: ip,
        items: orderItems,
      })
      .returning();

    // Sample tracking link uses the demo order id; the demo page renders
    // a fake "you'll be notified when ready" status when this URL is
    // visited so the SMS recipient can see what the live experience
    // would look like.
    const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim() || req.protocol || "https";
    const host = (req.headers["x-forwarded-host"] as string) || req.headers.host;
    const trackingUrl = `${proto}://${host}/demo/order/${created.id}`;
    const firstName = created.guestName.split(" ")[0];
    const smsBody = `Hi ${firstName}! This is a DEMO from dash by Hollywood East Cafe — no real order was placed. Track sample: ${trackingUrl} (For demo purposes only.)`;

    let smsError: string | null = null;
    try {
      await sendSms(phoneNorm, smsBody);
    } catch (err) {
      smsError = err instanceof Error ? err.message : String(err);
      req.log.warn({ err, demoOrderId: created.id }, "Demo SMS send failed");
    }
    await db
      .update(demoOrdersTable)
      .set({ smsSent: smsError == null, smsError })
      .where(eq(demoOrdersTable.id, created.id));

    res.status(201).json({
      id: created.id,
      guestName: created.guestName,
      phoneNumber: created.phoneNumber,
      items: orderItems,
      trackingUrl,
      smsSent: smsError == null,
    });
  } catch (err) {
    req.log.error({ err }, "Error creating demo order");
    res.status(500).json({ error: "Failed to submit demo order" });
  }
});

// ── Public: sample tracking page payload ─────────────────────────────────
// The demo SMS includes a tracking URL that loads the catering-web page,
// which fetches this endpoint to render a friendly "this is what live
// tracking looks like" view.
router.get("/demo/orders/:id", async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [row] = await db.select().from(demoOrdersTable).where(eq(demoOrdersTable.id, id));
    if (!row) {
      res.status(404).json({ error: "Demo order not found" });
      return;
    }
    res.json({
      id: row.id,
      guestName: row.guestName,
      items: row.items,
      createdAt: row.createdAt,
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching demo order");
    res.status(500).json({ error: "Failed to load demo order" });
  }
});

// ── Admin: read & write the demo menu selection ──────────────────────────
// Mounted by routes/index.ts AFTER requireAdminAuth on /admin/demo-menu.
const adminRouter: IRouter = Router();

adminRouter.get("/admin/demo-menu", async (req, res) => {
  try {
    const rows = await db
      .select({ menuItemId: demoMenuItemsTable.menuItemId, sortOrder: demoMenuItemsTable.sortOrder })
      .from(demoMenuItemsTable)
      .orderBy(asc(demoMenuItemsTable.sortOrder));
    res.json({ menuItemIds: rows.map((r) => r.menuItemId) });
  } catch (err) {
    req.log.error({ err }, "Error reading admin demo menu");
    res.status(500).json({ error: "Failed to load demo menu" });
  }
});

adminRouter.put("/admin/demo-menu", async (req, res) => {
  try {
    const { menuItemIds } = req.body as { menuItemIds?: number[] };
    if (!Array.isArray(menuItemIds)) {
      res.status(400).json({ error: "menuItemIds array required" });
      return;
    }
    const cleaned = menuItemIds.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
    const unique = Array.from(new Set(cleaned));
    if (unique.length > 0) {
      const found = await db
        .select({ id: menuItemsTable.id })
        .from(menuItemsTable)
        .where(inArray(menuItemsTable.id, unique));
      if (found.length !== unique.length) {
        res.status(400).json({ error: "One or more menu items do not exist" });
        return;
      }
    }
    await db.transaction(async (tx) => {
      await tx.delete(demoMenuItemsTable);
      if (unique.length > 0) {
        await tx.insert(demoMenuItemsTable).values(
          unique.map((id, i) => ({ menuItemId: id, sortOrder: i * 10 })),
        );
      }
    });
    res.json({ menuItemIds: unique });
  } catch (err) {
    req.log.error({ err }, "Error updating admin demo menu");
    res.status(500).json({ error: "Failed to update demo menu" });
  }
});

export { adminRouter as adminDemoRouter };
export default router;
