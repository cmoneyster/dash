import { sql } from "drizzle-orm";
import { pgTable, serial, text, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";

// Per-post moderation candidates. The poller inserts a row per Instagram post
// returned by the hashtag search, deduped on instagram_post_id. The admin
// moderation UI flips each row's status; only `approved` + not-unavailable
// rows show on the public wall.
export const instagramHashtagCandidatesTable = pgTable(
  "instagram_hashtag_candidates",
  {
    id: serial("id").primaryKey(),
    instagramPostId: text("instagram_post_id").notNull(),
    hashtag: text("hashtag").notNull(),
    caption: text("caption").notNull().default(""),
    permalink: text("permalink").notNull().default(""),
    // 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM' (mirrors the IG Graph media_type).
    mediaType: text("media_type").notNull().default("IMAGE"),
    // Cached thumbnail in object storage (so the moderation grid stays fast
    // even if Instagram is slow). Populated by the poller; null on cache miss.
    thumbnailObjectPath: text("thumbnail_object_path"),
    thumbnailServingUrl: text("thumbnail_serving_url"),
    // The original IG-supplied media_url / thumbnail_url (kept as a fallback
    // when our cache hasn't loaded yet).
    originalThumbnailUrl: text("original_thumbnail_url"),
    postedAt: timestamp("posted_at"),
    // 'pending' | 'approved' | 'denied' | 'blacklisted'
    // 'blacklisted' is a permanent "hide forever" — the poller skips this
    // post id even if it shows up in a future search.
    status: text("status").notNull().default("pending"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at"),
    approvedAt: timestamp("approved_at"),
    autoRule: text("auto_rule"),
    isUnavailable: boolean("is_unavailable").notNull().default(false),
    lastCheckedAt: timestamp("last_checked_at"),
    // 'hashtag_poll' (default) or 'story_mention' (arrived via Meta webhook).
    source: text("source").notNull().default("hashtag_poll"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    postIdUnique: uniqueIndex("instagram_hashtag_candidates_post_id_idx").on(t.instagramPostId),
    statusIdx: index("instagram_hashtag_candidates_status_idx").on(t.status),
  }),
);

export type InstagramHashtagCandidate = typeof instagramHashtagCandidatesTable.$inferSelect;

// Hashtag-id lookup cache. The hashtag-id call counts against the same Meta
// quota as the recent-media call, so we cache the resolved id forever (it
// doesn't change). Refreshed lazily if a poller cycle ever sees a cache miss.
export const instagramHashtagIdCacheTable = pgTable("instagram_hashtag_id_cache", {
  // Lowercased hashtag with no leading '#'.
  hashtag: text("hashtag").primaryKey(),
  hashtagId: text("hashtag_id").notNull(),
  fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
});
