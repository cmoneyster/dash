import { createHash } from "crypto";
import { db } from "@workspace/db";
import {
  eventSettingsTable,
  instagramHashtagCandidatesTable,
  instagramHashtagIdCacheTable,
} from "@workspace/db/schema";
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { logger } from "./logger";
import { ObjectStorageService } from "./objectStorage";
import {
  InstagramApiError,
  captionMentionsHandle,
  fetchRecentMediaForHashtag,
  isInstagramConfigured,
  isPermalinkAvailable,
  lookupHashtagId,
  type InstagramMedia,
} from "./instagramGraph";

// Cleanup re-checks approved posts at most this often. It only runs at
// server startup (never on a timer) so it can't keep an idle server awake.
const CLEANUP_MIN_AGE_MS = 24 * 60 * 60 * 1000;
// Hard cap of 5 watched hashtags (per task spec). Quota-aware: Meta allows
// 30 hashtag searches / IG user / rolling 7 days, so we skip
// lookupHashtagId when we have a cache hit, and never blow past
// MAX_API_CALLS_PER_CYCLE in a single invocation.
const MAX_HASHTAGS = 5;
const MAX_API_CALLS_PER_CYCLE = 5;
const MEDIA_PER_HASHTAG = 25;

const objectStorage = new ObjectStorageService();

// In-process state so repeated clicks of the admin "Run poller now"
// button can't overlap, and startup cleanup runs at most once.
let pollerRunning = false;
let cleanupRunning = false;
let startupTasksStarted = false;

export type PollerSummary = {
  ranAt: string;
  hashtags: string[];
  apiCalls: number;
  inserted: number;
  skipped: number;
  errors: Array<{ hashtag: string; kind: string; message: string }>;
  notConfigured?: boolean;
};

async function fetchAndCacheThumbnail(
  postId: string,
  url: string | null,
): Promise<{ objectPath: string; servingUrl: string } | null> {
  if (!url) return null;
  try {
    // Hash the URL into the path so the same post never gets cached twice.
    const hash = createHash("sha256").update(`${postId}::${url}`).digest("hex").slice(0, 32);
    const fetchResp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!fetchResp.ok) return null;
    const contentType = fetchResp.headers.get("content-type") || "image/jpeg";
    const buffer = Buffer.from(await fetchResp.arrayBuffer());
    if (buffer.byteLength === 0) return null;

    const uploadUrl = await objectStorage.getObjectEntityUploadURL();
    const putResp = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: buffer,
    });
    if (!putResp.ok) return null;
    const objectPath = objectStorage.normalizeObjectEntityPath(uploadUrl);
    return { objectPath: `${objectPath}#${hash}`, servingUrl: `/api/storage${objectPath}` };
  } catch (err) {
    logger.warn({ err, postId }, "instagram: thumbnail cache failed");
    return null;
  }
}

async function getOrFetchHashtagId(hashtag: string, callBudget: { remaining: number }): Promise<string | null> {
  const [cached] = await db
    .select()
    .from(instagramHashtagIdCacheTable)
    .where(eq(instagramHashtagIdCacheTable.hashtag, hashtag));
  if (cached) return cached.hashtagId;
  if (callBudget.remaining <= 0) return null;
  callBudget.remaining -= 1;
  const id = await lookupHashtagId(hashtag);
  await db
    .insert(instagramHashtagIdCacheTable)
    .values({ hashtag, hashtagId: id })
    .onConflictDoNothing();
  return id;
}

function pickAutoStatus(
  media: InstagramMedia,
  settings: typeof eventSettingsTable.$inferSelect,
): { status: "pending" | "approved" | "denied"; rule: string | null } {
  // Auto-deny by age first — if a post is too old, never auto-approve it.
  const days = settings.instagramAutoDenyOlderThanDays;
  if (days != null && days > 0 && media.timestamp) {
    const ageMs = Date.now() - new Date(media.timestamp).getTime();
    if (Number.isFinite(ageMs) && ageMs > days * 24 * 60 * 60 * 1000) {
      return { status: "denied", rule: "auto_deny_too_old" };
    }
  }
  if (settings.instagramAutoApproveMention && settings.instagramHandle) {
    if (captionMentionsHandle(media.caption, settings.instagramHandle)) {
      return { status: "approved", rule: "auto_approve_mention" };
    }
  }
  return { status: "pending", rule: null };
}

