import { useState, useCallback, useEffect, useMemo } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import { DayPicker, type DayButtonProps } from "react-day-picker";
import "react-day-picker/dist/style.css";
import { getAdminToken } from "@/components/AdminGuard";
import { Loader2, Save, X, Plus, Trash2, CalendarDays, Info, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { parseDateLocal } from "@/lib/date";
import { format } from "date-fns";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authHeaders() {
  const token = getAdminToken();
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

type BlackoutDate = { id: number; date: string; reason: string | null };
type TimeWindow = { id: number; date: string; startTime: string; endTime: string; reason: string | null };

function toDateStr(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

function formatDisplay(dateStr: string): string {
  const d = parseDateLocal(dateStr);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function formatTime(t: string): string {
  const [h, m] = t.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

export default function CalendarManager() {
  const [saved, setSaved] = useState<BlackoutDate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  // Pending batch changes (full-day blocks)
  const [toAdd, setToAdd] = useState<Set<string>>(new Set());
  const [toRemove, setToRemove] = useState<Set<number>>(new Set());
  const [reason, setReason] = useState("");

  // Selected date for the detail panel
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  // Time windows for the selected date
  const [timeWindows, setTimeWindows] = useState<TimeWindow[]>([]);
  const [windowsLoading, setWindowsLoading] = useState(false);
  const [windowsError, setWindowsError] = useState("");

  // All dates that have time windows (for calendar indicators)
  const [datesWithWindows, setDatesWithWindows] = useState<Set<string>>(new Set());

  // Add time window form state
  const [newStart, setNewStart] = useState("09:00");
  const [newEnd, setNewEnd] = useState("11:00");
  const [newReason, setNewReason] = useState("");
  const [addingWindow, setAddingWindow] = useState(false);
  const [addWindowError, setAddWindowError] = useState("");

  const loadDates = useCallback(() => {
    setLoading(true);
    fetch(`${BASE}/api/admin/blackout-dates`, { headers: authHeaders() })
      .then(r => r.json())
      .then(setSaved)
      .finally(() => setLoading(false));
  }, []);

  const loadDatesWithWindows = useCallback(() => {
    fetch(`${BASE}/api/admin/blackout-time-windows/dates-with-windows`, { headers: authHeaders() })
      .then(r => r.ok ? r.json() : [])
      .then((dates: string[]) => setDatesWithWindows(new Set(dates)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadDates();
    loadDatesWithWindows();
  }, [loadDates, loadDatesWithWindows]);

  const loadTimeWindows = useCallback((dateStr: string) => {
    setWindowsLoading(true);
    setWindowsError("");
    fetch(`${BASE}/api/admin/blackout-time-windows?date=${dateStr}`, { headers: authHeaders() })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((ws: TimeWindow[]) => setTimeWindows(ws))
      .catch(() => setWindowsError("Failed to load time windows."))
      .finally(() => setWindowsLoading(false));
  }, []);

  function handleDayClick(day: Date) {
    const dateStr = toDateStr(day);
    setSelectedDate(dateStr);
    loadTimeWindows(dateStr);
    setAddWindowError("");
    setNewStart("09:00");
    setNewEnd("11:00");
    setNewReason("");
  }

  function toggleFullDayBlock(dateStr: string) {
    const existing = saved.find(b => b.date === dateStr);
    if (existing) {
      setToRemove(prev => {
        const next = new Set(prev);
        if (next.has(existing.id)) next.delete(existing.id);
        else next.add(existing.id);
        return next;
      });
    } else {
      setToAdd(prev => {
        const next = new Set(prev);
        if (next.has(dateStr)) next.delete(dateStr);
        else next.add(dateStr);
        return next;
      });
    }
  }

  function clearChanges() {
    setToAdd(new Set());
    setToRemove(new Set());
    setReason("");
    setSaveError("");
  }

  async function handleSave() {
    if (toAdd.size === 0 && toRemove.size === 0) return;
    setSaving(true);
    setSaveError("");
    try {
      for (const dateStr of toAdd) {
        await fetch(`${BASE}/api/admin/blackout-dates`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ date: dateStr, reason: reason.trim() || null }),
        });
      }
      for (const id of toRemove) {
        await fetch(`${BASE}/api/admin/blackout-dates/${id}`, {
          method: "DELETE",
          headers: authHeaders(),
        });
      }
      clearChanges();
      loadDates();
    } catch {
      setSaveError("Some changes couldn't be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleAddWindow() {
    if (!selectedDate) return;
    if (!newStart || !newEnd) { setAddWindowError("Start and end time are required."); return; }
    if (newEnd <= newStart) { setAddWindowError("End time must be after start time."); return; }
    setAddingWindow(true);
    setAddWindowError("");
    try {
      const res = await fetch(`${BASE}/api/admin/blackout-time-windows`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ date: selectedDate, startTime: newStart, endTime: newEnd, reason: newReason.trim() || null }),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        const msg = typeof body === "object" && body !== null && "error" in body && typeof (body as Record<string, unknown>).error === "string"
          ? (body as Record<string, string>).error
          : "Failed to add time window";
        throw new Error(msg);
      }
      setNewReason("");
      loadTimeWindows(selectedDate);
      loadDatesWithWindows();
    } catch (err) {
      setAddWindowError(err instanceof Error ? err.message : "Failed to add time window.");
    } finally {
      setAddingWindow(false);
    }
  }

  async function handleDeleteWindow(id: number) {
    if (!selectedDate) return;
    try {
      const res = await fetch(`${BASE}/api/admin/blackout-time-windows/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        const msg = typeof body === "object" && body !== null && "error" in body && typeof (body as Record<string, unknown>).error === "string"
          ? (body as Record<string, string>).error
          : "Failed to delete time window";
        setWindowsError(msg);
        return;
      }
      setTimeWindows(ws => ws.filter(w => w.id !== id));
      loadDatesWithWindows();
    } catch {
      setWindowsError("Failed to delete time window.");
    }
  }

  // Date → saved blackout lookup for tooltips
  const savedByDate = useMemo(() => {
    const map: Record<string, BlackoutDate> = {};
    for (const b of saved) map[b.date] = b;
    return map;
  }, [saved]);

  // Custom DayButton: adds tooltip + dot indicator for time windows
  const DayButtonWithTooltip = useCallback(({ day, modifiers: _m, children, ...buttonProps }: DayButtonProps) => {
    const dateStr = toDateStr(day.date);
    const blackout = savedByDate[dateStr];
    const isAdding = toAdd.has(dateStr);
    const isRemoving = !!(blackout && toRemove.has(blackout.id));
    const hasWindows = datesWithWindows.has(dateStr) && !blackout;
    const title = isAdding
      ? "Pending: Adding as blocked"
      : isRemoving
      ? "Pending: Removing from blocked"
      : blackout
      ? blackout.reason ? `Blocked: ${blackout.reason}` : "Blocked date"
      : hasWindows
      ? "Has time-range restrictions"
      : undefined;
    const isSelected = selectedDate === dateStr;
    return (
      <button
        {...buttonProps}
        title={title}
        style={{
          ...(buttonProps.style as React.CSSProperties | undefined),
          outline: isSelected ? "2px solid hsl(var(--primary))" : undefined,
          outlineOffset: isSelected ? "-2px" : undefined,
          borderRadius: "50%",
        }}
      >
        {children}
        {hasWindows && !isAdding && (
          <span
            style={{
              position: "absolute",
              bottom: 2,
              left: "50%",
              transform: "translateX(-50%)",
              width: 5,
              height: 5,
              borderRadius: "50%",
              backgroundColor: "hsl(43 96% 45%)",
              display: "block",
            }}
          />
        )}
      </button>
    );
  }, [savedByDate, toAdd, toRemove, datesWithWindows, selectedDate]);

  // Modifier maps
  const savedDates = saved
    .filter(b => !toRemove.has(b.id))
    .map(b => parseDateLocal(b.date));

  const markedForRemoval = saved
    .filter(b => toRemove.has(b.id))
    .map(b => parseDateLocal(b.date));

  const pendingAddDates = [...toAdd].map(parseDateLocal);

  const hasPendingChanges = toAdd.size > 0 || toRemove.size > 0;

  // Selected date state helpers
  const selectedIsFullyBlocked = selectedDate ? !!savedByDate[selectedDate] : false;
  const selectedIsPendingAdd = selectedDate ? toAdd.has(selectedDate) : false;
  const selectedIsPendingRemove = selectedDate
    ? !!(savedByDate[selectedDate] && toRemove.has(savedByDate[selectedDate].id))
    : false;
  const effectivelyBlocked = (selectedIsFullyBlocked && !selectedIsPendingRemove) || selectedIsPendingAdd;

  return (
    <AdminLayout>
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl sm:text-4xl mb-2">Availability Calendar</h1>
        <p className="text-muted-foreground">Click a date to manage full-day blocks or time-range restrictions.</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-[auto_1fr] gap-8 items-start">
          {/* Calendar */}
          <div className="bg-card p-8 rounded-3xl border border-border shadow-sm flex flex-col items-center gap-5">
            <DayPicker
              onDayClick={handleDayClick}
              components={{ DayButton: DayButtonWithTooltip }}
              modifiers={{
                blocked: savedDates,
                removing: markedForRemoval,
                adding: pendingAddDates,
              }}
              modifiersStyles={{
                blocked: {
                  color: "hsl(var(--destructive))",
                  fontWeight: "700",
                  textDecoration: "line-through",
                  backgroundColor: "hsl(var(--destructive) / 0.08)",
                  borderRadius: "50%",
                },
                removing: {
                  color: "hsl(var(--muted-foreground))",
                  fontWeight: "400",
                  textDecoration: "line-through",
                  opacity: 0.4,
                  borderRadius: "50%",
                },
                adding: {
                  backgroundColor: "hsl(43 96% 56% / 0.25)",
                  color: "hsl(32 95% 44%)",
                  fontWeight: "700",
                  borderRadius: "50%",
                  outline: "2px solid hsl(43 96% 56%)",
                  outlineOffset: "-2px",
                },
              }}
              className="scale-110 origin-center"
            />

            {/* Legend */}
            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground w-full pt-3 border-t border-border">
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-destructive/80 inline-block shrink-0" />
                Full-day block
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-amber-400 inline-block shrink-0" />
                Pending add
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-amber-500 inline-block shrink-0 mx-0.5" />
                Time restrictions
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-border inline-block shrink-0" />
                Pending remove
              </span>
            </div>

            <p className="text-xs text-muted-foreground text-center -mt-2 flex items-start gap-1.5">
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              Click any date to view or edit its availability settings.
            </p>
          </div>

          {/* Right panel */}
          <div className="space-y-6">
            {/* Selected date detail panel */}
            {selectedDate ? (
              <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
                <div className="px-5 py-4 border-b border-border flex items-center justify-between">
                  <div>
                    <h3 className="font-bold text-base">{formatDisplay(selectedDate)}</h3>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {effectivelyBlocked ? "Full-day block active" : "Available — manage time restrictions below"}
                    </p>
                  </div>
                  <button
                    onClick={() => setSelectedDate(null)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="p-5 space-y-5">
                  {/* Full-day block toggle */}
                  <div className="flex items-center justify-between bg-secondary/50 rounded-xl px-4 py-3">
                    <div className="flex items-center gap-2">
                      <CalendarDays className="w-4 h-4 text-muted-foreground" />
                      <div>
                        <p className="text-sm font-semibold">Full-day block</p>
                        <p className="text-xs text-muted-foreground">Marks the entire day as unavailable</p>
                      </div>
                    </div>
                    <button
                      onClick={() => toggleFullDayBlock(selectedDate)}
                      className={cn(
                        "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                        effectivelyBlocked ? "bg-destructive" : "bg-border"
                      )}
                    >
                      <span
                        className={cn(
                          "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
                          effectivelyBlocked ? "translate-x-6" : "translate-x-1"
                        )}
                      />
                    </button>
                  </div>

                  {/* Time windows section — disabled when full-day block is active */}
                  <div className={cn(effectivelyBlocked && "opacity-40 pointer-events-none")}>
                    <div className="flex items-center gap-2 mb-3">
                      <Clock className="w-4 h-4 text-muted-foreground" />
                      <h4 className="text-sm font-semibold">Time-range blocks</h4>
                      {effectivelyBlocked && (
                        <span className="text-xs text-muted-foreground">(ignored while full-day block is on)</span>
                      )}
                    </div>

                    {/* Existing windows */}
                    {windowsLoading ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                        <Loader2 className="w-4 h-4 animate-spin" /> Loading…
                      </div>
                    ) : windowsError ? (
                      <p className="text-sm text-destructive">{windowsError}</p>
                    ) : timeWindows.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-1">No time blocks for this date.</p>
                    ) : (
                      <ul className="space-y-2 mb-3">
                        {timeWindows.map(w => (
                          <li
                            key={w.id}
                            className="flex items-center justify-between bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/50 rounded-xl px-3 py-2"
                          >
                            <div>
                              <span className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                                {formatTime(w.startTime)} – {formatTime(w.endTime)}
                              </span>
                              {w.reason && (
                                <span className="ml-2 text-xs text-amber-600 dark:text-amber-400">— {w.reason}</span>
                              )}
                            </div>
                            <button
                              onClick={() => handleDeleteWindow(w.id)}
                              className="text-amber-400 hover:text-destructive transition-colors ml-2"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}

                    {/* Add window form */}
                    <div className="border border-border rounded-xl p-4 space-y-3 bg-background">
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                        <Plus className="w-3.5 h-3.5" /> Add time block
                      </p>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-xs text-muted-foreground block mb-1">Start time</label>
                          <input
                            type="time"
                            value={newStart}
                            onChange={e => setNewStart(e.target.value)}
                            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-muted-foreground block mb-1">End time</label>
                          <input
                            type="time"
                            value={newEnd}
                            onChange={e => setNewEnd(e.target.value)}
                            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground block mb-1">Reason (optional)</label>
                        <input
                          value={newReason}
                          onChange={e => setNewReason(e.target.value)}
                          placeholder="e.g. Lunch rush, Private booking…"
                          className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                        />
                      </div>
                      {addWindowError && <p className="text-xs text-destructive">{addWindowError}</p>}
                      <button
                        onClick={handleAddWindow}
                        disabled={addingWindow}
                        className="w-full flex items-center justify-center gap-2 py-2 bg-amber-500 text-white text-sm font-semibold rounded-lg hover:bg-amber-600 transition-colors disabled:opacity-50"
                      >
                        {addingWindow ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                        Add Block
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-card border border-border rounded-2xl p-6 text-center text-muted-foreground">
                <CalendarDays className="w-10 h-10 mx-auto mb-3 opacity-20" />
                <p className="font-medium mb-1">No date selected</p>
                <p className="text-sm">Click a date on the calendar to manage its availability.</p>
              </div>
            )}

            {/* Pending full-day changes panel */}
            {hasPendingChanges && (
              <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
                <div className="px-5 py-4 border-b border-border flex items-center justify-between">
                  <h3 className="font-bold text-base">Pending Full-Day Changes</h3>
                  <button
                    onClick={clearChanges}
                    className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                  >
                    <X className="w-3.5 h-3.5" /> Discard
                  </button>
                </div>

                <div className="p-5 space-y-4">
                  {toAdd.size > 0 && (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                        <Plus className="w-3.5 h-3.5 text-amber-500" /> Dates to Block ({toAdd.size})
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {[...toAdd].sort().map(dateStr => (
                          <div
                            key={dateStr}
                            className="flex items-center gap-1.5 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/50 text-amber-800 dark:text-amber-300 text-xs font-medium px-2.5 py-1 rounded-lg"
                          >
                            {formatDisplay(dateStr)}
                            <button
                              onClick={() => setToAdd(prev => { const n = new Set(prev); n.delete(dateStr); return n; })}
                              className="text-amber-500 hover:text-amber-700 dark:hover:text-amber-400 ml-0.5"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ))}
                      </div>

                      <div className="mt-3">
                        <label className="text-xs font-semibold text-muted-foreground block mb-1">Reason (optional)</label>
                        <input
                          value={reason}
                          onChange={e => setReason(e.target.value)}
                          placeholder="e.g. Holiday, Private event…"
                          className="w-full px-3 py-2 text-sm border border-border rounded-xl bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                        />
                      </div>
                    </div>
                  )}

                  {toRemove.size > 0 && (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                        <Trash2 className="w-3.5 h-3.5 text-muted-foreground" /> Dates to Unblock ({toRemove.size})
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {saved.filter(b => toRemove.has(b.id)).map(b => (
                          <div
                            key={b.id}
                            className="flex items-center gap-1.5 bg-secondary text-muted-foreground text-xs font-medium px-2.5 py-1 rounded-lg line-through"
                          >
                            {formatDisplay(b.date)}
                            <button
                              onClick={() => setToRemove(prev => { const n = new Set(prev); n.delete(b.id); return n; })}
                              className="text-muted-foreground hover:text-foreground ml-0.5 no-underline"
                              style={{ textDecoration: "none" }}
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {saveError && <p className="text-destructive text-sm">{saveError}</p>}

                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="w-full flex items-center justify-center gap-2 py-2.5 bg-foreground text-background font-semibold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-50"
                  >
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    {saving ? "Saving…" : "Save Changes"}
                  </button>
                </div>
              </div>
            )}

            {/* Current blocked dates list */}
            <div>
              <h3 className="font-bold text-lg mb-3">Blocked Dates ({saved.length})</h3>
              <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
                {saved.length === 0 ? (
                  <p className="p-6 text-muted-foreground text-center text-sm">No full-day blackout dates set.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {saved.map(b => {
                      const isRemoving = toRemove.has(b.id);
                      return (
                        <li
                          key={b.id}
                          className={cn(
                            "p-4 flex justify-between items-center hover:bg-secondary/30 transition-colors cursor-pointer",
                            isRemoving && "opacity-40",
                            selectedDate === b.date && "bg-primary/5"
                          )}
                          onClick={() => handleDayClick(parseDateLocal(b.date))}
                        >
                          <div>
                            <span className={cn("font-semibold text-sm", isRemoving ? "text-muted-foreground line-through" : "text-destructive")}>
                              {formatDisplay(b.date)}
                            </span>
                            {b.reason && <span className="text-sm text-muted-foreground ml-3">— {b.reason}</span>}
                          </div>
                          <button
                            onClick={e => {
                              e.stopPropagation();
                              setToRemove(prev => {
                                const n = new Set(prev);
                                if (n.has(b.id)) n.delete(b.id);
                                else n.add(b.id);
                                return n;
                              });
                            }}
                            className={cn("text-xs font-semibold transition-colors", isRemoving ? "text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300" : "text-muted-foreground hover:text-destructive")}
                          >
                            {isRemoving ? "Undo" : "Remove"}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
