import { useState, useEffect, useRef } from "react";
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
  smsOwnerForwardUnmatchedEnabled: boolean;
  smsOwnerReplyEnabled: boolean;
  smsBackfillDays: number;
  smsBackfillCompletedAt: string | null;
  smsInboundMode: "push" | "poll";
  smsPollEnabled: boolean;
  smsPollIntervalSeconds: number;
  smsPollIntervalSecondsMin: number;
  smsPollIntervalSecondsMax: number;
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

// Per-poll response-body baseline used for the cadence-card bandwidth
// estimate. Derived from the original ~8.6 MB/hour @ 3s observation
// using decimal-SI units (8.6e6 bytes / 1200 polls = 7167 B/poll), so
// at the 3s default this lands at ~8.60 MB/hour and at 30s at ~860
// KB/hour — exactly matching the surrounding help-text copy. We use
// SI (1000-based) units for the /hour bandwidth label because that's
// how telecom data plans are billed; the absolute byte counts on the
// Idle Activity page intentionally still use binary KB/MB. Kept as a
// constant rather than reading actual measured bytes from the
// snapshot so the estimate stays stable when the poller hasn't
// ticked yet (e.g. fresh deploy, push mode). The Idle Activity page
// surfaces the real measured average so an admin can compare
// estimate vs. reality.
const EJOIN_ESTIMATED_BYTES_PER_POLL = 7167;

function formatBandwidthPerHour(bytesPerHour: number): string {
  if (bytesPerHour < 1000) return `${Math.round(bytesPerHour)} B/hour`;
  if (bytesPerHour < 1_000_000) return `${(bytesPerHour / 1000).toFixed(1)} KB/hour`;
  return `${(bytesPerHour / 1_000_000).toFixed(2)} MB/hour`;
}

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

