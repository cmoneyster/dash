import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import { cn } from "@/lib/utils";

interface Props {
  className?: string;
  /** When true, render with full label text (used in sidebar footers). */
  withLabel?: boolean;
}

/**
 * Light/dark toggle. Click flips between explicit light and dark
 * (collapsing "system" to whatever is currently effective). Persisted
 * in localStorage and applied to <html class="dark"> via useTheme.
 */
export function ThemeToggle({ className, withLabel = false }: Props) {
  const { effective, toggle } = useTheme();
  const isDark = effective === "dark";
  const label = isDark ? "Switch to light mode" : "Switch to dark mode";

  if (withLabel) {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-label={label}
        title={label}
        data-testid="button-theme-toggle"
        className={cn(
          "flex items-center gap-3 w-full px-4 py-3 rounded-xl font-medium text-foreground/70 hover:bg-secondary hover:text-foreground transition-all duration-200",
          className,
        )}
      >
        {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        <span>{isDark ? "Light mode" : "Dark mode"}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      data-testid="button-theme-toggle"
      className={cn(
        "p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors",
        className,
      )}
    >
      {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
    </button>
  );
}
