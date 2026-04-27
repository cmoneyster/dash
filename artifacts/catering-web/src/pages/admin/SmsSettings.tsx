import { useState, useEffect } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import { getAdminToken } from "@/components/AdminGuard";
import {
  Save, Check, Loader2, MessageSquare, Plus, Trash2, Send,
  AlertTriangle, Smartphone, UserCog,
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
};

// Hardware: ejointech gateway exposes 8 physical SIM ports (1..8).
const EJOIN_PORT_COUNT = 8;
const EJOIN_VALID_PORTS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

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

  // Test-send card state.
  const [testPhone, setTestPhone] = useState("");
  const [testPort, setTestPort] = useState<string>(""); // "" = use round-robin
  const [testMessage, setTestMessage] = useState("");
  const [sendingTest, setSendingTest] = useState(false);
  const [testFeedback, setTestFeedback] = useState<Feedback>(null);

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
    } catch (e: any) {
      setLoadError(e?.message || "Failed to load SMS settings");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadSettings(); }, []);

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

  // ── Test send (arbitrary phone + optional port) ────────────────────────────

  async function handleTestSend() {
    setSendingTest(true);
    setTestFeedback(null);
    try {
      const to = testPhone.trim();
      if (!to || to.replace(/\D/g, "").length < 7) {
        throw new Error("Phone must contain at least 7 digits.");
      }
      const portStr = testPort.trim();
      let port: number | undefined;
      if (portStr !== "") {
        const n = Number(portStr);
        if (!Number.isInteger(n) || n < 1 || n > EJOIN_PORT_COUNT) {
          throw new Error(`Port must be an integer between 1 and ${EJOIN_PORT_COUNT}.`);
        }
        // The dropdown only offers saved active ports + Auto, but guard
        // anyway in case the server pool changed under us.
        if (server && !server.smsActivePorts.includes(n)) {
          throw new Error(`Port ${n} is not in the saved active port pool. Save it first or pick "Auto".`);
        }
        port = n;
      }
      const body: Record<string, unknown> = { to };
      if (port != null) body.port = port;
      const trimmedMsg = testMessage.trim();
      if (trimmedMsg) body.message = trimmedMsg;
      const r = await fetch(`${BASE}/api/admin/sms-settings/test-send`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || "Failed to send test SMS");
      const portLabel = data?.portSource === "round-robin"
        ? `port ${data?.port} (round-robin pick)`
        : `port ${data?.port}`;
      const gateway = data?.gatewayResponse ? ` Gateway: ${data.gatewayResponse}.` : "";
      setTestFeedback({ kind: "success", message: `Sent test SMS to ${data?.sentTo} via ${portLabel}.${gateway}` });
    } catch (e: any) {
      setTestFeedback({ kind: "error", message: e?.message || "Failed to send test SMS" });
    } finally {
      setSendingTest(false);
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
                  min={0}
                  max={10000}
                  step={1}
                  value={threshold}
                  onChange={e => setThreshold(e.target.value)}
                  placeholder="5"
                  className="w-full px-4 py-2 border border-border rounded-xl bg-background"
                />
                <p className="text-xs text-muted-foreground mt-1">Defaults to 5 if left blank. Set to 0 to alert only when an item is fully out of stock.</p>
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

            {/* ── Card 4: Test Send (arbitrary phone) ────────────────────── */}
            <section className="bg-card border border-border rounded-2xl p-6 shadow-sm space-y-4">
              <div className="flex items-center gap-2">
                <Send className="w-4 h-4 text-muted-foreground" />
                <h2 className="font-display font-bold text-lg">Send Test SMS</h2>
              </div>
              <p className="text-sm text-muted-foreground">
                Send a one-off SMS to any phone number. Pin it to a specific port to verify a single SIM, or leave the
                port blank to use the next port from the round-robin pool.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Recipient phone</label>
                  <input
                    type="tel"
                    value={testPhone}
                    onChange={e => setTestPhone(e.target.value)}
                    placeholder="+1 555 123 4567"
                    className="w-full px-4 py-2 border border-border rounded-xl bg-background"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Port</label>
                  <select
                    value={testPort}
                    onChange={e => setTestPort(e.target.value)}
                    className="w-full px-4 py-2 border border-border rounded-xl bg-background"
                  >
                    <option value="">Auto (round-robin)</option>
                    {(server?.smsActivePorts ?? []).map(p => (
                      <option key={p} value={String(p)}>Port {p}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Message (optional)</label>
                <input
                  type="text"
                  value={testMessage}
                  onChange={e => setTestMessage(e.target.value)}
                  placeholder={`Test SMS from ${"<event name>"}`}
                  className="w-full px-4 py-2 border border-border rounded-xl bg-background"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Leave blank to send the default test message (uses the saved event name).
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleTestSend}
                  disabled={sendingTest || !server?.ejoinConfigured}
                  title={server?.ejoinConfigured ? "" : "Gateway is not configured."}
                  className="flex items-center gap-2 px-5 py-2.5 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {sendingTest ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  {sendingTest ? "Sending…" : "Send Test"}
                </button>
              </div>
              {testFeedback && (
                <p className={testFeedback.kind === "success" ? "text-sm text-emerald-600" : "text-sm text-destructive"}>
                  {testFeedback.message}
                </p>
              )}
            </section>
          </>
        )}
      </div>
    </AdminLayout>
  );
}
