import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  menuPackagesTable,
  menuPackageItemsTable,
  menuItemsTable,
} from "@workspace/db/schema";
import { asc, eq, sql } from "drizzle-orm";
import { loadPackageItems } from "./menu-packages";

const router: IRouter = Router();

type ItemInput = {
  menuItemId: number;
  quantity: number;
  sizeKey?: number | null;
};

function parseItems(raw: unknown): ItemInput[] | string {
  if (!Array.isArray(raw)) return "items must be an array";
  const out: ItemInput[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") return "each item must be an object";
    const mid = Number((r as any).menuItemId);
    const qty = Number((r as any).quantity);
    const sz = (r as any).sizeKey;
    if (!Number.isFinite(mid) || mid <= 0) return "menuItemId required";
    if (!Number.isFinite(qty) || qty <= 0) return "quantity must be positive";
    let sizeKey: number | null = null;
    if (sz != null && sz !== "") {
      const n = Number(sz);
      if (!Number.isFinite(n) || n < 1 || n > 5) return "sizeKey must be 1..5 or null";
      sizeKey = n;
    }
    out.push({ menuItemId: mid, quantity: qty, sizeKey });
  }
  return out;
}

async function loadAdminPackage(id: number) {
  const [p] = await db.select().from(menuPackagesTable).where(eq(menuPackagesTable.id, id));
  if (!p) return null;
  const { items, partiallyAvailable } = await loadPackageItems(p.id, { onlyAvailable: false });
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    imageUrl: p.imageUrl,
    servesGuests: p.servesGuests,
    hidden: p.hidden,
    sortOrder: p.sortOrder,
    partiallyAvailable,
    items,
  };
}

// List
router.get("/admin/menu-packages", async (req, res) => {
  try {
    const pkgs = await db
      .select()
      .from(menuPackagesTable)
      .orderBy(asc(menuPackagesTable.sortOrder), asc(menuPackagesTable.id));
    const out = await Promise.all(pkgs.map(async (p) => {
      const { items, partiallyAvailable } = await loadPackageItems(p.id, { onlyAvailable: false });
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        imageUrl: p.imageUrl,
        servesGuests: p.servesGuests,
        hidden: p.hidden,
        sortOrder: p.sortOrder,
        partiallyAvailable,
        itemCount: items.length,
      };
    }));
    res.json(out);
  } catch (err) {
    req.log.error({ err }, "Error listing admin menu packages");
    res.status(500).json({ error: "Failed to list menu packages" });
  }
});

router.get("/admin/menu-packages/:id", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const out = await loadAdminPackage(id);
    if (!out) { res.status(404).json({ error: "Not found" }); return; }
    res.json(out);
  } catch (err) {
    req.log.error({ err }, "Error getting admin menu package");
    res.status(500).json({ error: "Failed to get menu package" });
  }
});

