import { useState, useCallback, useEffect, useMemo } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import { DayPicker, type DayButtonProps } from "react-day-picker";
import "react-day-picker/dist/style.css";
import { getAdminToken } from "@/components/AdminGuard";
import { Loader2, Save, X, Plus, Trash2, CalendarDays, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { parseDateLocal } from "@/lib/date";
import { format } from "date-fns";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authHeaders() {
  const token = getAdminToken();
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

type BlackoutDate = { id: number; date: string; reason: string | null };

function toDateStr(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

function formatDisplay(dateStr: string): string {
  const d = parseDateLocal(dateStr);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

export default function CalendarManager() {
  const [saved, setSaved] = useState<BlackoutDate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  // Pending changes
  const [toAdd, setToAdd] = useState<Set<string>>(new Set());
  const [toRemove, setToRemove] = useState<Set<number>>(new Set());
  const [reason, setReason] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    fetch(`${BASE}/api/admin/blackout-dates`, { headers: authHeaders() })
      .then(r => r.json())
      .then(setSaved)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  function handleDayClick(day: Date) {
    const dateStr = toDateStr(day);
    const existing = saved.find(b => b.date === dateStr);

    if (existing) {
      // Toggle removal of a saved date
      setToRemove(prev => {
        const next = new Set(prev);
        if (next.has(existing.id)) next.delete(existing.id);
        else next.add(existing.id);
        return next;
      });
    } else {
      // Toggle addition of a new pending date
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
      // Batch create new dates
      for (const dateStr of toAdd) {
        await fetch(`${BASE}/api/admin/blackout-dates`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ date: dateStr, reason: reason.trim() || null }),
        });
      }
      // Batch delete removed dates
      for (const id of toRemove) {
        await fetch(`${BASE}/api/admin/blackout-dates/${id}`, {
          method: "DELETE",
          headers: authHeaders(),
        });
      }
      clearChanges();
      load();
    } catch {
      setSaveError("Some changes couldn't be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  // Date → saved blackout lookup for tooltips
  const savedByDate = useMemo(() => {
    const map: Record<string, BlackoutDate> = {};
    for (const b of saved) map[b.date] = b;
    return map;
  }, [saved]);

  // Custom DayButton (v9 API): adds title tooltip showing reason for blocked dates
  const DayButtonWithTooltip = useCallback(({ day, modifiers: _m, children, ...buttonProps }: DayButtonProps) => {
    const dateStr = toDateStr(day.date);
    const blackout = savedByDate[dateStr];
    const isAdding = toAdd.has(dateStr);
    const isRemoving = !!(blackout && toRemove.has(blackout.id));
    const title = isAdding
      ? "Pending: Adding as blocked"
      : isRemoving
      ? "Pending: Removing from blocked"
      : blackout
      ? blackout.reason ? `Blocked: ${blackout.reason}` : "Blocked date"
      : undefined;
    return <button {...buttonProps} title={title}>{children}</button>;
  }, [savedByDate, toAdd, toRemove]);

  // Modifier maps
  const savedDates = saved
    .filter(b => !toRemove.has(b.id))
    .map(b => parseDateLocal(b.date));

  const markedForRemoval = saved
    .filter(b => toRemove.has(b.id))
    .map(b => parseDateLocal(b.date));

  const pendingAddDates = [...toAdd].map(parseDateLocal);
  const pendingAddSet = toAdd;

  const hasPendingChanges = toAdd.size > 0 || toRemove.size > 0;

  return (
    <AdminLayout>
      <div className="mb-8">
        <h1 className="font-display font-bold text-4xl mb-2">Availability Calendar</h1>
        <p className="text-muted-foreground">Select dates to block or unblock, then click Save Changes.</p>
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
            <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground w-full pt-3 border-t border-border">
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-destructive/80 inline-block shrink-0" />
                Blocked
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-amber-400 inline-block shrink-0" />
                Adding
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-border inline-block shrink-0" />
                Removing
              </span>
            </div>

            <p className="text-xs text-muted-foreground text-center -mt-2 flex items-start gap-1.5">
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              Click any date to toggle it. Red = blocked. Click a blocked date to schedule its removal.
            </p>
          </div>

          {/* Right panel */}
          <div className="space-y-6">
            {/* Pending changes panel */}
            {hasPendingChanges ? (
              <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
                <div className="px-5 py-4 border-b border-border flex items-center justify-between">
                  <h3 className="font-bold text-base">Pending Changes</h3>
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
                            className="flex items-center gap-1.5 bg-amber-50 border border-amber-200 text-amber-800 text-xs font-medium px-2.5 py-1 rounded-lg"
                          >
                            {formatDisplay(dateStr)}
                            <button
                              onClick={() => setToAdd(prev => { const n = new Set(prev); n.delete(dateStr); return n; })}
                              className="text-amber-500 hover:text-amber-700 ml-0.5"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ))}
                      </div>

                      {/* Reason input for new dates */}
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
            ) : (
              <div className="bg-card border border-border rounded-2xl p-6 text-center text-muted-foreground">
                <CalendarDays className="w-10 h-10 mx-auto mb-3 opacity-20" />
                <p className="font-medium mb-1">No pending changes</p>
                <p className="text-sm">Click dates on the calendar to block or unblock them.</p>
              </div>
            )}

            {/* Current blocked dates list */}
            <div>
              <h3 className="font-bold text-lg mb-3">Blocked Dates ({saved.length})</h3>
              <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
                {saved.length === 0 ? (
                  <p className="p-6 text-muted-foreground text-center text-sm">No blackout dates set.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {saved.map(b => {
                      const isRemoving = toRemove.has(b.id);
                      return (
                        <li
                          key={b.id}
                          className={cn("p-4 flex justify-between items-center hover:bg-secondary/30 transition-colors", isRemoving && "opacity-40")}
                        >
                          <div>
                            <span className={cn("font-semibold text-sm", isRemoving ? "text-muted-foreground line-through" : "text-destructive")}>
                              {formatDisplay(b.date)}
                            </span>
                            {b.reason && <span className="text-sm text-muted-foreground ml-3">— {b.reason}</span>}
                          </div>
                          <button
                            onClick={() => {
                              setToRemove(prev => {
                                const n = new Set(prev);
                                if (n.has(b.id)) n.delete(b.id);
                                else n.add(b.id);
                                return n;
                              });
                            }}
                            className={cn("text-xs font-semibold transition-colors", isRemoving ? "text-amber-600 hover:text-amber-700" : "text-muted-foreground hover:text-destructive")}
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
