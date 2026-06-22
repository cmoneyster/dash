import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  eventSettingsTable,
  instagramHashtagCandidatesTable,
} from "@workspace/db/schema";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { isInstagramConfigured } from "../lib/instagramGraph";
import { runPollerOnce, INSTAGRAM_POLL_INTERVAL_RANGE } from "../lib/instagramPoller";

const router: IRouter = Router();

const VALID_STATUSES = new Set(["pending", "approved", "denied", "blacklisted", "all"]);
const VALID_ACTIONS = new Set(["approve", "deny", "blacklist"]);

function statusForAction(action: string): "approved" | "denied" | "blacklisted" {
  if (action === "approve") return "approved";
  if (action === "deny") return "denied";
  return "blacklisted";
}

function adminIdentifier(req: any): string {
  const auth = (req.headers["authorization"] || "").toString();
  // The admin token is HMAC-derived from a shared secret with no per-user
  // identity. Hash a short tag so the audit columns aren't blank, but don't
  // leak the token itself.
  const tail = auth.slice(-8);
  return `admin:${tail || "session"}`;
}

function serializeCandidate(c: typeof instagramHashtagCandidatesTable.$inferSelect) {
  return {
    id: c.id,
    instagramPostId: c.instagramPostId,
    hashtag: c.hashtag,
    caption: c.caption,
    permalink: c.permalink,
    mediaType: c.mediaType,
    thumbnailUrl: c.thumbnailServingUrl ?? c.originalThumbnailUrl ?? null,
    postedAt: c.postedAt ? c.postedAt.toISOString() : null,
    status: c.status,
    autoRule: c.autoRule,
    decidedBy: c.decidedBy,
    decidedAt: c.decidedAt ? c.decidedAt.toISOString() : null,
    approvedAt: c.approvedAt ? c.approvedAt.toISOString() : null,
    isUnavailable: c.isUnavailable,
    source: c.source ?? "hashtag_poll",
    createdAt: c.createdAt.toISOString(),
  };
}

router.get("/admin/instagram/candidates", async (req, res) => {
  try {
    const status = String(req.query.status ?? "pending");
    if (!VALID_STATUSES.has(status)) {
      res.status(400).json({ error: "Invalid status filter" });
      return;
    }
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 60));

    const where = status === "all" ? undefined : eq(instagramHashtagCandidatesTable.status, status);
    const rows = where
      ? await db.select().from(instagramHashtagCandidatesTable).where(where).orderBy(desc(instagramHashtagCandidatesTable.createdAt)).limit(limit)
      : await db.select().from(instagramHashtagCandidatesTable).orderBy(desc(instagramHashtagCandidatesTable.createdAt)).limit(limit);

    // Tab counts so the UI can render badges without a second round-trip.
    const counts = await db
      .select({
        status: instagramHashtagCandidatesTable.status,
        count: sql<number>`count(*)::int`,
      })
      .from(instagramHashtagCandidatesTable)
      .groupBy(instagramHashtagCandidatesTable.status);
    const countByStatus: Record<string, number> = {};
    for (const r of counts) countByStatus[r.status] = Number(r.count);

    res.json({
      candidates: rows.map(serializeCandidate),
      counts: {
        pending: countByStatus.pending ?? 0,
        approved: countByStatus.approved ?? 0,
        denied: countByStatus.denied ?? 0,
        blacklisted: countByStatus.blacklisted ?? 0,
      },
    });
  } catch (err: any) {
    req.log.error({ err }, "instagram: list candidates failed");
    res.status(500).json({ error: "Failed to list candidates" });
  }
});

// Returns the moderation sidebar's "needs your attention" badge count.
// Pending posts inserted AFTER the admin's last visit, so the badge clears
// once the page is loaded (see /admin/instagram/visit).
router.get("/admin/instagram/badge", async (req, res) => {
  try {
    const [settings] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
    const since = settings?.instagramAdminLastVisitedAt;
    const filter = since
      ? and(
          eq(instagramHashtagCandidatesTable.status, "pending"),
          gt(instagramHashtagCandidatesTable.createdAt, since),
        )
      : eq(instagramHashtagCandidatesTable.status, "pending");
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(instagramHashtagCandidatesTable)
      .where(filter);
    const totalPending = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(instagramHashtagCandidatesTable)
      .where(eq(instagramHashtagCandidatesTable.status, "pending"));
    res.json({
      newSinceLastVisit: Number(row?.count ?? 0),
      totalPending: Number(totalPending[0]?.count ?? 0),
    });
  } catch (err: any) {
    req.log.error({ err }, "instagram: badge count failed");
    res.status(500).json({ error: "Failed to fetch badge count" });
  }
});

router.post("/admin/instagram/visit", async (_req, res) => {
  try {
    await db
      .update(eventSettingsTable)
      .set({ instagramAdminLastVisitedAt: new Date() })
      .where(eq(eventSettingsTable.id, 1));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to mark visit" });
  }
});

