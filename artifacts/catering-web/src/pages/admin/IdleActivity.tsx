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
  title: string;
  icon: any;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-card p-6 rounded-2xl border border-border shadow-sm">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
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

export default function IdleActivity() {
  // Auto-refresh once a minute so the operator sees fresh numbers
  // without leaning on the button. Manual refresh stays available
  // for impatient cycles. We deliberately don't use Server-Sent
  // Events here — the data is cheap to recompute and the operator
  // looks at this page for seconds, not minutes.
  const { data, isLoading, isFetching, refetch, error } = useGetAdminIdleActivity({
    query: {
      queryKey: getGetAdminIdleActivityQueryKey(),
      refetchInterval: 60_000,
      refetchOnWindowFocus: true,
    },
  });

  return (
    <AdminLayout>
      <div className="mb-8 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display font-bold text-4xl mb-2">Idle Activity</h1>
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
        <div className="mb-6 p-4 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">
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
              <Row label="Last hour (count)" value={data.ejoinPolls.lastHour.count.toLocaleString()} />
              <Row label="Last hour (bytes)" value={formatBytes(data.ejoinPolls.lastHour.bytes)} />
              <Row label="Last 24h (count)" value={data.ejoinPolls.last24h.count.toLocaleString()} />
              <Row label="Last 24h (bytes)" value={formatBytes(data.ejoinPolls.last24h.bytes)} />
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

            <Card title={`Client HTTP Polls (last ${data.clientPolls.windowMinutes} min)`} icon={Globe}>
              {data.clientPolls.byFamily.map((f) => (
                <Row
                  key={f.family}
                  label={FAMILY_LABELS[f.family] ?? f.family}
                  value={f.count.toLocaleString()}
                />
              ))}
              <p className="text-xs text-muted-foreground pt-2">
                Counts every request that reached the API, grouped by the page
                family that probably issued it. The dashboard's own polling is
                excluded.
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
