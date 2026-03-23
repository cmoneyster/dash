import { db, menuItemsTable } from "@workspace/db";
import { count } from "drizzle-orm";
import { logger } from "./logger";

const MENU_SEED = [
  { name: "Bacon Rolls with Chicken (25)", description: "Tender chicken wrapped in savory bacon, served in a batch of 25. A crowd-pleasing catering favorite.", price: "72.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces" },
  { name: "Bacon Rolls with Shrimp (25)", description: "Plump shrimp wrapped in crispy bacon, served in a batch of 25. Rich, savory, and irresistible.", price: "78.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces" },
  { name: "Baked Roast Pork Buns (25)", description: "Fluffy baked buns filled with savory char siu roast pork. A classic dim sum staple, 25 pieces.", price: "65.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces" },
  { name: "Baked Roast Pork Pastry (25)", description: "Flaky golden pastry filled with fragrant roast pork. Light, buttery, and full of flavor. 25 pieces.", price: "68.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces" },
  { name: "Bean Sheet Rolls with Pork in Oyster Sauce (25)", description: "Silky bean curd sheets rolled with seasoned pork, finished with a rich oyster sauce glaze. 25 pieces.", price: "70.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces" },
  { name: "Crab Wontons (25)", description: "Crispy golden wontons filled with creamy crab. Perfect bite-sized appetizers for any event. 25 pieces.", price: "75.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces" },
  { name: "Curry Chicken Pastry (25)", description: "Flaky hand-held pastries filled with aromatic curry-spiced chicken. A savory crowd favorite. 25 pieces.", price: "65.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces" },
  { name: "Curry Chicken Spring Rolls (25)", description: "Crispy spring rolls packed with curried chicken and vegetables. Golden and satisfying. 25 pieces.", price: "62.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces" },
  { name: "Fried Chicken Wings (25)", description: "Crispy, golden-fried chicken wings seasoned to perfection. A classic that never disappoints. 25 pieces.", price: "75.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces" },
  { name: "Fried Chicken Wontons (25)", description: "Crunchy wontons filled with seasoned chicken. Great for dipping and snacking. 25 pieces.", price: "65.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces" },
  { name: "Fried Shrimp Balls (25)", description: "Crispy fried shrimp balls with a delicate crunch and tender shrimp center. 25 pieces.", price: "78.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces" },
  { name: "Fried Shrimp Wontons (25)", description: "Light, crispy wontons filled with seasoned shrimp. A perfect catering appetizer. 25 pieces.", price: "72.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces" },
  { name: "Fried Taro Shrimp Cakes (25)", description: "Golden taro cakes with shrimp — crispy outside, soft inside. A unique dim sum treat. 25 pieces.", price: "70.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces" },
  { name: "Golden Roast Pork Buns (25)", description: "Pillowy buns filled with sweet and savory roast pork, finished with a beautiful golden glaze. 25 pieces.", price: "65.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces" },
  { name: "Pork & Shrimp Spring Rolls (25)", description: "Classic crispy spring rolls filled with seasoned pork and shrimp. A timeless catering staple. 25 pieces.", price: "68.75", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces" },
  { name: "Shrimp Toast (25)", description: "Crispy toast topped with seasoned shrimp paste and sesame seeds. An elegant party appetizer. 25 pieces.", price: "72.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces" },
  { name: "Spicy Chicken Wontons (25)", description: "Crispy wontons with a spicy seasoned chicken filling. Perfect for guests who love heat. 25 pieces.", price: "65.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces" },
  { name: "Spicy Shrimp Wontons (25)", description: "Golden fried wontons filled with spicy seasoned shrimp. Bold flavor in every bite. 25 pieces.", price: "70.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces" },
  { name: "Steamed Beef Balls (25)", description: "Tender steamed beef balls seasoned with traditional spices. A classic dim sum offering. 25 pieces.", price: "65.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces" },
  { name: "Steamed Beef Shu Mai (25)", description: "Open-topped steamed dumplings filled with seasoned beef. A dim sum essential. 25 pieces.", price: "68.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces" },
  { name: "Steamed Chicken Ginger Dumplings (25)", description: "Delicate steamed dumplings filled with chicken and fresh ginger. Light and aromatic. 25 pieces.", price: "65.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces" },
  { name: "Steamed Pork & Shrimp Shu Mai (25)", description: "Classic open-faced steamed dumplings with a pork and shrimp filling. A dim sum signature. 25 pieces.", price: "68.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces" },
  { name: "Steamed Shrimp Balls (25)", description: "Soft, delicate steamed shrimp balls with a clean, fresh flavor. Light and elegant. 25 pieces.", price: "72.00", category: "Small Bites - Savory", available: true, servingSize: 25, unit: "pieces" },
  { name: "Baked Custard Buns (25)", description: "Soft baked buns filled with rich, creamy egg custard. A beloved sweet dim sum treat. 25 pieces.", price: "60.00", category: "Small Bites - Sweet", available: true, servingSize: 25, unit: "pieces" },
  { name: "Fried Sesame Balls with Sweet Lotus Paste (25)", description: "Crispy fried sesame balls with a sweet lotus paste center. A traditional dessert delight. 25 pieces.", price: "62.00", category: "Small Bites - Sweet", available: true, servingSize: 25, unit: "pieces" },
  { name: "Grannie Yu's Almond Cookies (25)", description: "A family recipe — tender, crumbly almond cookies with a classic Chinese bakery flavor. 25 pieces.", price: "45.00", category: "Small Bites - Sweet", available: true, servingSize: 25, unit: "pieces" },
  { name: "Orange Chicken", description: "Crispy chicken tossed in a tangy, sweet orange glaze. A beloved classic — bold, bright, and satisfying.", price: "85.00", category: "Entrées - Meat", available: true, servingSize: 1, unit: "tray" },
  { name: "Sweet & Sour Chicken", description: "Crispy chicken with vibrant sweet and sour sauce and colorful peppers. A timeless crowd-pleaser.", price: "82.00", category: "Entrées - Meat", available: true, servingSize: 1, unit: "tray" },
  { name: "Beef with Chinese Broccoli", description: "Tender sliced beef stir-fried with crisp Chinese broccoli in a savory garlic sauce.", price: "90.00", category: "Entrées - Meat", available: true, servingSize: 1, unit: "tray" },
  { name: "Chicken with Chinese Broccoli", description: "Sliced chicken breast stir-fried with Chinese broccoli, finished with a light oyster sauce.", price: "82.00", category: "Entrées - Meat", available: true, servingSize: 1, unit: "tray" },
  { name: "Fried Jalapeño Garlic Pork Chops", description: "Crispy pork chops tossed with sautéed jalapeño and fragrant garlic. Bold heat, amazing flavor.", price: "92.00", category: "Entrées - Meat", available: true, servingSize: 1, unit: "tray" },
  { name: "Firecracker Shrimp", description: "Crispy shrimp in a bold, spicy firecracker sauce. Big heat, big flavor — a standout entrée.", price: "95.00", category: "Entrées - Seafood", available: true, servingSize: 1, unit: "tray" },
  { name: "Honey Pineapple Shrimp", description: "Plump shrimp tossed in a sweet honey pineapple glaze. Tropical, bright, and delicious.", price: "95.00", category: "Entrées - Seafood", available: true, servingSize: 1, unit: "tray" },
  { name: "Orange Shrimp", description: "Crispy shrimp glazed in tangy orange sauce. A vibrant, crowd-pleasing catering favorite.", price: "95.00", category: "Entrées - Seafood", available: true, servingSize: 1, unit: "tray" },
  { name: "Crispy Fish Tempura", description: "Light, golden tempura-battered fish with a perfectly crispy coating. Clean flavor, elegant presentation.", price: "90.00", category: "Entrées - Seafood", available: true, servingSize: 1, unit: "tray" },
  { name: "Firecracker Fish Filet", description: "Crispy fish filet tossed in a fiery, bold firecracker sauce. Full of heat and flavor.", price: "88.00", category: "Entrées - Seafood", available: true, servingSize: 1, unit: "tray" },
  { name: "Fried Jalapeño Garlic Fish Filet", description: "Golden fried fish filet tossed with fresh jalapeño and garlic. Crispy, bold, and perfectly balanced.", price: "88.00", category: "Entrées - Seafood", available: true, servingSize: 1, unit: "tray" },
  { name: "Chicken Fried Rice", description: "Wok-fried rice with tender chicken, egg, and vegetables. Served in trays sized for any event.", price: "65.00", category: "Entrées - Noodles & Rice", available: true, servingSize: 1, unit: "tray" },
  { name: "Shrimp Fried Rice", description: "Wok-fried rice loaded with plump shrimp, egg, and vegetables. A catering essential.", price: "72.00", category: "Entrées - Noodles & Rice", available: true, servingSize: 1, unit: "tray" },
  { name: "Chinese Sausage Fried Rice", description: "Fragrant fried rice with sliced Chinese sausage (lap cheong), egg, and scallions.", price: "68.00", category: "Entrées - Noodles & Rice", available: true, servingSize: 1, unit: "tray" },
  { name: "Vegetable Fried Rice", description: "Wok-fried rice with fresh seasonal vegetables and egg. Light, flavorful, and satisfying.", price: "58.00", category: "Entrées - Noodles & Rice", available: true, servingSize: 1, unit: "tray" },
  { name: "Plain Egg Fried Rice", description: "Classic wok-fried egg rice — simple, fragrant, and the perfect base for any meal.", price: "55.00", category: "Entrées - Noodles & Rice", available: true, servingSize: 1, unit: "tray" },
  { name: "Chicken Lo Mein", description: "Soft lo mein noodles tossed with chicken and vegetables in a savory soy sauce.", price: "65.00", category: "Entrées - Noodles & Rice", available: true, servingSize: 1, unit: "tray" },
  { name: "Shrimp Lo Mein", description: "Tender lo mein noodles with plump shrimp and crisp vegetables in savory sauce.", price: "72.00", category: "Entrées - Noodles & Rice", available: true, servingSize: 1, unit: "tray" },
  { name: "Plain Lo Mein", description: "Classic lo mein noodles tossed in a light savory sauce. A versatile catering staple.", price: "55.00", category: "Entrées - Noodles & Rice", available: true, servingSize: 1, unit: "tray" },
  { name: "Vegetable Lo Mein", description: "Lo mein noodles with fresh vegetables in a savory sauce. A great vegetarian option.", price: "58.00", category: "Entrées - Noodles & Rice", available: true, servingSize: 1, unit: "tray" },
  { name: "Steamed White Rice", description: "Perfect steamed white rice — the essential accompaniment to any entrée.", price: "28.00", category: "Entrées - Noodles & Rice", available: true, servingSize: 1, unit: "tray" },
  { name: "French Fries", description: "Crispy golden French fries. A crowd-pleasing side for any catering event.", price: "32.00", category: "Entrées - Noodles & Rice", available: true, servingSize: 1, unit: "tray" },
];

export async function seedIfEmpty(): Promise<void> {
  try {
    const [result] = await db.select({ count: count() }).from(menuItemsTable);
    if (result && result.count > 0) {
      logger.info({ count: result.count }, "Database already seeded, skipping");
      return;
    }

    logger.info("Menu items table is empty — seeding now");
    await db.insert(menuItemsTable).values(MENU_SEED);
    logger.info({ count: MENU_SEED.length }, "Seeded menu items successfully");
  } catch (err) {
    logger.error({ err }, "Failed to seed menu items");
  }
}
