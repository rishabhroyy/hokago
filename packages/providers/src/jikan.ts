import type {
  MetadataLifecycleState,
  MetadataMatch,
  MetadataProvider,
  MetadataQuery,
  MetadataSearchOptions,
  MetadataSearchResult,
} from "@hokago/metadata";

const BASE_URL = process.env.HOKAGO_JIKAN_BASE_URL ?? "https://api.jikan.moe/v4";

interface JikanAnime {
  mal_id: number;
  title: string;
  aired: { from: string | null } | null;
  status: string | null;
  synopsis: string | null;
  images: { jpg: { large_image_url: string | null } } | null;
}

interface JikanResponse {
  data: JikanAnime[];
}

function lifecycleFromStatus(status: string | null): MetadataLifecycleState {
  switch (status) {
    case "Finished Airing":
      return "ENDED";
    case "Currently Airing":
      return "ONGOING";
    case "Not yet aired":
      return "UNRELEASED";
    default:
      return "UNKNOWN";
  }
}

/**
 * Anime fallback provider (§8.2), used when AniList misses. Backed by
 * Cloudflare edge caching that honors If-Modified-Since — the only one of
 * the three providers where a conditional revalidation can return a real 304
 * (§8.3), which resolveMetadata uses on MetadataCache TTL expiry to avoid a
 * full re-fetch. (Jikan has no ETag — verified live against api.jikan.moe,
 * which returns Cache-Control/Last-Modified but no ETag header.)
 */
export class JikanProvider implements MetadataProvider {
  readonly provider = "MAL" as const;

  async search(query: MetadataQuery, options?: MetadataSearchOptions): Promise<MetadataSearchResult> {
    const url = `${BASE_URL}/anime?q=${encodeURIComponent(query.title)}&limit=10`;
    const headers: Record<string, string> = {};
    if (options?.lastModified) headers["if-modified-since"] = options.lastModified;

    const res = await fetch(url, { headers });
    if (res.status === 304) return { matches: [], notModified: true, lastModified: options?.lastModified };
    if (!res.ok) throw new Error(`Jikan search failed: ${res.status} ${res.statusText}`);

    const lastModified = res.headers.get("last-modified") ?? undefined;
    const body = (await res.json()) as JikanResponse;
    const matches: MetadataMatch[] = body.data.map((anime) => ({
      providerId: String(anime.mal_id),
      title: anime.title,
      year: anime.aired?.from ? Number(anime.aired.from.slice(0, 4)) : undefined,
      overview: anime.synopsis ?? undefined,
      premieredAt: anime.aired?.from ?? undefined,
      lifecycleState: lifecycleFromStatus(anime.status),
      artwork: anime.images?.jpg.large_image_url ? [{ kind: "POSTER", url: anime.images.jpg.large_image_url }] : undefined,
    }));
    return { matches, lastModified };
  }
}
