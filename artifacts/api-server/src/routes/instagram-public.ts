import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  eventSettingsTable,
  instagramHashtagCandidatesTable,
} from "@workspace/db/schema";
import { and, desc, eq } from "drizzle-orm";

const router: IRouter = Router();

// Public hashtag wall payload. Approved + available posts only, capped at the
// admin's configured max. Returns `{enabled,placement,handle,items}` so the
// website can decide whether to render the section at all without a second
// fetch. Always 200 (even when the wall is disabled) so the website's
// caching layer doesn't churn.
router.get("/instagram/wall", async (req, res) => {
  try {
    const [settings] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
    const enabled = !!settings?.instagramWallEnabled;
    const handle = settings?.instagramHandle ?? "";
    const maxItems = settings?.instagramWallMaxItems ?? 12;
    const placement = {
      home: !!settings?.instagramWallShowOnHome,
      gallery: !!settings?.instagramWallShowOnGallery,
    };
    if (!enabled) {
      res.json({ enabled, placement, handle, items: [] });
      return;
    }
    const rows = await db
      .select()
      .from(instagramHashtagCandidatesTable)
      .where(
        and(
          eq(instagramHashtagCandidatesTable.status, "approved"),
          eq(instagramHashtagCandidatesTable.isUnavailable, false),
        ),
      )
      .orderBy(desc(instagramHashtagCandidatesTable.postedAt), desc(instagramHashtagCandidatesTable.id))
      .limit(Math.max(1, Math.min(60, maxItems)));
    const items = rows.map((r) => ({
      id: r.id,
      instagramPostId: r.instagramPostId,
      caption: r.caption,
      permalink: r.permalink,
      mediaType: r.mediaType,
      thumbnailUrl: r.thumbnailServingUrl ?? r.originalThumbnailUrl ?? null,
      postedAt: r.postedAt ? r.postedAt.toISOString() : null,
    }));
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({ enabled, placement, handle, items });
  } catch (err: any) {
    req.log.error({ err }, "instagram: public wall fetch failed");
    res.status(500).json({ error: "Failed to load Instagram wall" });
  }
});

export default router;
