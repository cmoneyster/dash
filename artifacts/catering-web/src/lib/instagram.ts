import { useQuery } from "@tanstack/react-query";

type WallMeta = {
  handle: string;
  hashtags: string[];
  enabled: boolean;
  placement: { home: boolean; gallery: boolean };
  items: unknown[];
};

async function fetchWallMeta(): Promise<WallMeta> {
  const r = await fetch("/api/instagram/wall");
  if (!r.ok) return { handle: "", hashtags: [], enabled: false, placement: { home: false, gallery: false }, items: [] };
  return r.json();
}

function useWallMeta() {
  return useQuery({
    queryKey: ["instagram-wall"],
    queryFn: fetchWallMeta,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

// Shares the same React Query cache key as HashtagWall so there is only
// ever one network request regardless of how many components call this.
export function useInstagramHandle(): string {
  const { data } = useWallMeta();
  return (data?.handle ?? "").replace(/^@/, "");
}

export function useInstagramHashtags(): string[] {
  const { data } = useWallMeta();
  return data?.hashtags ?? [];
}
