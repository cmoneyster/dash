import { useState, useEffect } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import { getAdminToken } from "@/components/AdminGuard";
import { Eye, EyeOff, Save, ExternalLink, Copy, Check, Loader2, ShoppingBag, ChefHat, Receipt, Users, CreditCard, Upload, X as XIcon, CalendarDays } from "lucide-react";

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
  cleared,
  onClear,
}: {
  label: string;
  sublabel: string;
  hasExisting: boolean;
  existingLabel: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  cleared?: boolean;
  onClear?: (next: boolean) => void;
}) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label className="block text-sm font-semibold mb-1.5">
        {label}
        {hasExisting && !cleared && (
          <span className="ml-2 text-xs font-normal text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded-full">
            {existingLabel}
          </span>
        )}
        {cleared && (
          <span className="ml-2 text-xs font-normal text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 rounded-full">
            Will be removed on save
          </span>
        )}
      </label>
      <div className="relative">
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={e => { onChange(e.target.value); if (e.target.value && onClear) onClear(false); }}
          placeholder={placeholder}
          disabled={cleared}
          className="w-full pl-4 pr-10 py-2.5 border border-border rounded-xl bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all disabled:bg-secondary/30 disabled:text-muted-foreground"
        />
        <button
          type="button"
          onClick={() => setShow(s => !s)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
      <div className="flex items-center justify-between mt-1.5 gap-2">
        <p className="text-xs text-muted-foreground flex-1">{sublabel}</p>
        {hasExisting && onClear && (
          <button
            type="button"
            onClick={() => onClear(!cleared)}
            className="text-xs font-medium text-destructive hover:underline shrink-0"
          >
            {cleared ? "Undo" : "Remove password"}
          </button>
        )}
      </div>
    </div>
  );
}

