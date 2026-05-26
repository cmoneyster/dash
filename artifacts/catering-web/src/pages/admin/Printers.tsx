import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListPrinters,
  useCreatePrinter,
  useUpdatePrinter,
  useDeletePrinter,
  useListPrintJobs,
  useRetryPrintJob,
  useTestLanPrinter,
  useGetPrintAgentHeartbeat,
  getListPrintersQueryKey,
  getListPrintJobsQueryKey,
  type Printer,
  type CreatePrinterBody,
  type PrintJob,
  type PrintTemplate,
} from "@workspace/api-client-react";
import { useForm } from "react-hook-form";
import {
  Printer as PrinterIcon,
  Plus,
  Trash2,
  Pencil,
  AlertTriangle,
  Check,
  RefreshCw,
  X,
  Eye,
  EyeOff,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronUp,
  Palette,
  Copy,
  Network,
  Bold,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Terminal,
} from "lucide-react";
import { AdminLayout } from "@/components/AdminLayout";
import { getAdminToken } from "@/components/AdminGuard";

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


function TestLanButton({ printer }: { printer: Printer }) {
  const testLan = useTestLanPrinter();

  if (!printer.lanIp) return null;

  const state = testLan.isPending ? "pending" : testLan.isSuccess ? "ok" : testLan.isError ? "err" : "idle";

  return (
    <button
      type="button"
      onClick={() => testLan.mutate({ id: printer.id })}
      disabled={state === "pending"}
      title="Send a direct TCP test to port 9100 — bypasses the print queue"
      className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium transition-all active:scale-95 disabled:opacity-60 ${
        state === "ok"
          ? "bg-green-600 text-white"
          : state === "err"
          ? "bg-red-600 text-white"
          : "bg-muted hover:bg-muted/70 text-foreground"
      }`}
    >
      {state === "pending"
        ? <><Loader2 className="w-3 h-3 animate-spin" /> Testing…</>
        : state === "ok"
        ? <><Check className="w-3 h-3" /> LAN OK</>
        : state === "err"
        ? <><XCircle className="w-3 h-3" /> LAN Failed</>
        : <><Network className="w-3 h-3" /> Test via LAN</>}
    </button>
  );
}

// ─── Template designer types & helpers ───────────────────────────────────────

type SectionKey =
  | "header" | "orderNumber" | "guestName" | "tableNumber"
  | "timestamp" | "source" | "items" | "totals" | "notes" | "footer";
type SectionAlign = "left" | "center" | "right";
type SectionStyleLocal = {
  visible?: boolean;
  bold?: boolean;
  align?: SectionAlign;
  size?: "normal" | "double";
  dividerAfter?: boolean;
};
type TicketType = "kitchen_ticket" | "customer_receipt" | "item_label" | "plate_label";

const TICKET_TYPES: { value: TicketType; label: string }[] = [
  { value: "kitchen_ticket",   label: "Kitchen" },
  { value: "customer_receipt", label: "Receipt" },
  { value: "item_label",       label: "Item label" },
  { value: "plate_label",      label: "Plate label" },
];

const SECTION_LABELS: Record<SectionKey, string> = {
  header:      "Header / title",
  orderNumber: "Order number",
  guestName:   "Guest name",
  tableNumber: "Table number",
  timestamp:   "Timestamp",
  source:      "Order source",
  items:       "Items list",
  totals:      "Totals",
  notes:       "Order notes",
  footer:      "Footer",
};

const DEFAULT_TICKET_SECTIONS: Record<TicketType, SectionKey[]> = {
  kitchen_ticket:   ["header", "orderNumber", "guestName", "tableNumber", "timestamp", "source", "items", "notes", "footer"],
  customer_receipt: ["header", "timestamp", "orderNumber", "guestName", "tableNumber", "items", "totals", "footer"],
  item_label:       ["orderNumber", "guestName", "tableNumber", "items", "timestamp"],
  plate_label:      ["orderNumber", "guestName", "items", "timestamp"],
};

const EMPTY_TEMPLATE: PrintTemplate = { businessName: "", footer: "", dividerChar: "-" };

function getOrder(tpl: PrintTemplate, tt: TicketType): SectionKey[] {
  const layout = tpl[tt as keyof PrintTemplate] as { sectionOrder?: string[] } | null | undefined;
  return (layout?.sectionOrder as SectionKey[] | undefined) ?? DEFAULT_TICKET_SECTIONS[tt];
}

function getStyle(tpl: PrintTemplate, tt: TicketType, key: SectionKey): SectionStyleLocal {
  const layout = tpl[tt as keyof PrintTemplate] as { sections?: Record<string, SectionStyleLocal> } | null | undefined;
  return (layout?.sections?.[key]) ?? {};
}

function patchLayout(tpl: PrintTemplate, tt: TicketType, patch: { sectionOrder?: string[]; sections?: Record<string, SectionStyleLocal> }): PrintTemplate {
  const prev = (tpl[tt as keyof PrintTemplate] ?? {}) as Record<string, unknown>;
  return { ...tpl, [tt]: { ...prev, ...patch } };
}

function patchStyle(tpl: PrintTemplate, tt: TicketType, key: SectionKey, stylePatch: Partial<SectionStyleLocal>): PrintTemplate {
  const layout = (tpl[tt as keyof PrintTemplate] ?? {}) as { sectionOrder?: string[]; sections?: Record<string, SectionStyleLocal> };
  return patchLayout(tpl, tt, {
    ...layout,
    sections: { ...layout.sections, [key]: { ...layout.sections?.[key], ...stylePatch } },
  });
}

function moveSection(tpl: PrintTemplate, tt: TicketType, key: SectionKey, dir: -1 | 1): PrintTemplate {
  const order = [...getOrder(tpl, tt)];
  const idx = order.indexOf(key);
  const next = idx + dir;
  if (idx < 0 || next < 0 || next >= order.length) return tpl;
  [order[idx], order[next]] = [order[next], order[idx]];
  const layout = (tpl[tt as keyof PrintTemplate] ?? {}) as Record<string, unknown>;
  return patchLayout(tpl, tt, { ...layout, sectionOrder: order });
}

// ─── Section row component ────────────────────────────────────────────────────

function SectionRow({
  sectionKey, style, isFirst, isLast,
  onUp, onDown, onChange,
}: {
  sectionKey: SectionKey;
  style: SectionStyleLocal;
  isFirst: boolean;
  isLast: boolean;
  onUp: () => void;
  onDown: () => void;
  onChange: (patch: Partial<SectionStyleLocal>) => void;
}) {
  const visible      = style.visible !== false;
  const isBold       = style.bold === true;
  const align        = style.align ?? "left";
  const isDouble     = style.size === "double";
  const dividerAfter = style.dividerAfter === true;

  const btnBase = "flex items-center justify-center rounded transition-colors";
  const iconSz  = "w-3 h-3";
  const activeBtn = "bg-primary text-primary-foreground";
  const inactiveBtn = "hover:bg-muted text-muted-foreground";

  return (
    <div className={`rounded-lg px-1 py-0.5 transition-opacity ${!visible ? "opacity-40" : ""}`}>
      <div className="flex items-center gap-0.5">
        <div className="flex flex-col">
          <button type="button" onClick={onUp} disabled={isFirst}
            className={`${btnBase} w-5 h-4 hover:bg-muted disabled:opacity-20`} title="Move up">
            <ChevronUp className={iconSz} />
          </button>
          <button type="button" onClick={onDown} disabled={isLast}
            className={`${btnBase} w-5 h-4 hover:bg-muted disabled:opacity-20`} title="Move down">
            <ChevronDown className={iconSz} />
          </button>
        </div>

        <button type="button" onClick={() => onChange({ visible: !visible })}
          title={visible ? "Hide" : "Show"}
          className={`${btnBase} w-6 h-6 shrink-0 ${visible ? `text-foreground hover:bg-muted` : inactiveBtn}`}>
          {visible ? <Eye className={iconSz} /> : <EyeOff className={iconSz} />}
        </button>

        <span className="flex-1 text-xs truncate min-w-0 mx-0.5">{SECTION_LABELS[sectionKey]}</span>

        <button type="button" onClick={() => onChange({ bold: !isBold })}
          title={isBold ? "Remove bold" : "Bold"}
          className={`${btnBase} w-6 h-6 shrink-0 ${isBold ? activeBtn : inactiveBtn}`}>
          <Bold className={iconSz} />
        </button>

        <div className="flex">
          {(["left", "center", "right"] as SectionAlign[]).map((a) => (
            <button key={a} type="button" onClick={() => onChange({ align: a })} title={`Align ${a}`}
              className={`${btnBase} w-5 h-6 ${align === a ? `${activeBtn} rounded` : inactiveBtn}`}>
              {a === "left" ? <AlignLeft className={iconSz} /> : a === "center" ? <AlignCenter className={iconSz} /> : <AlignRight className={iconSz} />}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-1 pl-10 mt-0.5">
        <button type="button" onClick={() => onChange({ size: isDouble ? "normal" : "double" })}
          title={isDouble ? "Switch to normal size" : "Switch to double-height"}
          className={`text-[10px] px-1.5 h-4 rounded font-mono font-bold transition-colors ${isDouble ? activeBtn : `border ${inactiveBtn}`}`}>
          {isDouble ? "2x" : "1x"}
        </button>
        <button type="button" onClick={() => onChange({ dividerAfter: !dividerAfter })}
          title={dividerAfter ? "Remove divider after" : "Add divider after section"}
          className={`text-[10px] px-1.5 h-4 rounded font-mono transition-colors ${dividerAfter ? activeBtn : `border ${inactiveBtn}`}`}>
          ——
        </button>
      </div>
    </div>
  );
}

// ─── PrintTemplateDesignerModal ───────────────────────────────────────────────

function PrintTemplateDesignerModal({
  printer,
  onClose,
}: {
  printer: Printer;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const update = useUpdatePrinter({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getListPrintersQueryKey() }) },
  });

  const existing = printer.printTemplate as PrintTemplate | null | undefined;

  const [testPrintState, setTestPrintState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  const handleTestPrint = async () => {
    setTestPrintState("sending");
    try {
      const token = getAdminToken();
      const res = await fetch(`/api/admin/printers/${printer.id}/test-print-template`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ ticketType, template: tpl }),
      });
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        throw new Error(d.error ?? "Failed");
      }
      setTestPrintState("sent");
      setTimeout(() => setTestPrintState("idle"), 3000);
    } catch {
      setTestPrintState("error");
      setTimeout(() => setTestPrintState("idle"), 3000);
    }
  };

  const [tpl, setTpl] = useState<PrintTemplate>({
    businessName:    existing?.businessName    ?? "",
    footer:          existing?.footer          ?? "",
    dividerChar:     existing?.dividerChar     ?? "-",
    headerText:      existing?.headerText      ?? "",
    logoUrl:         existing?.logoUrl         ?? "",
    logoPosition:    existing?.logoPosition    ?? null,
    kitchen_ticket:  existing?.kitchen_ticket  ?? undefined,
    customer_receipt: existing?.customer_receipt ?? undefined,
    item_label:      existing?.item_label      ?? undefined,
    plate_label:     existing?.plate_label     ?? undefined,
  });

  const [ticketType, setTicketType] = useState<TicketType>("kitchen_ticket");
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchPreview = (template: PrintTemplate, type: TicketType) => {
    setPreviewLoading(true);
    const token = getAdminToken();
    fetch(`/api/admin/printers/${printer.id}/preview-template`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ ticketType: type, template }),
    })
      .then((r) => r.json())
      .then((d: { text: string }) => { setPreviewText(d.text); setPreviewLoading(false); })
      .catch(() => { setPreviewText("(preview error)"); setPreviewLoading(false); });
  };

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchPreview(tpl, ticketType), 150);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [tpl, ticketType]);

  const handleSave = async () => {
    const clean: PrintTemplate = {
      ...tpl,
      businessName: tpl.businessName?.trim() || null,
      footer: tpl.footer?.trim() || null,
      dividerChar: tpl.dividerChar?.slice(0, 1) || "-",
    };
    await update.mutateAsync({ id: printer.id, data: { printTemplate: clean } });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const sectionOrder = getOrder(tpl, ticketType);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div
        className="bg-card rounded-2xl shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b shrink-0">
          <div>
            <h2 className="font-semibold text-lg flex items-center gap-2">
              <Palette className="w-4 h-4 text-muted-foreground" />
              Receipt template — {printer.name}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Customise each ticket type. Reorder sections and set visibility, bold, and alignment per section.
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-muted"><X className="w-5 h-5" /></button>
        </div>

        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* ── Left sidebar: global controls + per-ticket section list ── */}
          <div className="w-80 shrink-0 border-r overflow-y-auto">
            <div className="p-4 space-y-3 border-b">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Global</p>

              <div>
                <label className="block text-xs font-medium mb-1">Business name <span className="text-muted-foreground font-normal">(on receipts)</span></label>
                <input
                  value={tpl.businessName ?? ""}
                  onChange={(e) => setTpl((p) => ({ ...p, businessName: e.target.value }))}
                  className="w-full px-3 py-1.5 border rounded-lg bg-background text-sm"
                  placeholder="Hollywood East Cafe"
                />
              </div>

              <div>
                <label className="block text-xs font-medium mb-1">Ticket header text <span className="text-muted-foreground font-normal">(overrides "KITCHEN" etc.)</span></label>
                <input
                  value={tpl.headerText ?? ""}
                  onChange={(e) => setTpl((p) => ({ ...p, headerText: e.target.value }))}
                  className="w-full px-3 py-1.5 border rounded-lg bg-background text-sm"
                  placeholder="KITCHEN"
                />
              </div>


              <div className="flex items-end gap-2">
                <div>
                  <label className="block text-xs font-medium mb-1">Divider char</label>
                  <input
                    value={tpl.dividerChar ?? "-"}
                    onChange={(e) => setTpl((p) => ({ ...p, dividerChar: e.target.value.slice(0, 1) || "-" }))}
                    className="w-12 px-3 py-1.5 border rounded-lg bg-background text-sm font-mono text-center"
                    maxLength={1}
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1">Footer</label>
                <textarea
                  value={tpl.footer ?? ""}
                  onChange={(e) => setTpl((p) => ({ ...p, footer: e.target.value }))}
                  className="w-full px-3 py-1.5 border rounded-lg bg-background text-sm font-mono resize-none"
                  rows={3}
                  placeholder="Thank you for your order!"
                />
              </div>
            </div>

            <div className="p-4 space-y-2">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Sections — {TICKET_TYPES.find((t) => t.value === ticketType)?.label}
                </p>
                <button
                  type="button"
                  onClick={() =>
                    setTpl((p) => {
                      const updated = { ...p };
                      delete (updated as Record<string, unknown>)[ticketType];
                      return updated;
                    })
                  }
                  className="text-[10px] text-muted-foreground hover:text-foreground underline"
                  title="Reset this ticket type to defaults"
                >
                  Reset
                </button>
              </div>

              <p className="text-[10px] text-muted-foreground">
                Drag-to-reorder not available — use ↑↓ arrows. Toggle eye to hide a section.
              </p>

              <div className="space-y-0.5">
                {sectionOrder.map((key, idx) => (
                  <SectionRow
                    key={key}
                    sectionKey={key}
                    style={getStyle(tpl, ticketType, key)}
                    isFirst={idx === 0}
                    isLast={idx === sectionOrder.length - 1}
                    onUp={() => setTpl((p) => moveSection(p, ticketType, key, -1))}
                    onDown={() => setTpl((p) => moveSection(p, ticketType, key, 1))}
                    onChange={(patch) => setTpl((p) => patchStyle(p, ticketType, key, patch))}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* ── Right panel: ticket type tabs + live preview ── */}
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            <div className="flex items-center gap-1 px-4 py-3 border-b bg-muted/30 shrink-0 flex-wrap">
              {TICKET_TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setTicketType(t.value)}
                  className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${
                    ticketType === t.value
                      ? "bg-primary text-primary-foreground"
                      : "bg-background border hover:bg-muted text-foreground"
                  }`}
                >
                  {t.label}
                </button>
              ))}
              {previewLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground ml-2" />}
            </div>

            <div className="flex-1 overflow-y-auto p-5">
              <div className="bg-white dark:bg-slate-950 border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl p-4 max-w-sm mx-auto shadow-inner">
                {previewText !== null ? (
                  <pre className="font-mono text-[11px] leading-[1.5] text-slate-900 dark:text-slate-100 whitespace-pre">
                    {previewText || "(empty ticket)"}
                  </pre>
                ) : (
                  <div className="flex items-center justify-center py-8 text-muted-foreground">
                    <Loader2 className="w-5 h-5 animate-spin" />
                  </div>
                )}
              </div>
              <p className="text-center text-[11px] text-muted-foreground mt-3">
                48-column preview · alignment shown · bold &amp; size visible on physical printout only
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between px-5 py-4 border-t shrink-0 bg-muted/20">
          <button
            type="button"
            onClick={() => setTpl(EMPTY_TEMPLATE)}
            className="text-xs text-muted-foreground hover:text-foreground underline"
          >
            Reset all to defaults
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-muted hover:bg-muted/80 active:scale-95 transition-all text-sm"
            >
              Close
            </button>
            {printer.lanIp && (
              <button
                type="button"
                onClick={handleTestPrint}
                disabled={testPrintState === "sending"}
                title="Print the current design (unsaved) to the physical printer"
                className={`px-4 py-2 rounded-xl font-medium text-sm transition-all active:scale-95 disabled:opacity-60 inline-flex items-center gap-2 border ${
                  testPrintState === "sent"
                    ? "border-green-500 text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30"
                    : testPrintState === "error"
                    ? "border-red-400 text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30"
                    : "border-border hover:bg-muted text-foreground"
                }`}
              >
                {testPrintState === "sending"
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Printing…</>
                  : testPrintState === "sent"
                  ? <><Check className="w-4 h-4" /> Sent to printer</>
                  : testPrintState === "error"
                  ? <><X className="w-4 h-4" /> Print failed</>
                  : <><PrinterIcon className="w-4 h-4" /> Test print</>}
              </button>
            )}
            <button
              type="button"
              onClick={handleSave}
              disabled={update.isPending || saved}
              className={`px-5 py-2 rounded-xl font-medium text-sm transition-all active:scale-95 disabled:opacity-60 inline-flex items-center gap-2 ${
                saved ? "bg-green-600 text-white" : "bg-primary text-primary-foreground hover:opacity-90"
              }`}
            >
              {update.isPending
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
                : saved
                ? <><Check className="w-4 h-4" /> Saved</>
                : "Save template"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

type PrinterFormValues = Omit<CreatePrinterBody, "printMode">;

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
  const { register, handleSubmit, reset } = useForm<PrinterFormValues>({
    defaultValues: initial ?? {
      name: "",
      model: "TSP143IV",
      lanIp: "",
      location: "",
      printsKitchenTicket: true,
      printsCustomerReceipt: false,
      printsItemLabels: false,
      autoPrintOnNewOrder: true,
      suppressItemLabelsForPlateLines: true,
      enabled: true,
    },
  });

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
            <label className="block text-sm font-medium mb-1">
              LAN IP
              <span className="text-xs text-muted-foreground ml-2">required for LAN delivery</span>
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
            <p className="text-sm font-semibold">Behaviour</p>
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
  const [designingTemplate, setDesigningTemplate] = useState(false);
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

  const outputs: string[] = [];
  if (p.printsKitchenTicket) outputs.push("Kitchen");
  if (p.printsCustomerReceipt) outputs.push("Receipts");
  if (p.printsItemLabels) outputs.push("Item labels");

  const hasTemplate = !!(p.printTemplate as PrintTemplate | null | undefined);

  return (
    <div className="bg-card rounded-2xl border p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-muted rounded-xl"><PrinterIcon className="w-5 h-5 text-muted-foreground" /></div>
          <div>
            <div className="font-semibold flex items-center gap-2">
              {p.name}
              {hasTemplate && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 font-medium">
                  custom template
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {p.model}{p.location ? ` · ${p.location}` : ""}{p.lanIp ? ` · ${p.lanIp}` : ""}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setDesigningTemplate(true)}
            className="p-2 rounded-lg hover:bg-violet-50 dark:hover:bg-violet-950/40 active:scale-95 transition-all text-violet-700 dark:text-violet-400"
            title="Design receipt template"
          >
            <Palette className="w-4 h-4" />
          </button>
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
        <span className="text-xs bg-indigo-50 dark:bg-indigo-950/40 text-indigo-800 dark:text-indigo-300 px-2 py-0.5 rounded-full">LAN browser</span>
      </div>

      <div className="mt-3 flex items-center gap-2 flex-wrap">
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
        <TestLanButton printer={p} />
        <span className="text-[11px] text-muted-foreground">Sends a test job · LAN test bypasses queue</span>
      </div>

      {p.lanIp && <RouterAgentSetup printer={p} />}

      <PrinterDialog open={editing} initial={p} onClose={() => setEditing(false)} />
      {designingTemplate && (
        <PrintTemplateDesignerModal
          printer={p}
          onClose={() => setDesigningTemplate(false)}
        />
      )}
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
        } catch { }
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

function RouterAgentHeartbeatBadge() {
  const { data } = useGetPrintAgentHeartbeat({
    query: { refetchInterval: 15_000, queryKey: ["printAgentHeartbeat"] },
  });

  const lastSeenAt = data?.lastSeenAt ?? null;
  const isLive =
    lastSeenAt !== null &&
    Date.now() - new Date(lastSeenAt).getTime() < 90_000;

  if (!lastSeenAt) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 inline-block" />
        Offline
      </span>
    );
  }

  if (!isLive) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 inline-block" />
        Last seen {relTime(lastSeenAt)}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-600 dark:text-green-400">
      <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block animate-pulse" />
      Live · {relTime(lastSeenAt)}
    </span>
  );
}

