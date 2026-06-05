import { Layout } from "@/components/Layout";
import { HashtagWall } from "@/components/HashtagWall";
import { useQuery } from "@tanstack/react-query";
import { Instagram, ExternalLink, Camera } from "lucide-react";

type WallStatus = {
  enabled: boolean;
  placement: { home: boolean; gallery: boolean };
  handle: string;
  hashtags: string[];
  items: unknown[];
};

async function fetchWallStatus(): Promise<WallStatus> {
  const r = await fetch("/api/instagram/wall");
  if (!r.ok) throw new Error("failed");
  return r.json();
}

export default function Gallery() {
  const { data, isLoading } = useQuery({
    queryKey: ["instagram-wall"],
    queryFn: fetchWallStatus,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const handle = data?.handle?.replace(/^@/, "") ?? "";
  const hashtags: string[] = data?.hashtags ?? [];

  const hasItems =
    !isLoading &&
    data &&
    data.enabled &&
    data.placement.gallery &&
    data.items.length > 0;

  const showEmpty =
    !isLoading &&
    data &&
    (!data.enabled || !data.placement.gallery || data.items.length === 0);

  return (
    <Layout>
      {/* ── Hero ──────────────────────────────────────────────────────── */}
      <section className="pt-32 pb-12 bg-secondary/30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <span className="inline-block py-1 px-3 rounded-full bg-primary/10 text-primary font-bold text-xs uppercase tracking-widest mb-4">
            Gallery
          </span>
          <h1 className="font-display text-4xl md:text-6xl font-bold text-foreground mb-4">
            Snapshots from the dash community
          </h1>
          <p className="text-lg text-foreground/70 max-w-2xl mx-auto mb-6">
            Real photos from real events, posted by guests and clients.
          </p>

          {/* Follow button */}
          {handle && (
            <a
              href={`https://instagram.com/${handle}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-primary text-primary-foreground font-semibold text-sm hover:opacity-90 transition-opacity mb-5"
            >
              <Instagram className="w-4 h-4" />
              Follow @{handle}
            </a>
          )}

          {/* Hashtag CTA */}
          {hashtags.length > 0 && (
            <p className="text-sm text-foreground/60 mt-2">
              Tag your photos with{" "}
              {hashtags.map((h, i) => (
                <span key={h}>
                  <span className="font-semibold text-primary">#{h}</span>
                  {i < hashtags.length - 1 && " or "}
                </span>
              ))}{" "}
              to be featured here
            </p>
          )}
        </div>
      </section>

      {/* ── Photo grid ────────────────────────────────────────────────── */}
      <HashtagWall surface="gallery" />

      {/* ── Closing CTA (when photos exist) ───────────────────────────── */}
      {hasItems && handle && (
        <section className="py-12 bg-background border-t border-border">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div>
              <p className="font-semibold text-foreground">Love what you see?</p>
              <p className="text-sm text-muted-foreground">
                Follow us and tag your photos to be featured in the community gallery.
                {hashtags.length > 0 && (
                  <> Use {hashtags.map((h, i) => (
                    <span key={h}>
                      <span className="font-semibold text-primary">#{h}</span>
                      {i < hashtags.length - 1 && " or "}
                    </span>
                  ))}.
                  </>
                )}
              </p>
            </div>
            <a
              href={`https://instagram.com/${handle}`}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 inline-flex items-center gap-2 px-5 py-2.5 rounded-full border border-primary text-primary font-semibold text-sm hover:bg-primary hover:text-primary-foreground transition-colors"
            >
              <Instagram className="w-4 h-4" />
              @{handle}
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
        </section>
      )}

      {/* ── Empty state ────────────────────────────────────────────────── */}
      {showEmpty && (
        <section className="py-24 bg-background">
          <div className="max-w-lg mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-6">
              <Camera className="w-8 h-8 text-primary" />
            </div>
            <h2 className="font-display font-bold text-2xl mb-3">
              Be the first!
            </h2>
            <p className="text-muted-foreground mb-2 leading-relaxed">
              Share your dash experience and your photo could appear right here.
            </p>
            {(hashtags.length > 0 || handle) && (
              <p className="text-muted-foreground mb-8 leading-relaxed">
                {hashtags.length > 0 && (
                  <>
                    Tag your post with{" "}
                    {hashtags.map((h, i) => (
                      <span key={h}>
                        <span className="font-semibold text-primary">#{h}</span>
                        {i < hashtags.length - 1 && " or "}
                      </span>
                    ))}
                    {handle && <> or mention <span className="font-semibold text-primary">@{handle}</span></>}
                    .
                  </>
                )}
                {hashtags.length === 0 && handle && (
                  <>Mention <span className="font-semibold text-primary">@{handle}</span> in your post.</>
                )}
              </p>
            )}
            {handle && (
              <a
                href={`https://instagram.com/${handle}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-primary text-primary-foreground font-semibold hover:opacity-90 transition-opacity"
              >
                <Instagram className="w-4 h-4" />
                Follow us on Instagram
              </a>
            )}
            {!handle && (
              <p className="text-sm text-muted-foreground mt-4">
                Check back soon — photos from our events will appear here.
              </p>
            )}
          </div>
        </section>
      )}
    </Layout>
  );
}
