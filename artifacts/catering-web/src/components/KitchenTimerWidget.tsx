import { useState, useEffect, useRef } from "react";
import { Timer, Pencil, Check, X, Plus } from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────

type KitchenTimer = {
  id: string;
  label: string;
  durationSeconds: number;
  startedAt: number;
  alarming: boolean;
};

type TimerPreset = {
  id: string;
  name: string;
  durationSeconds: number;
};

type DraftPreset = {
  id: string;
  name: string;
  mins: string;
  secs: string;
};

// ── Storage ────────────────────────────────────────────────────────────────

const TIMERS_KEY = "kitchen-timers";
const PRESETS_KEY = "kitchen-timer-presets";

const DEFAULT_PRESETS: TimerPreset[] = [
  { id: "p1", name: "30 sec",  durationSeconds: 30   },
  { id: "p2", name: "1 min",   durationSeconds: 60   },
  { id: "p3", name: "2 min",   durationSeconds: 120  },
  { id: "p4", name: "3 min",   durationSeconds: 180  },
  { id: "p5", name: "5 min",   durationSeconds: 300  },
  { id: "p6", name: "10 min",  durationSeconds: 600  },
  { id: "p7", name: "15 min",  durationSeconds: 900  },
  { id: "p8", name: "30 min",  durationSeconds: 1800 },
];

function loadTimers(): KitchenTimer[] {
  try {
    const raw = JSON.parse(localStorage.getItem(TIMERS_KEY) ?? "[]");
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function saveTimers(timers: KitchenTimer[]) {
  localStorage.setItem(TIMERS_KEY, JSON.stringify(timers));
}

function loadPresets(): TimerPreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PRESETS_KEY) ?? "null");
    return Array.isArray(raw) && raw.length > 0 ? raw : DEFAULT_PRESETS;
  } catch { return DEFAULT_PRESETS; }
}

function savePresets(presets: TimerPreset[]) {
  localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
}

// ── Helpers ────────────────────────────────────────────────────────────────

function remainingMs(t: KitchenTimer, now: number): number {
  return t.durationSeconds * 1000 - (now - t.startedAt);
}

function fmtMs(ms: number): string {
  if (ms <= 0) return "0:00";
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function parseDur(mins: string, secs: string): number {
  const m = parseInt(mins || "0", 10);
  const s = parseInt(secs || "0", 10);
  if (!Number.isFinite(m) || !Number.isFinite(s)) return 0;
  return Math.max(0, m * 60 + s);
}

function presetToDraft(p: TimerPreset): DraftPreset {
  const m = Math.floor(p.durationSeconds / 60);
  const s = p.durationSeconds % 60;
  return { id: p.id, name: p.name, mins: m > 0 ? String(m) : "", secs: s > 0 ? String(s) : "" };
}

function playTimerAlarm() {
  try {
    const ctx = new AudioContext();
    // Three rapid high-pitched beeps — distinct from the order chime and void alarm
    [0, 0.22, 0.44].forEach(offset => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "square";
      osc.frequency.value = 1046.5; // C6
      const t = ctx.currentTime + offset;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.12, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      osc.start(t);
      osc.stop(t + 0.19);
    });
  } catch { /* AudioContext blocked — silently skip */ }
}

// ── Component ──────────────────────────────────────────────────────────────

