import { useState, useEffect } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import { getAdminToken } from "@/components/AdminGuard";
import { Eye, EyeOff, Save, ExternalLink, Copy, Check, Loader2, MessageSquare, ShoppingBag, ChefHat, Receipt, Users } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="p-1.5 text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-secondary"
      title="Copy link"
    >
      {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
    </button>
  );
}

function PasswordField({
  label,
  sublabel,
  hasExisting,
  existingLabel,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  sublabel: string;
  hasExisting: boolean;
  existingLabel: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label className="block text-sm font-semibold mb-1.5">
        {label}
        {hasExisting && (
          <span className="ml-2 text-xs font-normal text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
            {existingLabel}
          </span>
        )}
      </label>
      <div className="relative">
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full pl-4 pr-10 py-2.5 border border-border rounded-xl bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all"
        />
        <button
          type="button"
          onClick={() => setShow(s => !s)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
      <p className="text-xs text-muted-foreground mt-1.5">{sublabel}</p>
    </div>
  );
}

export default function EventSettings() {
  const [eventName, setEventName] = useState("");
  const [orderPassword, setOrderPassword] = useState("");
  const [kitchenPassword, setKitchenPassword] = useState("");
  const [eventTakerPassword, setEventTakerPassword] = useState("");
  const [eventTakerTaxEnabled, setEventTakerTaxEnabled] = useState(false);
  const [eventTakerTaxRate, setEventTakerTaxRate] = useState<string>("");
  const [hasOrderPassword, setHasOrderPassword] = useState(false);
  const [hasKitchenPassword, setHasKitchenPassword] = useState(false);
  const [hasEventTakerPassword, setHasEventTakerPassword] = useState(false);
  const [twilioConfigured, setTwilioConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const token = getAdminToken();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const origin = window.location.origin;
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const eventUrl = `${origin}${base}/event`;
  const kitchenUrl = `${origin}${base}/kitchen`;
  const takerUrl = `${origin}${base}/event-taker`;

  useEffect(() => {
    fetch(`${BASE}/api/admin/event-settings`, { headers })
      .then(r => r.json())
      .then(data => {
        setEventName(data.eventName ?? "");
        setHasOrderPassword(data.hasOrderPassword ?? data.hasPassword ?? false);
        setHasKitchenPassword(data.hasKitchenPassword ?? false);
        setHasEventTakerPassword(data.hasEventTakerPassword ?? false);
        setEventTakerTaxEnabled(data.eventTakerTaxEnabled ?? false);
        setEventTakerTaxRate(data.eventTakerTaxRate != null ? String(data.eventTakerTaxRate) : "");
        setTwilioConfigured(data.twilioConfigured ?? false);
      })
      .catch(() => setError("Failed to load event settings"))
      .finally(() => setLoading(false));
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const body: Record<string, unknown> = {
        eventName,
        eventTakerTaxEnabled,
        eventTakerTaxRate: eventTakerTaxRate.trim() === "" ? null : Number(eventTakerTaxRate),
      };
      if (orderPassword) body.orderPassword = orderPassword;
      if (kitchenPassword !== undefined) body.kitchenPassword = kitchenPassword;
      if (eventTakerPassword !== undefined) body.eventTakerPassword = eventTakerPassword;

      const res = await fetch(`${BASE}/api/admin/event-settings`, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Save failed");
      const data = await res.json();
      setEventName(data.eventName);
      setHasOrderPassword(data.hasOrderPassword ?? false);
      setHasKitchenPassword(data.hasKitchenPassword ?? false);
      setHasEventTakerPassword(data.hasEventTakerPassword ?? false);
      setEventTakerTaxEnabled(data.eventTakerTaxEnabled ?? false);
      setEventTakerTaxRate(data.eventTakerTaxRate != null ? String(data.eventTakerTaxRate) : "");
      setTwilioConfigured(data.twilioConfigured ?? false);
      setOrderPassword("");
      setKitchenPassword("");
      setEventTakerPassword("");
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      setError("Failed to save settings. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AdminLayout>
      <div className="mb-8">
        <h1 className="font-display font-bold text-4xl mb-2">Event Settings</h1>
        <p className="text-muted-foreground">Configure the on-site event ordering experience for guests and kitchen staff.</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="max-w-2xl space-y-6">
          <form onSubmit={handleSave} className="bg-card border border-border rounded-2xl p-6 shadow-sm space-y-5">
            <h2 className="font-display font-bold text-xl">Event Configuration</h2>

            <div>
              <label className="block text-sm font-semibold mb-1.5">Event Name</label>
              <input
                value={eventName}
                onChange={e => setEventName(e.target.value)}
                placeholder="e.g. Summer Gala 2026, Office Holiday Party"
                className="w-full px-4 py-2.5 border border-border rounded-xl bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all"
              />
              <p className="text-xs text-muted-foreground mt-1.5">Displayed to guests on the ordering page and kitchen display.</p>
            </div>

            <div className="border-t border-border pt-5 space-y-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                <ShoppingBag className="w-4 h-4" />
                <span className="font-semibold text-foreground">Guest Ordering Password</span>
              </div>
              <PasswordField
                label=""
                sublabel={hasOrderPassword ? "Leave blank to keep the existing password." : "Guests enter this to access the ordering page."}
                hasExisting={hasOrderPassword}
                existingLabel="Password set"
                placeholder={hasOrderPassword ? "Enter a new password to change it" : "Set a password for guests"}
                value={orderPassword}
                onChange={setOrderPassword}
              />
            </div>

            <div className="border-t border-border pt-5 space-y-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                <Users className="w-4 h-4" />
                <span className="font-semibold text-foreground">Event Order Taker (Staff) Password</span>
              </div>
              <PasswordField
                label=""
                sublabel={
                  hasEventTakerPassword
                    ? "Leave blank to keep the existing password. Clear the field and save to remove it (falls back to guest password)."
                    : "If left blank, the guest ordering password is used for the staff order taker too."
                }
                hasExisting={hasEventTakerPassword}
                existingLabel="Separate password set"
                placeholder={hasEventTakerPassword ? "Enter a new password to change it" : "Same as guest password (leave blank)"}
                value={eventTakerPassword}
                onChange={setEventTakerPassword}
              />
              <div className="space-y-3 pt-2">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Receipt className="w-4 h-4" />
                  <span className="font-semibold text-foreground">Sales Tax (Order Taker)</span>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={eventTakerTaxEnabled}
                    onChange={e => setEventTakerTaxEnabled(e.target.checked)}
                    className="w-4 h-4 accent-primary"
                  />
                  <span className="text-sm font-medium">Apply sales tax to order taker totals</span>
                </label>
                {eventTakerTaxEnabled && (
                  <div className="max-w-xs">
                    <label className="block text-xs font-medium text-muted-foreground mb-1">Tax Rate (%)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max="100"
                      value={eventTakerTaxRate}
                      onChange={e => setEventTakerTaxRate(e.target.value)}
                      placeholder="e.g. 6.25"
                      className="w-full px-4 py-2 border border-border rounded-xl bg-background"
                    />
                    <p className="text-xs text-muted-foreground mt-1">Applied as a percentage of subtotal.</p>
                  </div>
                )}
              </div>
            </div>

            <div className="border-t border-border pt-5 space-y-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                <ChefHat className="w-4 h-4" />
                <span className="font-semibold text-foreground">Kitchen Display Password</span>
              </div>
              <PasswordField
                label=""
                sublabel={
                  hasKitchenPassword
                    ? "Leave blank to keep the existing password. Clear the field and save to remove it (falls back to guest password)."
                    : "If left blank, the guest ordering password is used for the kitchen display too."
                }
                hasExisting={hasKitchenPassword}
                existingLabel="Separate password set"
                placeholder={hasKitchenPassword ? "Enter a new password to change it" : "Same as guest password (leave blank)"}
                value={kitchenPassword}
                onChange={setKitchenPassword}
              />
            </div>

            {error && <p className="text-destructive text-sm">{error}</p>}

            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-2 px-5 py-2.5 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4 text-emerald-400" /> : <Save className="w-4 h-4" />}
              {saving ? "Saving…" : saved ? "Saved!" : "Save Settings"}
            </button>
          </form>

          <div className="bg-card border border-border rounded-2xl p-6 shadow-sm space-y-3">
            <div className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-muted-foreground" />
              <h2 className="font-display font-bold text-lg">SMS Notifications</h2>
              {twilioConfigured ? (
                <span className="text-xs font-normal text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">Active</span>
              ) : (
                <span className="text-xs font-normal text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">Not connected</span>
              )}
            </div>
            {twilioConfigured ? (
              <p className="text-sm text-muted-foreground">
                Twilio is connected. Guests who provide a phone number will automatically receive a text confirmation when they place an order, and another when their order is ready for pickup.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Connect a Twilio account via the integrations panel to enable SMS order confirmations and pickup alerts for guests.
              </p>
            )}
          </div>

          <div className="bg-card border border-border rounded-2xl p-6 shadow-sm space-y-4">
            <h2 className="font-display font-bold text-xl">Share These Links</h2>
            <p className="text-sm text-muted-foreground">Send the ordering link to guests and the kitchen link to your staff before the event.</p>

            <div className="space-y-3">
              <div>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <ShoppingBag className="w-3.5 h-3.5 text-muted-foreground" />
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Guest Ordering Page</p>
                </div>
                <div className="flex items-center gap-2 bg-secondary rounded-xl px-4 py-2.5">
                  <span className="flex-1 text-sm font-mono truncate">{eventUrl}</span>
                  <CopyButton text={eventUrl} />
                  <a href="/event" target="_blank" rel="noopener noreferrer" className="p-1.5 text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-background">
                    <ExternalLink className="w-4 h-4" />
                  </a>
                </div>
              </div>

              <div>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <Users className="w-3.5 h-3.5 text-muted-foreground" />
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Staff Order Taker (POS)</p>
                </div>
                <div className="flex items-center gap-2 bg-secondary rounded-xl px-4 py-2.5">
                  <span className="flex-1 text-sm font-mono truncate">{takerUrl}</span>
                  <CopyButton text={takerUrl} />
                  <a href="/event-taker" target="_blank" rel="noopener noreferrer" className="p-1.5 text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-background">
                    <ExternalLink className="w-4 h-4" />
                  </a>
                </div>
              </div>

              <div>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <ChefHat className="w-3.5 h-3.5 text-muted-foreground" />
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Kitchen Display</p>
                </div>
                <div className="flex items-center gap-2 bg-secondary rounded-xl px-4 py-2.5">
                  <span className="flex-1 text-sm font-mono truncate">{kitchenUrl}</span>
                  <CopyButton text={kitchenUrl} />
                  <a href="/kitchen" target="_blank" rel="noopener noreferrer" className="p-1.5 text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-background">
                    <ExternalLink className="w-4 h-4" />
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
