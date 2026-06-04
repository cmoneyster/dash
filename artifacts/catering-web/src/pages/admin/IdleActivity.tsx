import { useState } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import {
  useGetAdminIdleActivity,
  getGetAdminIdleActivityQueryKey,
} from "@workspace/api-client-react";
import { Activity, MessageSquare, Instagram, Globe, RefreshCw } from "lucide-react";

// Names for the route families the server reports back. Kept here so
// the page can render a friendly label even if the server adds new
// families later (unknown ones fall back to the raw key).
const FAMILY_LABELS: Record<string, string> = {
  "kitchen-display": "Kitchen Display",
  "staff-order-taker": "Staff Order Taker",
  "catering-admin": "Catering Admin",
  "unmatched-messages": "Unmatched Messages",
  "other-admin": "Other Admin",
  "public": "Public Site",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// Per-hour bandwidth label so the operator can compare the SmsSettings
// "estimated MB/hour at this interval" estimate side-by-side with the
// real measurement here. Uses decimal-SI units (1000-based) to match
// telecom-data-plan accounting and the units used by the SmsSettings
// estimate widget; the absolute-bytes display above intentionally
// keeps binary units (KB = 1024) since those are byte counts, not
// data-plan sizes.
function formatBytesPerHour(bytesPerHour: number): string {
  if (bytesPerHour < 1000) return `${Math.round(bytesPerHour)} B/hour`;
  if (bytesPerHour < 1_000_000) return `${(bytesPerHour / 1000).toFixed(1)} KB/hour`;
  return `${(bytesPerHour / 1_000_000).toFixed(2)} MB/hour`;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function formatAbsolute(iso: string): string {
  return new Date(iso).toLocaleString();
}

function Card({
  title,
  icon: Icon,
  children,
}: {
  title: React.ReactNode;
  icon: any;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-card p-6 rounded-2xl border border-border shadow-sm">
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary shrink-0">
          <Icon className="w-5 h-5" />
        </div>
        <h3 className="font-bold text-base">{title}</h3>
      </div>
      <div className="space-y-3 text-sm">{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between items-baseline gap-4 border-b border-border/50 pb-2 last:border-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-semibold text-foreground tabular-nums">{value}</span>
    </div>
  );
}

type WindowKey = "last5min" | "lastHour" | "last24h";

const WINDOW_OPTIONS: { key: WindowKey; label: string; title: string }[] = [
  { key: "last5min", label: "5 min",    title: "last 5 min" },
  { key: "lastHour", label: "1 hour",   title: "last hour" },
  { key: "last24h",  label: "24 hours", title: "last 24 hours" },
];

export default function IdleActivity() {
  // Auto-refresh once a minute so the operator sees fresh numbers
  // without leaning on the button. Manual refresh stays available
  // for impatient cycles. Window-focus refetches are intentionally
  // disabled so polling truly stays at one request per minute even
  // when the operator clicks between tabs. We deliberately don't
  // use Server-Sent Events here — the data is cheap to recompute
  // and the operator looks at this page for seconds, not minutes.
  const { data, isLoading, isFetching, refetch, error } = useGetAdminIdleActivity({
    query: {
      queryKey: getGetAdminIdleActivityQueryKey(),
      refetchInterval: 60_000,
      refetchOnWindowFocus: false,
    },
  });

  // Which time window to show in the Client HTTP Polls card.
  // All three datasets arrive in every poll response so switching is
  // instant — no extra network request needed.
  const [pollWindow, setPollWindow] = useState<WindowKey>("last5min");

  return (
    <AdminLayout>
      <div className="mb-8 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display font-bold text-2xl sm:text-4xl mb-2">Idle Activity</h1>
          <p className="text-muted-foreground max-w-2xl">
            Background traffic counters for the API server. Useful for confirming the
            SIM gateway and Instagram pollers are still cycling and for spotting
            unexpected load when no one is using the site. Counters live in memory
            and reset whenever the server restarts.
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-primary text-primary-foreground font-medium text-sm disabled:opacity-60 hover:opacity-90 transition-opacity"
        >
          <RefreshCw className={isFetching ? "w-4 h-4 animate-spin" : "w-4 h-4"} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-6 p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/50 text-red-700 dark:text-red-400 text-sm">
          Failed to load idle activity. Try refreshing.
        </div>
      )}

      {isLoading && !data && (
        <p className="text-muted-foreground text-sm">Loading…</p>
      )}

      {data && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
            <Card title="SIM Gateway Polls" icon={Activity}>
              <Row
                label="Status"
                value={
                  data.smsPoller.enabled
                    ? `polling every ${data.smsPoller.intervalSeconds}s`
                    : "polling paused"
                }
              />
              <Row label="Inbound mode" value={data.smsPoller.inboundMode} />
              <Row label="Gateway fetches (last hour)" value={data.ejoinPolls.lastHour.count.toLocaleString()} />
              {/*
                Actual measured bandwidth over the trailing 60 minutes.
                Bytes accumulated in the last hour ARE the per-hour
                rate, so we render it with the same MB/hour format the
                SMS Settings cadence card uses for its estimate. This
                is the apples-to-apples "estimate vs reality"
                comparison: if the estimate says ~8.6 MB/hour at 3 s
                cadence and this says ~9 MB/hour, the operator knows
                the estimate is honest. Includes both the listing
                fetch and any per-port detail fetches escalation
                triggered, since both are real round-trips to the
                gateway.
              */}
              <Row
                label="Last hour usage"
                value={`${formatBytes(data.ejoinPolls.lastHour.bytes)} ≈ ${formatBytesPerHour(
                  data.ejoinPolls.lastHour.bytes,
                )}`}
              />
              {/*
                Per-fetch average is a secondary detail — useful for
                comparing against the ~7 KB/poll baseline the SMS
                Settings estimate is calibrated on, and for spotting
                response-size growth (e.g. a SIM message backlog
                inflating the listing payload). "Per fetch" not "per
                cycle": each escalated cycle counts as 2 fetches
                (listing + per-port detail), and admin-triggered
                backfill fetches contribute too, so this number is
                strictly per HTTP request to the gateway.
              */}
              <Row
                label="Avg per gateway fetch (last hour)"
                value={
                  data.ejoinPolls.lastHour.avgBytesPerPoll == null
                    ? "no data yet"
                    : formatBytes(data.ejoinPolls.lastHour.avgBytesPerPoll)
                }
              />
              <Row label="Gateway fetches (last 24h)" value={data.ejoinPolls.last24h.count.toLocaleString()} />
              <Row label="Last 24h usage" value={formatBytes(data.ejoinPolls.last24h.bytes)} />
              <p className="text-xs text-muted-foreground pt-2">
                Counts every HTTP request to the SIM gateway — steady-state
                polls, escalated per-port detail fetches, and admin-triggered
                backfill — so totals reflect real bandwidth. Compare "Last
                hour usage" to the estimated MB/hour on the SMS Settings
                cadence card.
              </p>
            </Card>

            <Card title="Outbound SMS" icon={MessageSquare}>
              <Row label="Last hour" value={data.outboundSms.lastHour.toLocaleString()} />
              <Row label="Last 24h" value={data.outboundSms.last24h.toLocaleString()} />
              <p className="text-xs text-muted-foreground pt-2">
                Counted only on real dispatch. Sends suppressed by shadow mode are
                excluded so the totals match what actually left the gateway.
              </p>
            </Card>

            <Card title="Instagram Poller" icon={Instagram}>
              <Row
                label="Status"
                value={
                  data.instagramPoller.enabled
                    ? `polling every ${data.instagramPoller.intervalMinutes} min`
                    : "polling paused"
                }
              />
              <Row label="Cycles in last 24h" value={data.instagramPolls.last24h.toLocaleString()} />
              <Row
                label="Last cycle"
                value={
                  data.instagramPolls.lastRunAt
                    ? `${formatRelative(data.instagramPolls.lastRunAt)} (${formatAbsolute(data.instagramPolls.lastRunAt)})`
                    : "never (since restart)"
                }
              />
            </Card>

            {/* Client HTTP Polls card — title row embeds the window toggle */}
            <Card
              icon={Globe}
              title={
                <span className="flex items-center gap-3 flex-wrap">
                  <span>
                    Client HTTP Polls{" "}
                    <span className="font-normal text-muted-foreground">
                      — {WINDOW_OPTIONS.find((o) => o.key === pollWindow)?.title}
                    </span>
                  </span>
                  {/* Segmented toggle: switching is instant because all three
                      window datasets arrive in every single poll response. */}
                  <span className="flex rounded-lg border border-border overflow-hidden text-xs font-normal">
                    {WINDOW_OPTIONS.map((opt) => (
                      <button
                        key={opt.key}
                        onClick={(e) => { e.stopPropagation(); setPollWindow(opt.key); }}
                        className={`px-2.5 py-1 transition-colors ${
                          pollWindow === opt.key
                            ? "bg-primary text-primary-foreground"
                            : "bg-background text-muted-foreground hover:bg-muted"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </span>
                </span>
              }
            >
              {data.clientPolls[pollWindow].map((f) => (
                <div
                  key={f.family}
                  className="border-b border-border/50 pb-2 last:border-0 last:pb-0"
                >
                  {/*
                    Family-level total stays on the same flex row as the
                    label so the existing visual rhythm of the card is
                    preserved. The endpoint sub-list below is collapsed
                    away entirely when there are zero hits or zero
                    endpoints (e.g. families with no traffic) so empty
                    families render exactly as before.
                  */}
                  <div className="flex justify-between items-baseline gap-4">
                    <span className="text-muted-foreground">
                      {FAMILY_LABELS[f.family] ?? f.family}
                    </span>
                    <span className="font-mono font-semibold text-foreground tabular-nums">
                      {f.count.toLocaleString()}
                    </span>
                  </div>
                  {f.endpoints.length > 0 && (
                    <ul className="mt-1.5 ml-3 space-y-0.5">
                      {f.endpoints.map((ep) => (
                        <li
                          key={ep.path}
                          className="flex justify-between items-baseline gap-4 text-xs"
                        >
                          {/*
                            Endpoint paths are :id-normalized templates
                            with the /api prefix stripped server-side
                            (e.g. /event-taker/orders/:id/payment).
                            We render them in mono so the route shape
                            reads cleanly and word-break so a long path
                            wraps inside the card instead of overflowing.
                          */}
                          <span className="font-mono text-muted-foreground/80 break-all">
                            {ep.path}
                          </span>
                          <span className="font-mono text-muted-foreground tabular-nums">
                            {ep.count.toLocaleString()}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
              <p className="text-xs text-muted-foreground pt-2">
                Counts every request that reached the API, grouped by the page
                family that probably issued it and broken down by route. Numeric
                IDs are folded together (e.g.{" "}
                <span className="font-mono">/orders/:id</span> covers every
                order). Showing the{" "}
                <span className="font-medium">
                  {WINDOW_OPTIONS.find((o) => o.key === pollWindow)?.title}
                </span>{" "}
                window — use the toggle above to switch. This page's own
                polling for these counters is excluded; the sidebar's badge
                polling on every admin page is not.
              </p>
            </Card>
          </div>

          <div className="text-xs text-muted-foreground text-center">
            Server started {formatRelative(data.serverStartedAt)} ({formatAbsolute(data.serverStartedAt)}).
            Snapshot taken {formatRelative(data.asOf)}.
          </div>
        </>
      )}
    </AdminLayout>
  );
}
