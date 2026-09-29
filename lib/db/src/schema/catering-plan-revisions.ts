import { pgTable, serial, integer, varchar, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { cateringInquiriesTable } from "./catering-inquiries";

export type CateringPlanItemSnapshot = {
  menuItemId: number;
  name: string;
  quantity: number;
  sizeSlot: number | null;
  sizeLabel: string | null;
  unitPrice: number;
  pricingTemplate: "per_unit" | "pan_sizes" | null;
  lineItemId?: string;
  notes?: string | null;
  priceMode?: "auto" | "manual" | null;
  sizeServings?: number | null;
  unit?: string | null;
  servingSize?: number | null;
};

export type CateringPlanSnapshot = {
  items: CateringPlanItemSnapshot[];
  eventDate: string | null;
  eventTime: string | null;
  guestCount: number | null;
  venueAddress: string | null;
  menuNotes: string | null;
  // Internal merge guards retain the full editable quote line snapshot so
  // custom rows and manual pricing can be kept intact at review time.
  quoteLineItems?: unknown[];
};

export const cateringPlanLinksTable = pgTable("catering_plan_links", {
  inquiryId: integer("inquiry_id")
    .primaryKey()
    .references(() => cateringInquiriesTable.id, { onDelete: "cascade" }),
  token: varchar("token", { length: 64 }).notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const cateringPlanRevisionsTable = pgTable("catering_plan_revisions", {
  id: serial("id").primaryKey(),
  inquiryId: integer("inquiry_id")
    .notNull()
    .references(() => cateringInquiriesTable.id, { onDelete: "cascade" }),
  submissionId: varchar("submission_id", { length: 128 }).notNull(),
  status: text("status").notNull().default("pending"),
  note: text("note").notNull().default(""),
  baseSnapshot: jsonb("base_snapshot").$type<CateringPlanSnapshot>().notNull(),
  proposedSnapshot: jsonb("proposed_snapshot").$type<CateringPlanSnapshot>().notNull(),
  reviewedAt: timestamp("reviewed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  submissionUnique: uniqueIndex("catering_plan_revisions_submission_uniq").on(table.submissionId),
}));

export type CateringPlanLink = typeof cateringPlanLinksTable.$inferSelect;
export type CateringPlanRevision = typeof cateringPlanRevisionsTable.$inferSelect;