import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListPrinters,
  useCreatePrinter,
  useUpdatePrinter,
  useDeletePrinter,
  useListPrintJobs,
  useRetryPrintJob,
  getListPrintersQueryKey,
  getListPrintJobsQueryKey,
  CreatePrinterBodyPrintMode,
  type Printer,
  type CreatePrinterBody,
  type PrintJob,
} from "@workspace/api-client-react";
import { useForm } from "react-hook-form";
import { Printer as PrinterIcon, Plus, Trash2, Pencil, Wifi, WifiOff, AlertTriangle, Copy, Check, RefreshCw, X, Eye, XCircle, Loader2, Terminal, ChevronDown, ChevronUp } from "lucide-react";
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
      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 active:scale-95 transition-all text-slate-700 dark:text-slate-300"
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

function CodeBlock({ text, obscureToken = false }: { text: string; obscureToken?: boolean }) {
  const display = obscureToken
    ? text.replace(/([0-9a-f]{64})/i, (m) => `${m.slice(0, 8)}…`)
    : text;
  return (
    <div className="flex items-start gap-2 bg-slate-900 dark:bg-slate-950 rounded-lg p-3 font-mono text-[11px] text-slate-100 overflow-x-auto">
      <span className="flex-1 break-all whitespace-pre-wrap">{display}</span>
      <CopyButton text={text} />
    </div>
  );
}

