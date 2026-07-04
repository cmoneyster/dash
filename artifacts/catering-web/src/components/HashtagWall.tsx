import { useEffect, useState } from "react";
import { Instagram, Play, X as XIcon, ExternalLink, Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

type WallItem = {
  id: number;
  instagramPostId: string;
  caption: string;
  permalink: string;
  mediaType: string;
  thumbnailUrl: string | null;
  postedAt: string | null;
};

type WallResponse = {
  enabled: boolean;
  placement: { home: boolean; gallery: boolean };
  handle: string;
  items: WallItem[];
};

async function fetchWall(): Promise<WallResponse> {
  const r = await fetch("/api/instagram/wall");
  if (!r.ok) throw new Error("Failed to load Instagram wall");
  return r.json();
}

export type HashtagWallProps = {
  /** Which page is rendering — used to honor placement settings. */
  surface: "home" | "gallery";
  /** When true, renders a header + section chrome. Default true. */
  withChrome?: boolean;
};

// Public-facing component. Renders nothing when:
//   - the wall is disabled in admin settings
//   - the placement for this surface is off
//   - there are zero approved items
// So callers can safely drop <HashtagWall surface="home"/> without thinking.
export function HashtagWall({ surface, withChrome = true }: HashtagWallProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["instagram-wall"],
    queryFn: fetchWall,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const [openItem, setOpenItem] = useState<WallItem | null>(null);

  if (isLoading || isError || !data) return null;
  if (!data.enabled) return null;
  if (surface === "home" && !data.placement.home) return null;
  if (surface === "gallery" && !data.placement.gallery) return null;
  if (data.items.length === 0) return null;

  const handle = data.handle.replace(/^@/, "");

  const inner = (
    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2 md:gap-3">
      {data.items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => setOpenItem(item)}
          className="group relative aspect-square overflow-hidden rounded-lg bg-secondary focus:outline-none focus:ring-2 focus:ring-primary/50"
          aria-label={`Open Instagram post: ${item.caption.slice(0, 80)}`}
        >
          {item.thumbnailUrl ? (
            <img
              src={item.thumbnailUrl}
              alt={item.caption ? item.caption.slice(0, 120) : "dash catering event photo"}
              loading="lazy"
              className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
              onError={(e) => {
                // Hide broken thumbnails so the grid stays tidy if IG drops one.
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-muted-foreground">
              <Instagram className="w-8 h-8 opacity-40" />
            </div>
          )}
          {item.mediaType === "VIDEO" && (
            <span className="absolute top-2 right-2 rounded-full bg-black/60 p-1.5 text-white">
              <Play className="w-3 h-3" />
            </span>
          )}
          <span className="pointer-events-none absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
        </button>
      ))}
    </div>
  );

  return (
    <>
      {withChrome ? (
        <section className="py-16 md:py-24 bg-background" data-testid="hashtag-wall">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-end justify-between mb-8">
              <div>
                <p className="text-xs font-bold uppercase tracking-widest text-primary mb-2">
                  From Instagram
                </p>
                <h2 className="font-display text-3xl md:text-4xl font-bold">
                  Real moments from real events
                </h2>
              </div>
              {handle && (
                <a
                  href={`https://instagram.com/${handle}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hidden sm:inline-flex items-center gap-2 text-sm font-semibold text-primary hover:underline"
                >
                  See more on @{handle}
                  <ExternalLink className="w-4 h-4" />
                </a>
              )}
            </div>
            {inner}
            {handle && (
              <div className="sm:hidden mt-6 flex justify-center">
                <a
                  href={`https://instagram.com/${handle}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-sm font-semibold text-primary hover:underline"
                >
                  See more on @{handle}
                  <ExternalLink className="w-4 h-4" />
                </a>
              </div>
            )}
          </div>
        </section>
      ) : (
        inner
      )}

      {openItem && <Lightbox item={openItem} onClose={() => setOpenItem(null)} />}
    </>
  );
}

// Modal lightbox. Embeds Instagram's official iframe via oEmbed (which is
// what `instagram.com/p/<id>/embed` returns directly — no API needed).
// Falls back to a plain image + "Open on Instagram" link if the embed
// can't load.
function Lightbox({ item, onClose }: { item: WallItem; onClose: () => void }) {
  const [embedFailed, setEmbedFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  // Derive the embed src from the permalink. IG accepts /p/<id>/ and /reel/<id>/.
  const embedUrl = (() => {
    if (!item.permalink) return null;
    try {
      const u = new URL(item.permalink);
      if (!/instagram\.com$/i.test(u.hostname.replace(/^www\./, ""))) return null;
      const path = u.pathname.replace(/\/?$/, "/");
      return `https://www.instagram.com${path}embed`;
    } catch {
      return null;
    }
  })();

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="relative bg-background rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 z-10 p-2 rounded-full bg-white/90 text-foreground hover:bg-white transition-colors shadow"
          aria-label="Close"
        >
          <XIcon className="w-5 h-5" />
        </button>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {embedUrl && !embedFailed ? (
            <div className="relative">
              {!loaded && (
                <div className="absolute inset-0 flex items-center justify-center bg-secondary">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              )}
              <iframe
                src={embedUrl}
                title="Instagram post"
                className="w-full"
                style={{ height: "min(90vh, 720px)", border: 0 }}
                allowFullScreen
                onLoad={() => setLoaded(true)}
                onError={() => setEmbedFailed(true)}
              />
            </div>
          ) : (
            <div className="p-4">
              {item.thumbnailUrl && (
                <img src={item.thumbnailUrl} alt={item.caption ? item.caption.slice(0, 120) : "dash catering event photo"} className="w-full rounded-lg mb-4" />
              )}
              <p className="text-sm whitespace-pre-wrap break-words text-foreground/80 mb-4">
                {item.caption || "(no caption)"}
              </p>
              {item.permalink && (
                <a
                  href={item.permalink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground font-semibold text-sm hover:opacity-90"
                >
                  Open on Instagram <ExternalLink className="w-4 h-4" />
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
