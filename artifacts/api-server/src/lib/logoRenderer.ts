import sharp from "sharp";
import { logger } from "./logger";

const DEFAULT_PRINT_WIDTH_PX = 576;
const CACHE_TTL_MS = 10 * 60 * 1000;

type CacheEntry = { escBytes: Buffer; cachedAt: number };
const cache = new Map<string, CacheEntry>();

function buildGsV0(bitmap: Buffer, widthPx: number, heightPx: number): Buffer {
  const bytesPerRow = Math.ceil(widthPx / 8);
  const header = Buffer.from([
    0x1d, 0x76, 0x30, 0x00,
    bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff,
    heightPx & 0xff,   (heightPx >> 8)   & 0xff,
  ]);
  return Buffer.concat([header, bitmap]);
}

/**
 * Fetch a logo URL, resize to fit the printer dot width, convert to a 1-bit
 * ESC/POS GS v 0 raster image command, and return the bytes.
 *
 * Results are cached in-memory for CACHE_TTL_MS to avoid re-fetching on
 * every print job. Returns null on any error so the caller can fall back.
 */
export async function fetchLogoEscBytes(
  url: string,
  printWidthPx = DEFAULT_PRINT_WIDTH_PX,
): Promise<Buffer | null> {
  const cacheKey = `${url}@${printWidthPx}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.escBytes;
  }

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());

    const { data, info } = await sharp(buf)
      .resize(printWidthPx, null, { fit: "inside", withoutEnlargement: true })
      .grayscale()
      .threshold(128)
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height } = info;
    const bytesPerRow = Math.ceil(width / 8);
    const bitmap = Buffer.alloc(bytesPerRow * height, 0);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[y * width + x] === 0) {
          bitmap[y * bytesPerRow + Math.floor(x / 8)] |= 1 << (7 - (x % 8));
        }
      }
    }

    const escBytes = buildGsV0(bitmap, width, height);
    cache.set(cacheKey, { escBytes, cachedAt: Date.now() });
    return escBytes;
  } catch (err) {
    logger.warn({ err, url }, "logo fetch/convert failed — falling back to [LOGO] text");
    return null;
  }
}

/** Invalidate the cache for a specific URL (e.g. after logo change). */
export function invalidateLogoCache(url: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${url}@`)) cache.delete(key);
  }
}