// Inline "Saving… / Saved!" indicator for the per-toggle auto-save
// pattern used by the Customer Chat checkboxes. Renders nothing when
// idle so the label looks normal once the brief Saved! state fades.
function BoolToggleIndicator({ status }: { status: "idle" | "saving" | "saved" | "error" | undefined }) {
  if (!status || status === "idle") return null;
  if (status === "saving") {
    return (
      <span className="ml-2 inline-flex items-center gap-1 text-xs font-normal text-muted-foreground align-middle">
        <Loader2 className="w-3 h-3 animate-spin" />
        Saving…
      </span>
    );
  }
  if (status === "saved") {
    return (
      <span className="ml-2 inline-flex items-center gap-1 text-xs font-normal text-emerald-600 align-middle">
        <Check className="w-3 h-3" />
        Saved!
      </span>
    );
  }
  // status === "error"
  return (
    <span className="ml-2 inline-flex items-center gap-1 text-xs font-normal text-destructive align-middle">
      Save failed
    </span>
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
  // The three booleans (forward / forward-unmatched / owner-reply)
  // each auto-save on click via the per-toggle handler below — the
  // "Save Chat Settings" button only commits cap + backfill days.
  const [forwardEnabled, setForwardEnabled] = useState(false);
  const [forwardUnmatchedEnabled, setForwardUnmatchedEnabled] = useState(false);
  const [forwardCap, setForwardCap] = useState<string>("1");
  const [ownerReplyEnabled, setOwnerReplyEnabled] = useState(false);
  const [backfillDays, setBackfillDays] = useState<string>("90");
  // SIM-gateway poll cadence (toggle + interval seconds). Default 3s
  // matches the safety net set by the scheduler when nothing is
  // persisted yet. The string-state mirrors the input so the user can
  // type freely; we coerce + clamp on save.
  const [pollEnabled, setPollEnabled] = useState<boolean>(true);
  const [pollIntervalSec, setPollIntervalSec] = useState<string>("3");
  const [savingPoll, setSavingPoll] = useState(false);
  const [savedPoll, setSavedPoll] = useState(false);
  const [pollError, setPollError] = useState("");
  const [runningPollNow, setRunningPollNow] = useState(false);
  const [pollNowFeedback, setPollNowFeedback] = useState<Feedback>(null);
  const [savingChat, setSavingChat] = useState(false);
  const [savedChat, setSavedChat] = useState(false);
  const [chatError, setChatError] = useState("");

  // Per-toggle auto-save state. Keyed by the server field name so the
  // checkbox label can render its own "Saving… / Saved!" indicator
  // without the three booleans interfering with each other.
  type BoolToggleField =
    | "smsOwnerForwardEnabled"
    | "smsOwnerForwardUnmatchedEnabled"
    | "smsOwnerReplyEnabled";
  type BoolToggleStatus = "idle" | "saving" | "saved" | "error";
  const [boolToggleStatus, setBoolToggleStatus] = useState<
    Partial<Record<BoolToggleField, BoolToggleStatus>>
  >({});
  const [boolToggleError, setBoolToggleError] = useState<
    Partial<Record<BoolToggleField, string>>
  >({});
  // Per-field monotonic request id. Each persistChatBoolean call bumps the
  // counter for its field and remembers the value it was issued under;
  // when the response (success OR error) finally arrives, it only mutates
  // state if its captured id still matches the latest. This is what stops
  // a slow earlier toggle from clobbering a faster later toggle when the
  // admin clicks the same checkbox twice in quick succession (or two
  // different checkboxes in quick succession). Without this, a stale
  // success response could re-sync ALL three booleans from an outdated
  // server snapshot and undo the user's most recent click.
  const boolToggleReqIdRef = useRef<Record<BoolToggleField, number>>({
    smsOwnerForwardEnabled: 0,
    smsOwnerForwardUnmatchedEnabled: 0,
    smsOwnerReplyEnabled: 0,
  });

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

  // Feedback for the pre-built test buttons.
  const [lowStockFeedback, setLowStockFeedback] = useState<Feedback>(null);
  const [sendingLowStock, setSendingLowStock] = useState(false);
  const [ownerTestFeedback, setOwnerTestFeedback] = useState<Feedback>(null);
  const [sendingOwnerTest, setSendingOwnerTest] = useState(false);
  const [chatOwnerTestFeedback, setChatOwnerTestFeedback] = useState<Feedback>(null);
  const [sendingChatOwnerTest, setSendingChatOwnerTest] = useState(false);

  // Per-button post-send cooldown so admins can't fire repeated test
  // texts at the gateway / their own phone in rapid succession. Tracked
  // as the unix-ms timestamp at which the button becomes pressable
  // again (0 = no cooldown active). 10s window matches the time it
  // typically takes a real SMS to round-trip the gateway, so by the
  // time the cooldown clears the admin has either seen the test text
  // or has good evidence that something went wrong.
  const TEST_COOLDOWN_MS = 10_000;
  const [ownerTestCooldownUntil, setOwnerTestCooldownUntil] = useState(0);
  const [chatOwnerTestCooldownUntil, setChatOwnerTestCooldownUntil] = useState(0);
  // Drives a 1Hz re-render so the "Retry in Ns" countdown ticks down
  // visually without each cooldown owning its own setInterval.
  const [nowTs, setNowTs] = useState(() => Date.now());
  useEffect(() => {
    const anyActive = ownerTestCooldownUntil > nowTs || chatOwnerTestCooldownUntil > nowTs;
    if (!anyActive) return;
    const id = setInterval(() => setNowTs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [ownerTestCooldownUntil, chatOwnerTestCooldownUntil, nowTs]);
  const ownerTestCooldownLeft = Math.max(0, Math.ceil((ownerTestCooldownUntil - nowTs) / 1000));
  const chatOwnerTestCooldownLeft = Math.max(0, Math.ceil((chatOwnerTestCooldownUntil - nowTs) / 1000));

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
      setForwardUnmatchedEnabled(!!data.smsOwnerForwardUnmatchedEnabled);
      setForwardCap(data.smsOwnerForwardCapPer24h == null ? "" : String(data.smsOwnerForwardCapPer24h));
      setOwnerReplyEnabled(!!data.smsOwnerReplyEnabled);
      setBackfillDays(String(data.smsBackfillDays ?? 90));
      setPollEnabled(!!data.smsPollEnabled);
      setPollIntervalSec(String(data.smsPollIntervalSeconds ?? 3));
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
      // Cooldown applies whether the send succeeded or failed — a
      // failure that's actually a slow-but-eventually-delivered SMS
      // shouldn't let the admin spam-retry and end up with five
      // identical texts on their phone.
      setOwnerTestCooldownUntil(Date.now() + TEST_COOLDOWN_MS);
      setNowTs(Date.now());
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

  async function handleSendChatOwnerTest() {
    setSendingChatOwnerTest(true);
    setChatOwnerTestFeedback(null);
    try {
      const r = await fetch(`${BASE}/api/admin/sms-settings/test-chat-owner-alert`, { method: "POST", headers });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || "Failed to send chat-owner test");
      const sourceLabel =
        data?.smsChatOwnerPhoneSource === "db-owner"
          ? " (using Owner Notifications phone)"
          : data?.smsChatOwnerPhoneSource === "env"
          ? " (using legacy OWNER_PHONE env var)"
          : "";
      const portInfo = data?.port != null ? ` via chat port ${data.port}` : "";
      const gateway = data?.gatewayResponse ? ` Gateway: ${data.gatewayResponse}.` : "";
      setChatOwnerTestFeedback({
        kind: "success",
        message: `Sent test to ${data?.sentTo}${portInfo}${sourceLabel}.${gateway}`,
      });
    } catch (e: any) {
      setChatOwnerTestFeedback({ kind: "error", message: e?.message || "Failed to send chat-owner test" });
    } finally {
      setSendingChatOwnerTest(false);
      // Same per-button cooldown shape as the owner-alert test —
      // applies on success or failure so admins can't spam-retry the
      // chat port.
      setChatOwnerTestCooldownUntil(Date.now() + TEST_COOLDOWN_MS);
      setNowTs(Date.now());
    }
  }

  // ── SIM gateway poll cadence (toggle + interval) ───────────────────
  // Persists `smsPollEnabled` + `smsPollIntervalSeconds`. The scheduler
  // re-reads these every tick so changes take effect on the very next
  // cycle without a server restart. The "Run now" button hits a
  // dedicated endpoint that ignores the enabled flag so an operator
  // can force one cycle even while polling is paused.
  async function savePollCadence() {
    setSavingPoll(true);
    setPollError("");
    setSavedPoll(false);
    try {
      const seconds = Number(pollIntervalSec);
      const min = server?.smsPollIntervalSecondsMin ?? 3;
      const max = server?.smsPollIntervalSecondsMax ?? 86_400;
      if (!Number.isFinite(seconds) || !Number.isInteger(seconds) || seconds < min || seconds > max) {
        throw new Error(`Interval must be an integer between ${min} and ${max} seconds.`);
      }
      const r = await fetch(`${BASE}/api/admin/sms-settings`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          smsPollEnabled: pollEnabled,
          smsPollIntervalSeconds: seconds,
        }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || "Save failed");
      const next = data as ServerState;
      setServer(next);
      setPollEnabled(!!next.smsPollEnabled);
      setPollIntervalSec(String(next.smsPollIntervalSeconds));
      setSavedPoll(true);
      setTimeout(() => setSavedPoll(false), 2000);
    } catch (e: any) {
      setPollError(e?.message || "Save failed");
    } finally {
      setSavingPoll(false);
    }
  }

  async function runPollNow() {
    setRunningPollNow(true);
    setPollNowFeedback(null);
    try {
      const r = await fetch(`${BASE}/api/admin/sms-settings/poller/run-now`, {
        method: "POST",
        headers,
      });
      const data: {
        skipped?: boolean;
        skipReason?: "already-running" | "ejoin-not-configured" | "no-chat-port";
        fetchedCount?: number;
        ingested?: number;
        errors?: number;
        error?: string;
      } | null = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || "Run failed");
      // Translate the scheduler's structured result into something the
      // admin can act on. Skips are not errors but the operator needs
      // to know why nothing was pulled.
      let message: string;
      let kind: "success" | "error" = "success";
      if (data?.skipped) {
        kind = "error";
        switch (data.skipReason) {
          case "already-running":
            message = "Another poll is already in progress — try again in a few seconds.";
            break;
          case "ejoin-not-configured":
            message = "Skipped: the SIM gateway URL or credentials are not configured.";
            break;
          case "no-chat-port":
            message = "Skipped: no customer chat port is set under Phone Pool.";
            break;
          default:
            message = "Poll was skipped.";
        }
      } else {
        const fetched = data?.fetchedCount ?? 0;
        const ingested = data?.ingested ?? 0;
        const errs = data?.errors ?? 0;
        if (fetched === 0) {
          message = "Poll finished — no new messages.";
        } else {
          message = `Pulled ${fetched} message${fetched === 1 ? "" : "s"}, saved ${ingested}.`;
        }
        if (errs > 0) {
          message += ` ${errs} error${errs === 1 ? "" : "s"} during ingest.`;
          kind = "error";
        }
      }
      setPollNowFeedback({ kind, message });
      setTimeout(() => setPollNowFeedback(null), 6000);
    } catch (e: any) {
      setPollNowFeedback({ kind: "error", message: e?.message || "Run failed" });
    } finally {
      setRunningPollNow(false);
    }
  }

  // ── Customer Chat behavior card (forwarding + backfill window) ─────────────

  // Persists ONLY the cap + backfill-window inputs. The three booleans
  // (forwardEnabled / forwardUnmatchedEnabled / ownerReplyEnabled) each
  // auto-save the moment the admin clicks them via persistChatBoolean
  // below — historically they were bundled into this section save,
  // which left the on-screen checkbox state out of sync with the DB
  // any time the admin toggled but didn't click Save (root cause of
  // the silently-disabled owner-reply incident).
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
          smsOwnerForwardCapPer24h: cap,
          smsBackfillDays: days,
        }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || "Save failed");
      const next = data as ServerState;
      setServer(next);
      setForwardCap(next.smsOwnerForwardCapPer24h == null ? "" : String(next.smsOwnerForwardCapPer24h));
      setBackfillDays(String(next.smsBackfillDays));
      setSavedChat(true);
      setTimeout(() => setSavedChat(false), 2000);
    } catch (e: any) {
      setChatError(e?.message || "Save failed");
    } finally {
      setSavingChat(false);
    }
  }

  // Auto-save handler for the three Customer Chat boolean toggles. Each
  // checkbox calls this on change; the DB write happens immediately so
  // a user who toggles and walks away can never be surprised by the
  // server still holding the old value. On failure we revert the local
  // checkbox state and surface a per-toggle error message — the toggle
  // visually un-flips so the admin sees that the change didn't take.
  async function persistChatBoolean(
    field: BoolToggleField,
    nextValue: boolean,
    applyLocal: (v: boolean) => void,
  ): Promise<void> {
    // Optimistic update: flip the checkbox immediately so the click
    // feels instant even if the network is slow.
    applyLocal(nextValue);
    setBoolToggleStatus(s => ({ ...s, [field]: "saving" }));
    setBoolToggleError(s => ({ ...s, [field]: undefined }));
    // Bump the per-field request id and capture it for this call.
    // When the response lands we use this captured id to decide whether
    // we are still the latest in-flight request for this field; if not,
    // we silently drop the response so we don't clobber a newer click.
    const myReqId = ++boolToggleReqIdRef.current[field];
    const isLatest = () => boolToggleReqIdRef.current[field] === myReqId;
    try {
      const r = await fetch(`${BASE}/api/admin/sms-settings`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ [field]: nextValue }),
      });
      const data: unknown = await r.json().catch(() => null);
      if (!r.ok) {
        const errMsg =
          data && typeof data === "object" && "error" in data && typeof (data as { error?: unknown }).error === "string"
            ? (data as { error: string }).error
            : "Save failed";
        throw new Error(errMsg);
      }
      // BoolToggleField is a strict subset of ServerState's keys whose
      // value type is boolean, so `next[field]` is typed as boolean
      // without any cast.
      const next = data as ServerState;
      const persistedValue: boolean = next[field];
      // Stale response: a newer toggle has been issued for this field
      // since we kicked off; do nothing so we don't override the user's
      // most recent intent. The newer in-flight request will resolve
      // and produce the authoritative state.
      if (!isLatest()) return;
      // Re-sync only the field we toggled (server PUT only changed
      // that one) and update server snapshot. We deliberately do NOT
      // overwrite the OTHER two booleans from this response — a parallel
      // in-flight toggle on a different field could otherwise be
      // clobbered by this response's older snapshot of that field.
      setServer(s => (s ? { ...s, [field]: persistedValue } : next));
      applyLocal(persistedValue);
      setBoolToggleStatus(s => ({ ...s, [field]: "saved" }));
      setTimeout(() => {
        if (!isLatest()) return;
        setBoolToggleStatus(s => (s[field] === "saved" ? { ...s, [field]: "idle" } : s));
      }, 1500);
    } catch (e: unknown) {
      // Stale failure: drop it. The newer in-flight request owns the
      // user-visible state for this field.
      if (!isLatest()) return;
      // Revert the optimistic flip so the checkbox reflects what's
      // actually persisted.
      applyLocal(!nextValue);
      const errMsg = e instanceof Error ? e.message : "Save failed";
      setBoolToggleStatus(s => ({ ...s, [field]: "error" }));
      setBoolToggleError(s => ({ ...s, [field]: errMsg }));
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
  const chatOwnerDirty = server ? (chatOwnerPhone.trim() || null) !== server.smsChatOwnerPhone : true;
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
                <div className="flex items-center gap-3 flex-wrap">
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
                  <button
                    type="button"
                    onClick={handleSendChatOwnerTest}
                    disabled={
                      sendingChatOwnerTest ||
                      chatOwnerTestCooldownLeft > 0 ||
                      chatOwnerDirty ||
                      server?.smsChatOwnerPhoneSource === "none" ||
                      server?.smsChatPort == null
                    }
                    title={
                      server?.smsChatPort == null
                        ? "Pick a customer chat port first."
                        : server?.smsChatOwnerPhoneSource === "none"
                        ? "Save a chat-owner phone first (or fall back to Owner Notifications / OWNER_PHONE)."
                        : chatOwnerDirty
                        ? "Save your changes before testing."
                        : chatOwnerTestCooldownLeft > 0
                        ? `Cooling down — try again in ${chatOwnerTestCooldownLeft}s.`
                        : "Send a test SMS through the chat port to the effective chat-owner number."
                    }
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground border border-border rounded-xl px-3 py-2 hover:bg-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {sendingChatOwnerTest ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                    {sendingChatOwnerTest
                      ? "Sending…"
                      : chatOwnerTestCooldownLeft > 0
                      ? `Retry in ${chatOwnerTestCooldownLeft}s`
                      : "Send Test Chat-Owner Text"}
                  </button>
                </div>
                {chatOwnerTestFeedback && (
                  <p className={chatOwnerTestFeedback.kind === "success" ? "text-xs text-emerald-600" : "text-xs text-destructive"}>
                    {chatOwnerTestFeedback.message}
                  </p>
                )}
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
                  disabled={
                    sendingOwnerTest ||
                    ownerTestCooldownLeft > 0 ||
                    ownerDirty ||
                    server?.ownerNotificationPhoneSource === "none"
                  }
                  title={
                    server?.ownerNotificationPhoneSource === "none"
                      ? "Save an owner phone first (or set OWNER_PHONE)."
                      : ownerDirty
                      ? "Save your changes before testing."
                      : ownerTestCooldownLeft > 0
                      ? `Cooling down — try again in ${ownerTestCooldownLeft}s.`
                      : "Send a test SMS to the saved owner number."
                  }
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground border border-border rounded-xl px-3 py-2 hover:bg-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {sendingOwnerTest ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                  {sendingOwnerTest
                    ? "Sending…"
                    : ownerTestCooldownLeft > 0
                    ? `Retry in ${ownerTestCooldownLeft}s`
                    : "Send test owner alert"}
                </button>
              </div>
              {ownerTestFeedback && (
                <p className={ownerTestFeedback.kind === "success" ? "text-xs text-emerald-600" : "text-xs text-destructive"}>
                  {ownerTestFeedback.message}
                </p>
              )}
            </section>

            {/* ── Card 2a': SIM Gateway Poll Cadence ─────────────────────
                 Controls the inbound-SMS poll loop on the SIM gateway.
                 Defaults to 3s which generates ~8.6 MB/hour of HTTP
                 traffic — operators on a slow link can dial it back to
                 reduce load. Toggle pauses the loop entirely; the
                 push-mode safety-net catch-up still runs every 10 min
                 from the scheduler regardless. */}
            <section className="bg-card border border-border rounded-2xl p-6 shadow-sm space-y-4">
              <div className="flex items-center gap-2 flex-wrap">
                <RefreshCw className="w-4 h-4 text-muted-foreground" />
                <h2 className="font-display font-bold text-lg">SIM Gateway Poll Cadence</h2>
                <StatusPill ok={pollEnabled} okLabel="Polling on" badLabel="Polling paused" />
              </div>
              <p className="text-sm text-muted-foreground">
                How often the API server asks the SIM gateway for new inbound texts. Default is every 3 seconds
                (~8.6 MB/hour of HTTP traffic). Increase the interval to reduce load — at 30 seconds the same
                traffic drops to ~860 KB/hour. Push-mode catch-up safety net (every 10 minutes) is unaffected.
              </p>
              {/*
                Reactive bandwidth estimate. Recomputes as the admin
                types a new interval so the impact of the change is
                visible BEFORE saving. The constant baseline keeps the
                estimate stable across deploys; the Idle Activity page
                surfaces the actual measured average for ground truth.
              */}
              {(() => {
                const seconds = Number(pollIntervalSec);
                const min = server?.smsPollIntervalSecondsMin ?? 3;
                const max = server?.smsPollIntervalSecondsMax ?? 86_400;
                const valid = Number.isFinite(seconds) && Number.isInteger(seconds) && seconds >= min && seconds <= max;
                if (!valid) return null;
                const pollsPerHour = 3600 / seconds;
                const bytesPerHour = pollsPerHour * EJOIN_ESTIMATED_BYTES_PER_POLL;
                // Push mode ignores the operator-tunable interval and
                // uses a 10-minute safety-net cadence instead. Surface
                // both numbers so the admin understands the typed-in
                // interval doesn't actually take effect in push mode.
                const inPush = server?.smsInboundMode === "push";
                const pushBytesPerHour = (3600 / 600) * EJOIN_ESTIMATED_BYTES_PER_POLL;
                return (
                  <div className="bg-secondary/50 border border-border rounded-xl px-4 py-3 text-sm space-y-1">
                    <div>
                      <span className="text-muted-foreground">Estimated gateway bandwidth at this interval: </span>
                      <span className="font-semibold tabular-nums">~{formatBandwidthPerHour(bytesPerHour)}</span>
                    </div>
                    {inPush && (
                      <div className="text-amber-700">
                        Push mode is active — the live cadence is the 10-minute safety-net (~{formatBandwidthPerHour(pushBytesPerHour)}),
                        and the interval above is ignored until you switch back to poll mode.
                      </div>
                    )}
                    <div className="text-muted-foreground text-xs">
                      Estimate uses ~{(EJOIN_ESTIMATED_BYTES_PER_POLL / 1000).toFixed(1)} KB per poll.
                      Actual usage is shown on the Idle Activity page.
                    </div>
                  </div>
                );
              })()}
              <div className="space-y-3">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={pollEnabled}
                    onChange={e => setPollEnabled(e.target.checked)}
                    className="mt-1 w-4 h-4"
                  />
                  <span className="text-sm">
                    <span className="font-medium block">Enable inbound poll loop</span>
                    <span className="text-muted-foreground text-xs">
                      Turn OFF to stop the periodic poll entirely (e.g. during maintenance). The "Run poll now"
                      button below still works while paused.
                    </span>
                  </span>
                </label>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5" htmlFor="smsPollIntervalInput">
                  Poll interval (seconds)
                </label>
                <input
                  id="smsPollIntervalInput"
                  type="number"
                  min={server?.smsPollIntervalSecondsMin ?? 3}
                  max={server?.smsPollIntervalSecondsMax ?? 600}
                  step={1}
                  value={pollIntervalSec}
                  onChange={e => setPollIntervalSec(e.target.value)}
                  className="w-full sm:w-48 px-4 py-2 border border-border rounded-xl bg-background"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Range: {server?.smsPollIntervalSecondsMin ?? 3}–{server?.smsPollIntervalSecondsMax ?? 600} seconds.
                  Takes effect on the next poll cycle.
                </p>
              </div>
              {pollError && <p className="text-destructive text-sm">{pollError}</p>}
              <div className="flex items-center gap-3 flex-wrap">
                <button
                  type="button"
                  onClick={savePollCadence}
                  disabled={savingPoll}
                  className="flex items-center gap-2 px-5 py-2.5 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-50"
                >
                  {savingPoll ? <Loader2 className="w-4 h-4 animate-spin" /> : savedPoll ? <Check className="w-4 h-4 text-emerald-400" /> : <Save className="w-4 h-4" />}
                  {savingPoll ? "Saving…" : savedPoll ? "Saved!" : "Save Poll Settings"}
                </button>
                <button
                  type="button"
                  onClick={runPollNow}
                  disabled={runningPollNow}
                  title="Force one poll cycle now (works even when polling is paused)."
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground border border-border rounded-xl px-3 py-2 hover:bg-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {runningPollNow ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                  {runningPollNow ? "Running…" : "Run poll now"}
                </button>
              </div>
              {pollNowFeedback && (
                <p className={pollNowFeedback.kind === "success" ? "text-xs text-emerald-600" : "text-xs text-destructive"}>
                  {pollNowFeedback.message}
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
                {/*
                  Each checkbox is disabled while its OWN auto-save PUT
                  is in flight (status === "saving") so a fast double-
                  click can't queue a second toggle on top of an
                  unresolved first one. The unmatched checkbox is
                  additionally disabled when the parent forward toggle
                  is OFF (the unmatched gate is meaningless without it).
                */}
                <label className={`flex items-start gap-3 ${boolToggleStatus.smsOwnerForwardEnabled === "saving" ? "cursor-not-allowed opacity-70" : "cursor-pointer"}`}>
                  <input
                    type="checkbox"
                    checked={forwardEnabled}
                    disabled={boolToggleStatus.smsOwnerForwardEnabled === "saving"}
                    onChange={e =>
                      persistChatBoolean("smsOwnerForwardEnabled", e.target.checked, setForwardEnabled)
                    }
                    className="mt-1 w-4 h-4"
                  />
                  <span className="text-sm">
                    <span className="font-medium block">
                      Forward inbound texts to owner
                      <BoolToggleIndicator status={boolToggleStatus.smsOwnerForwardEnabled} />
                    </span>
                    <span className="text-muted-foreground text-xs">
                      Each forward is tagged <code className="px-1 py-0.5 bg-secondary rounded">[#N]</code> so the owner knows which inquiry it belongs to. Saves automatically on click.
                    </span>
                    {boolToggleError.smsOwnerForwardEnabled && (
                      <span className="text-destructive text-xs block">{boolToggleError.smsOwnerForwardEnabled}</span>
                    )}
                  </span>
                </label>
                <label className={`flex items-start gap-3 ${(!forwardEnabled || boolToggleStatus.smsOwnerForwardUnmatchedEnabled === "saving") ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}>
                  <input
                    type="checkbox"
                    checked={forwardUnmatchedEnabled}
                    disabled={!forwardEnabled || boolToggleStatus.smsOwnerForwardUnmatchedEnabled === "saving"}
                    onChange={e =>
                      persistChatBoolean(
                        "smsOwnerForwardUnmatchedEnabled",
                        e.target.checked,
                        setForwardUnmatchedEnabled,
                      )
                    }
                    className="mt-1 w-4 h-4"
                  />
                  <span className="text-sm">
                    <span className="font-medium block">
                      Also forward texts from unknown senders
                      <BoolToggleIndicator status={boolToggleStatus.smsOwnerForwardUnmatchedEnabled} />
                    </span>
                    <span className="text-muted-foreground text-xs">
                      OFF by default — texts from numbers that don't match any catering inquiry (random spam, verification codes, wrong numbers) still land in the Unmatched inbox but are never forwarded to the owner phone. Turn this ON only if you want every inbound, including unknowns, texted to the owner. Requires "Forward inbound texts to owner" above.
                    </span>
                    {boolToggleError.smsOwnerForwardUnmatchedEnabled && (
                      <span className="text-destructive text-xs block">{boolToggleError.smsOwnerForwardUnmatchedEnabled}</span>
                    )}
                  </span>
                </label>
                <label className={`flex items-start gap-3 ${boolToggleStatus.smsOwnerReplyEnabled === "saving" ? "cursor-not-allowed opacity-70" : "cursor-pointer"}`}>
                  <input
                    type="checkbox"
                    checked={ownerReplyEnabled}
                    disabled={boolToggleStatus.smsOwnerReplyEnabled === "saving"}
                    onChange={e =>
                      persistChatBoolean("smsOwnerReplyEnabled", e.target.checked, setOwnerReplyEnabled)
                    }
                    className="mt-1 w-4 h-4"
                  />
                  <span className="text-sm">
                    <span className="font-medium block">
                      Allow owner to reply by texting <code className="px-1 py-0.5 bg-secondary rounded">#N &lt;message&gt;</code>
                      <BoolToggleIndicator status={boolToggleStatus.smsOwnerReplyEnabled} />
                    </span>
                    <span className="text-muted-foreground text-xs">
                      Replies are routed back to the customer through the dedicated chat port. The customer never sees the owner's number. Saves automatically on click.
                    </span>
                    {boolToggleError.smsOwnerReplyEnabled && (
                      <span className="text-destructive text-xs block">{boolToggleError.smsOwnerReplyEnabled}</span>
                    )}
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
