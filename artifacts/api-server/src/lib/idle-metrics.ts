// In-memory rolling counters that power the admin "Idle Activity"
// page. The goal is operator visibility, not billing accuracy: the
// owner wants to glance at a card and answer "is anything weird
// running while no one is on the site?" without tailing logs or
// opening the deployment dashboard.
//
// Design notes:
//   - All state lives in this process. A restart resets every counter,
//     and the admin page surfaces `serverStartedAt` so the operator
//     knows how far back the numbers actually go.
//   - We aggregate into 1-minute buckets at write time so a busy
//     site with thousands of HTTP hits/min doesn't grow a per-event
//     array. The 24-hour window is therefore at most 1440 buckets per
//     metric — trivial memory.
//   - Buckets older than 24h + a small grace window are pruned on
//     every write so the Map size stays bounded forever.
//   - Snapshot reads sum buckets within the requested window; we use
//     ms-precision `now` rather than minute-aligned cutoffs so the
//     "last hour" line moves smoothly between renders.
//
// The only public surface is the four `record*` helpers (called by
// the ejoin poller, the SMS sender, the instagram poller, and an
// Express middleware) plus `snapshot()` (called by the admin route).
// Everything else is internal.

const SERVER_STARTED_AT = new Date();
const MS_PER_MINUTE = 60_000;
const HOUR_MIN = 60;
const DAY_MIN = 24 * 60;
const HTTP_WINDOW_MIN = 5;
// Keep slightly more than 24h of buckets so a snapshot taken right at
// the boundary still has the full window available.
const RETAIN_BUCKETS = DAY_MIN + 10;

// A single minute bucket holds totals for every metric we track. Using
// one shared shape keeps the Map small (one entry per minute, not one
// per metric per minute) and the snapshot loop simple. The HTTP slot
// is a nested map (family → endpoint-template → count) so the admin
// page can break each family down into the routes contributing to it.
type Bucket = {
  minute: number;
  ejoinPolls: number;
  ejoinBytes: number;
  smsOutbound: number;
  instagramPolls: number;
  http: Map<RouteFamily, Map<string, number>>;
};

// Cardinality cap: how many distinct endpoint templates we'll remember
// per family per minute. Path normalization already collapses :id-style
// segments so the natural cardinality is small (well under 20 in
// practice). The cap exists strictly as a defensive bound against a
// path-explosion attack — if a request flood includes pseudo-random
// path segments the normalizer doesn't recognize, we lose detail on
// the overflow but keep aggregate counts and bounded memory.
const MAX_ENDPOINTS_PER_FAMILY_PER_BUCKET = 50;
// Bucket key used to collapse overflow once the per-family endpoint
// map fills up. Surfaces in the UI as "(other)" so the operator knows
// they're seeing a roll-up rather than a real endpoint.
const OVERFLOW_ENDPOINT_KEY = "(other)";

// Number of distinct endpoints surfaced per family in the snapshot.
// The roll-up sums anything beyond this into "(other)" so the card
// stays readable even if a family touches dozens of routes.
const ENDPOINTS_PER_FAMILY_IN_SNAPSHOT = 8;

const buckets = new Map<number, Bucket>();

// Last successful instagram poll timestamp — surfaced separately
// because the operator cares about "when did this last actually run"
// in addition to the count today.
let lastInstagramPollAt: Date | null = null;

function nowMinute(): number {
  return Math.floor(Date.now() / MS_PER_MINUTE);
}

function getOrCreateBucket(minute: number): Bucket {
  let b = buckets.get(minute);
  if (!b) {
    b = {
      minute,
      ejoinPolls: 0,
      ejoinBytes: 0,
      smsOutbound: 0,
      instagramPolls: 0,
      http: new Map(),
    };
    buckets.set(minute, b);
    pruneOldBuckets(minute);
  }
  return b;
}

function pruneOldBuckets(currentMinute: number): void {
  const cutoff = currentMinute - RETAIN_BUCKETS;
  for (const m of buckets.keys()) {
    if (m < cutoff) buckets.delete(m);
  }
}

// Public route-family tags. Kept narrow on purpose — the operator
// wants "kitchen" vs "staff order taker" vs "admin", not a per-route
// breakdown. Anything we don't recognize lands in "public".
export type RouteFamily =
  | "kitchen-display"
  | "staff-order-taker"
  | "catering-admin"
  | "unmatched-messages"
  | "other-admin"
  | "public";

// Classify an inbound HTTP path into a coarse family. Path is the URL
// path without query string. The order matters: more specific admin
// branches must match before the catch-all "/admin" → other-admin.
export function classifyPath(path: string): RouteFamily {
  if (path.startsWith("/api/event-ordering")) return "kitchen-display";
  if (path.startsWith("/api/event-taker")) return "staff-order-taker";
  if (path.startsWith("/api/admin/catering")) return "catering-admin";
  if (path.startsWith("/api/admin/messages")) return "unmatched-messages";
  if (path.startsWith("/api/admin")) return "other-admin";
  return "public";
}