function RouterAgentSetup({ printer }: { printer: Printer }) {
  const [open, setOpen] = useState(false);
  const serverUrl = window.location.origin;
  const token = getAdminToken() ?? "";
  const installUrl = `${serverUrl}/api/print-agent/install.sh?token=${encodeURIComponent(token)}`;
  const downloadCmd = `wget -O /root/print-agent.sh '${installUrl}'`;
  const runCmd = `(trap '' HUP; sh /root/print-agent.sh > /var/log/print-agent.log 2>&1) &`;
  const cronWatchdog = `* * * * * pgrep -f print-agent.sh > /dev/null || (trap '' HUP; sh /root/print-agent.sh >> /var/log/print-agent.log 2>&1) &`;

  return (
    <div className="mt-3 border-t pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-left py-1 hover:opacity-70 transition-opacity"
      >
        <div className="flex items-center gap-1.5 flex-wrap">
          <Terminal className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground">Router Agent Setup</span>
          <span className="text-[11px] text-muted-foreground/60 hidden sm:inline">— GL.iNet / OpenWrt TCP/9100</span>
          <RouterAgentHeartbeatBadge />
        </div>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
      </button>

      {open && (
        <div className="mt-3 space-y-4">
          <p className="text-xs text-muted-foreground">
            A shell agent running on a GL.iNet (OpenWrt) router polls the server every 5 s, fetches raw
            ESC/POS bytes for any queued job, and pipes them to the target printer's IP via{" "}
            <code className="font-mono bg-muted px-0.5 rounded">nc</code> on TCP port 9100. One agent
            handles all printers with a LAN IP configured — no CORS, no browser required.
          </p>

          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              1 · SSH into the router
            </p>
            <CodeBlock text="ssh -o HostKeyAlgorithms=+ssh-rsa root@192.168.22.1" />
            <p className="text-[11px] text-muted-foreground">Replace <code className="font-mono bg-muted px-0.5 rounded">192.168.22.1</code> with your GL.iNet router's LAN IP if different.</p>
          </div>

          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              2a · Download the install script
            </p>
            <CodeBlock text={downloadCmd} obscureToken />
          </div>

          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              2b · Launch it in the background
            </p>
            <CodeBlock text={runCmd} />
            <p className="text-[11px] text-muted-foreground">
              The server URL and token are baked into the script. <code className="font-mono bg-muted px-0.5 rounded">trap '' HUP</code> keeps it running after you close the SSH session.
            </p>
          </div>

          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              3 · Verify it's running
            </p>
            <CodeBlock text="tail -f /var/log/print-agent.log" />
            <p className="text-[11px] text-muted-foreground">You should see <em>Starting (server=…)</em> — send a test print above to confirm delivery.</p>
          </div>

          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              4 · Add cron watchdog (recommended)
            </p>
            <p className="text-[11px] text-muted-foreground">
              Restarts the agent automatically if it crashes. GL.iNet uses{" "}
              <code className="font-mono bg-muted px-0.5 rounded">/tmp/gl_crontabs/root</code> — append with:
            </p>
            <CodeBlock text={`echo '${cronWatchdog}' >> /tmp/gl_crontabs/root`} />
          </div>

          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Management commands
            </p>
            <div className="space-y-1">
              <p className="text-[11px] text-muted-foreground">Stop:</p>
              <CodeBlock text="kill $(pgrep -f print-agent.sh)" />
              <p className="text-[11px] text-muted-foreground">Restart:</p>
              <CodeBlock text={`kill $(pgrep -f print-agent.sh) 2>/dev/null; ${runCmd}`} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
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
              Configure Star receipt printers for LAN direct printing via TCP port 9100. Use the{" "}
              <span className="inline-flex items-center gap-1"><Palette className="w-3.5 h-3.5 text-violet-600" /> palette</span>{" "}
              button on each printer to design its receipt template.
            </p>
          </div>
          <button
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-primary text-primary-foreground font-medium hover:opacity-90 active:scale-95 transition-all shrink-0"
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