router.post("/admin/instagram/candidates/:id/decision", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const action = String(req.body?.action ?? "");
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid candidate id" });
      return;
    }
    if (!VALID_ACTIONS.has(action)) {
      res.status(400).json({ error: "Invalid action" });
      return;
    }
    const newStatus = statusForAction(action);
    const now = new Date();
    const [updated] = await db
      .update(instagramHashtagCandidatesTable)
      .set({
        status: newStatus,
        decidedBy: adminIdentifier(req),
        decidedAt: now,
        approvedAt: newStatus === "approved" ? now : null,
        autoRule: null,
      })
      .where(eq(instagramHashtagCandidatesTable.id, id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Candidate not found" });
      return;
    }
    res.json(serializeCandidate(updated));
  } catch (err: any) {
    req.log.error({ err }, "instagram: decision failed");
    res.status(500).json({ error: "Failed to record decision" });
  }
});

router.post("/admin/instagram/candidates/bulk-decision", async (req, res) => {
  try {
    const ids: unknown = req.body?.ids;
    const action = String(req.body?.action ?? "");
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: "ids[] is required" });
      return;
    }
    const numericIds = ids
      .map((v) => Number(v))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (numericIds.length === 0) {
      res.status(400).json({ error: "ids[] contained no valid numbers" });
      return;
    }
    if (!VALID_ACTIONS.has(action)) {
      res.status(400).json({ error: "Invalid action" });
      return;
    }
    const newStatus = statusForAction(action);
    const now = new Date();
    const updated = await db
      .update(instagramHashtagCandidatesTable)
      .set({
        status: newStatus,
        decidedBy: adminIdentifier(req),
        decidedAt: now,
        approvedAt: newStatus === "approved" ? now : null,
        autoRule: null,
      })
      .where(inArray(instagramHashtagCandidatesTable.id, numericIds))
      .returning();
    res.json({ updatedCount: updated.length });
  } catch (err: any) {
    req.log.error({ err }, "instagram: bulk decision failed");
    res.status(500).json({ error: "Failed to record bulk decision" });
  }
});

router.post("/admin/instagram/poller/run-now", async (req, res) => {
  try {
    const summary = await runPollerOnce();
    res.json({
      summary,
      configured: isInstagramConfigured(),
    });
  } catch (err: any) {
    req.log.error({ err }, "instagram: manual poller run failed");
    res.status(500).json({ error: "Failed to run poller" });
  }
});