export function KitchenTimerWidget() {
  const [timers, setTimers] = useState<KitchenTimer[]>(() => {
    const loaded = loadTimers();
    const n = Date.now();
    return loaded.map(t => ({ ...t, alarming: t.alarming || remainingMs(t, n) <= 0 }));
  });

  const [presets, setPresets] = useState<TimerPreset[]>(loadPresets);
  const [now, setNow] = useState(Date.now());
  const [showLauncher, setShowLauncher] = useState(false);
  const [editingPresets, setEditingPresets] = useState(false);
  const [draftPresets, setDraftPresets] = useState<DraftPreset[]>([]);
  const [customMins, setCustomMins] = useState("");
  const [customSecs, setCustomSecs] = useState("");
  const [customLabel, setCustomLabel] = useState("");
  const [pillCycleIdx, setPillCycleIdx] = useState(0);
  const [flashAlarm, setFlashAlarm] = useState(false);

  const alreadyAlarmedRef = useRef<Set<string>>(new Set());
  const prevAlarmingIdsRef = useRef<Set<string>>(new Set(timers.filter(t => t.alarming).map(t => t.id)));
  const launcherRef = useRef<HTMLDivElement>(null);

  // ── Main tick: update now + detect newly alarmed timers ────────────────
  useEffect(() => {
    const id = setInterval(() => {
      const n = Date.now();
      setNow(n);
      setTimers(prev => {
        let changed = false;
        const updated = prev.map(t => {
          if (!t.alarming && remainingMs(t, n) <= 0) {
            changed = true;
            if (!alreadyAlarmedRef.current.has(t.id)) {
              alreadyAlarmedRef.current.add(t.id);
            }
            return { ...t, alarming: true };
          }
          return t;
        });
        if (changed) saveTimers(updated);
        return changed ? updated : prev;
      });
    }, 250);
    return () => clearInterval(id);
  }, []);

  // ── Alarm sound + flash when timers newly become alarming ──────────────
  useEffect(() => {
    const newlyAlarming = timers.filter(t => t.alarming && !prevAlarmingIdsRef.current.has(t.id));
    if (newlyAlarming.length > 0) {
      playTimerAlarm();
      setFlashAlarm(true);
      setTimeout(() => setFlashAlarm(false), 700);
    }
    prevAlarmingIdsRef.current = new Set(timers.filter(t => t.alarming).map(t => t.id));
  }, [timers]);

  // ── Persist presets ────────────────────────────────────────────────────
  useEffect(() => { savePresets(presets); }, [presets]);

  // ── Pill cycling ───────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => setPillCycleIdx(i => i + 1), 2000);
    return () => clearInterval(id);
  }, []);

  // ── Close launcher on outside click ────────────────────────────────────
  useEffect(() => {
    if (!showLauncher) return;
    function handle(e: MouseEvent) {
      if (launcherRef.current && !launcherRef.current.contains(e.target as Node)) {
        setShowLauncher(false);
        setEditingPresets(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [showLauncher]);

  // ── Derived ────────────────────────────────────────────────────────────
  const alarmingTimers = timers.filter(t => t.alarming);
  const activeTimers = timers.filter(t => !t.alarming);
  const urgentActive = activeTimers.filter(t => remainingMs(t, now) <= 10000);
  const quietTimers = activeTimers.filter(t => remainingMs(t, now) > 10000);
  const hasUrgent = urgentActive.length > 0 || alarmingTimers.length > 0;
  const pillTimer = quietTimers.length > 0 ? quietTimers[pillCycleIdx % quietTimers.length] : null;

  // ── Handlers ───────────────────────────────────────────────────────────
  function addTimer(label: string, durationSeconds: number) {
    if (durationSeconds <= 0) return;
    const t: KitchenTimer = {
      id: crypto.randomUUID(),
      label: label.trim() || fmtMs(durationSeconds * 1000),
      durationSeconds,
      startedAt: Date.now(),
      alarming: false,
    };
    setTimers(prev => {
      const next = [...prev, t];
      saveTimers(next);
      return next;
    });
    setShowLauncher(false);
  }

  function dismissTimer(id: string) {
    setTimers(prev => {
      const next = prev.filter(t => t.id !== id);
      saveTimers(next);
      return next;
    });
    alreadyAlarmedRef.current.delete(id);
  }

  function dismissAllAlarming() {
    alarmingTimers.forEach(t => alreadyAlarmedRef.current.delete(t.id));
    setTimers(prev => {
      const next = prev.filter(t => !t.alarming);
      saveTimers(next);
      return next;
    });
  }

  function startEditPresets() {
    setDraftPresets(presets.map(presetToDraft));
    setEditingPresets(true);
  }

  function saveEditPresets() {
    const saved: TimerPreset[] = draftPresets
      .map(d => ({ id: d.id, name: d.name.trim() || "Timer", durationSeconds: parseDur(d.mins, d.secs) }))
      .filter(p => p.durationSeconds > 0);
    setPresets(saved);
    setEditingPresets(false);
  }

  function updateDraft(id: string, field: keyof DraftPreset, val: string) {
    setDraftPresets(prev => prev.map(d => d.id === id ? { ...d, [field]: val } : d));
  }

  function handleCustomStart() {
    const dur = parseDur(customMins, customSecs);
    if (dur <= 0) return;
    addTimer(customLabel, dur);
    setCustomMins("");
    setCustomSecs("");
    setCustomLabel("");
  }

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <>
      {/* Header button + launcher popover */}
      <div className="relative" ref={launcherRef}>
        <button
          onClick={() => { setShowLauncher(v => !v); setEditingPresets(false); }}
          title="Kitchen timers"
          className={`p-2 rounded-lg transition-colors relative ${
            timers.length > 0
              ? "text-amber-400 hover:bg-white/10"
              : "hover:bg-white/10 text-white/60 hover:text-white"
          }`}
        >
          <Timer className="w-4 h-4" />
          {timers.length > 0 && (
            <span className={`absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-0.5 rounded-full text-[9px] font-bold flex items-center justify-center ${
              alarmingTimers.length > 0 ? "bg-red-500 text-white animate-pulse" : "bg-amber-500 text-black"
            }`}>
              {timers.length}
            </span>
          )}
        </button>

        {showLauncher && (
          <div className="absolute right-0 top-full mt-2 w-72 bg-[#1e1e1e] border border-white/10 rounded-2xl shadow-2xl z-[60] p-4 space-y-4">
            {/* Header row */}
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-white">Kitchen Timers</span>
              {!editingPresets ? (
                <button
                  onClick={startEditPresets}
                  className="text-xs text-white/40 hover:text-white/70 flex items-center gap-1 transition-colors"
                >
                  <Pencil className="w-3 h-3" /> Edit presets
                </button>
              ) : (
                <div className="flex items-center gap-3">
                  <button onClick={saveEditPresets} className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors">
                    <Check className="w-3 h-3" /> Save
                  </button>
                  <button onClick={() => setEditingPresets(false)} className="text-xs text-white/40 hover:text-white/70 flex items-center gap-1 transition-colors">
                    <X className="w-3 h-3" /> Cancel
                  </button>
                </div>
              )}
            </div>

            {/* Preset grid or edit mode */}
            {!editingPresets ? (
              <div className="grid grid-cols-4 gap-1.5">
                {presets.map(p => (
                  <button
                    key={p.id}
                    onClick={() => addTimer(p.name, p.durationSeconds)}
                    className="flex flex-col items-center gap-0.5 px-1.5 py-2.5 rounded-xl bg-white/5 hover:bg-amber-500/20 border border-white/10 hover:border-amber-500/40 transition-colors text-center"
                  >
                    <span className="text-[10px] text-white/60 leading-tight truncate w-full text-center">{p.name}</span>
                    <span className="text-xs font-bold text-white tabular-nums">{fmtMs(p.durationSeconds * 1000)}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-2 max-h-52 overflow-y-auto pr-0.5">
                {draftPresets.map(d => (
                  <div key={d.id} className="flex items-center gap-1.5">
                    <input
                      value={d.name}
                      onChange={e => updateDraft(d.id, "name", e.target.value)}
                      placeholder="Label"
                      className="flex-1 min-w-0 px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-white text-xs placeholder:text-white/30 focus:outline-none focus:border-amber-400"
                    />
                    <input
                      type="number"
                      min={0}
                      max={99}
                      value={d.mins}
                      onChange={e => updateDraft(d.id, "mins", e.target.value)}
                      placeholder="m"
                      className="w-10 px-1.5 py-1 rounded-lg bg-white/5 border border-white/10 text-white text-xs text-center placeholder:text-white/30 focus:outline-none focus:border-amber-400"
                    />
                    <span className="text-white/30 text-xs">:</span>
                    <input
                      type="number"
                      min={0}
                      max={59}
                      value={d.secs}
                      onChange={e => updateDraft(d.id, "secs", e.target.value)}
                      placeholder="s"
                      className="w-10 px-1.5 py-1 rounded-lg bg-white/5 border border-white/10 text-white text-xs text-center placeholder:text-white/30 focus:outline-none focus:border-amber-400"
                    />
                  </div>
                ))}
              </div>
            )}

            {/* Custom timer */}
            {!editingPresets && (
              <div className="border-t border-white/10 pt-3 space-y-2">
                <p className="text-xs text-white/40">Custom</p>
                <input
                  value={customLabel}
                  onChange={e => setCustomLabel(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleCustomStart()}
                  placeholder="Label (optional)"
                  className="w-full px-2 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white text-xs placeholder:text-white/30 focus:outline-none focus:border-amber-400"
                />
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={0}
                    max={99}
                    value={customMins}
                    onChange={e => setCustomMins(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleCustomStart()}
                    placeholder="mm"
                    className="w-16 px-2 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white text-xs text-center placeholder:text-white/30 focus:outline-none focus:border-amber-400"
                  />
                  <span className="text-white/40 font-semibold">:</span>
                  <input
                    type="number"
                    min={0}
                    max={59}
                    value={customSecs}
                    onChange={e => setCustomSecs(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleCustomStart()}
                    placeholder="ss"
                    className="w-16 px-2 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white text-xs text-center placeholder:text-white/30 focus:outline-none focus:border-amber-400"
                  />
                  <button
                    onClick={handleCustomStart}
                    disabled={parseDur(customMins, customSecs) <= 0}
                    className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-black text-xs font-semibold transition-colors"
                  >
                    <Plus className="w-3 h-3" /> Start
                  </button>
                </div>
              </div>
            )}

            {/* Active timers in launcher */}
            {timers.length > 0 && !editingPresets && (
              <div className="border-t border-white/10 pt-3 space-y-1.5">
                <p className="text-xs text-white/40">Running</p>
                {timers.map(t => {
                  const rem = remainingMs(t, now);
                  const isUrgent = t.alarming || rem <= 10000;
                  return (
                    <div
                      key={t.id}
                      className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg ${
                        t.alarming
                          ? "bg-red-500/20 border border-red-500/30"
                          : isUrgent
                          ? "bg-orange-500/15 border border-orange-500/30"
                          : "bg-white/5 border border-white/10"
                      }`}
                    >
                      <span className="text-xs text-white/70 truncate mr-2">{t.label}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`text-xs font-mono font-bold tabular-nums ${
                          t.alarming ? "text-red-400 animate-pulse" : isUrgent ? "text-orange-400" : "text-amber-400"
                        }`}>
                          {t.alarming ? "Done!" : fmtMs(rem)}
                        </span>
                        <button
                          onClick={() => dismissTimer(t.id)}
                          className="text-white/30 hover:text-white/70 transition-colors"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Floating pill — quiet timers only, no urgent/alarming */}
      {!hasUrgent && pillTimer && !showLauncher && (
        <div className="fixed bottom-5 right-5 z-40 pointer-events-auto">
          <button
            onClick={() => setShowLauncher(true)}
            className="flex items-center gap-2 pl-2.5 pr-3 py-1.5 rounded-full bg-[#1e1e1e]/95 border border-amber-500/40 shadow-lg backdrop-blur-sm hover:border-amber-400/70 transition-colors"
          >
            <Timer className="w-3.5 h-3.5 text-amber-400 animate-pulse shrink-0" />
            {pillTimer.label && (
              <span className="text-xs text-white/60 truncate max-w-[72px]">{pillTimer.label}</span>
            )}
            <span className="text-sm font-mono font-bold text-amber-400 tabular-nums">
              {fmtMs(remainingMs(pillTimer, now))}
            </span>
            {quietTimers.length > 1 && (
              <span className="text-[9px] text-white/40 font-medium">+{quietTimers.length - 1}</span>
            )}
          </button>
        </div>
      )}

      {/* Urgent / alarming overlay */}
      {hasUrgent && (
        <div
          className={`fixed bottom-5 right-5 z-50 w-72 rounded-2xl shadow-2xl border backdrop-blur-md transition-colors duration-150 ${
            flashAlarm
              ? "bg-red-950/95 border-red-400"
              : "bg-[#180808]/95 border-red-500/50"
          }`}
        >
          <div className="p-4 space-y-3">
            {/* Overlay header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Timer className={`w-4 h-4 ${alarmingTimers.length > 0 ? "text-red-400 animate-pulse" : "text-orange-400"}`} />
                <span className="text-sm font-semibold text-white">
                  {alarmingTimers.length > 0 ? "Timer Alert" : "Timer"}
                </span>
              </div>
              {alarmingTimers.length > 1 && (
                <button
                  onClick={dismissAllAlarming}
                  className="text-xs text-white/40 hover:text-white/70 transition-colors"
                >
                  Dismiss all
                </button>
              )}
            </div>

            {/* Alarming timers */}
            {alarmingTimers.map(t => (
              <div
                key={t.id}
                className={`flex items-center justify-between px-3 py-2.5 rounded-xl border transition-colors ${
                  flashAlarm ? "bg-red-500/40 border-red-400/60" : "bg-red-500/20 border-red-500/40"
                }`}
              >
                <div>
                  <p className="text-sm font-semibold text-white">{t.label}</p>
                  <p className="text-xs font-bold text-red-400 animate-pulse mt-0.5">Time's up!</p>
                </div>
                <button
                  onClick={() => dismissTimer(t.id)}
                  className="px-3 py-1.5 rounded-lg bg-red-500 hover:bg-red-400 text-white text-xs font-bold transition-colors shrink-0 ml-2"
                >
                  OK
                </button>
              </div>
            ))}

            {/* Urgent (≤10s remaining, not yet alarmed) */}
            {urgentActive.map(t => {
              const rem = remainingMs(t, now);
              return (
                <div key={t.id} className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-orange-500/10 border border-orange-500/30">
                  <div>
                    <p className="text-sm font-semibold text-white/90">{t.label}</p>
                    <p className="text-4xl font-mono font-bold text-red-400 leading-none mt-1 tabular-nums">
                      {fmtMs(rem)}
                    </p>
                  </div>
                  <button
                    onClick={() => dismissTimer(t.id)}
                    className="text-white/30 hover:text-white/60 transition-colors ml-2 shrink-0"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              );
            })}

            {/* Quiet timers (small, beneath urgent) */}
            {quietTimers.length > 0 && (
              <div className="space-y-1.5 border-t border-white/10 pt-2">
                {quietTimers.map(t => {
                  const rem = remainingMs(t, now);
                  return (
                    <div key={t.id} className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10">
                      <span className="text-xs text-white/60 truncate mr-2">{t.label}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-xs font-mono font-bold text-amber-400 tabular-nums">{fmtMs(rem)}</span>
                        <button onClick={() => dismissTimer(t.id)} className="text-white/30 hover:text-white/60 transition-colors">
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
