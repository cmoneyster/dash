import { Router, type IRouter } from "express";

const router: IRouter = Router();

/**
 * Thin proxy for the Google Places API (New). The key is held server-side
 * so it never ships to the browser, and so we can apply rate limiting and
 * uniform error handling.
 *
 * Returns HTTP 503 with `{ available: false, ... }` when the API key isn't
 * configured. The catering-web client treats that as "fall back to a plain
 * text input" so a missing/expired key never breaks the form.
 */

const PLACES_BASE = "https://places.googleapis.com/v1";

function getKey(): string | null {
  const k = process.env.GOOGLE_PLACES_API_KEY?.trim();
  return k && k.length > 0 ? k : null;
}

// ── In-memory rate limit (per IP) ───────────────────────────────────────────
// Lightweight protection so a misbehaving client can't burn through the
// project's Google billing quota. 60 req/min/IP is generous for normal
// type-ahead use (autocomplete fires on every keystroke, debounced).
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;
// Hard cap on tracked clients so a flood of unique (or spoofed) IPs can't
// grow the map without bound. When exceeded we evict the oldest entry,
// which at worst lets a legitimate client briefly slip its budget — much
// safer than unbounded RAM use.
const RATE_MAX_KEYS = 5_000;
const hits = new Map<string, number[]>();
function rateLimit(ip: string): boolean {
  const now = Date.now();
  const arr = hits.get(ip)?.filter(t => now - t < RATE_WINDOW_MS) ?? [];
  if (arr.length >= RATE_MAX) {
    hits.set(ip, arr);
    return false;
  }
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > RATE_MAX_KEYS) {
    // Map iteration order is insertion order — the first key is the oldest.
    const oldest = hits.keys().next().value;
    if (oldest !== undefined) hits.delete(oldest);
  }
  return true;
}
// Periodic GC so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits.entries()) {
    const fresh = arr.filter(t => now - t < RATE_WINDOW_MS);
    if (fresh.length === 0) hits.delete(ip);
    else hits.set(ip, fresh);
  }
}, RATE_WINDOW_MS).unref?.();

function clientIp(req: { ip?: string; headers: Record<string, unknown> }): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0]!.trim();
  return req.ip ?? "unknown";
}

type AutocompleteSuggestion = {
  placeId: string;
  primaryText: string;
  secondaryText: string;
  fullText: string;
};

router.get("/places/autocomplete", async (req, res) => {
  const key = getKey();
  if (!key) {
    res.status(503).json({
      available: false,
      error: "Address lookup is not configured on this server.",
    });
    return;
  }

  if (!rateLimit(clientIp(req))) {
    res.status(429).json({ error: "Too many requests. Please slow down." });
    return;
  }

  const q = String(req.query.q ?? "").trim();
  const sessionToken = String(req.query.sessionToken ?? "").trim() || undefined;
  if (q.length < 2) {
    res.json({ suggestions: [] });
    return;
  }

  try {
    const r = await fetch(`${PLACES_BASE}/places:autocomplete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
      },
      body: JSON.stringify({
        input: q,
        sessionToken,
        // US-only catering business — restrict suggestions to keep results
        // relevant and reduce billable predictions.
        includedRegionCodes: ["us"],
      }),
    });

    if (!r.ok) {
      const text = await r.text().catch(() => "");
      req.log.error({ status: r.status, body: text }, "Google Places autocomplete failed");
      res.status(502).json({ error: "Address lookup is temporarily unavailable." });
      return;
    }

    const body = (await r.json()) as {
      suggestions?: Array<{
        placePrediction?: {
          placeId?: string;
          place?: string;
          text?: { text?: string };
          structuredFormat?: {
            mainText?: { text?: string };
            secondaryText?: { text?: string };
          };
        };
      }>;
    };

    const suggestions: AutocompleteSuggestion[] = (body.suggestions ?? [])
      .map(s => {
        const p = s.placePrediction;
        if (!p) return null;
        // Both `placeId` and `place` ("places/ChIJ…") shapes appear in the
        // wild; normalize to the bare ID.
        const rawId = p.placeId ?? (p.place ? p.place.replace(/^places\//, "") : "");
        if (!rawId) return null;
        const main = p.structuredFormat?.mainText?.text ?? p.text?.text ?? "";
        const sec  = p.structuredFormat?.secondaryText?.text ?? "";
        return {
          placeId: rawId,
          primaryText: main,
          secondaryText: sec,
          fullText: p.text?.text ?? [main, sec].filter(Boolean).join(", "),
        };
      })
      .filter((x): x is AutocompleteSuggestion => x !== null);

    res.json({ suggestions });
  } catch (err) {
    req.log.error({ err }, "Google Places autocomplete threw");
    res.status(502).json({ error: "Address lookup is temporarily unavailable." });
  }
});

router.get("/places/details/:placeId", async (req, res) => {
  const key = getKey();
  if (!key) {
    res.status(503).json({
      available: false,
      error: "Address lookup is not configured on this server.",
    });
    return;
  }

  if (!rateLimit(clientIp(req))) {
    res.status(429).json({ error: "Too many requests. Please slow down." });
    return;
  }

  const placeId = String(req.params.placeId ?? "").trim();
  if (!placeId || !/^[A-Za-z0-9_-]+$/.test(placeId)) {
    res.status(400).json({ error: "Invalid placeId" });
    return;
  }
  const sessionToken = String(req.query.sessionToken ?? "").trim() || undefined;

  try {
    const url = new URL(`${PLACES_BASE}/places/${encodeURIComponent(placeId)}`);
    if (sessionToken) url.searchParams.set("sessionToken", sessionToken);

    const r = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "X-Goog-Api-Key": key,
        // Field mask is required by the Places API (New). Keeping it tight
        // so we only pay the SKU for the data we actually use.
        "X-Goog-FieldMask": "id,displayName,formattedAddress",
      },
    });

    if (!r.ok) {
      const text = await r.text().catch(() => "");
      req.log.error({ status: r.status, body: text }, "Google Places details failed");
      res.status(502).json({ error: "Address lookup is temporarily unavailable." });
      return;
    }

    const body = (await r.json()) as {
      id?: string;
      displayName?: { text?: string };
      formattedAddress?: string;
    };

    const formattedAddress = body.formattedAddress ?? "";
    const placeName = body.displayName?.text ?? null;

    // Compose a single-line venue string. If the place has a real business
    // / venue name (e.g. "Moody Gardens"), prepend it to the formatted
    // address so the saved string reads like a human label rather than
    // just an anonymous street address. We deduplicate when the place
    // name already appears as the leading token of the formatted address.
    let composed = formattedAddress;
    if (placeName && formattedAddress) {
      const head = formattedAddress.split(",")[0]?.trim().toLowerCase() ?? "";
      if (head !== placeName.trim().toLowerCase()) {
        composed = `${placeName} — ${formattedAddress}`;
      }
    } else if (placeName && !formattedAddress) {
      composed = placeName;
    }

    res.json({
      placeId: body.id ?? placeId,
      placeName,
      formattedAddress,
      composed,
    });
  } catch (err) {
    req.log.error({ err }, "Google Places details threw");
    res.status(502).json({ error: "Address lookup is temporarily unavailable." });
  }
});

export default router;
