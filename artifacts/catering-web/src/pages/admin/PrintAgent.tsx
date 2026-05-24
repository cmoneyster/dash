import { useState } from "react";
import { Wifi, WifiOff, Loader2, CheckCircle2, XCircle, Network, Info } from "lucide-react";
import { AdminLayout } from "@/components/AdminLayout";
import { usePrintAgent, type AgentJobResult } from "@/hooks/usePrintAgent";

function StatusBadge({ status }: { status: string }) {
  if (status === "idle") return (
    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-green-100 dark:bg-green-950/40 text-green-800 dark:text-green-300 text-sm font-medium">
      <Wifi className="w-4 h-4" /> Active — waiting for jobs
    </span>
  );
  if (status === "polling") return (
    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-100 dark:bg-blue-950/40 text-blue-800 dark:text-blue-300 text-sm font-medium">
      <Loader2 className="w-4 h-4 animate-spin" /> Checking queue…
    </span>
  );
  if (status === "delivering") return (
    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-100 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 text-sm font-medium">
      <Loader2 className="w-4 h-4 animate-spin" /> Delivering…
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-red-100 dark:bg-red-950/40 text-red-800 dark:text-red-300 text-sm font-medium">
      <WifiOff className="w-4 h-4" /> Error
    </span>
  );
}

function JobRow({ r }: { r: AgentJobResult }) {
  return (
    <div className="flex items-center gap-3 py-2.5 border-b last:border-0">
      {r.ok
        ? <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400 shrink-0" />
        : <XCircle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0" />}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">
          Job #{r.jobId} · {r.jobType}
          <span className="ml-2 text-xs text-slate-500 dark:text-slate-400 font-normal">→ {r.lanIp}</span>
        </div>
        {r.error && (
          <div className="text-xs text-red-600 dark:text-red-400 mt-0.5 truncate">{r.error}</div>
        )}
      </div>
      <div className="text-xs text-slate-500 dark:text-slate-400 shrink-0">
        {r.deliveredAt.toLocaleTimeString()}
      </div>
    </div>
  );
}

export default function PrintAgent() {
  const [enabled, setEnabled] = useState(true);
  const agent = usePrintAgent({ enabled });

  return (
    <AdminLayout>
      <div className="max-w-2xl mx-auto p-4 sm:p-6 space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Network className="w-6 h-6" /> LAN Print Agent
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
              Keep this page open on a device connected to your printer's local network.
            </p>
          </div>
          <button
            onClick={() => setEnabled(e => !e)}
            className={`px-4 py-2 rounded-xl font-medium text-sm transition-colors ${
              enabled
                ? "bg-red-100 dark:bg-red-950/40 text-red-800 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-900/40"
                : "bg-green-100 dark:bg-green-950/40 text-green-800 dark:text-green-300 hover:bg-green-200 dark:hover:bg-green-900/40"
            }`}
          >
            {enabled ? "Pause agent" : "Resume agent"}
          </button>
        </div>

        {/* Status card */}
        <div className="bg-card border rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <StatusBadge status={enabled ? agent.status : "idle"} />
            <div className="flex items-center gap-4 text-sm text-slate-600 dark:text-slate-400">
              <span className="text-green-700 dark:text-green-400 font-medium">{agent.successCount} delivered</span>
              {agent.failCount > 0 && (
                <span className="text-red-700 dark:text-red-400 font-medium">{agent.failCount} failed</span>
              )}
            </div>
          </div>
          {agent.lastError && (
            <div className="text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/50 rounded-xl p-3 flex items-start gap-2">
              <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{agent.lastError}</span>
            </div>
          )}
        </div>

        {/* Setup instructions */}
        <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800/40 rounded-2xl p-4">
          <div className="flex items-start gap-3">
            <Info className="w-5 h-5 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
            <div className="text-sm text-blue-900 dark:text-blue-200 space-y-2">
              <p className="font-semibold">One-time setup per browser</p>
              <p>
                Star printers use HTTPS with a self-signed certificate. Before the agent
                can deliver to a printer, visit{" "}
                <code className="bg-blue-100 dark:bg-blue-900/50 px-1 rounded text-xs">
                  https://&lt;printer-ip&gt;/StarWebPRNT/SendMessage
                </code>{" "}
                in this browser and accept the security warning. You only need to do this once per browser.
              </p>
              <p>
                Printer IP addresses are configured in{" "}
                <a href="/admin/printers" className="underline font-medium">Admin → Printers</a>.
                Set the printer's <strong>Print mode</strong> to{" "}
                <em>LAN browser only</em> or <em>CloudPRNT + LAN fallback</em>.
              </p>
            </div>
          </div>
        </div>

        {/* Delivery history */}
        <div className="bg-card border rounded-2xl overflow-hidden">
          <div className="p-4 border-b">
            <h2 className="font-semibold">Delivery history</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Most recent 20 jobs this session</p>
          </div>
          {agent.history.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
              No deliveries yet. Jobs will appear here as they are delivered.
            </div>
          ) : (
            <div className="px-4 divide-y">
              {agent.history.map((r, i) => (
                <JobRow key={`${r.jobId}-${i}`} r={r} />
              ))}
            </div>
          )}
        </div>
      </div>
    </AdminLayout>
  );
}