router.post("/admin/menu-packages", async (req, res): Promise<void> => {
  try {
    const { name, description, imageUrl, servesGuests, hidden, items } = req.body ?? {};
    if (typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name required" }); return;
    }
    const guests = Number(servesGuests);
    if (!Number.isFinite(guests) || guests <= 0 || guests > 100000) {
      res.status(400).json({ error: "servesGuests must be a positive integer" }); return;
    }
    const parsedItems = parseItems(items ?? []);
    if (typeof parsedItems === "string") {
      res.status(400).json({ error: parsedItems }); return;
    }

    // Validate every menu item exists, and pan-size constraint.
    if (parsedItems.length > 0) {
      const ids = Array.from(new Set(parsedItems.map((i) => i.menuItemId)));
      const found = await db
        .select()
        .from(menuItemsTable)
        .where(sql`${menuItemsTable.id} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
      const byId = new Map(found.map((m) => [m.id, m] as const));
      for (const it of parsedItems) {
        const mi = byId.get(it.menuItemId);
        if (!mi) { res.status(400).json({ error: `menu item ${it.menuItemId} not found` }); return; }
        if (mi.pricingTemplate === "pan_sizes") {
          if (it.sizeKey == null) { res.status(400).json({ error: `sizeKey required for pan-size item ${mi.name}` }); return; }
          const lbl = (mi as any)[`size${it.sizeKey}Label`];
          if (lbl == null) { res.status(400).json({ error: `size slot ${it.sizeKey} not configured for ${mi.name}` }); return; }
        }
      }
    }

    const [maxRow] = await db
      .select({ max: sql<number>`COALESCE(MAX(${menuPackagesTable.sortOrder}), -10)` })
      .from(menuPackagesTable);
    const nextSort = Number(maxRow?.max ?? -10) + 10;

    const [pkg] = await db.insert(menuPackagesTable).values({
      name: name.trim(),
      description: typeof description === "string" ? description : "",
      imageUrl: typeof imageUrl === "string" && imageUrl.trim() ? imageUrl.trim() : null,
      servesGuests: Math.floor(guests),
      hidden: hidden === true,
      sortOrder: nextSort,
    }).returning();

    if (!pkg) { res.status(500).json({ error: "Failed to create" }); return; }

    if (parsedItems.length > 0) {
      await db.insert(menuPackageItemsTable).values(parsedItems.map((it, idx) => ({
        packageId: pkg.id,
        menuItemId: it.menuItemId,
        quantity: Math.floor(it.quantity),
        sizeKey: it.sizeKey,
        sortOrder: idx * 10,
      })));
    }

    const out = await loadAdminPackage(pkg.id);
    res.status(201).json(out);
  } catch (err) {
    req.log.error({ err }, "Error creating menu package");
    res.status(500).json({ error: "Failed to create menu package" });
  }
});

router.put("/admin/menu-packages/:id", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const [existing] = await db.select().from(menuPackagesTable).where(eq(menuPackagesTable.id, id));
    if (!existing) { res.status(404).json({ error: "Not found" }); return; }

    const { name, description, imageUrl, servesGuests, hidden, items } = req.body ?? {};
    const updates: Partial<typeof menuPackagesTable.$inferInsert> = { updatedAt: new Date() };
    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) { res.status(400).json({ error: "name required" }); return; }
      updates.name = name.trim();
    }
    if (description !== undefined) {
      updates.description = typeof description === "string" ? description : "";
    }
    if (imageUrl !== undefined) {
      updates.imageUrl = typeof imageUrl === "string" && imageUrl.trim() ? imageUrl.trim() : null;
    }
    if (servesGuests !== undefined) {
      const guests = Number(servesGuests);
      if (!Number.isFinite(guests) || guests <= 0 || guests > 100000) {
        res.status(400).json({ error: "servesGuests must be a positive integer" }); return;
      }
      updates.servesGuests = Math.floor(guests);
    }
    if (hidden !== undefined) updates.hidden = hidden === true;

    let parsedItems: ItemInput[] | null = null;
    if (items !== undefined) {
      const r = parseItems(items);
      if (typeof r === "string") { res.status(400).json({ error: r }); return; }
      parsedItems = r;
      // Validate items
      if (parsedItems.length > 0) {
        const ids = Array.from(new Set(parsedItems.map((i) => i.menuItemId)));
        const found = await db
          .select()
          .from(menuItemsTable)
          .where(sql`${menuItemsTable.id} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
        const byId = new Map(found.map((m) => [m.id, m] as const));
        for (const it of parsedItems) {
          const mi = byId.get(it.menuItemId);
          if (!mi) { res.status(400).json({ error: `menu item ${it.menuItemId} not found` }); return; }
          if (mi.pricingTemplate === "pan_sizes") {
            if (it.sizeKey == null) { res.status(400).json({ error: `sizeKey required for pan-size item ${mi.name}` }); return; }
            const lbl = (mi as any)[`size${it.sizeKey}Label`];
            if (lbl == null) { res.status(400).json({ error: `size slot ${it.sizeKey} not configured for ${mi.name}` }); return; }
          }
        }
      }
    }

    await db.transaction(async (tx) => {
      await tx.update(menuPackagesTable).set(updates).where(eq(menuPackagesTable.id, id));
      if (parsedItems !== null) {
        await tx.delete(menuPackageItemsTable).where(eq(menuPackageItemsTable.packageId, id));
        if (parsedItems.length > 0) {
          await tx.insert(menuPackageItemsTable).values(parsedItems.map((it, idx) => ({
            packageId: id,
            menuItemId: it.menuItemId,
            quantity: Math.floor(it.quantity),
            sizeKey: it.sizeKey,
            sortOrder: idx * 10,
          })));
        }
      }
    });

    const out = await loadAdminPackage(id);
    res.json(out);
  } catch (err) {
    req.log.error({ err }, "Error updating menu package");
    res.status(500).json({ error: "Failed to update menu package" });
  }
});

router.delete("/admin/menu-packages/:id", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    await db.delete(menuPackagesTable).where(eq(menuPackagesTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Error deleting menu package");
    res.status(500).json({ error: "Failed to delete menu package" });
  }
});

router.post("/admin/menu-packages/reorder", async (req, res): Promise<void> => {
  try {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.every((x: unknown) => Number.isInteger(x))) {
      res.status(400).json({ error: "ids must be an integer array" }); return;
    }
    await db.transaction(async (tx) => {
      for (let i = 0; i < ids.length; i++) {
        await tx.update(menuPackagesTable)
          .set({ sortOrder: i * 10 })
          .where(eq(menuPackagesTable.id, ids[i] as number));
      }
    });
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Error reordering menu packages");
    res.status(500).json({ error: "Failed to reorder" });
  }
});

export default router;
