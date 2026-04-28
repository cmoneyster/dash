import { useState, useEffect } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import { getAdminToken } from "@/components/AdminGuard";
import {
  Save, Check, Loader2, MessageSquare, Plus, Trash2, Send,
  AlertTriangle, Smartphone, UserCog, MessagesSquare, RefreshCw,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// Local "what we last loaded / last saved" so the buttons can detect unsaved
// edits and gate the test-action buttons (the test endpoints always send to
// what's persisted, never to the dirty form state).
type ServerState = {
  smsActivePorts: number[];
  ownerNotificationPhone: string | null;
  lowStockAlertPhones: string[];
  lowStockAlertThreshold: number | null;
  ejoinConfigured: boolean;
  ownerNotificationPhoneSource: "db" | "env" | "none";
  smsChatPort: number | null;
  smsChatOwnerPhone: string | null;
  smsChatOwnerPhoneSource: "db-chat" | "db-owner" | "env" | "none";
  smsOwnerForwardEnabled: boolean;
  smsOwnerForwardCapPer24h: number | null;
  smsOwnerReplyEnabled: boolean;
  smsBackfillDays: number;
  smsBackfillCompletedAt: string | null;
  smsInboundMode: "push" | "poll";
  ejoinPortCount: number;
};

type BackfillStatus = {
  inFlight: boolean;
  startedAt: string | null;
  lastResult: { startedAt: string; finishedAt: string; ingested: number; skipped: number; errors: number } | null;
  backfillDays: number;
  completedAt: string | null;
};

// Hardware: ejointech gateway exposes 8 physical SIM ports (1..8).
const EJOIN_VALID_PORTS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const EJOIN_PORT_COUNT = EJOIN_VALID_PORTS.length;

const FORWARD_CAP_OPTIONS: { value: string; label: string }[] = [
  { value: "1", label: "1 forward / 24h" },
  { value: "3", label: "3 forwards / 24h" },
  { value: "5", label: "5 forwards / 24h" },
  { value: "10", label: "10 forwards / 24h" },
  { value: "", label: "Unlimited" },
];

type FeedbackKind = "success" | "error";
type Feedback = { kind: FeedbackKind; message: string } | null;

function StatusPill({ ok, okLabel, badLabel }: { ok: boolean; okLabel: string; badLabel: string }) {
  return ok ? (
    <span className="text-xs font-normal text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">{okLabel}</span>
  ) : (
    <span className="text-xs font-normal text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">{badLabel}</span>
  );
}

function arraysEqual(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}
function portsEqual(a: number[], b: number[]) {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

export default function SmsSettings() {
  const token = getAdminToken();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [server, setServer] = useState<ServerState | null>(null);

  // Form state. Active ports tracked as a Set<number> backing 8 checkboxes;
  // every other field is plain string-state coerced on save.
  const [activePorts, setActivePorts] = useState<Set<number>>(new Set([7]));
  const [ownerPhone, setOwnerPhone] = useState("");
  const [alertPhones, setAlertPhones] = useState<string[]>([]);
  const [threshold, setThreshold] = useState<string>("");

  // Customer-chat-port form state (single-port picker; "" = none).
  const [chatPort, setChatPort] = useState<string>("");
  const [savingChatPort, setSavingChatPort] = useState(false);
  const [savedChatPort, setSavedChatPort] = useState(false);
  const [chatPortError, setChatPortError] = useState("");

  // Customer-chat owner-phone override (the number that receives forwarded
  // customer texts and is recognized as the owner when replying via the
  // chat port). Empty string = use the legacy owner notification phone.
  const [chatOwnerPhone, setChatOwnerPhone] = useState<string>("");
  const [savingChatOwnerPhone, setSavingChatOwnerPhone] = useState(false);
  const [savedChatOwnerPhone, setSavedChatOwnerPhone] = useState(false);
  const [chatOwnerPhoneError, setChatOwnerPhoneError] = useState("");

  // Customer-chat behavior card form state.
  const [forwardEnabled, setForwardEnabled] = useState(false);
  const [forwardCap, setForwardCap] = useState<string>("1");
  const [ownerReplyEnabled, setOwnerReplyEnabled] = useState(false);
  const [backfillDays, setBackfillDays] = useState<string>("90");
  const [savingChat, setSavingChat] = useState(false);
  const [savedChat, setSavedChat] = useState(false);
  const [chatError, setChatError] = useState("");

  // Backfill action state.
  const [backfillStatus, setBackfillStatus] = useState<BackfillStatus | null>(null);
  const [runningBackfill, setRunningBackfill] = useState(false);
  const [backfillFeedback, setBackfillFeedback] = useState<Feedback>(null);

  // Per-section save state. Three forms share the same backend PUT but with
  // different bodies so a partial failure doesn't roll back unrelated edits.
  const [savingPorts, setSavingPorts] = useState(false);
  const [savedPorts, setSavedPorts] = useState(false);
  const [portsError, setPortsError] = useState("");

  const [savingOwner, setSavingOwner] = useState(false);
  const [savedOwner, setSavedOwner] = useState(false);
  const [ownerError, setOwnerError] = useState("");

  const [savingAlerts, setSavingAlerts] = useState(false);
  const [savedAlerts, setSavedAlerts] = useState(false);
  const [alertsError, setAlertsError] = useState("");

  // Feedback for the two pre-built test buttons.
  const [lowStockFeedback, setLowStockFeedback] = useState<Feedback>(null);
  const [sendingLowStock, setSendingLowStock] = useState(false);
  const [ownerTestFeedback, setOwnerTestFeedback] = useState<Feedback>(null);
  const [sendingOwnerTest, setSendingOwnerTest] = useState(false);

  async function loadSettings() {
    setLoading(true);
    setLoadError("");
    try {
      const r = await fetch(`${BASE}/api/admin/sms-settings`, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as ServerState;
      setServer(data);
      setActivePorts(new Set(data.smsActivePorts));
      setOwnerPhone(data.ownerNotificationPhone ?? "");
      setAlertPhones(data.lowStockAlertPhones);
      setThreshold(data.lowStockAlertThreshold != null ? String(data.lowStockAlertThreshold) : "");
      setChatPort(data.smsChatPort != null ? String(data.smsChatPort) : "");
      setChatOwnerPhone(data.smsChatOwnerPhone ?? "");
      setForwardEnabled(!!data.smsOwnerForwardEnabled);
      setForwardCap(data.smsOwnerForwardCapPer24h == null ? "" : String(data.smsOwnerForwardCapPer24h));
      setOwnerReplyEnabled(!!data.smsOwnerReplyEnabled);
      setBackfillDays(String(data.smsBackfillDays ?? 90));
    } catch (e: any) {
      setLoadError(e?.message || "Failed to load SMS settings");
    } finally {
      setLoading(false);
    }
  }

  async function loadBackfillStatus() {
    try {
      const r = await fetch(`${BASE}/api/admin/messages/backfill/status`, { headers });
      if (!r.ok) return;
      const data = (await r.json()) as BackfillStatus;
      setBackfillStatus(data);
    } catch {
      // silent — non-critical status panel
    }
  }

  useEffect(() => { loadSettings(); loadBackfillStatus(); }, []);
  useEffect(() => {
    // While a backfill is running, poll status until it stops so the UI
    // can show progress + the final summary without forcing a reload.
    if (!backfillStatus?.inFlight) return;
    const id = setInterval(loadBackfillStatus, 3_000);
    return () => clearInterval(id);
  }, [backfillStatus?.inFlight]);

  // ── Ports ──────────────────────────────────────────────────────────────────

  function togglePort(port: number) {
    setActivePorts(prev => {
      const next = new Set(prev);
      if (next.has(port)) next.delete(port);
      else next.add(port);
      return next;
    });
  }

  function selectedPortsArray(): number[] {
    // Sorted ascending so the persisted order is stable + the round-robin
    // cycles through ports in a predictable sequence.
    return [...activePorts].filter(p => Number.isInteger(p)).sort((a, b) => a - b);
  }

  async function savePorts() {
    setSavingPorts(true);
    setPortsError("");
    setSavedPorts(false);
    try {
      const ports = selectedPortsArray();
      if (ports.length === 0) throw new Error("Select at least one port.");
      const r = await fetch(`${BASE}/api/admin/sms-settings`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ smsActivePorts: ports }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || "Save failed");
      setServer(data as ServerState);
      setActivePorts(new Set((data as ServerState).smsActivePorts));
      setSavedPorts(true);
      setTimeout(() => setSavedPorts(false), 2000);
    } catch (e: any) {
      setPortsError(e?.message || "Save failed");
    } finally {
      setSavingPorts(false);
    }
  }

  // ── Owner phone ────────────────────────────────────────────────────────────

  async function saveOwnerPhone() {
    setSavingOwner(true);
    setOwnerError("");
    setSavedOwner(false);
    try {
      const trimmed = ownerPhone.trim();
      const value = trimmed === "" ? null : trimmed;
      if (value !== null && value.replace(/\D/g, "").length < 7) {
        throw new Error("Phone must contain at least 7 digits.");
      }
      const r = await fetch(`${BASE}/api/admin/sms-settings`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ ownerNotificationPhone: value }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || "Save failed");
      setServer(data as ServerState);
      setOwnerPhone((data as ServerState).ownerNotificationPhone ?? "");
      setSavedOwner(true);
      setTimeout(() => setSavedOwner(false), 2000);
    } catch (e: any) {
      setOwnerError(e?.message || "Save failed");
    } finally {
      setSavingOwner(false);
    }
  }

  async function handleSendOwnerTest() {
    setSendingOwnerTest(true);
    setOwnerTestFeedback(null);
    try {
      const r = await fetch(`${BASE}/api/admin/sms-settings/test-owner-alert`, { method: "POST", headers });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || "Failed to send owner test");
      const where = data?.ownerNotificationPhoneSource === "env" ? " (using legacy OWNER_PHONE env var)" : "";
      const portInfo = data?.port != null ? ` via port ${data.port}` : "";
      const gateway = data?.gatewayResponse ? ` Gateway: ${data.gatewayResponse}.` : "";
      setOwnerTestFeedback({ kind: "success", message: `Sent test to ${data?.sentTo}${portInfo}${where}.${gateway}` });
    } catch (e: any) {
      setOwnerTestFeedback({ kind: "error", message: e?.message || "Failed to send owner test" });
    } finally {
      setSendingOwnerTest(false);
    }
  }

  // ── Low-stock alerts ───────────────────────────────────────────────────────

  function updateAlertPhoneAt(idx: number, value: string) {
    setAlertPhones(prev => prev.map((p, i) => (i === idx ? value : p)));
  }
  function removeAlertPhoneAt(idx: number) {
    setAlertPhones(prev => prev.filter((_, i) => i !== idx));
  }
  function addAlertPhone() {
    setAlertPhones(prev => [...prev, ""]);
  }

  async function saveAlerts() {
    setSavingAlerts(true);
    setAlertsError("");
    setSavedAlerts(false);
    try {
      const cleaned = alertPhones.map(p => p.trim()).filter(Boolean);
      const body: Record<string, unknown> = {
        lowStockAlertPhones: cleaned,
        lowStockAlertThreshold: threshold.trim() === "" ? null : Number(threshold),
      };
      const r = await fetch(`${BASE}/api/admin/sms-settings`, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || "Save failed");
      setServer(data as ServerState);
      setAlertPhones((data as ServerState).lowStockAlertPhones);
      setThreshold(
        (data as ServerState).lowStockAlertThreshold != null
          ? String((data as ServerState).lowStockAlertThreshold)
          : ""
      );
      setSavedAlerts(true);
      setTimeout(() => setSavedAlerts(false), 2000);
    } catch (e: any) {
      setAlertsError(e?.message || "Save failed");
    } finally {
      setSavingAlerts(false);
    }
  }

  async function handleSendLowStockTest() {
    setSendingLowStock(true);
    setLowStockFeedback(null);
    try {
      const r = await fetch(`${BASE}/api/admin/sms-settings/test-low-stock-alert`, {
        method: "POST",
        headers,
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || "Failed to send test alert");
      const sent = typeof data?.sentCount === "number" ? data.sentCount : 0;
      const total = typeof data?.totalCount === "number" ? data.totalCount : sent;
      const failed: string[] = Array.isArray(data?.results)
        ? data.results.filter((r: any) => !r?.ok).map((r: any) => r.phone)
        : [];
      const message = failed.length === 0
        ? (total === 1 ? `Test alert sent to the saved recipient.` : `Test alert sent to all ${sent} recipients.`)
        : `Test alert sent to ${sent} of ${total}. Failed: ${failed.join(", ")}.`;
      setLowStockFeedback({ kind: failed.length === 0 ? "success" : "error", message });
    } catch (e: any) {
      setLowStockFeedback({ kind: "error", message: e?.message || "Failed to send test alert" });
    } finally {
      setSendingLowStock(false);
    }
  }

  // ── Customer Chat Port (single port picker) ────────────────────────────────

  async function saveChatPort() {
    setSavingChatPort(true);
    setChatPortError("");
    setSavedChatPort(false);
    try {
      const value = chatPort === "" ? null : Number(chatPort);
      const r = await fetch(`${BASE}/api/admin/sms-settings`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ smsChatPort: value }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || "Save failed");
      const next = data as ServerState;
      setServer(next);
      setChatPort(next.smsChatPort != null ? String(next.smsChatPort) : "");
      setSavedChatPort(true);
      setTimeout(() => setSavedChatPort(false), 2000);
    } catch (e: any) {
      setChatPortError(e?.message || "Save failed");
    } finally {
      setSavingChatPort(false);
    }
  }

  // ── Customer-chat owner phone override ─────────────────────────────────────

  async function saveChatOwnerPhone() {
    setSavingChatOwnerPhone(true);
    setChatOwnerPhoneError("");
    setSavedChatOwnerPhone(false);
    try {
      const trimmed = chatOwnerPhone.trim();
      const value = trimmed === "" ? null : trimmed;
      if (value !== null && value.replace(/\D/g, "").length < 7) {
        throw new Error("Phone must contain at least 7 digits.");
      }
      const r = await fetch(`${BASE}/api/admin/sms-settings`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ smsChatOwnerPhone: value }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || "Save failed");
      const next = data as ServerState;
      setServer(next);
      setChatOwnerPhone(next.smsChatOwnerPhone ?? "");
      setSavedChatOwnerPhone(true);
      setTimeout(() => setSavedChatOwnerPhone(false), 2000);
    } catch (e: any) {
      setChatOwnerPhoneError(e?.message || "Save failed");
    } finally {
      setSavingChatOwnerPhone(false);
    }
  }

  // ── Customer Chat behavior card (forwarding + backfill window) ─────────────

  async function saveChatBehavior() {
    setSavingChat(true);
    setChatError("");
    setSavedChat(false);
    try {
      const cap = forwardCap === "" ? null : Number(forwardCap);
      const days = Number(backfillDays);
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        throw new Error("Backfill window must be between 1 and 365 days.");
      }
      const r = await fetch(`${BASE}/api/admin/sms-settings`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          smsOwnerForwardEnabled: forwardEnabled,
          smsOwnerForwardCapPer24h: cap,
          smsOwnerReplyEnabled: ownerReplyEnabled,
          smsBackfillDays: days,
        }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || "Save failed");
      const next = data as ServerState;
      setServer(next);
      setForwardEnabled(next.smsOwnerForwardEnabled);
      setForwardCap(next.smsOwnerForwardCapPer24h == null ? "" : String(next.smsOwnerForwardCapPer24h));
      setOwnerReplyEnabled(next.smsOwnerReplyEnabled);
      setBackfillDays(String(next.smsBackfillDays));
      setSavedChat(true);
      setTimeout(() => setSavedChat(false), 2000);
    } catch (e: any) {
      setChatError(e?.message || "Save failed");
    } finally {
      setSavingChat(false);
    }
  }

  async function handleRunBackfill() {
    setRunningBackfill(true);
    setBackfillFeedback(null);
    try {
      const r = await fetch(`${BASE}/api/admin/messages/backfill`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || "Failed to start backfill");
      const result = data?.result;
      if (result) {
        setBackfillFeedback({
          kind: "success",
          message: `Backfilled ${result.ingested} message${result.ingested === 1 ? "" : "s"} (${result.skipped} duplicates / ${result.errors} errors).`,
        });
      } else {
        setBackfillFeedback({ kind: "success", message: "Backfill kicked off." });
      }
      await loadBackfillStatus();
    } catch (e: any) {
      setBackfillFeedback({ kind: "error", message: e?.message || "Failed to start backfill" });
    } finally {
      setRunningBackfill(false);
    }
  }

  // ── Derived state ──────────────────────────────────────────────────────────

  // Test buttons reach the live (saved) state. Disable them when the form is
  // dirty so admins don't get confused by "I tested with my edits but they
  // didn't apply".
  const portsDirty = server ? !portsEqual(selectedPortsArray(), server.smsActivePorts) : true;
  const ownerDirty = server ? (ownerPhone.trim() || null) !== server.ownerNotificationPhone : true;
  const alertsDirty = (() => {
    if (!server) return true;
    const cleaned = alertPhones.map(p => p.trim()).filter(Boolean);
    if (!arraysEqual(cleaned, server.lowStockAlertPhones)) return true;
    const t = threshold.trim() === "" ? null : Number(threshold);
    return t !== server.lowStockAlertThreshold;
  })();

  return (
    <AdminLayout>
      <div className="space-y-6 max-w-4xl">
        <div className="flex items-center gap-3">
          <MessageSquare className="w-6 h-6 text-foreground/70" />
          <div>
            <h1 className="font-display font-bold text-2xl">SMS Settings</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Gateway ports, owner notifications, low-stock alerts, and test sends.
            </p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : loadError ? (
          <div className="bg-destructive/10 border border-destructive/30 text-destructive rounded-2xl p-4 text-sm">
            {loadError}
          </div>
        ) : (
          <>
            {/* ── Card 1: Gateway Ports ──────────────────────────────────── */}
            <section className="bg-card border border-border rounded-2xl p-6 shadow-sm space-y-4">
              <div className="flex items-center gap-2 flex-wrap">
                <Smartphone className="w-4 h-4 text-muted-foreground" />
                <h2 className="font-display font-bold text-lg">Gateway Ports</h2>
                <StatusPill ok={!!server?.ejoinConfigured} okLabel="Gateway connected" badLabel="Gateway not configured" />
              </div>
              <p className="text-sm text-muted-foreground">
                Outgoing SMS rotates through the selected ports in round-robin order so multiple SIMs can share the load.
                The gateway has {EJOIN_PORT_COUNT} physical SIM ports — tick the ones with active SIMs installed.
              </p>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Active ports</label>
                <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
                  {EJOIN_VALID_PORTS.map(p => {
                    const checked = activePorts.has(p);
                    return (
                      <label
                        key={p}
                        className={`flex items-center justify-center gap-1.5 px-3 py-2 border rounded-xl cursor-pointer text-sm font-medium transition-colors ${
                          checked
                            ? "bg-foreground text-background border-foreground"
                            : "bg-background text-foreground border-border hover:bg-secondary"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => togglePort(p)}
                          aria-label={`Port ${p}`}
                          className="sr-only"
                        />
                        Port {p}
                      </label>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Currently saved: {server?.smsActivePorts.length ? server.smsActivePorts.join(", ") : "(none)"}
                </p>
              </div>
              {portsError && <p className="text-destructive text-sm">{portsError}</p>}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={savePorts}
                  disabled={savingPorts}
                  className="flex items-center gap-2 px-5 py-2.5 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-50"
                >
                  {savingPorts ? <Loader2 className="w-4 h-4 animate-spin" /> : savedPorts ? <Check className="w-4 h-4 text-emerald-400" /> : <Save className="w-4 h-4" />}
                  {savingPorts ? "Saving…" : savedPorts ? "Saved!" : "Save Ports"}
                </button>
              </div>
            </section>

            {/* ── Card 1b: Customer Chat Port (single SIM) ──────────────── */}
            <section className="bg-card border border-border rounded-2xl p-6 shadow-sm space-y-4">
              <div className="flex items-center gap-2 flex-wrap">
                <MessagesSquare className="w-4 h-4 text-muted-foreground" />
                <h2 className="font-display font-bold text-lg">Customer Chat Port</h2>
                <StatusPill
                  ok={server?.smsChatPort != null}
                  okLabel={`Port ${server?.smsChatPort}`}
                  badLabel="Not configured"
                />
                <span className="text-xs font-normal text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">
                  Inbound: {server?.smsInboundMode === "push" ? "webhook (push)" : "poller (pull)"}
                </span>
              </div>
              <p className="text-sm text-muted-foreground">
                The single SIM that customers see when they receive any catering text — quotes, change-request replies,
                invoice notifications, event reminders, and the inquiry chat composer all go through this one port.
                Inbound texts on this port are captured into the matching inquiry's chat thread. The chat port cannot
                also be in the round-robin pool above.
              </p>
              <div className="max-w-xs">
                <label className="block text-xs font-medium text-muted-foreground mb-1.5" htmlFor="chatPortSelect">
                  Dedicated chat port
                </label>
                <select
                  id="chatPortSelect"
                  value={chatPort}
                  onChange={e => setChatPort(e.target.value)}
                  className="w-full px-4 py-2 border border-border rounded-xl bg-background"
                >
                  <option value="">— None (chat disabled) —</option>
                  {EJOIN_VALID_PORTS.map(p => (
                    <option key={p} value={p}>Port {p}</option>
                  ))}
                </select>
              </div>
              {chatPortError && <p className="text-destructive text-sm">{chatPortError}</p>}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={saveChatPort}
                  disabled={savingChatPort}
                  className="flex items-center gap-2 px-5 py-2.5 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-50"
                >
                  {savingChatPort ? <Loader2 className="w-4 h-4 animate-spin" /> : savedChatPort ? <Check className="w-4 h-4 text-emerald-400" /> : <Save className="w-4 h-4" />}
                  {savingChatPort ? "Saving…" : savedChatPort ? "Saved!" : "Save Chat Port"}
                </button>
              </div>

              {/* ── Phone number for customer chat ──────────────────────── */}
              <div className="border-t border-border pt-4 space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <label
                    className="block text-sm font-medium text-foreground"
                    htmlFor="chatOwnerPhoneInput"
                  >
                    Phone number for customer chat
                  </label>
                  {server?.smsChatOwnerPhoneSource === "db-chat" && (
                    <span className="text-xs font-normal text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
                      Active
                    </span>
                  )}
                  {server?.smsChatOwnerPhoneSource === "db-owner" && (
                    <span className="text-xs font-normal text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">
                      Falling back to Owner Notifications phone
                    </span>
                  )}
                  {server?.smsChatOwnerPhoneSource === "env" && (
                    <span className="text-xs font-normal text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">
                      Falling back to legacy OWNER_PHONE env var
                    </span>
                  )}
                  {server?.smsChatOwnerPhoneSource === "none" && (
                    <span className="text-xs font-normal text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">
                      Not configured
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Phone that receives forwarded customer texts and is recognized as the owner when replying with the
                  <code className="mx-1 px-1.5 py-0.5 bg-secondary rounded">#&lt;inquiry-id&gt;</code> tag.
                  Leave blank to keep using the Owner Notifications phone below. Either way, every chat-side message
                  (forwards, owner-relay corrective texts) is sent through the chat port above so the owner sees
                  one continuous thread per customer. Other owner alerts (low-stock, inquiry-arrival,
                  quote-response, the test owner alert) still use the Owner Notifications phone on the round-robin pool.
                </p>
                <input
                  id="chatOwnerPhoneInput"
                  type="tel"
                  value={chatOwnerPhone}
                  onChange={e => setChatOwnerPhone(e.target.value)}
                  placeholder="+1 555 123 4567"
                  className="w-full max-w-xs px-4 py-2 border border-border rounded-xl bg-background"
                />
                {chatOwnerPhoneError && (
                  <p className="text-destructive text-sm">{chatOwnerPhoneError}</p>
                )}
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={saveChatOwnerPhone}
                    disabled={savingChatOwnerPhone}
                    className="flex items-center gap-2 px-5 py-2.5 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-50"
                  >
                    {savingChatOwnerPhone ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : savedChatOwnerPhone ? (
                      <Check className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <Save className="w-4 h-4" />
                    )}
                    {savingChatOwnerPhone ? "Saving…" : savedChatOwnerPhone ? "Saved!" : "Save Chat Owner Phone"}
                  </button>
                </div>
              </div>
            </section>

            {/* ── Card 2: Owner Notifications ────────────────────────────── */}
            <section className="bg-card border border-border rounded-2xl p-6 shadow-sm space-y-4">
              <div className="flex items-center gap-2 flex-wrap">
                <UserCog className="w-4 h-4 text-muted-foreground" />
                <h2 className="font-display font-bold text-lg">Owner Notifications</h2>
                {server?.ownerNotificationPhoneSource === "db" && (
                  <span className="text-xs font-normal text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
                    Active
                  </span>
                )}
                {server?.ownerNotificationPhoneSource === "env" && (
                  <span className="text-xs font-normal text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">
                    Using legacy OWNER_PHONE env var
                  </span>
                )}
                {server?.ownerNotificationPhoneSource === "none" && (
                  <span className="text-xs font-normal text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">
                    Not configured
                  </span>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                Single phone number that receives a text whenever a new catering inquiry arrives or a guest accepts /
                requests changes on a quote. Leave blank to disable (or to fall back to the legacy <code>OWNER_PHONE</code> env var if set).
              </p>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Owner phone number</label>
                <input
                  type="tel"
                  value={ownerPhone}
                  onChange={e => setOwnerPhone(e.target.value)}
                  placeholder="+1 555 123 4567"
                  className="w-full px-4 py-2 border border-border rounded-xl bg-background"
                />
                {server?.ownerNotificationPhoneSource === "env" && (
                  <div className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                    Owner alerts are currently being sent to the legacy <code>OWNER_PHONE</code> environment value.
                    Save a number above to take control here, or unset the <code>OWNER_PHONE</code> environment value to disable owner alerts entirely.
                  </div>
                )}
              </div>
              {ownerError && <p className="text-destructive text-sm">{ownerError}</p>}
              <div className="flex items-center gap-3 flex-wrap">
                <button
                  type="button"
                  onClick={saveOwnerPhone}
                  disabled={savingOwner}
                  className="flex items-center gap-2 px-5 py-2.5 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-50"
                >
                  {savingOwner ? <Loader2 className="w-4 h-4 animate-spin" /> : savedOwner ? <Check className="w-4 h-4 text-emerald-400" /> : <Save className="w-4 h-4" />}
                  {savingOwner ? "Saving…" : savedOwner ? "Saved!" : "Save Owner Phone"}
                </button>
                <button
                  type="button"
                  onClick={handleSendOwnerTest}
                  disabled={sendingOwnerTest || ownerDirty || server?.ownerNotificationPhoneSource === "none"}
                  title={
                    server?.ownerNotificationPhoneSource === "none"
                      ? "Save an owner phone first (or set OWNER_PHONE)."
                      : ownerDirty
                      ? "Save your changes before testing."
                      : "Send a test SMS to the saved owner number."
                  }
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground border border-border rounded-xl px-3 py-2 hover:bg-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {sendingOwnerTest ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                  {sendingOwnerTest ? "Sending…" : "Send test owner alert"}
                </button>
              </div>
              {ownerTestFeedback && (
                <p className={ownerTestFeedback.kind === "success" ? "text-xs text-emerald-600" : "text-xs text-destructive"}>
                  {ownerTestFeedback.message}
                </p>
              )}
            </section>

            {/* ── Card 2b: Customer Chat (forwarding + backfill) ────────── */}
            <section className="bg-card border border-border rounded-2xl p-6 shadow-sm space-y-4">
              <div className="flex items-center gap-2 flex-wrap">
                <MessagesSquare className="w-4 h-4 text-muted-foreground" />
                <h2 className="font-display font-bold text-lg">Customer Chat</h2>
              </div>
              <p className="text-sm text-muted-foreground">
                Forward inbound customer texts to the owner phone, optionally let the owner reply back from their phone using the
                <code className="mx-1 px-1.5 py-0.5 bg-secondary rounded">#&lt;inquiry-id&gt;</code> tag, and choose how far back to
                pull existing SIM messages on first deployment. Owner forwarding goes to the chat-owner phone configured under
                Customer Chat Port (or, if blank, falls back to the Owner Notifications phone below) — at least one of the two
                must be set.
              </p>

              <div className="space-y-3">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={forwardEnabled}
                    onChange={e => setForwardEnabled(e.target.checked)}
                    className="mt-1 w-4 h-4"
                  />
                  <span className="text-sm">
                    <span className="font-medium block">Forward inbound texts to owner</span>
                    <span className="text-muted-foreground text-xs">
                      Each forward is tagged <code className="px-1 py-0.5 bg-secondary rounded">[#N]</code> so the owner knows which inquiry it belongs to.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ownerReplyEnabled}
                    onChange={e => setOwnerReplyEnabled(e.target.checked)}
                    className="mt-1 w-4 h-4"
                  />
                  <span className="text-sm">
                    <span className="font-medium block">Allow owner to reply by texting <code className="px-1 py-0.5 bg-secondary rounded">#N &lt;message&gt;</code></span>
                    <span className="text-muted-foreground text-xs">
                      Replies are routed back to the customer through the dedicated chat port. The customer never sees the owner's number.
                    </span>
                  </span>
                </label>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5" htmlFor="forwardCapSelect">
                    Forwards per inquiry per 24h
                  </label>
                  <select
                    id="forwardCapSelect"
                    value={forwardCap}
                    onChange={e => setForwardCap(e.target.value)}
                    disabled={!forwardEnabled}
                    className="w-full px-4 py-2 border border-border rounded-xl bg-background disabled:opacity-50"
                  >
                    {FORWARD_CAP_OPTIONS.map(o => (
                      <option key={o.value || "unlimited"} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    Protects the SIM from being hammered by a chatty customer. Default is 1.
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5" htmlFor="backfillDaysInput">
                    Historical backfill window (days)
                  </label>
                  <input
                    id="backfillDaysInput"
                    type="number"
                    min={1}
                    max={365}
                    step={1}
                    value={backfillDays}
                    onChange={e => setBackfillDays(e.target.value)}
                    className="w-full px-4 py-2 border border-border rounded-xl bg-background"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    How far back to pull existing SIM messages on first boot or when "Run backfill now" is clicked. Default 90 days.
                  </p>
                </div>
              </div>

              {chatError && <p className="text-destructive text-sm">{chatError}</p>}
              <div className="flex items-center gap-3 flex-wrap">
                <button
                  type="button"
                  onClick={saveChatBehavior}
                  disabled={savingChat}
                  className="flex items-center gap-2 px-5 py-2.5 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-50"
                >
                  {savingChat ? <Loader2 className="w-4 h-4 animate-spin" /> : savedChat ? <Check className="w-4 h-4 text-emerald-400" /> : <Save className="w-4 h-4" />}
                  {savingChat ? "Saving…" : savedChat ? "Saved!" : "Save Chat Settings"}
                </button>
                <button
                  type="button"
                  onClick={handleRunBackfill}
                  disabled={runningBackfill || backfillStatus?.inFlight || server?.smsChatPort == null}
                  title={
                    server?.smsChatPort == null
                      ? "Pick a customer chat port first."
                      : backfillStatus?.inFlight
                      ? "Backfill already running."
                      : "Pull historical SMS from the gateway and ingest into chat threads."
                  }
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground border border-border rounded-xl px-3 py-2 hover:bg-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {runningBackfill || backfillStatus?.inFlight ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5" />
                  )}
                  {runningBackfill || backfillStatus?.inFlight ? "Running backfill…" : "Run backfill now"}
                </button>
              </div>
              {backfillFeedback && (
                <p className={backfillFeedback.kind === "success" ? "text-xs text-emerald-600" : "text-xs text-destructive"}>
                  {backfillFeedback.message}
                </p>
              )}
              {backfillStatus && (backfillStatus.lastResult || backfillStatus.completedAt) && (
                <div className="text-xs text-muted-foreground bg-secondary/50 rounded-xl px-3 py-2">
                  {backfillStatus.lastResult ? (
                    <>
                      Last run: <strong>{new Date(backfillStatus.lastResult.finishedAt).toLocaleString()}</strong> —
                      ingested {backfillStatus.lastResult.ingested}, skipped {backfillStatus.lastResult.skipped},
                      errors {backfillStatus.lastResult.errors}.
                    </>
                  ) : backfillStatus.completedAt ? (
                    <>Last completed: <strong>{new Date(backfillStatus.completedAt).toLocaleString()}</strong>.</>
                  ) : null}
                </div>
              )}
            </section>

            {/* ── Card 3: Low-Stock Alerts ───────────────────────────────── */}
            <section className="bg-card border border-border rounded-2xl p-6 shadow-sm space-y-4">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-muted-foreground" />
                <h2 className="font-display font-bold text-lg">Low-Stock Alerts</h2>
              </div>
              <p className="text-sm text-muted-foreground">
                Send a text to the kitchen the first time an item drops to or below the threshold during an event.
                The alert fires once per crossing — restocking the item resets it so the next dip will alert again.
              </p>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Recipient phone numbers</label>
                {alertPhones.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic mb-2">No recipients — low-stock SMS is disabled.</p>
                ) : (
                  <div className="space-y-2 mb-2">
                    {alertPhones.map((phone, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <input
                          type="tel"
                          value={phone}
                          onChange={e => updateAlertPhoneAt(idx, e.target.value)}
                          placeholder="+1 555 123 4567"
                          aria-label={`Recipient phone #${idx + 1}`}
                          className="flex-1 px-4 py-2 border border-border rounded-xl bg-background"
                        />
                        <button
                          type="button"
                          onClick={() => removeAlertPhoneAt(idx)}
                          aria-label={`Remove recipient phone #${idx + 1}`}
                          className="p-2 text-muted-foreground hover:text-destructive border border-border rounded-xl hover:border-destructive/40 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  onClick={addAlertPhone}
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground border border-border rounded-xl px-3 py-1.5 hover:bg-secondary transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" /> Add another phone
                </button>
              </div>
              <div className="max-w-xs">
                <label className="block text-xs font-medium text-muted-foreground mb-1">Threshold (units remaining)</label>
                <input
                  type="number"
                  min={1}
                  max={10000}
                  step={1}
                  value={threshold}
                  onChange={e => setThreshold(e.target.value)}
                  placeholder="5"
                  className="w-full px-4 py-2 border border-border rounded-xl bg-background"
                />
                <p className="text-xs text-muted-foreground mt-1">Defaults to 5 if left blank. An alert fires once when an item drops to or below this many units.</p>
              </div>
              {alertsError && <p className="text-destructive text-sm">{alertsError}</p>}
              <div className="flex items-center gap-3 flex-wrap">
                <button
                  type="button"
                  onClick={saveAlerts}
                  disabled={savingAlerts}
                  className="flex items-center gap-2 px-5 py-2.5 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-50"
                >
                  {savingAlerts ? <Loader2 className="w-4 h-4 animate-spin" /> : savedAlerts ? <Check className="w-4 h-4 text-emerald-400" /> : <Save className="w-4 h-4" />}
                  {savingAlerts ? "Saving…" : savedAlerts ? "Saved!" : "Save Alert Settings"}
                </button>
                <button
                  type="button"
                  onClick={handleSendLowStockTest}
                  disabled={sendingLowStock || (server?.lowStockAlertPhones.length ?? 0) === 0 || alertsDirty}
                  title={
                    (server?.lowStockAlertPhones.length ?? 0) === 0
                      ? "Add and save at least one phone number first."
                      : alertsDirty
                      ? "Save your changes before testing."
                      : `Send a test SMS to all ${server?.lowStockAlertPhones.length} saved recipients.`
                  }
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground border border-border rounded-xl px-3 py-2 hover:bg-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {sendingLowStock ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                  {sendingLowStock ? "Sending…" : "Send test alert"}
                </button>
              </div>
              {lowStockFeedback && (
                <p className={lowStockFeedback.kind === "success" ? "text-xs text-emerald-600" : "text-xs text-destructive"}>
                  {lowStockFeedback.message}
                </p>
              )}
            </section>

          </>
        )}
      </div>
    </AdminLayout>
  );
}
