import { pgTable, varchar, timestamp, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const sharedPlansTable = pgTable("shared_plans", {
  shareToken:     varchar("share_token").primaryKey().default(sql`gen_random_uuid()`),
  sessionId:      varchar("session_id").notNull(),
  planName:       varchar("plan_name", { length: 100 }),
  plannerState:   jsonb("planner_state"),
  lastModifiedAt: timestamp("last_modified_at").notNull().defaultNow(),
  expiresAt:      timestamp("expires_at").notNull(),
});

export type SharedPlan = typeof sharedPlansTable.$inferSelect;
