import { pgTable, serial, varchar, text, timestamp } from "drizzle-orm/pg-core";

export const imagesTable = pgTable("images", {
  id: serial("id").primaryKey(),
  filename: varchar("filename", { length: 255 }).notNull(),
  objectPath: varchar("object_path", { length: 500 }).notNull(),
  servingUrl: text("serving_url").notNull(),
  mimeType: varchar("mime_type", { length: 100 }).notNull().default("image/jpeg"),
  uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
});
