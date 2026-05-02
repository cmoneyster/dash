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
// per metric per minute) and the snapshot loop simple.
type Bucket = {
  minute: number;
  ejoinPolls: number;
  ejoinBytes: number;
  smsOutbound: number;
  instagramPolls: number;
  http: Map<string, number>;
};

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

export function recordHttpRequest(family: RouteFamily): void {
  const b = getOrCreateBucket(nowMinute());
  b.http.set(family, (b.http.get(family) ?? 0) + 1);
}

// ── Snapshot ──────────────────────────────────────────────────────────────────

export type IdleActivitySnapshot = {
  serverStartedAt: string;
  asOf: string;
  ejoinPolls: {
    lastHour: { count: number; bytes: number };
    last24h: { count: number; bytes: number };
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
    byFamily: Array<{ family: RouteFamily; count: number }>;
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

export function snapshot(): IdleActivitySnapshot {
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

  // Roll up the HTTP map across the 5-minute window into a single
  // sorted array. Families with zero hits are still surfaced so the
  // UI can render a consistent table.
  const httpTotals = new Map<RouteFamily, number>([
    ["kitchen-display", 0],
    ["staff-order-taker", 0],
    ["catering-admin", 0],
    ["unmatched-messages", 0],
    ["other-admin", 0],
    ["public", 0],
  ]);
  for (const b of httpBuckets) {
    for (const [fam, n] of b.http) {
      httpTotals.set(fam as RouteFamily, (httpTotals.get(fam as RouteFamily) ?? 0) + n);
    }
  }
  const byFamily: Array<{ family: RouteFamily; count: number }> = [];
  for (const [family, count] of httpTotals) byFamily.push({ family, count });
  // Stable order: highest first, then alphabetical so equal-count
  // families don't visually swap between renders.
  byFamily.sort((a, b) => b.count - a.count || a.family.localeCompare(b.family));

  return {
    serverStartedAt: SERVER_STARTED_AT.toISOString(),
    asOf: new Date().toISOString(),
    ejoinPolls: {
      lastHour: { count: ejoinPollsHour, bytes: ejoinBytesHour },
      last24h: { count: ejoinPollsDay, bytes: ejoinBytesDay },
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
  };
}

// Test-only escape hatch so unit tests can drive the module through a
// known-clean state without restarting the process.
export function _resetIdleMetricsForTests(): void {
  buckets.clear();
  lastInstagramPollAt = null;
}