export default function EventSettings() {
  const [eventName, setEventName] = useState("");
  const [orderPassword, setOrderPassword] = useState("");
  const [kitchenPassword, setKitchenPassword] = useState("");
  const [eventTakerPassword, setEventTakerPassword] = useState("");
  const [clearOrderPassword, setClearOrderPassword] = useState(false);
  const [clearKitchenPassword, setClearKitchenPassword] = useState(false);
  const [clearEventTakerPassword, setClearEventTakerPassword] = useState(false);
  const [eventTakerTaxEnabled, setEventTakerTaxEnabled] = useState(false);
  const [eventTakerTaxRate, setEventTakerTaxRate] = useState<string>("");
  const [cateringTaxEnabled, setCateringTaxEnabled] = useState(false);
  const [cateringTaxRate, setCateringTaxRate] = useState<string>("");
  const [venmoHandle, setVenmoHandle] = useState("");
  const [venmoQrImageUrl, setVenmoQrImageUrl] = useState<string | null>(null);
  const [venmoUploading, setVenmoUploading] = useState(false);
  const [venmoUploadError, setVenmoUploadError] = useState("");
  // ── On the Dash Experience pricing config ──
  // String-backed inputs so we can preserve admin keystrokes (decimals,
  // empty while typing, etc.). Validated and coerced to numbers on save.
  const [otdSetupFee, setOtdSetupFee] = useState<string>("500");
  const [otdFeeWaiverThreshold, setOtdFeeWaiverThreshold] = useState<string>("2000");
  const [otdIncludedHours, setOtdIncludedHours] = useState<string>("2");
  const [otdAdditionalHourRate, setOtdAdditionalHourRate] = useState<string>("100");
  const [otdMaxAdditionalHours, setOtdMaxAdditionalHours] = useState<string>("3");
  // ── Daily booking capacity ── all string-backed so admins can leave
  // any field blank to mean "unlimited / no cap configured".
  const [dailyGuestCap, setDailyGuestCap] = useState<string>("");
  const [dailyDropOffSlots, setDailyDropOffSlots] = useState<string>("");
  const [dailyOnTheDashSlots, setDailyOnTheDashSlots] = useState<string>("");
  const [dailyBuffetSlots, setDailyBuffetSlots] = useState<string>("");
  const [dailyGrazingSlots, setDailyGrazingSlots] = useState<string>("");
  const [dailyMadeToOrderSlots, setDailyMadeToOrderSlots] = useState<string>("");
  const [hasOrderPassword, setHasOrderPassword] = useState(false);
  const [hasKitchenPassword, setHasKitchenPassword] = useState(false);
  const [hasEventTakerPassword, setHasEventTakerPassword] = useState(false);
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
        setCateringTaxEnabled(data.cateringTaxEnabled ?? false);
        setCateringTaxRate(data.cateringTaxRate != null ? String(data.cateringTaxRate) : "");
        setVenmoHandle(data.venmoHandle ?? "");
        setVenmoQrImageUrl(data.venmoQrImageUrl ?? null);
        if (data.otdSetupFee != null) setOtdSetupFee(String(data.otdSetupFee));
        if (data.otdFeeWaiverThreshold != null) setOtdFeeWaiverThreshold(String(data.otdFeeWaiverThreshold));
        if (data.otdIncludedHours != null) setOtdIncludedHours(String(data.otdIncludedHours));
        if (data.otdAdditionalHourRate != null) setOtdAdditionalHourRate(String(data.otdAdditionalHourRate));
        if (data.otdMaxAdditionalHours != null) setOtdMaxAdditionalHours(String(data.otdMaxAdditionalHours));
        setDailyGuestCap(data.dailyGuestCap != null ? String(data.dailyGuestCap) : "");
        setDailyDropOffSlots(data.dailyDropOffSlots != null ? String(data.dailyDropOffSlots) : "");
        setDailyOnTheDashSlots(data.dailyOnTheDashSlots != null ? String(data.dailyOnTheDashSlots) : "");
        setDailyBuffetSlots(data.dailyBuffetSlots != null ? String(data.dailyBuffetSlots) : "");
        setDailyGrazingSlots(data.dailyGrazingSlots != null ? String(data.dailyGrazingSlots) : "");
        setDailyMadeToOrderSlots(data.dailyMadeToOrderSlots != null ? String(data.dailyMadeToOrderSlots) : "");
      })
      .catch(() => setError("Failed to load event settings"))
      .finally(() => setLoading(false));
  }, []);

  async function handleVenmoQrUpload(file: File) {
    setVenmoUploadError("");
    setVenmoUploading(true);
    try {
      const fd = new FormData();
      fd.append("image", file);
      const res = await fetch(`${BASE}/api/admin/event-settings/venmo-qr`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      if (!res.ok) throw new Error("Upload failed");
      const data = await res.json();
      setVenmoQrImageUrl(data.url);
    } catch {
      setVenmoUploadError("Failed to upload QR image. Try a smaller image.");
    } finally {
      setVenmoUploading(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const body: Record<string, unknown> = {
        eventName,
        eventTakerTaxEnabled,
        eventTakerTaxRate: eventTakerTaxRate.trim() === "" ? null : Number(eventTakerTaxRate),
        cateringTaxEnabled,
        cateringTaxRate: cateringTaxRate.trim() === "" ? null : Number(cateringTaxRate),
        venmoHandle: venmoHandle.trim() === "" ? null : venmoHandle.trim(),
        venmoQrImageUrl: venmoQrImageUrl ?? null,
        otdSetupFee: otdSetupFee.trim() === "" ? 0 : Number(otdSetupFee),
        otdFeeWaiverThreshold: otdFeeWaiverThreshold.trim() === "" ? 0 : Number(otdFeeWaiverThreshold),
        otdIncludedHours: otdIncludedHours.trim() === "" ? 0 : Number(otdIncludedHours),
        otdAdditionalHourRate: otdAdditionalHourRate.trim() === "" ? 0 : Number(otdAdditionalHourRate),
        otdMaxAdditionalHours: otdMaxAdditionalHours.trim() === "" ? 0 : Number(otdMaxAdditionalHours),
        // Capacity caps — empty string means "unlimited" (sent as null).
        dailyGuestCap: dailyGuestCap.trim() === "" ? null : Number(dailyGuestCap),
        dailyDropOffSlots: dailyDropOffSlots.trim() === "" ? null : Number(dailyDropOffSlots),
        dailyOnTheDashSlots: dailyOnTheDashSlots.trim() === "" ? null : Number(dailyOnTheDashSlots),
        dailyBuffetSlots: dailyBuffetSlots.trim() === "" ? null : Number(dailyBuffetSlots),
        dailyGrazingSlots: dailyGrazingSlots.trim() === "" ? null : Number(dailyGrazingSlots),
        dailyMadeToOrderSlots: dailyMadeToOrderSlots.trim() === "" ? null : Number(dailyMadeToOrderSlots),
      };
      if (clearOrderPassword) body.orderPassword = null;
      else if (orderPassword) body.orderPassword = orderPassword;
      if (clearKitchenPassword) body.kitchenPassword = null;
      else if (kitchenPassword) body.kitchenPassword = kitchenPassword;
      if (clearEventTakerPassword) body.eventTakerPassword = null;
      else if (eventTakerPassword) body.eventTakerPassword = eventTakerPassword;

      const res = await fetch(`${BASE}/api/admin/event-settings`, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // Surface server-provided validation messages instead of a generic "Save failed".
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Save failed");
      }
      const data = await res.json() as any;
      setDailyGuestCap(data.dailyGuestCap != null ? String(data.dailyGuestCap) : "");
      setDailyDropOffSlots(data.dailyDropOffSlots != null ? String(data.dailyDropOffSlots) : "");
      setDailyOnTheDashSlots(data.dailyOnTheDashSlots != null ? String(data.dailyOnTheDashSlots) : "");
      setDailyBuffetSlots(data.dailyBuffetSlots != null ? String(data.dailyBuffetSlots) : "");
      setDailyGrazingSlots(data.dailyGrazingSlots != null ? String(data.dailyGrazingSlots) : "");
      setDailyMadeToOrderSlots(data.dailyMadeToOrderSlots != null ? String(data.dailyMadeToOrderSlots) : "");
      setEventName(data.eventName);
      setHasOrderPassword(data.hasOrderPassword ?? false);
      setHasKitchenPassword(data.hasKitchenPassword ?? false);
      setHasEventTakerPassword(data.hasEventTakerPassword ?? false);
      setEventTakerTaxEnabled(data.eventTakerTaxEnabled ?? false);
      setEventTakerTaxRate(data.eventTakerTaxRate != null ? String(data.eventTakerTaxRate) : "");
      setCateringTaxEnabled(data.cateringTaxEnabled ?? false);
      setCateringTaxRate(data.cateringTaxRate != null ? String(data.cateringTaxRate) : "");
      setVenmoHandle(data.venmoHandle ?? "");
      setVenmoQrImageUrl(data.venmoQrImageUrl ?? null);
      setOrderPassword("");
      setKitchenPassword("");
      setEventTakerPassword("");
      setClearOrderPassword(false);
      setClearKitchenPassword(false);
      setClearEventTakerPassword(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e: any) {
      setError(e?.message || "Failed to save settings. Please try again.");
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
                sublabel={hasOrderPassword ? "Leave blank to keep the existing password. Required — cannot be removed." : "Guests enter this to access the ordering page."}
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
                    ? "Leave blank to keep the existing password. Use Remove password to clear it (falls back to guest password)."
                    : "If left blank, the guest ordering password is used for the staff order taker too."
                }
                hasExisting={hasEventTakerPassword}
                existingLabel="Separate password set"
                placeholder={hasEventTakerPassword ? "Enter a new password to change it" : "Same as guest password (leave blank)"}
                value={eventTakerPassword}
                onChange={setEventTakerPassword}
                cleared={clearEventTakerPassword}
                onClear={setClearEventTakerPassword}
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

            <div className="border-t border-border pt-5 space-y-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Receipt className="w-4 h-4" />
                <span className="font-semibold text-foreground">Sales Tax (Catering Invoices)</span>
              </div>
              <p className="text-xs text-muted-foreground">
                When enabled, tax is added to the Square order at the specified rate and appears
                as a separate line on the customer's invoice.
              </p>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={cateringTaxEnabled}
                  onChange={e => setCateringTaxEnabled(e.target.checked)}
                  className="w-4 h-4 accent-primary"
                />
                <span className="text-sm font-medium">Apply sales tax to catering invoices</span>
              </label>
              {cateringTaxEnabled && (
                <div className="max-w-xs">
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Tax Rate (%)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    value={cateringTaxRate}
                    onChange={e => setCateringTaxRate(e.target.value)}
                    placeholder="e.g. 8.875"
                    className="w-full px-4 py-2 border border-border rounded-xl bg-background"
                  />
                  <p className="text-xs text-muted-foreground mt-1">Applied as a percentage of subtotal on every catering Square order.</p>
                </div>
              )}
            </div>

            <div className="border-t border-border pt-5 space-y-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                <CreditCard className="w-4 h-4" />
                <span className="font-semibold text-foreground">Venmo Payment</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Shown on the staff Order Taker payment screen when the cashier picks Venmo.
                Leave blank to hide the Venmo option.
              </p>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Venmo handle</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">@</span>
                  <input
                    value={venmoHandle}
                    onChange={e => setVenmoHandle(e.target.value.replace(/^@/, ""))}
                    placeholder="your-business-handle"
                    className="w-full pl-8 pr-4 py-2 border border-border rounded-xl bg-background"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Venmo QR code image</label>
                {venmoQrImageUrl ? (
                  <div className="flex items-start gap-3">
                    <div className="w-32 h-32 rounded-xl border border-border overflow-hidden bg-secondary">
                      <img src={venmoQrImageUrl} alt="Venmo QR" className="w-full h-full object-cover" />
                    </div>
                    <div className="flex flex-col gap-2">
                      <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-border rounded-lg cursor-pointer hover:bg-secondary">
                        <Upload className="w-3.5 h-3.5" /> Replace
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={e => { const f = e.target.files?.[0]; if (f) handleVenmoQrUpload(f); }}
                          disabled={venmoUploading}
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => setVenmoQrImageUrl(null)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-destructive border border-destructive/30 rounded-lg hover:bg-destructive/10"
                      >
                        <XIcon className="w-3.5 h-3.5" /> Remove
                      </button>
                    </div>
                  </div>
                ) : (
                  <label className="inline-flex items-center gap-2 px-4 py-2 border border-dashed border-border rounded-xl cursor-pointer hover:bg-secondary text-sm">
                    {venmoUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                    {venmoUploading ? "Uploading…" : "Upload QR image"}
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={e => { const f = e.target.files?.[0]; if (f) handleVenmoQrUpload(f); }}
                      disabled={venmoUploading}
                    />
                  </label>
                )}
                {venmoUploadError && <p className="text-xs text-destructive mt-1.5">{venmoUploadError}</p>}
                <p className="text-xs text-muted-foreground mt-1.5">Square images work best. Click Save Settings below to confirm changes.</p>
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
                    ? "Leave blank to keep the existing password. Use Remove password to clear it (falls back to guest password)."
                    : "If left blank, the guest ordering password is used for the kitchen display too."
                }
                hasExisting={hasKitchenPassword}
                existingLabel="Separate password set"
                placeholder={hasKitchenPassword ? "Enter a new password to change it" : "Same as guest password (leave blank)"}
                value={kitchenPassword}
                onChange={setKitchenPassword}
                cleared={clearKitchenPassword}
                onClear={setClearKitchenPassword}
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

          <form onSubmit={handleSave} className="bg-card border border-border rounded-2xl p-6 shadow-sm space-y-4">
            <div>
              <h2 className="font-display font-bold text-lg">On the Dash Experience Pricing</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Live pricing for the on-site food trailer service mode. Each customer's quote
                snapshots these values at submission time, so changes here only affect new inquiries.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Setup fee ($)</label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={otdSetupFee}
                  onChange={e => setOtdSetupFee(e.target.value)}
                  className="w-full px-4 py-2 border border-border rounded-xl bg-background"
                />
                <p className="text-xs text-muted-foreground mt-1">Charged when subtotal is under the waiver threshold below.</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Setup fee waived at subtotal ($)</label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={otdFeeWaiverThreshold}
                  onChange={e => setOtdFeeWaiverThreshold(e.target.value)}
                  className="w-full px-4 py-2 border border-border rounded-xl bg-background"
                />
                <p className="text-xs text-muted-foreground mt-1">Food subtotal at or above this amount gets the setup fee waived.</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Included on-site hours</label>
                <input
                  type="number"
                  min={0}
                  step="0.5"
                  value={otdIncludedHours}
                  onChange={e => setOtdIncludedHours(e.target.value)}
                  className="w-full px-4 py-2 border border-border rounded-xl bg-background"
                />
                <p className="text-xs text-muted-foreground mt-1">Hours of on-site service included in the setup fee.</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Additional hour rate ($/hr)</label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={otdAdditionalHourRate}
                  onChange={e => setOtdAdditionalHourRate(e.target.value)}
                  className="w-full px-4 py-2 border border-border rounded-xl bg-background"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Maximum additional hours</label>
                <input
                  type="number"
                  min={0}
                  max={24}
                  step={1}
                  value={otdMaxAdditionalHours}
                  onChange={e => setOtdMaxAdditionalHours(e.target.value)}
                  className="w-full px-4 py-2 border border-border rounded-xl bg-background"
                />
                <p className="text-xs text-muted-foreground mt-1">How many extra hours past the included time guests can book.</p>
              </div>
            </div>
            {error && <p className="text-destructive text-sm">{error}</p>}
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-2 px-5 py-2.5 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4 text-emerald-400" /> : <Save className="w-4 h-4" />}
              {saving ? "Saving…" : saved ? "Saved!" : "Save On the Dash Pricing"}
            </button>
          </form>

          <form onSubmit={handleSave} className="bg-card border border-border rounded-2xl p-6 shadow-sm space-y-4">
            <div className="flex items-center gap-2">
              <CalendarDays className="w-5 h-5 text-muted-foreground" />
              <h2 className="font-display font-bold text-xl">Daily Booking Capacity</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Caps used by the chat bot's date-availability tool. Confirmed orders count
              against caps; pending orders are visible but don't block. Leave any field
              blank to mean "no cap configured" for that dimension.
            </p>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Total guests per day</label>
              <input
                type="number"
                min={0}
                max={1000}
                step={1}
                value={dailyGuestCap}
                onChange={e => setDailyGuestCap(e.target.value)}
                placeholder="Unlimited"
                className="w-full px-4 py-2 border border-border rounded-xl bg-background"
              />
              <p className="text-xs text-muted-foreground mt-1">Across every booking that day, regardless of service style.</p>
            </div>
            <div className="border-t border-border pt-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Slots per service style</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Standard drop-off</label>
                  <input
                    type="number"
                    min={0}
                    max={1000}
                    step={1}
                    value={dailyDropOffSlots}
                    onChange={e => setDailyDropOffSlots(e.target.value)}
                    placeholder="Unlimited"
                    className="w-full px-4 py-2 border border-border rounded-xl bg-background"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">On the Dash (food trailer)</label>
                  <input
                    type="number"
                    min={0}
                    max={1000}
                    step={1}
                    value={dailyOnTheDashSlots}
                    onChange={e => setDailyOnTheDashSlots(e.target.value)}
                    placeholder="Unlimited"
                    className="w-full px-4 py-2 border border-border rounded-xl bg-background"
                  />
                  <p className="text-xs text-muted-foreground mt-1">Most teams set this to 1 — only one trailer per day.</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Buffet</label>
                  <input
                    type="number"
                    min={0}
                    max={1000}
                    step={1}
                    value={dailyBuffetSlots}
                    onChange={e => setDailyBuffetSlots(e.target.value)}
                    placeholder="Unlimited"
                    className="w-full px-4 py-2 border border-border rounded-xl bg-background"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Grazing</label>
                  <input
                    type="number"
                    min={0}
                    max={1000}
                    step={1}
                    value={dailyGrazingSlots}
                    onChange={e => setDailyGrazingSlots(e.target.value)}
                    placeholder="Unlimited"
                    className="w-full px-4 py-2 border border-border rounded-xl bg-background"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Made-to-order</label>
                  <input
                    type="number"
                    min={0}
                    max={1000}
                    step={1}
                    value={dailyMadeToOrderSlots}
                    onChange={e => setDailyMadeToOrderSlots(e.target.value)}
                    placeholder="Unlimited"
                    className="w-full px-4 py-2 border border-border rounded-xl bg-background"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-3">
                Buffet, grazing, and made-to-order aren't yet captured by checkout — these
                caps will start enforcing automatically when those modes ship.
              </p>
            </div>
            {error && <p className="text-destructive text-sm">{error}</p>}
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-2 px-5 py-2.5 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4 text-emerald-400" /> : <Save className="w-4 h-4" />}
              {saving ? "Saving…" : saved ? "Saved!" : "Save Capacity"}
            </button>
          </form>

          <div className="bg-card border border-border rounded-2xl p-6 shadow-sm space-y-4">
            <h2 className="font-display font-bold text-xl">Share These Links</h2>
            <p className="text-sm text-muted-foreground">Send the ordering link to guests and the kitchen link to your staff before the event.</p>

            <div className="space-y-3">
              <div>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <ShoppingBag className="w-3.5 h-3.5 text-muted-foreground" />
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Guest Event Ordering</p>
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
