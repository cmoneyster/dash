// Tiny typed wrapper around the two Instagram Graph API endpoints we need:
//   - GET /ig_hashtag_search?user_id=&q=  -> { data:[{id}] }
//   - GET /{hashtag-id}/recent_media?user_id=&fields=...
//
// Auth: long-lived USER access token + the IG Business User id, both stored
// as env secrets. The token is *never* persisted in the database.
//
// Errors are bucketed into a small union so the moderation UI can render the
// right message ("still in development mode" vs "rate limited" vs "auth").

const GRAPH_VERSION = "v19.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

export type InstagramErrorKind =
  | "not_configured"
  | "permission_denied"
  | "rate_limited"
  | "auth"
  | "network"
  | "unknown";

export class InstagramApiError extends Error {
  kind: InstagramErrorKind;
  status?: number;
  detail?: unknown;
  constructor(kind: InstagramErrorKind, message: string, opts?: { status?: number; detail?: unknown }) {
    super(message);
    this.name = "InstagramApiError";
    this.kind = kind;
    this.status = opts?.status;
    this.detail = opts?.detail;
  }
}

export function isInstagramConfigured(): boolean {
  return !!(process.env.INSTAGRAM_ACCESS_TOKEN && process.env.INSTAGRAM_USER_ID);
}

function getCreds(): { token: string; userId: string } {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const userId = process.env.INSTAGRAM_USER_ID;
  if (!token || !userId) {
    throw new InstagramApiError(
      "not_configured",
      "Instagram credentials missing. Set INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_USER_ID.",
    );
  }
  return { token, userId };
}

// IG Graph error codes that mean "your test app can't see this hashtag yet —
// add the IG account as an Instagram Tester or submit App Review". Surfaced
// as a friendly banner instead of a generic failure.
const PERMISSION_ERROR_CODES = new Set([10, 200, 803]);

async function graphFetch(url: URL): Promise<unknown> {
  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new InstagramApiError("network", `Network error contacting Instagram: ${(err as Error).message}`);
  }
  // Best-effort JSON parse — IG always returns JSON, but be defensive.
  let body: any = null;
  try {
    body = await resp.json();
  } catch {
    // ignore — body stays null
  }
  if (!resp.ok) {
    const apiErr = body?.error;
    const code = typeof apiErr?.code === "number" ? apiErr.code : null;
    const subcode = typeof apiErr?.error_subcode === "number" ? apiErr.error_subcode : null;
    const msg = apiErr?.message || resp.statusText || `HTTP ${resp.status}`;
    if (resp.status === 429 || code === 4 || code === 17 || code === 32) {
      throw new InstagramApiError("rate_limited", `Instagram rate limited: ${msg}`, { status: resp.status, detail: apiErr });
    }
    if (code != null && PERMISSION_ERROR_CODES.has(code)) {
      throw new InstagramApiError(
        "permission_denied",
        `Instagram blocked this hashtag search (code ${code}${subcode ? `/${subcode}` : ""}): ${msg}. ` +
        `Your app is likely still in Meta development mode — add the Instagram account as a Tester in the Meta Developer dashboard, or submit App Review.`,
        { status: resp.status, detail: apiErr },
      );
    }
    if (resp.status === 401 || resp.status === 403 || code === 190) {
      throw new InstagramApiError("auth", `Instagram auth error: ${msg}. Check INSTAGRAM_ACCESS_TOKEN.`, { status: resp.status, detail: apiErr });
    }
    throw new InstagramApiError("unknown", `Instagram API error: ${msg}`, { status: resp.status, detail: apiErr });
  }
  return body;
}

