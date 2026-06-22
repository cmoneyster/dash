// Meta Instagram webhook endpoint.
//
// Meta sends two kinds of requests here:
//
//   GET  /api/webhooks/instagram — hub challenge (one-time verification when
//                                  you register the webhook URL in the Meta app dashboard)
//   POST /api/webhooks/instagram — event delivery (story @mentions, etc.)
//
// Required env vars:
//   INSTAGRAM_WEBHOOK_VERIFY_TOKEN — any string you choose; must match the
//     "Verify Token" you enter in the Meta webhook config UI.
//   INSTAGRAM_APP_SECRET — your Meta app secret (Settings → Basic → App Secret).
//     Used to verify HMAC-SHA256 signatures on every POST payload.
//     If unset, signature verification is skipped (dev-only convenience).
//
// Webhook subscription in Meta app dashboard:
//   Object: instagram
//   Field: mentions
//
// This route is mounted WITHOUT admin auth because Meta calls it unauthenticated.
// Authenticity is established by either the shared verify token (GET) or the
// HMAC signature (POST).

import { createHmac, timingSafeEqual } from "crypto";
import { createHash } from "crypto";
import { Router } from "express";
import { db } from "@workspace/db";
import { instagramHashtagCandidatesTable, eventSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { fetchMentionedMedia, isInstagramConfigured } from "../lib/instagramGraph";
import { ObjectStorageService } from "../lib/objectStorage";

const router = Router();
const objectStorage = new ObjectStorageService();

function getWebhookConfig(): { appSecret: string | null; verifyToken: string | null } {
  return {
    appSecret: process.env.INSTAGRAM_APP_SECRET?.trim() || null,
    verifyToken: process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN?.trim() || null,
  };
}

function verifySignature(rawBody: Buffer, signature: string, appSecret: string): boolean {
  if (!signature.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ─── GET: hub challenge verification ────────────────────────────────────────
router.get("/webhooks/instagram", (req, res) => {
  const { verifyToken } = getWebhookConfig();
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && verifyToken && token === verifyToken) {
    res.status(200).send(String(challenge ?? ""));
    return;
  }
  logger.warn({ mode, hasToken: !!token }, "instagram-webhook: hub verification failed");
  res.status(403).json({ error: "Verification failed" });
});

// ─── POST: event delivery ────────────────────────────────────────────────────
router.post("/webhooks/instagram", (req, res) => {
  const { appSecret } = getWebhookConfig();
  const raw = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}));

  if (appSecret) {
    const sig = req.header("x-hub-signature-256") || "";
    if (!sig || !verifySignature(raw, sig, appSecret)) {
      req.log.warn("instagram-webhook: invalid HMAC signature");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }
  }

  // Respond immediately so Meta doesn't retry.
  res.status(200).json({ ok: true });

  // Parse and process asynchronously.
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return;
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    (payload as any).object !== "instagram" ||
    !Array.isArray((payload as any).entry)
  ) {
    return;
  }

  for (const entry of (payload as any).entry as unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const changes = (entry as any).changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      if (change?.field !== "mentions") continue;
      const mediaId = change?.value?.media_id;
      if (typeof mediaId === "string" && mediaId) {
        void processMentionAsync(mediaId);
      }
    }
  }
});

async function fetchAndCacheThumbnail(
  postId: string,
  url: string | null,
): Promise<{ objectPath: string; servingUrl: string } | null> {
  if (!url) return null;
  try {
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
    logger.warn({ err, postId }, "instagram-mention: thumbnail cache failed");
    return null;
  }
}

async function processMentionAsync(mediaId: string): Promise<void> {
  if (!isInstagramConfigured()) {
    logger.warn({ mediaId }, "instagram-mention: IG credentials not configured, skipping");
    return;
  }
  try {
    // Skip if already in the database (idempotency).
    const existing = await db
      .select({ id: instagramHashtagCandidatesTable.id })
      .from(instagramHashtagCandidatesTable)
      .where(eq(instagramHashtagCandidatesTable.instagramPostId, mediaId));
    if (existing.length > 0) {
      logger.info({ mediaId }, "instagram-mention: already exists, skipping");
      return;
    }

    const media = await fetchMentionedMedia(mediaId);
    if (!media) {
      logger.warn({ mediaId }, "instagram-mention: could not fetch media, skipping");
      return;
    }

    // For story mentions the media_url IS the story image/video.
    // For videos, use thumbnail_url as the preview.
    const thumbSource =
      media.mediaType === "VIDEO"
        ? (media.thumbnailUrl ?? media.mediaUrl)
        : (media.mediaUrl ?? media.thumbnailUrl);

    const cached = await fetchAndCacheThumbnail(media.id, thumbSource);

    const [settings] = await db
      .select({ instagramAutoApproveMention: eventSettingsTable.instagramAutoApproveMention })
      .from(eventSettingsTable)
      .where(eq(eventSettingsTable.id, 1));

    // Story mentions are intentional — the customer chose to @mention the
    // restaurant. Auto-approve when the setting is on.
    const autoApprove = settings?.instagramAutoApproveMention === true;
    const now = new Date();

    await db
      .insert(instagramHashtagCandidatesTable)
      .values({
        instagramPostId: media.id,
        hashtag: "",
        caption: media.caption,
        permalink: media.permalink,
        mediaType: media.mediaType,
        originalThumbnailUrl: thumbSource ?? null,
        thumbnailObjectPath: cached?.objectPath ?? null,
        thumbnailServingUrl: cached?.servingUrl ?? null,
        postedAt: media.timestamp ? new Date(media.timestamp) : null,
        status: autoApprove ? "approved" : "pending",
        autoRule: autoApprove ? "auto-approved:story-mention" : null,
        decidedBy: autoApprove ? "system" : null,
        decidedAt: autoApprove ? now : null,
        approvedAt: autoApprove ? now : null,
        source: "story_mention",
      })
      .onConflictDoNothing();

    logger.info({ mediaId: media.id, autoApprove }, "instagram-mention: candidate inserted");
  } catch (err) {
    logger.error({ err, mediaId }, "instagram-mention: processing failed");
  }
}

export default router;
