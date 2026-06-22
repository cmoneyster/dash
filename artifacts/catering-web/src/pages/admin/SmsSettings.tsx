import { useState, useEffect, useRef } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import { getAdminToken } from "@/components/AdminGuard";
import {
  Save, Check, Loader2, MessageSquare, Plus, Trash2, Send,
  AlertTriangle, Smartphone, UserCog, MessagesSquare, RefreshCw,
  Webhook, Copy, ChevronDown, ChevronUp,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// Local "what we last loaded / last saved" so the buttons can detect unsaved
// edits and gate the test-action buttons (the test endpoints always send to
// what's persisted, never to the dirty form state).
type ServerState = {
  smsActivePorts: number[];
  ownerNotificationPhone: string | null;
  ownerNotificationEmail: string | null;
  ownerNotificationEmailSource: "db" | "hardcoded";
  lowStockAlertPhones: string[];
  lowStockAlertThreshold: number | null;
  ejoinConfigured: boolean;
  ownerNotificationPhoneSource: "db" | "env" | "none";
  smsChatPort: number | null;
  smsChatOwnerPhone: string | null;
  smsChatOwnerPhoneSource: "db-chat" | "db-owner" | "env" | "none";
  smsChatOwnerEmail: string | null;
  smsChatOwnerEmailSource: "db-chat" | "db-owner" | "hardcoded";
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
  smsWebhookUrl: string | null;
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
    <span className="text-xs font-normal text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded-full">{okLabel}</span>
  ) : (
    <span className="text-xs font-normal text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 rounded-full">{badLabel}</span>
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

  // Customer-chat owner-email override (the address that receives chat
  // human-handoff alert emails). Empty = fall back to the Owner
  // Notifications email below, then to the legacy hardcoded recipient.
  const [chatOwnerEmail, setChatOwnerEmail] = useState<string>("");
  const [savingChatOwnerEmail, setSavingChatOwnerEmail] = useState(false);
  const [savedChatOwnerEmail, setSavedChatOwnerEmail] = useState(false);
  const [chatOwnerEmailError, setChatOwnerEmailError] = useState("");

  // Owner Notifications email (DB-managed fallback for chat handoffs
  // and any future owner email alerts).
  const [ownerEmail, setOwnerEmail] = useState<string>("");
  const [savingOwnerEmail, setSavingOwnerEmail] = useState(false);
  const [savedOwnerEmail, setSavedOwnerEmail] = useState(false);
  const [ownerEmailError, setOwnerEmailError] = useState("");

  // Customer-chat behavior card form state.
  // The three booleans (forward / forward-unmatched / owner-reply)
  // each auto-save on click via the per-toggle handler below — the
  // "Save Chat Settings" button only commits cap + backfill days.
  const [forwardEnabled, setForwardEnabled] = useState(false);
  const [forwardUnmatchedEnabled, setForwardUnmatchedEnabled] = useState(false);
  const [forwardCap, setForwardCap] = useState<string>("1");
  const [ownerReplyEnabled, setOwnerReplyEnabled] = useState(false);
  const [backfillDays, setBackfillDays] = useState<string>("90");
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
  const [webhookTestFeedback, setWebhookTestFeedback] = useState<Feedback>(null);
  const [regeneratingSecret, setRegeneratingSecret] = useState(false);
  const [regenerateSecretFeedback, setRegenerateSecretFeedback] = useState<Feedback>(null);
  const [sendingWebhookTest, setSendingWebhookTest] = useState(false);

  // Copy-to-clipboard flash state for the webhook URL.
  const [webhookUrlCopied, setWebhookUrlCopied] = useState(false);

  // Setup instructions accordion.
  const [showSetupInstructions, setShowSetupInstructions] = useState(false);

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
  const [webhookTestCooldownUntil, setWebhookTestCooldownUntil] = useState(0);
  // Drives a 1Hz re-render so the "Retry in Ns" countdown ticks down
  // visually without each cooldown owning its own setInterval.
  const [nowTs, setNowTs] = useState(() => Date.now());
  useEffect(() => {
    const anyActive = ownerTestCooldownUntil > nowTs || chatOwnerTestCooldownUntil > nowTs || webhookTestCooldownUntil > nowTs;
    if (!anyActive) return;
    const id = setInterval(() => setNowTs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [ownerTestCooldownUntil, chatOwnerTestCooldownUntil, webhookTestCooldownUntil, nowTs]);
  const ownerTestCooldownLeft = Math.max(0, Math.ceil((ownerTestCooldownUntil - nowTs) / 1000));
  const chatOwnerTestCooldownLeft = Math.max(0, Math.ceil((chatOwnerTestCooldownUntil - nowTs) / 1000));
  const webhookTestCooldownLeft = Math.max(0, Math.ceil((webhookTestCooldownUntil - nowTs) / 1000));

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
      setChatOwnerEmail(data.smsChatOwnerEmail ?? "");
      setOwnerEmail(data.ownerNotificationEmail ?? "");
      setForwardEnabled(!!data.smsOwnerForwardEnabled);
      setForwardUnmatchedEnabled(!!data.smsOwnerForwardUnmatchedEnabled);
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

  // ── Customer-chat owner email override ─────────────────────────────────────
  // Mirrors saveChatOwnerPhone but for the alert email recipient used
  // by the chat human-handoff tool. Resolution order at send time:
  // smsChatOwnerEmail → ownerNotificationEmail → hardcoded ALERT_TO.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  async function saveChatOwnerEmail() {
    setSavingChatOwnerEmail(true);
    setChatOwnerEmailError("");
    setSavedChatOwnerEmail(false);
    try {
      const trimmed = chatOwnerEmail.trim();
      const value = trimmed === "" ? null : trimmed;
      if (value !== null && (value.length > 254 || !EMAIL_RE.test(value))) {
        throw new Error("Email must be a valid address.");
      }
      const r = await fetch(`${BASE}/api/admin/sms-settings`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ smsChatOwnerEmail: value }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || "Save failed");
      const next = data as ServerState;
      setServer(next);
      setChatOwnerEmail(next.smsChatOwnerEmail ?? "");
      setSavedChatOwnerEmail(true);
      setTimeout(() => setSavedChatOwnerEmail(false), 2000);
    } catch (e: any) {
      setChatOwnerEmailError(e?.message || "Save failed");
    } finally {
      setSavingChatOwnerEmail(false);
    }
  }

  async function saveOwnerEmail() {
    setSavingOwnerEmail(true);
    setOwnerEmailError("");
    setSavedOwnerEmail(false);
    try {
      const trimmed = ownerEmail.trim();
      const value = trimmed === "" ? null : trimmed;
      if (value !== null && (value.length > 254 || !EMAIL_RE.test(value))) {
        throw new Error("Email must be a valid address.");
      }
      const r = await fetch(`${BASE}/api/admin/sms-settings`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ ownerNotificationEmail: value }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || "Save failed");
      const next = data as ServerState;
      setServer(next);
      setOwnerEmail(next.ownerNotificationEmail ?? "");
      setSavedOwnerEmail(true);
      setTimeout(() => setSavedOwnerEmail(false), 2000);
    } catch (e: any) {
      setOwnerEmailError(e?.message || "Save failed");
    } finally {
      setSavingOwnerEmail(false);
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

  // ── Webhook push mode — test inbound ──────────────────────────────────────
  // Fires a synthetic message through ingestInbound() on the server so the
  // admin can verify the full pipeline without needing the real gateway to
  // fire. Uses a fake phone (+10000000001) so it lands in Unmatched Messages.
  async function handleTestWebhookInbound() {
    setSendingWebhookTest(true);
    setWebhookTestFeedback(null);
    try {
      const r = await fetch(`${BASE}/api/admin/sms-settings/test-webhook-inbound`, {
        method: "POST",
        headers,
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || "Test failed");
      setWebhookTestFeedback({
        kind: "success",
        message: "Test message ingested — check Admin → Messages → Unmatched to confirm.",
      });
    } catch (e: any) {
      setWebhookTestFeedback({ kind: "error", message: e?.message || "Test failed" });
    } finally {
      setSendingWebhookTest(false);
      setWebhookTestCooldownUntil(Date.now() + TEST_COOLDOWN_MS);
      setNowTs(Date.now());
    }
  }

  function copyWebhookUrl() {
    const url = server?.smsWebhookUrl;
    if (!url) return;
    navigator.clipboard.writeText(url).then(() => {
      setWebhookUrlCopied(true);
      setTimeout(() => setWebhookUrlCopied(false), 2000);
    });
  }

  async function handleRegenerateSecret() {
    if (!confirm("This will generate a new secret and invalidate the current webhook URL. You'll need to update the URL in your eJoinTech gateway settings afterwards. Continue?")) return;
    setRegeneratingSecret(true);
    setRegenerateSecretFeedback(null);
    try {
      const r = await fetch(`${BASE}/api/admin/sms-settings/regenerate-webhook-secret`, {
        method: "POST",
        headers,
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || "Failed to regenerate");
      setServer(data as ServerState);
      setRegenerateSecretFeedback({ kind: "success", message: "New secret generated — copy the updated URL and paste it into eJoinTech." });
    } catch (e: any) {
      setRegenerateSecretFeedback({ kind: "error", message: e?.message || "Regeneration failed" });
    } finally {
      setRegeneratingSecret(false);
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

            {/* ── Card 1b: Customer Chat (port + phone + email) ────────── */}
            <section className="bg-card border border-border rounded-2xl p-6 shadow-sm space-y-4">
              <div className="flex items-center gap-2 flex-wrap">
                <MessagesSquare className="w-4 h-4 text-muted-foreground" />
                <h2 className="font-display font-bold text-lg">Customer Chat</h2>
                <StatusPill
                  ok={server?.smsChatPort != null}
                  okLabel={`Port ${server?.smsChatPort}`}
                  badLabel="Not configured"
                />
                <span className="text-xs font-normal text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">
                  Inbound: {server?.smsInboundMode === "push" ? "webhook (push)" : "poller (pull)"}
                </span>
              </div>

              {/* ── Customer Chat Port subsection ──────────────────────── */}
              <h3 className="font-display font-semibold text-sm text-foreground/80 uppercase tracking-wide">
                Customer Chat Port
              </h3>
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
                    <span className="text-xs font-normal text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded-full">
                      Active
                    </span>
                  )}
                  {server?.smsChatOwnerPhoneSource === "db-owner" && (
                    <span className="text-xs font-normal text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">
                      Falling back to Owner Notifications phone
                    </span>
                  )}
                  {server?.smsChatOwnerPhoneSource === "env" && (
                    <span className="text-xs font-normal text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 rounded-full">
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

              {/* ── Email for customer chat ─────────────────────────────── */}
              <div className="border-t border-border pt-4 space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <label
                    className="block text-sm font-medium text-foreground"
                    htmlFor="chatOwnerEmailInput"
                  >
                    Email for customer chat
                  </label>
                  {server?.smsChatOwnerEmailSource === "db-chat" && (
                    <span className="text-xs font-normal text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded-full">
                      Active
                    </span>
                  )}
                  {server?.smsChatOwnerEmailSource === "db-owner" && (
                    <span className="text-xs font-normal text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">
                      Falling back to Owner Notifications email
                    </span>
                  )}
                  {server?.smsChatOwnerEmailSource === "hardcoded" && (
                    <span className="text-xs font-normal text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 rounded-full">
                      Falling back to legacy hardcoded email
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Inbox that receives the chat human-handoff alert email when a guest asks to be reached by phone, email,
                  or text from the website chat. Leave blank to fall back to the Owner Notifications email below.
                </p>
                <input
                  id="chatOwnerEmailInput"
                  type="email"
                  value={chatOwnerEmail}
                  onChange={e => setChatOwnerEmail(e.target.value)}
                  placeholder="catering@example.com"
                  className="w-full max-w-xs px-4 py-2 border border-border rounded-xl bg-background"
                />
                {chatOwnerEmailError && (
                  <p className="text-destructive text-sm">{chatOwnerEmailError}</p>
                )}
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    type="button"
                    onClick={saveChatOwnerEmail}
                    disabled={savingChatOwnerEmail}
                    className="flex items-center gap-2 px-5 py-2.5 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-50"
                  >
                    {savingChatOwnerEmail ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : savedChatOwnerEmail ? (
                      <Check className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <Save className="w-4 h-4" />
                    )}
                    {savingChatOwnerEmail ? "Saving…" : savedChatOwnerEmail ? "Saved!" : "Save Chat Owner Email"}
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
                  <span className="text-xs font-normal text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded-full">
                    Active
                  </span>
                )}
                {server?.ownerNotificationPhoneSource === "env" && (
                  <span className="text-xs font-normal text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 rounded-full">
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
                  <div className="mt-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/50 rounded-xl px-3 py-2">
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

              {/* ── Owner email (fallback for chat handoff emails) ─────── */}
              <div className="border-t border-border pt-4 space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <label
                    className="block text-sm font-medium text-foreground"
                    htmlFor="ownerEmailInput"
                  >
                    Owner email
                  </label>
                  {server?.ownerNotificationEmailSource === "db" && (
                    <span className="text-xs font-normal text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded-full">
                      Active
                    </span>
                  )}
                  {server?.ownerNotificationEmailSource === "hardcoded" && (
                    <span className="text-xs font-normal text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 rounded-full">
                      Using legacy hardcoded email
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Default inbox for owner email alerts. Used as the fallback recipient for chat human-handoff emails when
                  no chat-specific email is set above. Leave blank to fall back to the legacy hardcoded address.
                </p>
                <input
                  id="ownerEmailInput"
                  type="email"
                  value={ownerEmail}
                  onChange={e => setOwnerEmail(e.target.value)}
                  placeholder="owner@example.com"
                  className="w-full max-w-xs px-4 py-2 border border-border rounded-xl bg-background"
                />
                {ownerEmailError && <p className="text-destructive text-sm">{ownerEmailError}</p>}
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    type="button"
                    onClick={saveOwnerEmail}
                    disabled={savingOwnerEmail}
                    className="flex items-center gap-2 px-5 py-2.5 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-50"
                  >
                    {savingOwnerEmail ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : savedOwnerEmail ? (
                      <Check className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <Save className="w-4 h-4" />
                    )}
                    {savingOwnerEmail ? "Saving…" : savedOwnerEmail ? "Saved!" : "Save Owner Email"}
                  </button>
                </div>
              </div>
            </section>

            {/* ── Card 2a': Webhook / Push Mode ───────────────────────── */}
            <section className="bg-card border border-border rounded-2xl p-6 shadow-sm space-y-4">
              <div className="flex items-center gap-2 flex-wrap">
                <Webhook className="w-4 h-4 text-muted-foreground" />
                <h2 className="font-display font-bold text-lg">Inbound Mode — Webhook Push</h2>
                {server?.smsInboundMode === "push" ? (
                  <span className="text-xs font-normal text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded-full">Push active</span>
                ) : (
                  <span className="text-xs font-normal text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 rounded-full">Poll mode — action required</span>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                Instead of polling the SIM gateway every few seconds (~8.6 MB/hour), the gateway pushes each
                inbound text directly to this server the moment it arrives — dropping background traffic to
                ~6 KB/hour. A lightweight safety-net poll still runs every 10 minutes to catch any missed deliveries.
              </p>

              {/* Webhook URL */}
              <div className="space-y-2">
                <label className="block text-xs font-medium text-muted-foreground">
                  eJoinTech gateway URL
                </label>
                <p className="text-xs text-muted-foreground">
                  Copy this URL and paste it into your eJoinTech gateway admin → SMS Forward → SMS to HTTP → URL field.
                  The secret is already embedded — no manual editing needed.
                </p>
                {server?.smsWebhookUrl ? (
                  <div className="flex items-stretch gap-2">
                    <code className="flex-1 block px-3 py-2 bg-secondary border border-border rounded-xl text-xs font-mono break-all leading-relaxed">
                      {server.smsWebhookUrl}
                    </code>
                    <button
                      type="button"
                      onClick={copyWebhookUrl}
                      title="Copy URL to clipboard"
                      className="flex-shrink-0 flex items-center gap-1.5 px-3 py-2 border border-border rounded-xl text-sm hover:bg-secondary transition-colors"
                    >
                      {webhookUrlCopied ? (
                        <><Check className="w-4 h-4 text-emerald-500" /><span className="text-xs text-emerald-600">Copied!</span></>
                      ) : (
                        <><Copy className="w-4 h-4" /><span className="text-xs">Copy</span></>
                      )}
                    </button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground italic">
                    URL unavailable — <code className="px-1 py-0.5 bg-secondary rounded">REPLIT_DOMAINS</code> env var not set.
                  </p>
                )}
              </div>

              {/* Regenerate secret */}
              <div className="flex items-center gap-3 flex-wrap">
                <button
                  type="button"
                  onClick={handleRegenerateSecret}
                  disabled={regeneratingSecret}
                  title="Generate a new random secret and update the URL. You'll need to paste the new URL into eJoinTech afterwards."
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground border border-border rounded-lg px-2.5 py-1.5 hover:bg-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {regeneratingSecret ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  {regeneratingSecret ? "Regenerating…" : "Regenerate secret"}
                </button>
              </div>
              {regenerateSecretFeedback && (
                <p className={regenerateSecretFeedback.kind === "success" ? "text-xs text-emerald-600" : "text-xs text-destructive"}>
                  {regenerateSecretFeedback.message}
                </p>
              )}

              {/* Test button */}
              <div className="flex items-center gap-3 flex-wrap">
                <button
                  type="button"
                  onClick={handleTestWebhookInbound}
                  disabled={
                    sendingWebhookTest ||
                    webhookTestCooldownLeft > 0 ||
                    server?.smsChatPort == null
                  }
                  title={
                    server?.smsChatPort == null
                      ? "Set a Dedicated Chat Port first."
                      : webhookTestCooldownLeft > 0
                      ? `Cooling down — try again in ${webhookTestCooldownLeft}s.`
                      : "Inject a synthetic test message through the inbound pipeline."
                  }
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground border border-border rounded-xl px-3 py-2 hover:bg-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {sendingWebhookTest ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                  {sendingWebhookTest
                    ? "Testing…"
                    : webhookTestCooldownLeft > 0
                    ? `Retry in ${webhookTestCooldownLeft}s`
                    : "Send test inbound"}
                </button>
              </div>
              {webhookTestFeedback && (
                <p className={webhookTestFeedback.kind === "success" ? "text-xs text-emerald-600" : "text-xs text-destructive"}>
                  {webhookTestFeedback.message}
                </p>
              )}

              {/* Setup instructions accordion */}
              <div className="border-t border-border pt-4">
                <button
                  type="button"
                  onClick={() => setShowSetupInstructions(v => !v)}
                  className="flex items-center gap-2 text-sm font-medium text-foreground hover:text-primary transition-colors"
                >
                  {showSetupInstructions ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  How to activate push mode
                </button>
                {showSetupInstructions && (
                  <ol className="mt-3 space-y-2.5 text-sm text-muted-foreground list-none">
                    <li className="flex gap-2.5">
                      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-secondary text-foreground text-xs font-semibold flex items-center justify-center">1</span>
                      <span>
                        In Replit Secrets (the padlock icon in the sidebar), add:
                        <br />
                        <code className="px-1 py-0.5 bg-secondary rounded text-xs">EJOIN_INBOUND_MODE</code> → <code className="px-1 py-0.5 bg-secondary rounded text-xs">push</code>
                      </span>
                    </li>
                    <li className="flex gap-2.5">
                      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-secondary text-foreground text-xs font-semibold flex items-center justify-center">2</span>
                      <span>Restart the API Server workflow (the circular-arrow button next to it in the sidebar).</span>
                    </li>
                    <li className="flex gap-2.5">
                      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-secondary text-foreground text-xs font-semibold flex items-center justify-center">3</span>
                      <span>Copy the webhook URL above — the secret is already embedded, no manual editing needed.</span>
                    </li>
                    <li className="flex gap-2.5">
                      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-secondary text-foreground text-xs font-semibold flex items-center justify-center">4</span>
                      <span>
                        In your eJoinTech gateway admin: <strong>SMS Forward → SMS to HTTP</strong> → enable → paste the URL → Save.
                      </span>
                    </li>
                    <li className="flex gap-2.5">
                      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-secondary text-foreground text-xs font-semibold flex items-center justify-center">5</span>
                      <span>
                        Click <strong>Send test inbound</strong> above to verify the full pipeline end-to-end.
                        A test entry will appear in <strong>Admin → Messages → Unmatched</strong>.
                      </span>
                    </li>
                    <li className="flex gap-2.5">
                      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-secondary text-foreground text-xs font-semibold flex items-center justify-center">ℹ</span>
                      <span className="text-xs">
                        A lightweight safety-net poll still runs every 10 minutes in the background (~6 KB/hour)
                        to catch any webhook delivery failures — no action needed.
                      </span>
                    </li>
                  </ol>
                )}
              </div>
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