// GET the moderation page's sidebar settings + stats. Read-only summary
// that mirrors what `/admin/event-settings` exposes plus a few derived
// status fields the moderation UI cares about (configured? pending count?).
router.get("/admin/instagram/status", async (req, res) => {
  try {
    const [settings] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [pulled24h] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(instagramHashtagCandidatesTable)
      .where(gt(instagramHashtagCandidatesTable.createdAt, since));
    const [pendingCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(instagramHashtagCandidatesTable)
      .where(eq(instagramHashtagCandidatesTable.status, "pending"));
    res.json({
      configured: isInstagramConfigured(),
      instagramHandle: settings?.instagramHandle ?? "",
      instagramHashtags: settings?.instagramHashtags ?? [],
      instagramWallEnabled: settings?.instagramWallEnabled ?? false,
      instagramWallMaxItems: settings?.instagramWallMaxItems ?? 12,
      instagramWallShowOnHome: settings?.instagramWallShowOnHome ?? false,
      instagramWallShowOnGallery: settings?.instagramWallShowOnGallery ?? false,
      instagramAutoApproveMention: settings?.instagramAutoApproveMention ?? false,
      instagramAutoDenyOlderThanDays: settings?.instagramAutoDenyOlderThanDays ?? 90,
      lastPolledAt: settings?.instagramLastPolledAt ? settings.instagramLastPolledAt.toISOString() : null,
      pulledLast24h: Number(pulled24h?.count ?? 0),
      pendingCount: Number(pendingCount?.count ?? 0),
      // Surface the operator-tunable polling controls so the moderation
      // sidebar can render the on/off toggle and minutes-between-polls
      // input alongside the rest of the IG settings (which all save
      // through the same PUT below).
      instagramPollEnabled: settings?.instagramPollEnabled ?? true,
      instagramPollIntervalMinutes: settings?.instagramPollIntervalMinutes ?? INSTAGRAM_POLL_INTERVAL_RANGE.default,
      instagramPollIntervalMinutesMin: INSTAGRAM_POLL_INTERVAL_RANGE.min,
      instagramPollIntervalMinutesMax: INSTAGRAM_POLL_INTERVAL_RANGE.max,
      // Webhook config status so the UI can tell the admin what to set up.
      // We only reveal presence (boolean), never the secret values.
      webhookAppSecretConfigured: !!(process.env.INSTAGRAM_APP_SECRET?.trim()),
      webhookVerifyTokenConfigured: !!(process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN?.trim()),
    });
  } catch (err: any) {
    req.log.error({ err }, "instagram: status failed");
    res.status(500).json({ error: "Failed to fetch status" });
  }
});

// PUT the hashtag-wall settings. Lives under /admin/instagram instead of
// /admin/event-settings so the moderation page can save just these fields
// without round-tripping unrelated event-settings values.
router.put("/admin/instagram/settings", async (req, res) => {
  try {
    const body = req.body ?? {};
    const updates: Record<string, any> = { updatedAt: new Date() };

    if (body.instagramHandle !== undefined) {
      const raw = body.instagramHandle == null ? "" : String(body.instagramHandle);
      const cleaned = raw.trim().replace(/^@/, "");
      if (cleaned.length > 60) {
        res.status(400).json({ error: "Instagram handle must be 60 characters or fewer" });
        return;
      }
      // Instagram handles are alphanumerics, periods, and underscores.
      if (cleaned && !/^[A-Za-z0-9._]+$/.test(cleaned)) {
        res.status(400).json({ error: "Instagram handle may only contain letters, numbers, periods, and underscores" });
        return;
      }
      updates.instagramHandle = cleaned;
    }

    if (body.instagramHashtags !== undefined) {
      if (!Array.isArray(body.instagramHashtags)) {
        res.status(400).json({ error: "instagramHashtags must be an array" });
        return;
      }
      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const raw of body.instagramHashtags) {
        if (typeof raw !== "string") continue;
        const tag = raw.trim().replace(/^#/, "").toLowerCase();
        if (!tag) continue;
        if (!/^[a-z0-9_]+$/.test(tag)) {
          res.status(400).json({ error: `Hashtag '${raw}' is invalid; use letters, numbers, and underscores only.` });
          return;
        }
        if (tag.length > 100) {
          res.status(400).json({ error: `Hashtag '${raw}' is too long.` });
          return;
        }
        if (seen.has(tag)) continue;
        seen.add(tag);
        cleaned.push(tag);
      }
      if (cleaned.length > 5) {
        res.status(400).json({ error: "At most 5 hashtags can be watched at once." });
        return;
      }
      updates.instagramHashtags = cleaned;
    }

    if (body.instagramWallEnabled !== undefined) {
      updates.instagramWallEnabled = !!body.instagramWallEnabled;
    }
    if (body.instagramWallMaxItems !== undefined) {
      const n = Number(body.instagramWallMaxItems);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 60) {
        res.status(400).json({ error: "instagramWallMaxItems must be an integer between 1 and 60" });
        return;
      }
      updates.instagramWallMaxItems = n;
    }
    if (body.instagramWallShowOnHome !== undefined) {
      updates.instagramWallShowOnHome = !!body.instagramWallShowOnHome;
    }
    if (body.instagramWallShowOnGallery !== undefined) {
      updates.instagramWallShowOnGallery = !!body.instagramWallShowOnGallery;
    }
    if (body.instagramAutoApproveMention !== undefined) {
      updates.instagramAutoApproveMention = !!body.instagramAutoApproveMention;
    }
    if (body.instagramAutoDenyOlderThanDays !== undefined) {
      const v = body.instagramAutoDenyOlderThanDays;
      if (v === null || v === "") {
        updates.instagramAutoDenyOlderThanDays = null;
      } else {
        const n = Number(v);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 3650) {
          res.status(400).json({ error: "instagramAutoDenyOlderThanDays must be an integer between 1 and 3650" });
          return;
        }
        updates.instagramAutoDenyOlderThanDays = n;
      }
    }
    if (body.instagramPollEnabled !== undefined) {
      updates.instagramPollEnabled = !!body.instagramPollEnabled;
    }
    if (body.instagramPollIntervalMinutes !== undefined) {
      const n = Number(body.instagramPollIntervalMinutes);
      if (
        !Number.isFinite(n) ||
        !Number.isInteger(n) ||
        n < INSTAGRAM_POLL_INTERVAL_RANGE.min ||
        n > INSTAGRAM_POLL_INTERVAL_RANGE.max
      ) {
        res.status(400).json({
          error: `instagramPollIntervalMinutes must be an integer between ${INSTAGRAM_POLL_INTERVAL_RANGE.min} and ${INSTAGRAM_POLL_INTERVAL_RANGE.max}`,
        });
        return;
      }
      updates.instagramPollIntervalMinutes = n;
    }

    // Ensure the singleton row exists.
    const [existing] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
    if (!existing) {
      // Persist new poll-cadence fields explicitly on bootstrap so the
      // row is self-consistent even if the caller's PUT didn't touch
      // them. Same defensive pattern used by the SMS settings route.
      await db.insert(eventSettingsTable).values({
        id: 1,
        ...updates,
        instagramPollEnabled: updates.instagramPollEnabled ?? true,
        instagramPollIntervalMinutes:
          updates.instagramPollIntervalMinutes ?? INSTAGRAM_POLL_INTERVAL_RANGE.default,
      });
    } else {
      await db.update(eventSettingsTable).set(updates).where(eq(eventSettingsTable.id, 1));
    }
    res.json({ ok: true });
  } catch (err: any) {
    req.log.error({ err }, "instagram: settings update failed");
    res.status(500).json({ error: "Failed to update Instagram settings" });
  }
});

export default router;