export async function lookupHashtagId(hashtag: string): Promise<string> {
  const { token, userId } = getCreds();
  const url = new URL(`${GRAPH_BASE}/ig_hashtag_search`);
  url.searchParams.set("user_id", userId);
  url.searchParams.set("q", hashtag.replace(/^#/, "").toLowerCase());
  url.searchParams.set("access_token", token);
  const body = (await graphFetch(url)) as { data?: Array<{ id?: string }> };
  const id = body?.data?.[0]?.id;
  if (!id) {
    throw new InstagramApiError("unknown", `Hashtag '${hashtag}' returned no id.`);
  }
  return String(id);
}

export type InstagramMedia = {
  id: string;
  caption: string;
  permalink: string;
  mediaType: string;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  timestamp: string | null;
};

export async function fetchRecentMediaForHashtag(hashtagId: string, limit: number = 25): Promise<InstagramMedia[]> {
  const { token, userId } = getCreds();
  const url = new URL(`${GRAPH_BASE}/${encodeURIComponent(hashtagId)}/recent_media`);
  url.searchParams.set("user_id", userId);
  url.searchParams.set("fields", "id,caption,media_type,media_url,permalink,thumbnail_url,timestamp");
  url.searchParams.set("limit", String(Math.max(1, Math.min(50, limit))));
  url.searchParams.set("access_token", token);
  const body = (await graphFetch(url)) as { data?: any[] };
  const items = Array.isArray(body?.data) ? body.data : [];
  return items.map((m) => ({
    id: String(m.id ?? ""),
    caption: typeof m.caption === "string" ? m.caption : "",
    permalink: typeof m.permalink === "string" ? m.permalink : "",
    mediaType: typeof m.media_type === "string" ? m.media_type : "IMAGE",
    mediaUrl: typeof m.media_url === "string" ? m.media_url : null,
    thumbnailUrl: typeof m.thumbnail_url === "string" ? m.thumbnail_url : null,
    timestamp: typeof m.timestamp === "string" ? m.timestamp : null,
  })).filter((m) => m.id);
}

// Best-effort permalink check used by the daily cleanup pass to detect
// posts that were deleted / made private after we already approved them.
// Returns true when the post still appears available, false on 404/403.
// Network errors fall through as `available` so a flaky network never
// nukes the wall.
export async function isPermalinkAvailable(permalink: string): Promise<boolean> {
  if (!permalink) return false;
  try {
    const resp = await fetch(permalink, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.status === 404 || resp.status === 410 || resp.status === 403) return false;
    return true;
  } catch {
    return true;
  }
}

// Fetches a single media object where your IG Business account was @mentioned.
// Used by the story-mention webhook handler after receiving a `mentions` event.
// Calls GET /{ig-user-id}/mentioned_media — the account must own the token.
// Returns null on any error (network, auth, not found) so the caller can skip gracefully.
export async function fetchMentionedMedia(mediaId: string): Promise<InstagramMedia | null> {
  try {
    const { token, userId } = getCreds();
    const url = new URL(`${GRAPH_BASE}/${encodeURIComponent(userId)}/mentioned_media`);
    url.searchParams.set("media_id", mediaId);
    url.searchParams.set("fields", "id,caption,media_type,media_url,permalink,thumbnail_url,timestamp");
    url.searchParams.set("access_token", token);
    const body = (await graphFetch(url)) as any;
    if (!body?.id) return null;
    return {
      id: String(body.id),
      caption: typeof body.caption === "string" ? body.caption : "",
      permalink: typeof body.permalink === "string" ? body.permalink : "",
      mediaType: typeof body.media_type === "string" ? body.media_type : "IMAGE",
      mediaUrl: typeof body.media_url === "string" ? body.media_url : null,
      thumbnailUrl: typeof body.thumbnail_url === "string" ? body.thumbnail_url : null,
      timestamp: typeof body.timestamp === "string" ? body.timestamp : null,
    };
  } catch {
    return null;
  }
}

// Case-insensitive caption mention check used by the auto-approve rule.
// Matches `@handle` in caption text or in any URL fragment / share text.
// Returns false when the handle is empty (rule effectively disabled).
export function captionMentionsHandle(caption: string, handle: string): boolean {
  const h = handle.replace(/^@/, "").trim().toLowerCase();
  if (!h) return false;
  if (!caption) return false;
  // \b doesn't play nicely with non-ASCII handles; use a guard char check.
  const re = new RegExp(`@${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9._])`, "i");
  return re.test(caption);
}
