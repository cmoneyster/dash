import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  menuPackagesTable,
  menuPackageItemsTable,
  menuItemsTable,
  menuCategoriesTable,
} from "@workspace/db/schema";
import { asc, eq } from "drizzle-orm";

const router: IRouter = Router();

type PublicItem = {
  id: number;
  menuItemId: number;
  quantity: number;
  sizeKey: number | null;
  sortOrder: number;
  menuItem: {
    id: number;
    name: string;
    category: string;
    description: string | null;
    price: number;
    imageUrl: string | null;
    allergens: string[];
    servingSize: number | null;
    unit: string | null;
    minimumOrderQty: number | null;
    pricingTemplate: string | null;
    available: boolean;
    otdEligible: boolean;
    size1Label: string | null; size1Price: string | null; size1Servings: number | null;
    size2Label: string | null; size2Price: string | null; size2Servings: number | null;
    size3Label: string | null; size3Price: string | null; size3Servings: number | null;
    size4Label: string | null; size4Price: string | null; size4Servings: number | null;
    size5Label: string | null; size5Price: string | null; size5Servings: number | null;
  };
};

async function loadPackageItems(packageId: number, opts: { onlyAvailable: boolean }): Promise<{
  items: PublicItem[];
  partiallyAvailable: boolean;
}> {
  const rows = await db
    .select()
    .from(menuPackageItemsTable)
    .innerJoin(menuItemsTable, eq(menuItemsTable.id, menuPackageItemsTable.menuItemId))
    .where(eq(menuPackageItemsTable.packageId, packageId))
    .orderBy(
      asc(menuPackageItemsTable.sortOrder),
      asc(menuPackageItemsTable.id),
    );

  const cats = await db.select().from(menuCategoriesTable);
  const hidden = new Set(cats.filter((c) => !c.visible).map((c) => c.name));

  let partiallyAvailable = false;
  const items: PublicItem[] = [];
  for (const r of rows) {
    const mi = r.menu_items;
    const isUsable = mi.available && !hidden.has(mi.category);
    if (!isUsable) {
      partiallyAvailable = true;
      if (opts.onlyAvailable) continue;
    }
    items.push({
      id: r.menu_package_items.id,
      menuItemId: r.menu_package_items.menuItemId,
      quantity: r.menu_package_items.quantity,
      sizeKey: r.menu_package_items.sizeKey ?? null,
      sortOrder: r.menu_package_items.sortOrder,
      menuItem: {
        id: mi.id,
        name: mi.name,
        category: mi.category,
        description: mi.description ?? null,
        price: parseFloat(mi.price),
        imageUrl: mi.imageUrl ?? null,
        allergens: mi.allergens ?? [],
        servingSize: mi.servingSize ?? null,
        unit: mi.unit ?? null,
        minimumOrderQty: mi.minimumOrderQty ?? null,
        pricingTemplate: mi.pricingTemplate ?? null,
        available: mi.available,
        otdEligible: mi.otdEligible === true,
        size1Label: mi.size1Label ?? null, size1Price: mi.size1Price ?? null, size1Servings: mi.size1Servings ?? null,
        size2Label: mi.size2Label ?? null, size2Price: mi.size2Price ?? null, size2Servings: mi.size2Servings ?? null,
        size3Label: mi.size3Label ?? null, size3Price: mi.size3Price ?? null, size3Servings: mi.size3Servings ?? null,
        size4Label: mi.size4Label ?? null, size4Price: mi.size4Price ?? null, size4Servings: mi.size4Servings ?? null,
        size5Label: mi.size5Label ?? null, size5Price: mi.size5Price ?? null, size5Servings: mi.size5Servings ?? null,
      },
    });
  }
  return { items, partiallyAvailable };
}

// Public list — non-hidden packages, with their items resolved (skipping
// items whose menu item is unavailable / category hidden).
router.get("/menu-packages", async (req, res) => {
  try {
    const pkgs = await db
      .select()
      .from(menuPackagesTable)
      .where(eq(menuPackagesTable.hidden, false))
      .orderBy(asc(menuPackagesTable.sortOrder), asc(menuPackagesTable.id));

    const all = await Promise.all(pkgs.map(async (p) => {
      const { items, partiallyAvailable } = await loadPackageItems(p.id, { onlyAvailable: true });
      // A package is on-the-dash eligible only when every available item
      // can be cooked on-site by the food trailer. Empty packages are not
      // eligible (we drop them below anyway).
      const otdEligible = items.length > 0 && items.every((i) => i.menuItem.otdEligible);
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        imageUrl: p.imageUrl,
        servesGuests: p.servesGuests,
        sortOrder: p.sortOrder,
        partiallyAvailable,
        otdEligible,
        items,
      };
    }));
    // Drop packages whose items are all unavailable — nothing for the
    // guest to load means the card is just clutter.
    res.json(all.filter((p) => p.items.length > 0));
  } catch (err) {
    req.log.error({ err }, "Error listing menu packages");
    res.status(500).json({ error: "Failed to list menu packages" });
  }
});

router.get("/menu-packages/:id", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [p] = await db
      .select()
      .from(menuPackagesTable)
      .where(eq(menuPackagesTable.id, id));
    if (!p || p.hidden) {
      res.status(404).json({ error: "Package not found" });
      return;
    }
    const { items, partiallyAvailable } = await loadPackageItems(p.id, { onlyAvailable: true });
    const otdEligible = items.length > 0 && items.every((i) => i.menuItem.otdEligible);
    res.json({
      id: p.id,
      name: p.name,
      description: p.description,
      imageUrl: p.imageUrl,
      servesGuests: p.servesGuests,
      sortOrder: p.sortOrder,
      partiallyAvailable,
      otdEligible,
      items,
    });
  } catch (err) {
    req.log.error({ err }, "Error getting menu package");
    res.status(500).json({ error: "Failed to get menu package" });
  }
});

export default router;
export { loadPackageItems };