/**
 * One poll cycle. Looks up each watched hashtag's id (cached), pulls recent
 * media, dedupes against `instagram_hashtag_candidates` by post id, downloads
 * thumbnails into object storage, applies auto-rules, inserts new rows.
 *
 * NEVER throws — everything wraps so the admin endpoint always gets a summary.
 */
export async function runPollerOnce(): Promise<PollerSummary> {
  const summary: PollerSummary = {
    ranAt: new Date().toISOString(),
    hashtags: [],
    apiCalls: 0,
    inserted: 0,
    skipped: 0,
    errors: [],
  };
  if (!isInstagramConfigured()) {
    summary.notConfigured = true;
    return summary;
  }
  if (pollerRunning) {
    return summary;
  }
  pollerRunning = true;
  try {
    const [settings] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
    if (!settings) return summary;
    const tags = (settings.instagramHashtags ?? [])
      .map((t) => t.replace(/^#/, "").trim().toLowerCase())
      .filter((t) => t.length > 0)
      .slice(0, MAX_HASHTAGS);
    summary.hashtags = tags;
    if (tags.length === 0) {
      await db
        .update(eventSettingsTable)
        .set({ instagramLastPolledAt: new Date() })
        .where(eq(eventSettingsTable.id, 1));
      return summary;
    }

    const callBudget = { remaining: MAX_API_CALLS_PER_CYCLE };
    for (const hashtag of tags) {
      try {
        const hashtagId = await getOrFetchHashtagId(hashtag, callBudget);
        if (!hashtagId) {
          summary.errors.push({ hashtag, kind: "budget", message: "Skipped: API call budget exhausted." });
          continue;
        }
        if (callBudget.remaining <= 0) {
          summary.errors.push({ hashtag, kind: "budget", message: "Skipped recent_media: budget exhausted." });
          continue;
        }
        callBudget.remaining -= 1;
        const media = await fetchRecentMediaForHashtag(hashtagId, MEDIA_PER_HASHTAG);

        // Bulk-load existing post ids for this batch so we only INSERT new rows.
        const incomingIds = media.map((m) => m.id);
        const existing = incomingIds.length
          ? await db
              .select({ id: instagramHashtagCandidatesTable.instagramPostId })
              .from(instagramHashtagCandidatesTable)
              .where(inArray(instagramHashtagCandidatesTable.instagramPostId, incomingIds))
          : [];
        const existingSet = new Set(existing.map((r) => r.id));

        for (const m of media) {
          if (existingSet.has(m.id)) {
            summary.skipped += 1;
            continue;
          }
          const thumbSource = m.mediaType === "VIDEO"
            ? (m.thumbnailUrl ?? m.mediaUrl)
            : (m.mediaUrl ?? m.thumbnailUrl);
          const cached = await fetchAndCacheThumbnail(m.id, thumbSource);
          const auto = pickAutoStatus(m, settings);
          const now = new Date();
          const insertRow = {
            instagramPostId: m.id,
            hashtag,
            caption: m.caption,
            permalink: m.permalink,
            mediaType: m.mediaType,
            originalThumbnailUrl: thumbSource,
            thumbnailObjectPath: cached?.objectPath ?? null,
            thumbnailServingUrl: cached?.servingUrl ?? null,
            postedAt: m.timestamp ? new Date(m.timestamp) : null,
            status: auto.status,
            autoRule: auto.rule,
            decidedBy: auto.rule ? "auto" : null,
            decidedAt: auto.rule ? now : null,
            approvedAt: auto.status === "approved" ? now : null,
          };
          try {
            const inserted = await db
              .insert(instagramHashtagCandidatesTable)
              .values(insertRow)
              .onConflictDoNothing()
              .returning({ id: instagramHashtagCandidatesTable.id });
            if (inserted.length > 0) summary.inserted += 1;
            else summary.skipped += 1;
          } catch (err) {
            logger.warn({ err, postId: m.id }, "instagram: insert candidate failed");
          }
        }
      } catch (err) {
        if (err instanceof InstagramApiError) {
          summary.errors.push({ hashtag, kind: err.kind, message: err.message });
          // On rate_limited or auth failures the rest of the cycle is futile.
          if (err.kind === "rate_limited" || err.kind === "auth" || err.kind === "not_configured") {
            break;
          }
        } else {
          summary.errors.push({ hashtag, kind: "unknown", message: (err as Error).message });
        }
      }
    }

    summary.apiCalls = MAX_API_CALLS_PER_CYCLE - callBudget.remaining;
    await db
      .update(eventSettingsTable)
      .set({ instagramLastPolledAt: new Date() })
      .where(eq(eventSettingsTable.id, 1));
  } catch (err) {
    logger.error({ err }, "instagram poller cycle failed");
  } finally {
    pollerRunning = false;
  }
  logger.info({ summary }, "instagram poller cycle complete");
  return summary;
}

/**
 * Daily cleanup. HEADs each approved+available candidate's permalink and
 * marks `is_unavailable=true` on 404/403 so the public wall drops it.
 */
export async function runCleanupOnce(): Promise<{ checked: number; markedUnavailable: number }> {
  if (cleanupRunning) return { checked: 0, markedUnavailable: 0 };
  cleanupRunning = true;
  try {
    const rows = await db
      .select()
      .from(instagramHashtagCandidatesTable)
      .where(
        and(
          eq(instagramHashtagCandidatesTable.status, "approved"),
          eq(instagramHashtagCandidatesTable.isUnavailable, false),
        ),
      );
    let markedUnavailable = 0;
    for (const row of rows) {
      const ok = await isPermalinkAvailable(row.permalink);
      const now = new Date();
      if (!ok) {
        await db
          .update(instagramHashtagCandidatesTable)
          .set({ isUnavailable: true, lastCheckedAt: now })
          .where(eq(instagramHashtagCandidatesTable.id, row.id));
        markedUnavailable += 1;
      } else {
        await db
          .update(instagramHashtagCandidatesTable)
          .set({ lastCheckedAt: now })
          .where(eq(instagramHashtagCandidatesTable.id, row.id));
      }
    }
    return { checked: rows.length, markedUnavailable };
  } catch (err) {
    logger.error({ err }, "instagram cleanup cycle failed");
    return { checked: 0, markedUnavailable: 0 };
  } finally {
    cleanupRunning = false;
  }
}

// True when any approved, still-available post hasn't been re-checked
// within CLEANUP_MIN_AGE_MS (or never has been).
async function cleanupIsDue(): Promise<boolean> {
  const cutoff = new Date(Date.now() - CLEANUP_MIN_AGE_MS);
  const [stale] = await db
    .select({ id: instagramHashtagCandidatesTable.id })
    .from(instagramHashtagCandidatesTable)
    .where(
      and(
        eq(instagramHashtagCandidatesTable.status, "approved"),
        eq(instagramHashtagCandidatesTable.isUnavailable, false),
        or(
          isNull(instagramHashtagCandidatesTable.lastCheckedAt),
          lt(instagramHashtagCandidatesTable.lastCheckedAt, cutoff),
        ),
      ),
    )
    .limit(1);
  return !!stale;
}

/**
 * Startup-only work. New hashtag posts are fetched solely via the admin
 * "Run poller now" button; the deleted-post cleanup piggybacks on server
 * startup when it's been more than a day, so neither ever wakes an idle
 * server by itself.
 */
export function startInstagramStartupTasks(): void {
  if (startupTasksStarted) return;
  startupTasksStarted = true;
  setTimeout(async () => {
    try {
      if (await cleanupIsDue()) await runCleanupOnce();
    } catch (err) {
      logger.error({ err }, "instagram startup cleanup failed");
    }
  }, 60_000).unref?.();
}