function RouterAgentSetup({ printerIp }: { printerIp: string }) {
  const [open, setOpen] = useState(false);
  const token = getAdminToken() ?? "";
  const serverUrl = window.location.origin;

  const sshCmd = "ssh -o HostKeyAlgorithms=+ssh-rsa root@192.168.22.1";
  const wgetCmd = `wget -O /root/print-agent.sh '${serverUrl}/api/print-agent/install.sh?token=${token}&printer=${printerIp}'`;
  const runCmd = "sh /root/print-agent.sh </dev/null >> /var/log/print-agent.log 2>&1 &";
  const cronLine = "* * * * * pgrep -f print-agent.sh > /dev/null || sh /root/print-agent.sh </dev/null >> /var/log/print-agent.log 2>&1 &";
  const rcLine = "sh /root/print-agent.sh </dev/null >> /var/log/print-agent.log 2>&1 &";

  return (
    <div className="mt-3 border-t pt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-700 dark:text-indigo-400 hover:underline"
      >
        <Terminal className="w-3.5 h-3.5" />
        Router agent setup
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      </button>

      {open && (
        <div className="mt-3 space-y-4 text-xs">
          <p className="text-muted-foreground">
            Run these commands on your GL.iNet router (SSH as root) to install or re-install the print agent for this printer (<code className="font-mono bg-muted px-1 rounded">{printerIp}</code>).
            The download URL has your token and printer IP already embedded — you can copy it and run it again any time you replace the router.
          </p>

          <div className="space-y-1">
            <p className="font-medium text-muted-foreground">1. SSH into the router</p>
            <CodeBlock text={sshCmd} />
          </div>

          <div className="space-y-1">
            <p className="font-medium text-muted-foreground">
              2. Download the pre-configured script
              {token
                ? <span className="font-normal ml-1">(token: <code className="bg-muted px-1 rounded">{token.slice(0, 8)}…</code>)</span>
                : <span className="font-normal ml-1 text-amber-600 dark:text-amber-400"> — log in as admin first so your token is included</span>
              }
            </p>
            <CodeBlock text={wgetCmd} obscureToken />
          </div>

          <div className="space-y-1">
            <p className="font-medium text-muted-foreground">3. Run it in the background (survives SSH disconnect)</p>
            <CodeBlock text={runCmd} />
          </div>

          <div className="space-y-1">
            <p className="font-medium text-muted-foreground">4. Watchdog cron — paste into <code className="bg-muted px-1 rounded">/etc/crontabs/root</code></p>
            <CodeBlock text={cronLine} />
          </div>

          <div className="space-y-1">
            <p className="font-medium text-muted-foreground">5. Auto-start on boot — paste into <code className="bg-muted px-1 rounded">/etc/rc.local</code> before <code className="bg-muted px-1 rounded">exit 0</code></p>
            <CodeBlock text={rcLine} />
          </div>

          <p className="text-muted-foreground/70">
            When replacing the router, repeat from step 1. The wget URL already has everything embedded — just re-run it to get a fresh copy of the script on the new router.
          </p>
        </div>
      )}
    </div>
  );
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
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl bg-muted hover:bg-muted/80 active:scale-95 transition-all">Cancel</button>
            <button type="submit" disabled={create.isPending || update.isPending} className="px-4 py-2 rounded-xl bg-primary text-primary-foreground font-medium hover:opacity-90 active:scale-95 transition-all disabled:opacity-60 inline-flex items-center gap-2">
              {(create.isPending || update.isPending) && <Loader2 className="w-4 h-4 animate-spin" />}
              {initial ? "Save changes" : "Add printer"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function PrinterCard({ p }: { p: Printer }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [testState, setTestState] = useState<"idle" | "pending" | "ok" | "err">("idle");
  const del = useDeletePrinter({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getListPrintersQueryKey() }) },
  });

  async function handleTestPrint() {
    setTestState("pending");
    const token = getAdminToken();
    try {
      const res = await fetch(`/api/admin/printers/${p.id}/test-print`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jobType: "test" }),
      });
      setTestState(res.ok ? "ok" : "err");
    } catch {
      setTestState("err");
    }
    await qc.invalidateQueries({ queryKey: getListPrintJobsQueryKey() });
    setTimeout(() => setTestState("idle"), 3000);
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
          <button
            onClick={() => setEditing(true)}
            className="p-2 rounded-lg hover:bg-muted active:scale-95 transition-all"
            title="Edit"
          >
            <Pencil className="w-4 h-4" />
          </button>
          <button
            onClick={() => {
              if (confirm(`Delete printer "${p.name}"?`))
                del.mutate({ id: p.id }, { onSuccess: () => qc.invalidateQueries({ queryKey: getListPrintersQueryKey() }) });
            }}
            className="p-2 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/40 active:scale-95 transition-all text-red-700 dark:text-red-400"
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

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={handleTestPrint}
          disabled={testState === "pending"}
          className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium transition-all active:scale-95 disabled:opacity-60 ${
            testState === "ok"
              ? "bg-green-600 text-white"
              : testState === "err"
              ? "bg-red-600 text-white"
              : "bg-foreground text-background hover:opacity-85"
          }`}
        >
          {testState === "pending"
            ? <><Loader2 className="w-3 h-3 animate-spin" /> Sending…</>
            : testState === "ok"
            ? <><Check className="w-3 h-3" /> Sent</>
            : testState === "err"
            ? <><XCircle className="w-3 h-3" /> Failed</>
            : "Test Print"}
        </button>
        <span className="text-[11px] text-muted-foreground">Sends a test page to this printer only</span>
      </div>

      {p.lanIp && <RouterAgentSetup printerIp={p.lanIp} />}

      <PrinterDialog open={editing} initial={p} onClose={() => setEditing(false)} />
    </div>
  );
}

type BroadcastPhase =
  | { phase: "idle" }
  | { phase: "sending"; jobType: string }
  | { phase: "done"; jobType: string; count: number };

function BroadcastTestPanel({ printers }: { printers: Printer[] }) {
  const qc = useQueryClient();
  const [state, setState] = useState<BroadcastPhase>({ phase: "idle" });

  async function broadcast(
    jobType: "kitchen_ticket" | "customer_receipt" | "item_label",
    filter: (p: Printer) => boolean,
  ) {
    const eligible = (printers as Printer[]).filter((p) => p.enabled && filter(p));
    setState({ phase: "sending", jobType });
    const token = getAdminToken();
    let count = 0;
    await Promise.all(
      eligible.map(async (p) => {
        try {
          const res = await fetch(`/api/admin/printers/${p.id}/test-print`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ jobType }),
          });
          if (res.ok) count++;
        } catch { /* silent */ }
      }),
    );
    await qc.invalidateQueries({ queryKey: getListPrintJobsQueryKey() });
    setState({ phase: "done", jobType, count });
    setTimeout(() => setState({ phase: "idle" }), 3000);
  }

  const sending = state.phase === "sending";

  const BtnCls = (active: boolean) =>
    `inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium transition-all active:scale-95 disabled:opacity-60 ${
      active ? "bg-foreground text-background hover:opacity-85" : "bg-muted hover:bg-muted/70 text-foreground"
    }`;

  return (
    <div className="bg-card rounded-2xl border p-4 shadow-sm">
      <div className="flex items-center gap-2 mb-3">
        <PrinterIcon className="w-4 h-4 text-muted-foreground" />
        <span className="font-semibold text-sm">Broadcast test prints</span>
        <span className="text-xs text-muted-foreground hidden sm:inline">— sends to every printer configured for that type</span>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => broadcast("kitchen_ticket", (p) => !!p.printsKitchenTicket)}
          disabled={sending}
          className={BtnCls(state.phase === "sending" && state.jobType === "kitchen_ticket")}
        >
          {state.phase === "sending" && state.jobType === "kitchen_ticket"
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : null}
          Test kitchen ticket
        </button>

        <button
          onClick={() => broadcast("customer_receipt", (p) => !!p.printsCustomerReceipt)}
          disabled={sending}
          className={BtnCls(state.phase === "sending" && state.jobType === "customer_receipt")}
        >
          {state.phase === "sending" && state.jobType === "customer_receipt"
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : null}
          Test receipt
        </button>

        <button
          onClick={() => broadcast("item_label", (p) => !!p.printsItemLabels)}
          disabled={sending}
          className={BtnCls(state.phase === "sending" && state.jobType === "item_label")}
        >
          {state.phase === "sending" && state.jobType === "item_label"
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : null}
          Test label
        </button>
      </div>

      {state.phase === "done" && (
        <div className={`mt-3 text-xs px-3 py-2 rounded-lg flex items-center gap-2 ${
          state.count > 0
            ? "bg-green-50 dark:bg-green-950/40 text-green-800 dark:text-green-300"
            : "bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300"
        }`}>
          {state.count > 0
            ? <Check className="w-3.5 h-3.5 shrink-0" />
            : <AlertTriangle className="w-3.5 h-3.5 shrink-0" />}
          {state.count > 0
            ? `Sent to ${state.count} printer${state.count === 1 ? "" : "s"}`
            : `No enabled printers are configured for ${state.jobType.replace(/_/g, " ")}`}
        </div>
      )}
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
          <button onClick={() => refetch()} className="p-1.5 rounded-lg hover:bg-muted active:scale-95 transition-all" title="Refresh"><RefreshCw className="w-4 h-4" /></button>
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
                    className="p-1.5 rounded-lg hover:bg-muted active:scale-95 transition-all text-muted-foreground"
                    title="Preview job content"
                  >
                    <Eye className="w-4 h-4" />
                  </button>
                  {j.status === "queued" && (
                    <button
                      onClick={() => handleCancel(j.id)}
                      disabled={canceling === j.id}
                      className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/40 active:scale-95 transition-all text-red-600 dark:text-red-400 disabled:opacity-40"
                      title="Cancel this job"
                    >
                      <XCircle className="w-4 h-4" />
                    </button>
                  )}
                  {(j.status === "failed" || j.status === "delivered") && (
                    <button
                      onClick={() => retry.mutate({ id: j.id })}
                      className="text-xs px-2 py-1 rounded-lg bg-muted hover:bg-muted/70 active:scale-95 transition-all"
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
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-primary text-primary-foreground font-medium hover:opacity-90 active:scale-95 transition-all"
          >
            <Plus className="w-4 h-4" /> Add printer
          </button>
        </div>

        {!isLoading && printers.length > 0 && (
          <BroadcastTestPanel printers={printers as Printer[]} />
        )}

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