// Normalize a request path into a route template by replacing
// numeric and UUID segments with `:id`. Without this every order ID,
// inquiry ID, etc. would create its own bucket key — the per-endpoint
// breakdown would be useless ("123 hits to /orders/47, 87 to /orders/48,
// …") instead of useful ("210 hits to /orders/:id"). Done at record
// time so the in-memory map keys stay bounded.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function normalizePath(path: string): string {
  // Strip the leading "/api" since every entry has it; the per-endpoint
  // list inside a family is more readable without the redundant prefix.
  const trimmed = path.startsWith("/api") ? path.slice(4) : path;
  if (trimmed === "") return "/";
  return trimmed
    .split("/")
    .map((seg) => {
      if (seg === "") return seg;
      if (/^\d+$/.test(seg)) return ":id";
      if (UUID_RE.test(seg)) return ":id";
      return seg;
    })
    .join("/");
}

// ── Recorders ─────────────────────────────────────────────────────────────────

export function recordEjoinPoll(bytes: number): void {
  const b = getOrCreateBucket(nowMinute());
  b.ejoinPolls += 1;
  b.ejoinBytes += Math.max(0, Math.floor(bytes));
}

export function recordOutboundSms(): void {
  const b = getOrCreateBucket(nowMinute());
  b.smsOutbound += 1;
}

export function recordInstagramPoll(): void {
  const b = getOrCreateBucket(nowMinute());
  b.instagramPolls += 1;
  lastInstagramPollAt = new Date();
}

export function recordHttpRequest(family: RouteFamily, normalizedPath: string): void {
  const b = getOrCreateBucket(nowMinute());
  let perEndpoint = b.http.get(family);
  if (!perEndpoint) {
    perEndpoint = new Map();
    b.http.set(family, perEndpoint);
  }
  // Once the per-family endpoint map is full, lump further distinct
  // endpoints into the overflow key so a path-explosion attacker can't
  // grow this map indefinitely. Existing keys still increment normally.
  let key = normalizedPath;
  if (!perEndpoint.has(key) && perEndpoint.size >= MAX_ENDPOINTS_PER_FAMILY_PER_BUCKET) {
    key = OVERFLOW_ENDPOINT_KEY;
  }
  perEndpoint.set(key, (perEndpoint.get(key) ?? 0) + 1);
}

// ── Snapshot ──────────────────────────────────────────────────────────────────

export type IdleActivitySnapshot = {
  serverStartedAt: string;
  asOf: string;
  ejoinPolls: {
    // `avgBytesPerPoll` is a derived rolling average of response-body
    // size per poll inside the window. Surfaced separately (instead of
    // making the UI divide bytes/count) so the SMS-settings cadence
    // estimate ("~X MB/hour at this interval") and the operator's
    // measured-actual reading on this page stay perfectly comparable.
    // null when no polls landed in the window so the UI can render a
    // "no data yet" hint instead of NaN.
    lastHour: { count: number; bytes: number; avgBytesPerPoll: number | null };
    last24h: { count: number; bytes: number; avgBytesPerPoll: number | null };
  };
  outboundSms: {
    lastHour: number;
    last24h: number;
  };
  instagramPolls: {
    last24h: number;
    lastRunAt: string | null;
  };
  clientPolls: {
    windowMinutes: number;
    byFamily: Array<{
      family: RouteFamily;
      count: number;
      // Per-endpoint breakdown sorted by count (desc, ties broken
      // alphabetically). Endpoint keys are :id-normalized templates with
      // the "/api" prefix stripped. Empty for families with zero hits.
      // Truncated past ENDPOINTS_PER_FAMILY_IN_SNAPSHOT into a synthetic
      // "(other)" row so the card stays readable.
      endpoints: Array<{ path: string; count: number }>;
    }>;
  };
  // Operator-tunable poller status. Fed by the route handler from the
  // scheduler modules so the admin can confirm what's currently in
  // effect (toggle + interval) without leaving the Idle Activity page.
  smsPoller: {
    enabled: boolean;
    intervalSeconds: number;
    inboundMode: "push" | "poll";
  };
  instagramPoller: {
    enabled: boolean;
    intervalMinutes: number;
  };
};

// Sum buckets within `windowMinutes` of "now". Inclusive of the
// current minute because that's where new writes are landing.
function bucketsInWindow(windowMinutes: number): Bucket[] {
  const current = nowMinute();
  const cutoff = current - windowMinutes;
  const out: Bucket[] = [];
  for (const b of buckets.values()) {
    if (b.minute > cutoff && b.minute <= current) out.push(b);
  }
  return out;
}

// Caller passes in the live poller status because that data lives in
// the scheduler modules — keeping idle-metrics free of those imports
// avoids a circular-dep risk and keeps this file purely about the
// in-memory counters.
export type PollerStatusInput = {
  smsPoller: { enabled: boolean; intervalSeconds: number; inboundMode: "push" | "poll" };
  instagramPoller: { enabled: boolean; intervalMinutes: number };
};

