import { db, menuItemsTable, menuCategoriesTable } from "@workspace/db";
import { count, isNull, eq, and, sql, ne } from "drizzle-orm";
import { logger } from "./logger";

const DIM_SUM_IMG    = "https://images.unsplash.com/photo-1563245372-f21724e3856d?w=800&q=80";
const BUNS_IMG       = "https://images.unsplash.com/photo-1582878826629-29b7ad1cdc43?w=800&q=80";
const ROLLS_IMG      = "https://images.unsplash.com/photo-1547592166-23ac45744acd?w=800&q=80";
const WONTONS_IMG    = "https://images.unsplash.com/photo-1534482421-64566f976cfa?w=800&q=80";
const DUMPLINGS_IMG  = "https://images.unsplash.com/photo-1496116218417-1a781b1c416c?w=800&q=80";
const WINGS_IMG      = "https://images.unsplash.com/photo-1527477396000-e27163b481c2?w=800&q=80";
const SWEET_IMG      = "https://images.unsplash.com/photo-1558961363-fa8fdf82db35?w=800&q=80";
const SESAME_IMG     = "https://images.unsplash.com/photo-1569050467447-ce54b3bbc37d?w=800&q=80";
const STIRFRY_IMG    = "https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=800&q=80";
const SHRIMP_IMG     = "https://images.unsplash.com/photo-1559410545-0bdcd187e0a6?w=800&q=80";
const FISH_IMG       = "https://images.unsplash.com/photo-1490645935967-10de6ba17061?w=800&q=80";
const FRIED_RICE_IMG = "https://images.unsplash.com/photo-1603133872878-684f208fb84b?w=800&q=80";
const LO_MEIN_IMG    = "https://images.unsplash.com/photo-1557872943-16a5ac26437e?w=800&q=80";
const RICE_IMG       = "https://images.unsplash.com/photo-1455619452474-d2be8b1e70cd?w=800&q=80";
const FRIES_IMG      = "https://images.unsplash.com/photo-1585109649139-366815a0d713?w=800&q=80";

