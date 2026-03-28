import { db, menuItemsTable } from "@workspace/db";
import { count, isNull, eq, and, sql } from "drizzle-orm";
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
    const [result] = await db.select({ count: count() }).from(menuItemsTable);

    if (result && result.count === 0) {
      logger.info("Menu items table is empty — seeding now");
      await db.insert(menuItemsTable).values(MENU_SEED);
      logger.info({ count: MENU_SEED.length }, "Seeded menu items successfully");
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
  } catch (err) {
    logger.error({ err }, "Failed to seed/patch menu items");
  }
}