export function snapshot(pollers: PollerStatusInput): IdleActivitySnapshot {
  const hourBuckets = bucketsInWindow(HOUR_MIN);
  const dayBuckets = bucketsInWindow(DAY_MIN);
  const httpBuckets = bucketsInWindow(HTTP_WINDOW_MIN);

  let ejoinPollsHour = 0, ejoinBytesHour = 0;
  for (const b of hourBuckets) {
    ejoinPollsHour += b.ejoinPolls;
    ejoinBytesHour += b.ejoinBytes;
  }
  let ejoinPollsDay = 0, ejoinBytesDay = 0, smsDay = 0, igDay = 0;
  for (const b of dayBuckets) {
    ejoinPollsDay += b.ejoinPolls;
    ejoinBytesDay += b.ejoinBytes;
    smsDay += b.smsOutbound;
    igDay += b.instagramPolls;
  }
  let smsHour = 0;
  for (const b of hourBuckets) smsHour += b.smsOutbound;

  // Roll up the HTTP map across the 5-minute window into per-family
  // totals AND a per-family per-endpoint breakdown. Families with zero
  // hits are still surfaced so the UI can render a consistent table;
  // their endpoints array is left empty.
  const FAMILIES: RouteFamily[] = [
    "kitchen-display",
    "staff-order-taker",
    "catering-admin",
    "unmatched-messages",
    "other-admin",
    "public",
  ];
  const perFamilyEndpoints = new Map<RouteFamily, Map<string, number>>();
  for (const fam of FAMILIES) perFamilyEndpoints.set(fam, new Map());
  for (const b of httpBuckets) {
    for (const [fam, endpoints] of b.http) {
      const target = perFamilyEndpoints.get(fam);
      if (!target) continue;
      for (const [path, n] of endpoints) {
        target.set(path, (target.get(path) ?? 0) + n);
      }
    }
  }
  const byFamily: Array<{
    family: RouteFamily;
    count: number;
    endpoints: Array<{ path: string; count: number }>;
  }> = [];
  for (const [family, endpoints] of perFamilyEndpoints) {
    let total = 0;
    for (const n of endpoints.values()) total += n;
    // Sort endpoints highest-count first; tie-break alphabetically so
    // ordering is stable between renders. Truncate past the snapshot
    // limit and roll the tail into "(other)" so the UI stays compact
    // even when a family touches many distinct routes.
    const sorted = Array.from(endpoints, ([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
    let trimmed: Array<{ path: string; count: number }>;
    if (sorted.length <= ENDPOINTS_PER_FAMILY_IN_SNAPSHOT) {
      trimmed = sorted;
    } else {
      trimmed = sorted.slice(0, ENDPOINTS_PER_FAMILY_IN_SNAPSHOT);
      let otherCount = 0;
      for (let i = ENDPOINTS_PER_FAMILY_IN_SNAPSHOT; i < sorted.length; i++) {
        otherCount += sorted[i].count;
      }
      if (otherCount > 0) trimmed.push({ path: OVERFLOW_ENDPOINT_KEY, count: otherCount });
    }
    byFamily.push({ family, count: total, endpoints: trimmed });
  }
  // Stable family ordering: highest first, then alphabetical so equal-
  // count families don't visually swap between renders.
  byFamily.sort((a, b) => b.count - a.count || a.family.localeCompare(b.family));

  // Round to whole bytes for stable display; we only ever surface this
  // as KB-precision in the UI so sub-byte fractions are noise.
  const avgHour = ejoinPollsHour > 0 ? Math.round(ejoinBytesHour / ejoinPollsHour) : null;
  const avgDay = ejoinPollsDay > 0 ? Math.round(ejoinBytesDay / ejoinPollsDay) : null;

  return {
    serverStartedAt: SERVER_STARTED_AT.toISOString(),
    asOf: new Date().toISOString(),
    ejoinPolls: {
      lastHour: { count: ejoinPollsHour, bytes: ejoinBytesHour, avgBytesPerPoll: avgHour },
      last24h: { count: ejoinPollsDay, bytes: ejoinBytesDay, avgBytesPerPoll: avgDay },
    },
    outboundSms: {
      lastHour: smsHour,
      last24h: smsDay,
    },
    instagramPolls: {
      last24h: igDay,
      lastRunAt: lastInstagramPollAt ? lastInstagramPollAt.toISOString() : null,
    },
    clientPolls: {
      windowMinutes: HTTP_WINDOW_MIN,
      byFamily,
    },
    smsPoller: pollers.smsPoller,
    instagramPoller: pollers.instagramPoller,
  };
}

// Test-only escape hatch so unit tests can drive the module through a
// known-clean state without restarting the process.
export function _resetIdleMetricsForTests(): void {
  buckets.clear();
  lastInstagramPollAt = null;
}

// Test-only accessor that exposes the internal Map size so the pruning
// contract ("buckets stay bounded after long simulated runs") can be
// asserted directly instead of inferred from snapshot output.
export function _getBucketCountForTests(): number {
  return buckets.size;
}
