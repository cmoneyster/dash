import { Layout } from "@/components/Layout";
import { HashtagWall } from "@/components/HashtagWall";
import { useQuery } from "@tanstack/react-query";

type WallStatus = {
  enabled: boolean;
  placement: { home: boolean; gallery: boolean };
  handle: string;
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

  const showEmpty =
    !isLoading &&
    data &&
    (!data.enabled || !data.placement.gallery || data.items.length === 0);

  return (
    <Layout>
      <section className="pt-32 pb-12 bg-secondary/30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <span className="inline-block py-1 px-3 rounded-full bg-primary/10 text-primary font-bold text-xs uppercase tracking-widest mb-4">
            Gallery
          </span>
          <h1 className="font-display text-4xl md:text-6xl font-bold text-foreground mb-4">
            Snapshots from the dash community
          </h1>
          <p className="text-lg text-foreground/70 max-w-2xl mx-auto">
            Real photos from real events, posted by guests and clients.
          </p>
        </div>
      </section>

      <HashtagWall surface="gallery" />

      {showEmpty && (
        <section className="py-24 bg-background">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <p className="text-lg text-muted-foreground">
              No photos to show just yet — check back soon!
            </p>
          </div>
        </section>
      )}
    </Layout>
  );
}
