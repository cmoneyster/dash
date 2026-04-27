import { Router, type IRouter } from "express";
import sharp from "sharp";
import { createHash } from "crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "@workspace/db";
import { eventSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { ObjectStorageService } from "../lib/objectStorage";

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

// Bundled fallback image — same JPEG that ships at /opengraph.jpg on the
// public site, sourced from attached_assets so the asset pipeline can't
// silently re-encode it (see Task #155 for the full back-story).
const FALLBACK_OG_IMAGE_PATH = path.resolve(
  process.cwd(),
  "..",
  "..",
  "attached_assets",
  "catering-web-opengraph.jpg",
);

const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
const LOGO_MAX = 160;
const LOGO_PADDING = 36;
const TAGLINE_MAX_CHARS = 80;

type LogoPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right" | "none";
const VALID_LOGO_POSITIONS: ReadonlySet<LogoPosition> = new Set([
  "top-left", "top-right", "bottom-left", "bottom-right", "none",
]);

interface SocialSettings {
  title: string;
  description: string;
  tagline: string;
  heroUrl: string | null;
  logoUrl: string | null;
  logoPosition: LogoPosition;
  eventName: string;
  instagramHandle: string | null;
}

async function loadSocialSettings(): Promise<SocialSettings> {
  const [row] = await db.select().from(eventSettingsTable).where(eq(eventSettingsTable.id, 1));
  const eventName = (row?.eventName ?? "").trim() || "dash by Hollywood East Cafe";
  const title = (row?.socialShareTitle ?? "").trim() || eventName;
  const description = (row?.socialShareDescription ?? "").trim()
    || "Asian-inspired catering for every occasion. Fresh ingredients, bold flavors, memorable events.";
  const rawPos = (row?.socialLogoPosition ?? "bottom-right") as string;
  const logoPosition: LogoPosition = VALID_LOGO_POSITIONS.has(rawPos as LogoPosition)
    ? (rawPos as LogoPosition)
    : "bottom-right";
  return {
    title,
    description,
    tagline: (row?.socialShareTagline ?? "").trim().slice(0, TAGLINE_MAX_CHARS),
    heroUrl: row?.socialHeroImageUrl ?? null,
    logoUrl: row?.socialLogoImageUrl ?? null,
    logoPosition,
    eventName,
    instagramHandle: (row?.instagramHandle ?? "").trim().replace(/^@/, "") || null,
  };
}

// The image library serves objects via /api/storage/objects/<id>. We strip
// the /api/storage prefix and load the object directly via the storage
// service so this server-side composer doesn't have to round-trip an HTTP
// request through itself. Returns null on miss so the caller can gracefully
// skip the overlay or fall back to the bundled image.
async function loadImageBuffer(servingUrl: string | null): Promise<Buffer | null> {
  if (!servingUrl) return null;
  const cleaned = servingUrl.split("?")[0];
  const objectsIdx = cleaned.indexOf("/objects/");
  if (objectsIdx === -1) return null;
  const objectPath = cleaned.slice(objectsIdx); // "/objects/<id>"
  try {
    const file = await objectStorage.getObjectEntityFile(objectPath);
    const [buf] = await file.download();
    return buf;
  } catch {
    return null;
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Builds an SVG with a bottom gradient strip + tagline text. Sharp composes
// this on top of the hero image. Using SVG (rather than the canvas-style
// sharp text API which requires extra fonts) keeps the dependency surface
// minimal — librsvg ships with sharp and handles the system font stack.
function buildTaglineSvg(tagline: string): Buffer {
  const safe = escapeXml(tagline);
  // Wrap manually to two lines if the tagline is long enough to need it.
  // Word-wrap at ~38 chars per line keeps the centered text legible without
  // dropping below the gradient.
  const words = safe.split(/\s+/);
  let line1 = "";
  let line2 = "";
  for (const w of words) {
    const candidate = line1 ? `${line1} ${w}` : w;
    if (candidate.length <= 38 || !line1) {
      line1 = candidate;
    } else {
      line2 = line2 ? `${line2} ${w}` : w;
    }
  }
  const hasLine2 = line2.trim() !== "";
  const fontSize = hasLine2 ? 48 : 60;
  const line1Y = hasLine2 ? OG_HEIGHT - 90 : OG_HEIGHT - 60;
  const line2Y = OG_HEIGHT - 35;
  const fontFamily = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif";
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}">
  <defs>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000000" stop-opacity="0" />
      <stop offset="1" stop-color="#000000" stop-opacity="0.78" />
    </linearGradient>
  </defs>
  <rect x="0" y="${OG_HEIGHT - 230}" width="${OG_WIDTH}" height="230" fill="url(#fade)" />
  <text x="${OG_WIDTH / 2}" y="${line1Y}" font-family="${fontFamily}" font-size="${fontSize}" font-weight="700" fill="#ffffff" text-anchor="middle" dominant-baseline="alphabetic" style="paint-order:stroke;stroke:rgba(0,0,0,0.35);stroke-width:1px;">${line1}</text>
  ${hasLine2 ? `<text x="${OG_WIDTH / 2}" y="${line2Y}" font-family="${fontFamily}" font-size="${fontSize}" font-weight="700" fill="#ffffff" text-anchor="middle" dominant-baseline="alphabetic" style="paint-order:stroke;stroke:rgba(0,0,0,0.35);stroke-width:1px;">${line2}</text>` : ""}
</svg>`;
  return Buffer.from(svg);
}

// In-memory composed-image cache. Key = hash of (heroUrl, logoUrl,
// logoPosition, tagline). 1 entry is enough in practice — the social share
// image rarely changes — but we keep up to 4 to cover quick A/B previews
// from the admin form. Settings save invalidates the cache.
let composedCache: Array<{ key: string; buf: Buffer }> = [];

function clearComposedCache() {
  composedCache = [];
}

function composedKey(s: SocialSettings): string {
  const h = createHash("sha1");
  h.update(s.heroUrl ?? "");
  h.update("|");
  h.update(s.logoUrl ?? "");
  h.update("|");
  h.update(s.logoPosition);
  h.update("|");
  h.update(s.tagline);
  return h.digest("hex");
}

async function composeOgImage(s: SocialSettings): Promise<Buffer> {
  const key = composedKey(s);
  const hit = composedCache.find(c => c.key === key);
  if (hit) return hit.buf;

  let baseBuf: Buffer | null = await loadImageBuffer(s.heroUrl);
  if (!baseBuf) {
    try {
      baseBuf = await fs.readFile(FALLBACK_OG_IMAGE_PATH);
    } catch {
      // As a last resort, paint a solid color rect so we always return
      // something serializable rather than 500ing.
      baseBuf = await sharp({
        create: { width: OG_WIDTH, height: OG_HEIGHT, channels: 3, background: { r: 30, g: 30, b: 30 } },
      }).jpeg().toBuffer();
    }
  }

  // Cover-fit the hero into 1200x630 and force a fresh JPEG re-encode so we
  // hand sharp's compositor a known-good RGB buffer.
  const base = await sharp(baseBuf)
    .resize(OG_WIDTH, OG_HEIGHT, { fit: "cover", position: "centre" })
    .toColorspace("srgb")
    .jpeg({ quality: 92, progressive: true })
    .toBuffer();

  const composites: sharp.OverlayOptions[] = [];

  if (s.tagline.trim() !== "") {
    composites.push({ input: buildTaglineSvg(s.tagline), top: 0, left: 0 });
  }

  if (s.logoPosition !== "none") {
    const logoBuf = await loadImageBuffer(s.logoUrl);
    if (logoBuf) {
      const resizedLogo = await sharp(logoBuf)
        .resize(LOGO_MAX, LOGO_MAX, { fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();
      const meta = await sharp(resizedLogo).metadata();
      const lw = meta.width ?? LOGO_MAX;
      const lh = meta.height ?? LOGO_MAX;
      let top: number;
      let left: number;
      switch (s.logoPosition) {
        case "top-left":
          top = LOGO_PADDING; left = LOGO_PADDING; break;
        case "top-right":
          top = LOGO_PADDING; left = OG_WIDTH - lw - LOGO_PADDING; break;
        case "bottom-left":
          top = OG_HEIGHT - lh - LOGO_PADDING; left = LOGO_PADDING; break;
        case "bottom-right":
        default:
          top = OG_HEIGHT - lh - LOGO_PADDING; left = OG_WIDTH - lw - LOGO_PADDING; break;
      }
      composites.push({ input: resizedLogo, top, left });
    }
  }

  const out = composites.length === 0
    ? base
    : await sharp(base).composite(composites).jpeg({ quality: 92, progressive: true }).toBuffer();

  composedCache = [{ key, buf: out }, ...composedCache].slice(0, 4);
  return out;
}

// Returns the live preview-meta payload. Public route — used both by the
// catering-web meta-injection middleware AND by the admin live-preview UI
// so they stay byte-for-byte identical.
router.get("/social-share/preview-meta", async (_req, res) => {
  try {
    const s = await loadSocialSettings();
    res.setHeader("Cache-Control", "public, max-age=15");
    res.json({
      title: s.title,
      description: s.description,
      // Versioned URL (key changes on save) so social crawlers and our own
      // injection cache pick up the new image without manual cache-busting.
      imageUrl: `/api/social-share/og-image.jpg?v=${composedKey(s).slice(0, 12)}`,
      instagramHandle: s.instagramHandle,
      tagline: s.tagline,
      logoPosition: s.logoPosition,
      hasHeroImage: !!s.heroUrl,
      hasLogoImage: !!s.logoUrl,
    });
  } catch (err: any) {
    // Never 500 here — meta-injection middleware swallows errors but a quiet
    // empty response keeps the public site rendering with default tags.
    res.status(200).json({
      title: "dash by Hollywood East Cafe",
      description: "Asian-inspired catering for every occasion.",
      imageUrl: "/opengraph.jpg",
      instagramHandle: null,
      tagline: "",
      logoPosition: "bottom-right",
      hasHeroImage: false,
      hasLogoImage: false,
    });
  }
});

router.get("/social-share/og-image.jpg", async (req, res) => {
  try {
    const s = await loadSocialSettings();
    const buf = await composeOgImage(s);
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Content-Length", String(buf.length));
    // Short cache so a Save shows up quickly on the admin preview iframe but
    // social crawlers still cache reasonably between scrapes.
    res.setHeader("Cache-Control", "public, max-age=300");
    res.end(buf);
  } catch (err) {
    req.log.error({ err }, "Error composing social-share og-image");
    // Fall back to the bundled JPEG so a sharp failure never breaks the
    // public link preview.
    try {
      const buf = await fs.readFile(FALLBACK_OG_IMAGE_PATH);
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Content-Length", String(buf.length));
      res.setHeader("Cache-Control", "public, max-age=60");
      res.end(buf);
    } catch {
      res.status(500).json({ error: "Failed to compose social-share image" });
    }
  }
});

export { clearComposedCache };
export default router;