const MENU_SEED = [
  // Small Bites - Savory
  { name: "Bacon Rolls with Chicken (25)", description: "Tender chicken wrapped in savory bacon, served in a batch of 25. A crowd-pleasing catering favorite.", price: "72.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces", imageUrl: DIM_SUM_IMG },
  { name: "Bacon Rolls with Shrimp (25)", description: "Plump shrimp wrapped in crispy bacon, served in a batch of 25. Rich, savory, and irresistible.", price: "78.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces", imageUrl: DIM_SUM_IMG },
  { name: "Baked Roast Pork Buns (25)", description: "Fluffy baked buns filled with savory char siu roast pork. A classic dim sum staple, 25 pieces.", price: "65.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces", imageUrl: BUNS_IMG },
  { name: "Baked Roast Pork Pastry (25)", description: "Flaky golden pastry filled with fragrant roast pork. Light, buttery, and full of flavor. 25 pieces.", price: "68.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces", imageUrl: BUNS_IMG },
  { name: "Bean Sheet Rolls with Pork in Oyster Sauce (25)", description: "Silky bean curd sheets rolled with seasoned pork, finished with a rich oyster sauce glaze. 25 pieces.", price: "70.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces", imageUrl: DUMPLINGS_IMG },
  { name: "Crab Wontons (25)", description: "Crispy golden wontons filled with creamy crab. Perfect bite-sized appetizers for any event. 25 pieces.", price: "75.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces", imageUrl: WONTONS_IMG },
  { name: "Curry Chicken Pastry (25)", description: "Flaky hand-held pastries filled with aromatic curry-spiced chicken. A savory crowd favorite. 25 pieces.", price: "65.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces", imageUrl: ROLLS_IMG },
  { name: "Curry Chicken Spring Rolls (25)", description: "Crispy spring rolls packed with curried chicken and vegetables. Golden and satisfying. 25 pieces.", price: "62.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces", imageUrl: ROLLS_IMG },
  { name: "Fried Chicken Wings (25)", description: "Crispy, golden-fried chicken wings seasoned to perfection. A classic that never disappoints. 25 pieces.", price: "75.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces", imageUrl: WINGS_IMG },
  { name: "Fried Chicken Wontons (25)", description: "Crunchy wontons filled with seasoned chicken. Great for dipping and snacking. 25 pieces.", price: "65.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces", imageUrl: WONTONS_IMG },
  { name: "Fried Shrimp Balls (25)", description: "Crispy fried shrimp balls with a delicate crunch and tender shrimp center. 25 pieces.", price: "78.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces", imageUrl: DIM_SUM_IMG },
  { name: "Fried Shrimp Wontons (25)", description: "Light, crispy wontons filled with seasoned shrimp. A perfect catering appetizer. 25 pieces.", price: "72.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces", imageUrl: WONTONS_IMG },
  { name: "Fried Taro Shrimp Cakes (25)", description: "Golden taro cakes with shrimp — crispy outside, soft inside. A unique dim sum treat. 25 pieces.", price: "70.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces", imageUrl: DIM_SUM_IMG },
  { name: "Golden Roast Pork Buns (25)", description: "Pillowy buns filled with sweet and savory roast pork, finished with a beautiful golden glaze. 25 pieces.", price: "65.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces", imageUrl: BUNS_IMG },
  { name: "Pork & Shrimp Spring Rolls (25)", description: "Classic crispy spring rolls filled with seasoned pork and shrimp. A timeless catering staple. 25 pieces.", price: "68.75", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces", imageUrl: ROLLS_IMG },
  { name: "Shrimp Toast (25)", description: "Crispy toast topped with seasoned shrimp paste and sesame seeds. An elegant party appetizer. 25 pieces.", price: "72.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces", imageUrl: DIM_SUM_IMG },
  { name: "Spicy Chicken Wontons (25)", description: "Crispy wontons with a spicy seasoned chicken filling. Perfect for guests who love heat. 25 pieces.", price: "65.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces", imageUrl: WONTONS_IMG },
  { name: "Spicy Shrimp Wontons (25)", description: "Golden fried wontons filled with spicy seasoned shrimp. Bold flavor in every bite. 25 pieces.", price: "70.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces", imageUrl: WONTONS_IMG },
  { name: "Steamed Beef Balls (25)", description: "Tender steamed beef balls seasoned with traditional spices. A classic dim sum offering. 25 pieces.", price: "65.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces", imageUrl: DUMPLINGS_IMG },
  { name: "Steamed Beef Shu Mai (25)", description: "Open-topped steamed dumplings filled with seasoned beef. A dim sum essential. 25 pieces.", price: "68.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces", imageUrl: DUMPLINGS_IMG },
  { name: "Steamed Chicken Ginger Dumplings (25)", description: "Delicate steamed dumplings filled with chicken and fresh ginger. Light and aromatic. 25 pieces.", price: "65.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces", imageUrl: DUMPLINGS_IMG },
  { name: "Steamed Pork & Shrimp Shu Mai (25)", description: "Classic open-faced steamed dumplings with a pork and shrimp filling. A dim sum signature. 25 pieces.", price: "68.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces", imageUrl: DUMPLINGS_IMG },
  { name: "Steamed Shrimp Balls (25)", description: "Soft, delicate steamed shrimp balls with a clean, fresh flavor. Light and elegant. 25 pieces.", price: "72.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces", imageUrl: DIM_SUM_IMG },
  // Small Bites - Sweet
  { name: "Baked Custard Buns (25)", description: "Soft baked buns filled with rich, creamy egg custard. A beloved sweet dim sum treat. 25 pieces.", price: "60.00", category: "Small Bites - Sweet", available: true, servingSize: 25, unit: "pieces", imageUrl: SWEET_IMG },
  { name: "Fried Sesame Balls with Sweet Lotus Paste (25)", description: "Crispy fried sesame balls with a sweet lotus paste center. A traditional dessert delight. 25 pieces.", price: "62.00", category: "Small Bites - Sweet", available: true, servingSize: 25, unit: "pieces", imageUrl: SESAME_IMG },
  { name: "Grannie Yu's Almond Cookies (25)", description: "A family recipe — tender, crumbly almond cookies with a classic Chinese bakery flavor. 25 pieces.", price: "45.00", category: "Small Bites - Sweet", available: true, servingSize: 25, unit: "pieces", imageUrl: SWEET_IMG },
  // Entrées - Meat
  { name: "Orange Chicken", description: "Crispy chicken tossed in a tangy, sweet orange glaze. A beloved classic — bold, bright, and satisfying.", price: "85.00", category: "Entrées - Meat", available: true, servingSize: 1, unit: "tray", imageUrl: SESAME_IMG },
  { name: "Sweet & Sour Chicken", description: "Crispy chicken with vibrant sweet and sour sauce and colorful peppers. A timeless crowd-pleaser.", price: "82.00", category: "Entrées - Meat", available: true, servingSize: 1, unit: "tray", imageUrl: STIRFRY_IMG },
  { name: "Beef with Chinese Broccoli", description: "Tender sliced beef stir-fried with crisp Chinese broccoli in a savory garlic sauce.", price: "90.00", category: "Entrées - Meat", available: true, servingSize: 1, unit: "tray", imageUrl: STIRFRY_IMG },
  { name: "Chicken with Chinese Broccoli", description: "Sliced chicken breast stir-fried with Chinese broccoli, finished with a light oyster sauce.", price: "82.00", category: "Entrées - Meat", available: true, servingSize: 1, unit: "tray", imageUrl: STIRFRY_IMG },
  { name: "Fried Jalapeño Garlic Pork Chops", description: "Crispy pork chops tossed with sautéed jalapeño and fragrant garlic. Bold heat, amazing flavor.", price: "92.00", category: "Entrées - Meat", available: true, servingSize: 1, unit: "tray", imageUrl: STIRFRY_IMG },
  // Entrées - Seafood
  { name: "Firecracker Shrimp", description: "Crispy shrimp in a bold, spicy firecracker sauce. Big heat, big flavor — a standout entrée.", price: "95.00", category: "Entrées - Seafood", available: true, servingSize: 1, unit: "tray", imageUrl: SHRIMP_IMG },
  { name: "Honey Pineapple Shrimp", description: "Plump shrimp tossed in a sweet honey pineapple glaze. Tropical, bright, and delicious.", price: "95.00", category: "Entrées - Seafood", available: true, servingSize: 1, unit: "tray", imageUrl: SHRIMP_IMG },
  { name: "Orange Shrimp", description: "Crispy shrimp glazed in tangy orange sauce. A vibrant, crowd-pleasing catering favorite.", price: "95.00", category: "Entrées - Seafood", available: true, servingSize: 1, unit: "tray", imageUrl: SHRIMP_IMG },
  { name: "Crispy Fish Tempura", description: "Light, golden tempura-battered fish with a perfectly crispy coating. Clean flavor, elegant presentation.", price: "90.00", category: "Entrées - Seafood", available: true, servingSize: 1, unit: "tray", imageUrl: FISH_IMG },
  { name: "Firecracker Fish Filet", description: "Crispy fish filet tossed in a fiery, bold firecracker sauce. Full of heat and flavor.", price: "88.00", category: "Entrées - Seafood", available: true, servingSize: 1, unit: "tray", imageUrl: FISH_IMG },
  { name: "Fried Jalapeño Garlic Fish Filet", description: "Golden fried fish filet tossed with fresh jalapeño and garlic. Crispy, bold, and perfectly balanced.", price: "88.00", category: "Entrées - Seafood", available: true, servingSize: 1, unit: "tray", imageUrl: FISH_IMG },
  // Entrées - Noodles & Rice
  { name: "Chicken Fried Rice", description: "Wok-fried rice with tender chicken, egg, and vegetables. Served in trays sized for any event.", price: "65.00", category: "Entrées - Noodles & Rice", available: true, servingSize: 1, unit: "tray", imageUrl: FRIED_RICE_IMG },
  { name: "Shrimp Fried Rice", description: "Wok-fried rice loaded with plump shrimp, egg, and vegetables. A catering essential.", price: "72.00", category: "Entrées - Noodles & Rice", available: true, servingSize: 1, unit: "tray", imageUrl: FRIED_RICE_IMG },
  { name: "Chinese Sausage Fried Rice", description: "Fragrant fried rice with sliced Chinese sausage (lap cheong), egg, and scallions.", price: "68.00", category: "Entrées - Noodles & Rice", available: true, servingSize: 1, unit: "tray", imageUrl: FRIED_RICE_IMG },
  { name: "Vegetable Fried Rice", description: "Wok-fried rice with fresh seasonal vegetables and egg. Light, flavorful, and satisfying.", price: "58.00", category: "Entrées - Noodles & Rice", available: true, servingSize: 1, unit: "tray", imageUrl: FRIED_RICE_IMG },
  { name: "Plain Egg Fried Rice", description: "Classic wok-fried egg rice — simple, fragrant, and the perfect base for any meal.", price: "55.00", category: "Entrées - Noodles & Rice", available: true, servingSize: 1, unit: "tray", imageUrl: FRIED_RICE_IMG },
  { name: "Chicken Lo Mein", description: "Soft lo mein noodles tossed with chicken and vegetables in a savory soy sauce.", price: "65.00", category: "Entrées - Noodles & Rice", available: true, servingSize: 1, unit: "tray", imageUrl: LO_MEIN_IMG },
  { name: "Shrimp Lo Mein", description: "Tender lo mein noodles with plump shrimp and crisp vegetables in savory sauce.", price: "72.00", category: "Entrées - Noodles & Rice", available: true, servingSize: 1, unit: "tray", imageUrl: LO_MEIN_IMG },
  { name: "Plain Lo Mein", description: "Classic lo mein noodles tossed in a light savory sauce. A versatile catering staple.", price: "55.00", category: "Entrées - Noodles & Rice", available: true, servingSize: 1, unit: "tray", imageUrl: LO_MEIN_IMG },
  { name: "Vegetable Lo Mein", description: "Lo mein noodles with fresh vegetables in a savory sauce. A great vegetarian option.", price: "58.00", category: "Entrées - Noodles & Rice", available: true, servingSize: 1, unit: "tray", imageUrl: LO_MEIN_IMG },
  { name: "Steamed White Rice", description: "Perfect steamed white rice — the essential accompaniment to any entrée.", price: "28.00", category: "Entrées - Noodles & Rice", available: true, servingSize: 1, unit: "tray", imageUrl: RICE_IMG },
  { name: "French Fries", description: "Crispy golden French fries. A crowd-pleasing side for any catering event.", price: "32.00", category: "Entrées - Noodles & Rice", available: true, servingSize: 1, unit: "tray", imageUrl: FRIES_IMG },
];

export async function seedIfEmpty(): Promise<void> {
  try {
    // Schema migrations that must run on every boot regardless of whether
    // the menu has been seeded yet — these are idempotent guards that
    // protect against destructive drizzle-kit pushes on prod databases
    // that still carry legacy column shapes.
    await runStandaloneMigrations();

    const [result] = await db.select({ count: count() }).from(menuItemsTable);

    if (result && result.count === 0) {
      logger.info("Menu items table is empty — seeding now");
      await db.insert(menuItemsTable).values(MENU_SEED);
      logger.info({ count: MENU_SEED.length }, "Seeded menu items successfully");
      await backfillCategories();
      return;
    }

    logger.info({ count: result?.count }, "Database already seeded, skipping");

    // Patch any existing items that are missing image URLs
    const missing = await db
      .select({ count: count() })
      .from(menuItemsTable)
      .where(isNull(menuItemsTable.imageUrl));

    if (missing[0] && missing[0].count > 0) {
      logger.info({ count: missing[0].count }, "Patching items missing image URLs");
      for (const item of MENU_SEED) {
        await db
          .update(menuItemsTable)
          .set({ imageUrl: item.imageUrl })
          .where(and(eq(menuItemsTable.name, item.name), isNull(menuItemsTable.imageUrl)));
      }
      logger.info("Image URL patch complete");
    }

    // Migrate old bare size labels ("Small" → "Small Pan", etc.)
    await db.execute(sql`
      UPDATE menu_items
      SET
        size1_label = CASE WHEN size1_label = 'Small'  THEN 'Small Pan'  ELSE size1_label END,
        size2_label = CASE WHEN size2_label = 'Medium' THEN 'Medium Pan' ELSE size2_label END,
        size3_label = CASE WHEN size3_label = 'Large'  THEN 'Large Pan'  ELSE size3_label END
      WHERE size1_label = 'Small' OR size2_label = 'Medium' OR size3_label = 'Large'
    `);

    // Add internal_notes column if it doesn't exist (production migration)
    await db.execute(sql`
      ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS internal_notes text
    `);

    // Shared plans — add plan_number, created_at, admin_notes columns + sequence (production migration)
    await db.execute(sql`
      CREATE SEQUENCE IF NOT EXISTS shared_plans_plan_number_seq START 1001 INCREMENT 1
    `);
    await db.execute(sql`
      ALTER TABLE shared_plans
        ADD COLUMN IF NOT EXISTS plan_number integer,
        ADD COLUMN IF NOT EXISTS created_at timestamp DEFAULT now(),
        ADD COLUMN IF NOT EXISTS admin_notes text
    `);
    // Backfill plan_number for any existing rows that don't have one yet
    await db.execute(sql`
      UPDATE shared_plans
      SET plan_number = nextval('shared_plans_plan_number_seq')
      WHERE plan_number IS NULL
    `);
    // Ensure future inserts get a number automatically
    await db.execute(sql`
      ALTER TABLE shared_plans
        ALTER COLUMN plan_number SET DEFAULT nextval('shared_plans_plan_number_seq')
    `);

    // Auto-correct items that have at least one pan price but are still marked per_unit
    await db.execute(sql`
      UPDATE menu_items
      SET pricing_template = 'pan_sizes'
      WHERE pricing_template = 'per_unit'
        AND (
          size1_price IS NOT NULL OR
          size2_price IS NOT NULL OR
          size3_price IS NOT NULL OR
          size4_price IS NOT NULL OR
          size5_price IS NOT NULL
        )
    `);

    // Add "Fried Jalapeño Garlic Shrimp" if it doesn't exist yet
    const [shrimpCheck] = await db
      .select({ count: count() })
      .from(menuItemsTable)
      .where(eq(menuItemsTable.name, "Fried Jalapeño Garlic Shrimp | 椒盐虾"));
    if (shrimpCheck && shrimpCheck.count === 0) {
      logger.info("Inserting missing menu item: Fried Jalapeño Garlic Shrimp | 椒盐虾");
      await db.insert(menuItemsTable).values({
        name: "Fried Jalapeño Garlic Shrimp | 椒盐虾",
        description: "Crispy shrimp tossed with fresh jalapeño and fragrant garlic. Bold, spicy, and irresistible — a must-have for any seafood lover.",
        price: "95.00",
        category: "Entrées - Seafood",
        available: true,
        pricingTemplate: "pan_sizes",
        imageUrl: "https://images.unsplash.com/photo-1625943553852-781c6b42d20e?w=800&q=80",
        size1Label: "Small Pan",
        size1Servings: 15,
        size2Label: "Medium Pan",
        size2Servings: 30,
        size3Label: "Large Pan",
        size3Servings: 45,
      });
      logger.info("Inserted Fried Jalapeño Garlic Shrimp | 椒盐虾 successfully");
    }
    await backfillCategories();
  } catch (err) {
    logger.error({ err }, "Failed to seed/patch menu items");
  }
}

const CATEGORY_DEFAULTS: Record<string, { plannerGroup: string; sortOrder: number }> = {
  "Small Bites - Savory":     { plannerGroup: "savory", sortOrder: 0 },
  "Small Bites - Sweet":      { plannerGroup: "sweet",  sortOrder: 1 },
  "Entrées - Meat":           { plannerGroup: "entree", sortOrder: 2 },
  "Entrées - Seafood":        { plannerGroup: "entree", sortOrder: 3 },
  "Entrées - Noodles & Rice": { plannerGroup: "entree", sortOrder: 4 },
};

function inferPlannerGroup(name: string): string {
  const lower = name.toLowerCase();
  if (lower.startsWith("entrée") || lower.startsWith("entree")) return "entree";
  return "other";
}

/**
 * Schema migrations that run on every boot, before menu seeding decisions.
 * Each statement must be idempotent (CREATE/ADD … IF NOT EXISTS, guarded
 * DO blocks, etc.) so we can rerun safely on every deploy. Place anything
 * here that needs to land *regardless* of whether the menu seed branch
 * fires — for example data migrations that must complete before drizzle's
 * model-driven schema diff runs (so we don't lose data to a pushed DROP).
 */
async function runStandaloneMigrations(): Promise<void> {
  // Multi-recipient low-stock SMS migration (production safe / idempotent).
  // Ensures the new array column exists, copies any pre-existing single
  // phone into the array first slot, then drops the legacy column. Safe to
  // re-run: every step is guarded by existence checks. Must run regardless
  // of seed branch so a freshly-deployed prod DB never loses its single
  // configured phone before the schema diff runs.
  await db.execute(sql`
    ALTER TABLE event_settings
      ADD COLUMN IF NOT EXISTS low_stock_alert_phones text[] NOT NULL DEFAULT ARRAY[]::text[]
  `);
  await db.execute(sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'event_settings' AND column_name = 'low_stock_alert_phone'
      ) THEN
        EXECUTE 'UPDATE event_settings
                   SET low_stock_alert_phones = ARRAY[low_stock_alert_phone]
                   WHERE low_stock_alert_phone IS NOT NULL
                     AND low_stock_alert_phone <> ''''
                     AND (low_stock_alert_phones IS NULL OR low_stock_alert_phones = ''{}'')';
        EXECUTE 'ALTER TABLE event_settings DROP COLUMN low_stock_alert_phone';
      END IF;
    END$$;
  `);
  // Plating layout column (nullable). Set by staff in the POS payment modal,
  // consumed by the kitchen display to render plate-grouped tickets. Safe to
  // re-run; existing rows simply remain NULL = no plating configured.
  await db.execute(sql`
    ALTER TABLE event_orders
      ADD COLUMN IF NOT EXISTS plate_groups jsonb
  `);
  // Per-plate / per-line packing progress for plated orders. Populated
  // lazily the first time the cook taps a line on the kitchen ticket and
  // cleared when the order moves backward to "preparing" or "pending".
  // Safe to re-run.
  await db.execute(sql`
    ALTER TABLE event_orders
      ADD COLUMN IF NOT EXISTS kitchen_progress jsonb
  `);
  // Server-synced "Fire totals" check-off state for non-plated kitchen
  // tickets (and the totals header on plated tickets). Holds the itemIds
  // of cart lines the cook has tapped so all kitchen devices see the same
  // checkmarks. Cleared by the routes when the order leaves the active
  // queue. Defaults to empty array so existing rows are valid. Safe to re-run.
  await db.execute(sql`
    ALTER TABLE event_orders
      ADD COLUMN IF NOT EXISTS fired_item_ids jsonb NOT NULL DEFAULT '[]'::jsonb
  `);

  // ── On the Dash Experience (food trailer / on-site cooking) ──────────────
  // Per-item eligibility flag — drop-off-only by default so the migration
  // is non-disruptive. Admins flip the flag per item via the Menu CSV or
  // direct edit.
  await db.execute(sql`
    ALTER TABLE menu_items
      ADD COLUMN IF NOT EXISTS otd_eligible boolean NOT NULL DEFAULT false
  `);

  // Service mode chosen at checkout + per-inquiry snapshot of the OTD fee
  // configuration so historical quotes never shift when the admin updates
  // pricing. Snapshot columns are intentionally nullable — only OTD
  // inquiries fill them in.
  await db.execute(sql`
    ALTER TABLE catering_inquiries
      ADD COLUMN IF NOT EXISTS service_mode text NOT NULL DEFAULT 'drop_off',
      ADD COLUMN IF NOT EXISTS otd_setup_fee numeric(10,2),
      ADD COLUMN IF NOT EXISTS otd_fee_waiver_threshold numeric(10,2),
      ADD COLUMN IF NOT EXISTS otd_included_hours numeric(5,2),
      ADD COLUMN IF NOT EXISTS otd_additional_hour_rate numeric(10,2),
      ADD COLUMN IF NOT EXISTS otd_max_additional_hours integer
  `);

  // Strict-enum guard at the DB layer so a buggy migration or direct
  // SQL write can never sneak an unknown service_mode through. The
  // app-level parser still rejects bad values first.
  await db.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'catering_inquiries_service_mode_check'
      ) THEN
        ALTER TABLE catering_inquiries
          ADD CONSTRAINT catering_inquiries_service_mode_check
          CHECK (service_mode IN ('drop_off', 'on_the_dash'));
      END IF;
    END $$;
  `);

  // Live OTD pricing config admins can edit in /admin/event-settings.
  // Defaults match launch pricing: $500 setup, waived at $2,000 subtotal,
  // 2 included hours, $100/hr extra up to 3 additional hours.
  await db.execute(sql`
    ALTER TABLE event_settings
      ADD COLUMN IF NOT EXISTS otd_setup_fee numeric(10,2) NOT NULL DEFAULT 500,
      ADD COLUMN IF NOT EXISTS otd_fee_waiver_threshold numeric(10,2) NOT NULL DEFAULT 2000,
      ADD COLUMN IF NOT EXISTS otd_included_hours numeric(5,2) NOT NULL DEFAULT 2,
      ADD COLUMN IF NOT EXISTS otd_additional_hour_rate numeric(10,2) NOT NULL DEFAULT 100,
      ADD COLUMN IF NOT EXISTS otd_max_additional_hours integer NOT NULL DEFAULT 3
  `);
}

async function backfillCategories(): Promise<void> {
  // Create the table if missing (production migration)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS menu_categories (
      id serial PRIMARY KEY,
      name text NOT NULL UNIQUE,
      sort_order integer NOT NULL DEFAULT 0,
      visible boolean NOT NULL DEFAULT true,
      planner_group text NOT NULL DEFAULT 'other',
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);

  const [catCount] = await db.select({ count: count() }).from(menuCategoriesTable);
  const distinctRows = await db
    .selectDistinct({ category: menuItemsTable.category })
    .from(menuItemsTable)
    .where(and(sql`${menuItemsTable.category} IS NOT NULL`, ne(menuItemsTable.category, "")));
  const distinctCats = distinctRows
    .map(r => r.category)
    .filter((c): c is string => typeof c === "string" && c.length > 0);

  if (!catCount || catCount.count === 0) {
    if (distinctCats.length === 0) return;
    const known = distinctCats.filter((c: string) => c in CATEGORY_DEFAULTS);
    const others = distinctCats
      .filter((c: string) => !(c in CATEGORY_DEFAULTS))
      .sort((a: string, b: string) => a.localeCompare(b));
    let nextSort = 5;
    const rows = [
      ...known.map((name: string) => ({
        name,
        sortOrder: CATEGORY_DEFAULTS[name].sortOrder,
        plannerGroup: CATEGORY_DEFAULTS[name].plannerGroup,
        visible: true,
      })),
      ...others.map((name: string) => ({
        name,
        sortOrder: nextSort++,
        plannerGroup: inferPlannerGroup(name),
        visible: true,
      })),
    ];
    logger.info({ count: rows.length }, "Backfilling menu_categories from existing menu_items");
    await db.insert(menuCategoriesTable).values(rows);
    return;
  }

  // Auto-add categories that exist in menu_items but are missing from menu_categories
  const existing = await db.select({ name: menuCategoriesTable.name }).from(menuCategoriesTable);
  const existingSet = new Set(existing.map((r) => r.name));
  const missing = distinctCats.filter((c: string) => !existingSet.has(c));
  if (missing.length > 0) {
    const [maxRow] = await db
      .select({ max: sql<number>`COALESCE(MAX(${menuCategoriesTable.sortOrder}), -1)` })
      .from(menuCategoriesTable);
    let nextSort = (maxRow?.max ?? -1) + 1;
    const rows = missing.map((name: string) => ({
      name,
      sortOrder: nextSort++,
      plannerGroup: inferPlannerGroup(name),
      visible: true,
    }));
    logger.info({ added: missing }, "Adding new menu categories from menu_items");
    await db.insert(menuCategoriesTable).values(rows);
  }
}
