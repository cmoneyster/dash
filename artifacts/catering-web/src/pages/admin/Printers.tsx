import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListPrinters,
  useCreatePrinter,
  useUpdatePrinter,
  useDeletePrinter,
  useTestPrintPrinter,
  useTestLanPrinter,
  useListPrintJobs,
  useRetryPrintJob,
  getListPrintersQueryKey,
  getListPrintJobsQueryKey,
  CreatePrinterBodyPrintMode,
  type Printer,
  type CreatePrinterBody,
  type PrintJob,
  type TestLanResult,
} from "@workspace/api-client-react";
import { useForm } from "react-hook-form";
import { Printer as PrinterIcon, Plus, Trash2, Pencil, Wifi, WifiOff, AlertTriangle, Copy, Check, RefreshCw, X, Eye, XCircle, Network } from "lucide-react";
import { AdminLayout } from "@/components/AdminLayout";
import { getAdminToken } from "@/components/AdminGuard";

const PRINT_MODE_LABELS: Record<string, string> = {
  cloudprnt: "CloudPRNT only",
  lan_browser: "LAN browser only",
  cloudprnt_lan_fallback: "CloudPRNT + LAN fallback",
};

function PrintModeBadge({ mode }: { mode: string }) {
  const cls =
    mode === "lan_browser"
      ? "bg-indigo-50 dark:bg-indigo-950/40 text-indigo-800 dark:text-indigo-300"
      : mode === "cloudprnt_lan_fallback"
      ? "bg-blue-50 dark:bg-blue-950/40 text-blue-800 dark:text-blue-300"
      : "bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300";
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${cls}`}>
      {PRINT_MODE_LABELS[mode] ?? mode}
    </span>
  );
}

function StatusPill({ p }: { p: Printer }) {
  if (!p.enabled) return <span className="px-2 py-0.5 rounded-full text-[11px] bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300">disabled</span>;
  const map: Record<string, { cls: string; label: string; icon?: typeof Wifi }> = {
    online:   { cls: "bg-green-100 dark:bg-green-950/40 text-green-800 dark:text-green-300", label: "online", icon: Wifi },
    offline:  { cls: "bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300", label: "offline", icon: WifiOff },
    error:    { cls: "bg-red-100 dark:bg-red-950/40 text-red-800 dark:text-red-300", label: "error", icon: AlertTriangle },
    disabled: { cls: "bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300", label: "disabled" },
  };
  const cfg = map[p.status] ?? map.offline;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${cfg.cls}`}>
      {Icon && <Icon className="w-3 h-3" />}
      {cfg.label}
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300"
    >
      {copied ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function relTime(iso: string | Date | null | undefined) {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  const ms = Date.now() - t;
  if (ms < 5_000) return "just now";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return new Date(iso).toLocaleString();
}

type PrinterFormValues = CreatePrinterBody & { id?: number };

function PrinterDialog({
  open,
  initial,
  onClose,
}: {
  open: boolean;
  initial: Printer | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const create = useCreatePrinter({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getListPrintersQueryKey() }) },
  });
  const update = useUpdatePrinter({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getListPrintersQueryKey() }) },
  });
  const { register, handleSubmit, reset, watch } = useForm<PrinterFormValues>({
    defaultValues: initial ?? {
      name: "",
      model: "TSP143IV",
      lanIp: "",
      location: "",
      printsKitchenTicket: true,
      printsCustomerReceipt: false,
      printsItemLabels: false,
      autoPrintOnNewOrder: true,
      printMode: CreatePrinterBodyPrintMode.cloudprnt,
      suppressItemLabelsForPlateLines: true,
      enabled: true,
    },
  });

  const printMode = watch("printMode" as keyof PrinterFormValues);
  const needsLanIp = printMode === "lan_browser" || printMode === "cloudprnt_lan_fallback";

  if (!open) return null;

  const onSubmit = handleSubmit(async (values) => {
    const body: CreatePrinterBody = {
      name: values.name,
      model: values.model || "TSP143IV",
      lanIp: values.lanIp || null,
      location: values.location || null,
      printsKitchenTicket: !!values.printsKitchenTicket,
      printsCustomerReceipt: !!values.printsCustomerReceipt,
      printsItemLabels: !!values.printsItemLabels,
      autoPrintOnNewOrder: !!values.autoPrintOnNewOrder,
      printMode: values.printMode ?? CreatePrinterBodyPrintMode.cloudprnt,
      suppressItemLabelsForPlateLines: !!values.suppressItemLabelsForPlateLines,
      enabled: !!values.enabled,
    };
    if (initial) {
      await update.mutateAsync({ id: initial.id, data: body });
    } else {
      await create.mutateAsync({ data: body });
    }
    reset();
    onClose();
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-card rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="font-semibold text-lg">{initial ? "Edit printer" : "Add printer"}</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={onSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Name</label>
            <input {...register("name", { required: true })} className="w-full px-3 py-2 border rounded-xl bg-background" placeholder="Trailer Kitchen" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Model</label>
              <select {...register("model")} className="w-full px-3 py-2 border rounded-xl bg-background">
                <option value="TSP143IV">TSP143IV</option>
                <option value="TSP100IV">TSP100IV</option>
                <option value="TSP650II">TSP650II</option>
                <option value="TSP700II">TSP700II</option>
                <option value="TSP800II">TSP800II</option>
                <option value="mC-Print3">mC-Print3</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Location</label>
              <input {...register("location")} className="w-full px-3 py-2 border rounded-xl bg-background" placeholder="Prep window" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Print mode</label>
            <select {...register("printMode" as keyof PrinterFormValues)} className="w-full px-3 py-2 border rounded-xl bg-background">
              <option value="cloudprnt">CloudPRNT only — printer polls the server directly</option>
              <option value="lan_browser">LAN browser only — browser agent delivers via WebPRNT</option>
              <option value="cloudprnt_lan_fallback">CloudPRNT + LAN fallback — agent picks up stale jobs</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              LAN IP
              {needsLanIp && <span className="text-red-500 ml-1">*</span>}
              <span className="text-xs text-muted-foreground ml-2">required for LAN delivery modes</span>
            </label>
            <input
              {...register("lanIp")}
              className="w-full px-3 py-2 border rounded-xl bg-background"
              placeholder="192.168.1.50"
            />
          </div>

          <div className="space-y-2 p-3 bg-muted/50 rounded-xl border">
            <p className="text-sm font-semibold">What does this printer print?</p>
            <label className="flex items-center gap-2 text-sm">
              <input {...register("printsKitchenTicket")} type="checkbox" className="w-4 h-4" /> Kitchen tickets
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input {...register("printsCustomerReceipt")} type="checkbox" className="w-4 h-4" /> Customer receipts
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input {...register("printsItemLabels")} type="checkbox" className="w-4 h-4" /> Individual item labels
            </label>
          </div>

          <div className="space-y-2 p-3 bg-muted/50 rounded-xl border">
            <p className="text-sm font-semibold">Behavior</p>
            <label className="flex items-center gap-2 text-sm">
              <input {...register("autoPrintOnNewOrder")} type="checkbox" className="w-4 h-4" /> Auto-print when a new order arrives
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input {...register("suppressItemLabelsForPlateLines")} type="checkbox" className="w-4 h-4" /> Skip item labels for items already on plates
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input {...register("enabled")} type="checkbox" className="w-4 h-4" /> Enabled
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl bg-muted hover:bg-muted/80">Cancel</button>
            <button type="submit" disabled={create.isPending || update.isPending} className="px-4 py-2 rounded-xl bg-primary text-primary-foreground font-medium disabled:opacity-60">
              {initial ? "Save changes" : "Add printer"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

type LanTestState = { phase: "idle" } | { phase: "pending" } | { phase: "queued"; jobId: number } | { phase: "done"; ok: boolean; message: string };

function PrinterCard({ p }: { p: Printer }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [lanTest, setLanTest] = useState<LanTestState>({ phase: "idle" });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const del = useDeletePrinter({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getListPrintersQueryKey() }) },
  });
  const test = useTestPrintPrinter({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getListPrintJobsQueryKey() }) },
  });
  const testLan = useTestLanPrinter({
    mutation: {
      onSuccess: (data: TestLanResult) => {
        if (data.jobId) {
          setLanTest({ phase: "queued", jobId: data.jobId });
          startPolling(data.jobId);
        } else {
          setLanTest({ phase: "done", ok: true, message: "Job queued" });
          setTimeout(() => setLanTest({ phase: "idle" }), 5000);
        }
      },
      onError: (err: unknown) => {
        const msg = err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : "Failed to queue test";
        setLanTest({ phase: "done", ok: false, message: msg });
        setTimeout(() => setLanTest({ phase: "idle" }), 6000);
      },
    },
  });

  function startPolling(jobId: number) {
    const token = getAdminToken();
    const deadline = Date.now() + 15_000;
    pollRef.current = setInterval(async () => {
      if (Date.now() > deadline) {
        stopPolling();
        setLanTest({ phase: "done", ok: false, message: "Timeout — is the Print Agent running on a device on this network?" });
        setTimeout(() => setLanTest({ phase: "idle" }), 8000);
        return;
      }
      try {
        const res = await fetch(`/api/print-agent/jobs/${jobId}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) return;
        const job = await res.json() as { status: string; error?: string | null; deliveredVia?: string | null };
        if (job.status === "printed") {
          stopPolling();
          setLanTest({ phase: "done", ok: true, message: `Printed via ${job.deliveredVia ?? "lan_browser"}` });
          setTimeout(() => setLanTest({ phase: "idle" }), 5000);
        } else if (job.status === "failed") {
          stopPolling();
          setLanTest({ phase: "done", ok: false, message: job.error ?? "Print failed" });
          setTimeout(() => setLanTest({ phase: "idle" }), 6000);
        }
      } catch { /* silent */ }
    }, 2000);
  }

  function stopPolling() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  const cloudprntUrl = `${window.location.origin}/api/cloudprnt/${p.cloudprntToken}`;
  const printMode = (p as unknown as Record<string, unknown>).printMode as string ?? "cloudprnt";
  const showCloudPrntUrl = printMode !== "lan_browser";

  const outputs: string[] = [];
  if (p.printsKitchenTicket) outputs.push("Kitchen");
  if (p.printsCustomerReceipt) outputs.push("Receipts");
  if (p.printsItemLabels) outputs.push("Item labels");

  return (
    <div className="bg-card rounded-2xl border p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-muted rounded-xl"><PrinterIcon className="w-5 h-5 text-muted-foreground" /></div>
          <div>
            <div className="font-semibold flex items-center gap-2">
              {p.name} <StatusPill p={p} />
            </div>
            <div className="text-xs text-muted-foreground">
              {p.model}{p.location ? ` · ${p.location}` : ""}{p.lanIp ? ` · ${p.lanIp}` : ""}
            </div>
            <div className="text-xs text-muted-foreground/70 mt-0.5">
              Last polled {relTime(p.lastPolledAt as unknown as string | null)}
              {p.lastError ? ` · ${p.lastError}` : ""}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setEditing(true)} className="p-2 rounded-lg hover:bg-muted" title="Edit"><Pencil className="w-4 h-4" /></button>
          <button
            onClick={() => { if (confirm(`Delete printer "${p.name}"?`)) del.mutate({ id: p.id }, { onSuccess: () => qc.invalidateQueries({ queryKey: getListPrintersQueryKey() }) }); }}
            className="p-2 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/40 text-red-700 dark:text-red-400"
            title="Delete"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1">
        {outputs.length === 0
          ? <span className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 rounded-full">No output toggles enabled</span>
          : outputs.map((o) => <span key={o} className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded-full">{o}</span>)}
        {p.autoPrintOnNewOrder && <span className="text-xs bg-green-50 dark:bg-green-950/40 text-green-800 dark:text-green-300 px-2 py-0.5 rounded-full">Auto-print</span>}
        <PrintModeBadge mode={printMode} />
      </div>

      {showCloudPrntUrl && (
        <div className="mt-3 p-2 bg-muted/50 rounded-lg flex items-center justify-between gap-2">
          <div className="text-[11px] text-muted-foreground break-all">
            <span className="font-medium">CloudPRNT URL:</span>{" "}
            <span className="font-mono">{cloudprntUrl}</span>
          </div>
          <CopyButton text={cloudprntUrl} />
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={() => test.mutate({ id: p.id, data: { jobType: "test" } })}
          disabled={test.isPending}
          className="text-xs px-3 py-1.5 rounded-lg bg-foreground text-background hover:opacity-90 disabled:opacity-60"
        >Test page</button>
        <button
          onClick={() => test.mutate({ id: p.id, data: { jobType: "kitchen_ticket" } })}
          disabled={test.isPending}
          className="text-xs px-3 py-1.5 rounded-lg bg-muted hover:bg-muted/80"
        >Test kitchen ticket</button>
        <button
          onClick={() => test.mutate({ id: p.id, data: { jobType: "customer_receipt" } })}
          disabled={test.isPending}
          className="text-xs px-3 py-1.5 rounded-lg bg-muted hover:bg-muted/80"
        >Test receipt</button>
        <button
          onClick={() => test.mutate({ id: p.id, data: { jobType: "item_label" } })}
          disabled={test.isPending}
          className="text-xs px-3 py-1.5 rounded-lg bg-muted hover:bg-muted/80"
        >Test label</button>
        {p.lanIp && (
          <button
            onClick={() => { setLanTest({ phase: "pending" }); testLan.mutate({ id: p.id }); }}
            disabled={testLan.isPending || lanTest.phase === "queued"}
            className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60 inline-flex items-center gap-1.5"
            title={`Queue a test job for LAN delivery to ${p.lanIp}`}
          >
            <Network className="w-3 h-3" />
            {lanTest.phase === "queued" ? "Waiting for agent…" : lanTest.phase === "pending" ? "Queuing…" : "Test via LAN"}
          </button>
        )}
      </div>

      {lanTest.phase === "done" && (
        <div className={`mt-2 text-xs px-3 py-2 rounded-lg flex items-center gap-2 ${
          lanTest.ok
            ? "bg-green-50 dark:bg-green-950/40 text-green-800 dark:text-green-300"
            : "bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-300"
        }`}>
          {lanTest.ok
            ? <Check className="w-3.5 h-3.5 shrink-0" />
            : <XCircle className="w-3.5 h-3.5 shrink-0" />}
          {lanTest.ok ? "Printed via LAN agent — " : "LAN error — "}
          <span>{lanTest.message}</span>
        </div>
      )}
      {lanTest.phase === "queued" && (
        <div className="mt-2 text-xs px-3 py-2 rounded-lg flex items-center gap-2 bg-blue-50 dark:bg-blue-950/40 text-blue-800 dark:text-blue-300">
          <Network className="w-3.5 h-3.5 shrink-0 animate-pulse" />
          Test job #{lanTest.jobId} queued — waiting for the LAN Print Agent to deliver it…
          {" "}<a href="/admin/print-agent" className="underline font-medium">Open agent</a>
        </div>
      )}

      <PrinterDialog open={editing} initial={p} onClose={() => setEditing(false)} />
    </div>
  );
}

function PreviewModal({ jobId, onClose }: { jobId: number; onClose: () => void }) {
  const [state, setState] = useState<{
    loading: boolean;
    text?: string;
    jobType?: string;
    status?: string;
    error?: string;
  }>({ loading: true });

  useEffect(() => {
    const token = getAdminToken();
    fetch(`/api/admin/print-jobs/${jobId}/preview`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(r => r.json())
      .then((d: { text: string; jobType: string; status: string }) =>
        setState({ loading: false, text: d.text, jobType: d.jobType, status: d.status }),
      )
      .catch(() => setState({ loading: false, error: "Failed to load preview" }));
  }, [jobId]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card rounded-2xl shadow-xl w-full max-w-sm max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <p className="font-semibold text-sm">Job #{jobId} preview</p>
            {state.jobType && (
              <p className="text-xs text-muted-foreground">
                {state.jobType}
                {state.status ? ` · ${state.status}` : ""}
              </p>
            )}
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {state.loading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {state.error && <p className="text-sm text-red-600">{state.error}</p>}
          {state.text !== undefined && (
            <pre className="font-mono text-[11px] leading-snug whitespace-pre bg-muted/50 border rounded-xl p-4 overflow-x-auto">
              {state.text || "(empty)"}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function PrintJobsPanel() {
  const { data: jobs = [], refetch } = useListPrintJobs({ limit: 50 }, {
    query: {
      queryKey: getListPrintJobsQueryKey({ limit: 50 }),
      refetchInterval: 30_000,
      refetchIntervalInBackground: false,
    },
  });
  const qc = useQueryClient();
  const retry = useRetryPrintJob({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getListPrintJobsQueryKey() }) },
  });
  const [previewJobId, setPreviewJobId] = useState<number | null>(null);
  const [canceling, setCanceling] = useState<number | null>(null);

  async function handleCancel(id: number) {
    setCanceling(id);
    try {
      const token = getAdminToken();
      await fetch(`/api/admin/print-jobs/${id}`, {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      await qc.invalidateQueries({ queryKey: getListPrintJobsQueryKey() });
    } finally {
      setCanceling(null);
    }
  }

  return (
    <>
      {previewJobId !== null && (
        <PreviewModal jobId={previewJobId} onClose={() => setPreviewJobId(null)} />
      )}
      <div className="bg-card rounded-2xl border shadow-sm">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="font-semibold">Recent print jobs</h2>
          <button onClick={() => refetch()} className="p-1.5 rounded-lg hover:bg-muted" title="Refresh"><RefreshCw className="w-4 h-4" /></button>
        </div>
        {jobs.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">No jobs yet. Send a test print to see them here.</div>
        ) : (
          <div className="divide-y">
            {(jobs as PrintJob[]).map((j) => (
              <div key={j.id} className="p-3 flex items-center justify-between gap-3 text-sm">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-[11px] text-muted-foreground">#{j.id}</span>
                    <span className="font-medium">{j.jobType}</span>
                    <StatusBadge status={j.status} />
                    {j.deliveredVia && <span className="text-[11px] text-muted-foreground">via {j.deliveredVia}</span>}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    printer #{j.printerId} · {relTime(j.createdAt as unknown as string)}
                    {j.attempts > 1 ? ` · ${j.attempts} attempts` : ""}
                    {j.error ? ` · ${j.error}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => setPreviewJobId(j.id)}
                    className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground"
                    title="Preview job content"
                  >
                    <Eye className="w-4 h-4" />
                  </button>
                  {j.status === "queued" && (
                    <button
                      onClick={() => handleCancel(j.id)}
                      disabled={canceling === j.id}
                      className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/40 text-red-600 dark:text-red-400 disabled:opacity-40"
                      title="Cancel this job"
                    >
                      <XCircle className="w-4 h-4" />
                    </button>
                  )}
                  {(j.status === "failed" || j.status === "delivered") && (
                    <button
                      onClick={() => retry.mutate({ id: j.id })}
                      className="text-xs px-2 py-1 rounded-lg bg-muted hover:bg-muted/80"
                    >Retry</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    queued: "bg-amber-100 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300",
    delivered: "bg-blue-100 dark:bg-blue-950/40 text-blue-800 dark:text-blue-300",
    printed: "bg-green-100 dark:bg-green-950/40 text-green-800 dark:text-green-300",
    failed: "bg-red-100 dark:bg-red-950/40 text-red-800 dark:text-red-300",
    canceled: "bg-muted text-muted-foreground",
  };
  return <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${map[status] ?? "bg-muted"}`}>{status}</span>;
}

export default function Printers() {
  const { data: printers = [], isLoading } = useListPrinters({
    query: {
      queryKey: getListPrintersQueryKey(),
      refetchInterval: 30_000,
      refetchIntervalInBackground: false,
    },
  });
  const [adding, setAdding] = useState(false);

  return (
    <AdminLayout>
      <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <PrinterIcon className="w-6 h-6" /> Printers
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Configure Star receipt printers. Each printer can run in CloudPRNT, LAN browser, or hybrid mode.
              For LAN delivery, open the <a href="/admin/print-agent" className="underline text-primary">Print Agent</a> page
              on a device connected to your printer's local network.
            </p>
          </div>
          <button
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-primary text-primary-foreground font-medium"
          >
            <Plus className="w-4 h-4" /> Add printer
          </button>
        </div>

        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : printers.length === 0 ? (
          <div className="bg-card rounded-2xl border p-8 text-center">
            <PrinterIcon className="w-10 h-10 mx-auto text-muted-foreground/30" />
            <p className="mt-3 font-medium">No printers configured yet</p>
            <p className="text-sm text-muted-foreground mt-1">Add your first Star TSP printer to enable network printing.</p>
          </div>
        ) : (
          <div className="grid gap-3">
            {(printers as Printer[]).map((p) => <PrinterCard key={p.id} p={p} />)}
          </div>
        )}

        <PrinterDialog open={adding} initial={null} onClose={() => setAdding(false)} />
        <PrintJobsPanel />
      </div>
    </AdminLayout>
  );
}
