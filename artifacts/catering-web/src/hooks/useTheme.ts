import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "catering_web_theme";

function readStored(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // localStorage may be unavailable (privacy mode, SSR) — fall through.
  }
  return "system";
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolveEffective(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") return systemPrefersDark() ? "dark" : "light";
  return mode;
}

function applyToDocument(mode: ThemeMode) {
  if (typeof document === "undefined") return;
  const effective = resolveEffective(mode);
  const root = document.documentElement;
  if (effective === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

/**
 * Apply the persisted theme to <html> as early as possible so the page
 * doesn't flash light styles before React hydrates. Call from main.tsx
 * before render.
 */
export function initTheme(): void {
  applyToDocument(readStored());
}

/**
 * Theme hook. Returns the current persisted mode (light/dark/system),
 * the resolved class on <html> ("light" | "dark"), a setter, and a
 * convenience toggle that flips between explicit light and dark.
 */
export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(() => readStored());
  const [effective, setEffective] = useState<"light" | "dark">(() =>
    resolveEffective(readStored())
  );

  // Apply + persist whenever mode changes.
  useEffect(() => {
    applyToDocument(mode);
    setEffective(resolveEffective(mode));
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // ignore — non-fatal
    }
  }, [mode]);

  // While in "system" mode, react to OS-level changes live.
  useEffect(() => {
    if (mode !== "system") return;
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      applyToDocument("system");
      setEffective(mq.matches ? "dark" : "light");
    };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
  }, []);

  const toggle = useCallback(() => {
    setModeState((prev) => {
      const cur = resolveEffective(prev);
      return cur === "dark" ? "light" : "dark";
    });
  }, []);

  return { mode, effective, setMode, toggle };
}
