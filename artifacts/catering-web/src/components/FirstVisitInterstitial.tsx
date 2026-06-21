import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { MapPin, UtensilsCrossed, X, Flame } from "lucide-react";

const STORAGE_KEY = "dash_landing_suppressed_until_v1";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function isSuppressed(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const until = Number(raw);
    if (!Number.isFinite(until)) return false;
    return until > Date.now();
  } catch {
    return false;
  }
}

type Tile = {
  id: "at-event" | "browsing";
  title: string;
  body: string;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
  testId: string;
  otdBadge?: true;
};

const TILES: Tile[] = [
  {
    id: "at-event",
    title: "I'm at an event — or want to try the demo",
    body: "Order food at a live event, or take a guided tour of the guest ordering experience.",
    icon: MapPin,
    href: "/event",
    testId: "tile-at-event",
    otdBadge: true,
  },
  {
    id: "browsing",
    title: "Browse the menu / plan an event",
    body: "Explore our full menu, build your event plan, and submit a catering inquiry — all at your own pace.",
    icon: UtensilsCrossed,
    href: "/",
    testId: "tile-browsing",
  },
];

export function FirstVisitInterstitial() {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState<boolean | null>(null);
  const [suppress, setSuppress] = useState(false);

  useEffect(() => {
    setOpen(!isSuppressed());
  }, []);

  // Lock body scroll while the overlay is up.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  function pickTile(href: string) {
    if (suppress) {
      try {
        localStorage.setItem(STORAGE_KEY, String(Date.now() + SEVEN_DAYS_MS));
      } catch {
        // ignore
      }
    }
    setOpen(false);
    navigate(href);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="What brings you here today?"
      className="fixed inset-0 z-[100] bg-foreground/85 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 overflow-y-auto"
    >
      <div className="relative w-full max-w-2xl bg-card rounded-2xl sm:rounded-3xl shadow-2xl p-4 sm:p-10 my-3 sm:my-8">
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close"
          className="absolute top-2 right-2 sm:top-4 sm:right-4 p-2 rounded-full text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="text-center mb-4 sm:mb-8 pr-8 sm:pr-0">
          <h2 className="font-display font-bold text-lg sm:text-4xl">
            What brings you to dash today?
          </h2>
          <p className="text-xs sm:text-base text-muted-foreground mt-1 sm:mt-2 max-w-xl mx-auto">
            Pick the option that fits. You can always come back from here.
          </p>
        </div>

        <label className="flex items-center justify-center gap-2 mb-3 sm:mb-6 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={suppress}
            onChange={(e) => setSuppress(e.target.checked)}
            className="w-4 h-4 accent-primary"
            data-testid="suppress-7d"
          />
          <span className="text-xs sm:text-sm text-foreground/80">
            Don't show this again for 7 days
          </span>
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 sm:gap-4">
          {TILES.map((tile) => {
            const Icon = tile.icon;
            return (
              <button
                key={tile.id}
                type="button"
                onClick={() => pickTile(tile.href)}
                data-testid={tile.testId}
                className="group text-left flex sm:flex-col items-start gap-3 p-3 sm:p-6 rounded-xl sm:rounded-2xl border border-border bg-background hover:bg-primary/5 hover:border-primary hover:-translate-y-0.5 hover:shadow-lg transition-all"
              >
                <div className="w-9 h-9 sm:w-12 sm:h-12 shrink-0 rounded-lg sm:rounded-xl bg-secondary group-hover:bg-primary group-hover:text-primary-foreground flex items-center justify-center transition-colors">
                  <Icon className="w-4.5 h-4.5 sm:w-6 sm:h-6" />
                </div>
                <div className="flex-1 min-w-0">
                  {tile.otdBadge && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-orange-600 dark:text-orange-400 mb-1.5">
                      <Flame className="w-3 h-3" />
                      On the Dash Experience
                    </span>
                  )}
                  <p className="font-bold text-sm sm:text-base leading-snug">{tile.title}</p>
                  <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed mt-1 sm:mt-2 flex-1">{tile.body}</p>
                  <span className="hidden sm:inline-block text-xs uppercase tracking-widest font-semibold text-primary mt-3">
                    Choose →
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
