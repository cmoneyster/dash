import { useEffect, useId, useMemo, useRef, useState } from "react";
import { MapPin, Loader2, Search } from "lucide-react";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type Suggestion = {
  placeId: string;
  primaryText: string;
  secondaryText: string;
  fullText: string;
};

type Props = {
  value: string;
  onChange: (formattedAddress: string, placeName?: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  id?: string;
};

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `tok-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Type-ahead venue / address picker backed by the server-side Google Places
 * proxy at `/api/places/*`. Used by both the customer cart checkout and the
 * admin Catering Orders editor so a single string format ends up in the
 * `venueAddress` column.
 *
 * If the server reports the lookup is unavailable (no API key, quota
 * exhausted, etc.) the component degrades to a plain text input with a
 * small explanatory hint — the form continues to work either way.
 */
export function VenueAutocomplete({
  value,
  onChange,
  placeholder = "Search venue or address…",
  disabled = false,
  className,
  inputClassName,
  id,
}: Props) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  // Local controlled text — keeps caret behavior smooth while debouncing.
  // Synced from the parent on the initial mount and whenever the parent
  // pushes a new value (e.g. selecting a saved inquiry).
  const [text, setText] = useState(value);
  useEffect(() => { setText(value); }, [value]);

  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [available, setAvailable] = useState<boolean>(true);
  const [resolving, setResolving] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);

  // Stable session token per "session" (cart visit / editing pass). Google
  // bills autocomplete + details together when the same token is reused,
  // which is the cheapest billing mode.
  const sessionToken = useMemo(() => uuid(), []);

  const wrapRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<number | null>(null);
  const lastQueryRef = useRef<string>("");

  // Click-outside closes the dropdown.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function runQuery(q: string) {
    const trimmed = q.trim();
    lastQueryRef.current = trimmed;
    if (trimmed.length < 2) {
      setSuggestions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    fetch(
      `${API_BASE}/api/places/autocomplete?q=${encodeURIComponent(trimmed)}&sessionToken=${encodeURIComponent(sessionToken)}`,
    )
      .then(async (r) => {
        if (r.status === 503) {
          setAvailable(false);
          setOpen(false);
          return null;
        }
        if (!r.ok) return null;
        return r.json() as Promise<{ suggestions: Suggestion[] }>;
      })
      .then((body) => {
        // Late responses for stale queries get dropped.
        if (lastQueryRef.current !== trimmed) return;
        if (body) {
          setSuggestions(body.suggestions ?? []);
          setActiveIdx(body.suggestions?.length ? 0 : -1);
        }
      })
      .catch(() => {
        // Network error — leave the dropdown empty rather than throwing.
      })
      .finally(() => {
        if (lastQueryRef.current === trimmed) setLoading(false);
      });
  }

  function handleInput(next: string) {
    setText(next);
    onChange(next); // keep the form value in sync as the user types
    setOpen(true);
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => runQuery(next), 250);
  }

  async function pick(s: Suggestion) {
    setOpen(false);
    setResolving(true);
    try {
      const r = await fetch(
        `${API_BASE}/api/places/details/${encodeURIComponent(s.placeId)}?sessionToken=${encodeURIComponent(sessionToken)}`,
      );
      if (r.status === 503) {
        setAvailable(false);
        // Best-effort fallback: use the suggestion text directly.
        setText(s.fullText);
        onChange(s.fullText, s.primaryText);
        return;
      }
      if (!r.ok) {
        setText(s.fullText);
        onChange(s.fullText, s.primaryText);
        return;
      }
      const body = (await r.json()) as {
        composed?: string;
        formattedAddress?: string;
        placeName?: string | null;
      };
      const finalText = body.composed || body.formattedAddress || s.fullText;
      setText(finalText);
      onChange(finalText, body.placeName ?? s.primaryText);
    } catch {
      setText(s.fullText);
      onChange(s.fullText, s.primaryText);
    } finally {
      setResolving(false);
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter") {
      if (activeIdx >= 0 && activeIdx < suggestions.length) {
        e.preventDefault();
        void pick(suggestions[activeIdx]!);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  // Plain-text fallback when the server reports lookup unavailable.
  if (!available) {
    return (
      <div className={className}>
        <input
          id={inputId}
          value={text}
          onChange={(e) => { setText(e.target.value); onChange(e.target.value); }}
          placeholder={placeholder}
          disabled={disabled}
          className={inputClassName}
        />
        <p className="text-xs text-muted-foreground mt-1">
          Address lookup is unavailable — please type the venue or address manually.
        </p>
      </div>
    );
  }

  return (
    <div className={className} ref={wrapRef}>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        <input
          id={inputId}
          value={text}
          onChange={(e) => handleInput(e.target.value)}
          onFocus={() => { if (suggestions.length > 0) setOpen(true); }}
          onKeyDown={onKey}
          placeholder={placeholder}
          disabled={disabled || resolving}
          autoComplete="off"
          className={inputClassName ? `${inputClassName} pl-9 pr-9` : "w-full pl-9 pr-9 py-2.5 bg-background border border-border rounded-xl focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all"}
        />
        {(loading || resolving) && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground animate-spin" />
        )}
      </div>

      {open && suggestions.length > 0 && (
        <div className="absolute z-30 mt-1 w-full max-w-full bg-card border border-border rounded-xl shadow-lg max-h-72 overflow-y-auto">
          {suggestions.map((s, i) => (
            <button
              key={s.placeId}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); void pick(s); }}
              onMouseEnter={() => setActiveIdx(i)}
              className={`w-full flex items-start gap-2.5 px-3 py-2.5 text-left text-sm transition-colors ${
                i === activeIdx ? "bg-secondary" : "hover:bg-secondary"
              }`}
            >
              <MapPin className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="font-medium truncate">{s.primaryText || s.fullText}</p>
                {s.secondaryText && (
                  <p className="text-xs text-muted-foreground truncate">{s.secondaryText}</p>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default VenueAutocomplete;
