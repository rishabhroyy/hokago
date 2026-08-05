import type {
  EpisodeMetadata,
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
  title_japanese: string | null;
  aired: { from: string | null } | null;
  status: string | null;
  synopsis: string | null;
  score: number | null;
  genres: { name: string }[] | null;
  studios: { name: string }[] | null;
  images: { jpg: { large_image_url: string | null } } | null;
}

interface JikanResponse {
  data: JikanAnime[];
}

interface JikanEpisode {
  mal_id: number;
  title: string | null;
}

interface JikanEpisodeResponse {
  data: JikanEpisode[];
  pagination: { has_next_page: boolean };
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
 * Anime fallback provider , used when AniList misses. Backed by
 * Cloudflare edge caching that honors If-Modified-Since — the only one of
 * the three providers where a conditional revalidation can return a real 304
 * , which resolveMetadata uses on MetadataCache TTL expiry to avoid a
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
      originalTitle: anime.title_japanese ?? undefined,
      genres: anime.genres && anime.genres.length > 0 ? anime.genres.map((g) => g.name) : undefined,
      rating: anime.score ?? undefined,
      studio: anime.studios?.find((s) => s.name)?.name ?? undefined,
    }));
    return { matches, lastModified };
  }

  /**
   * Per-episode titles from MAL. The catalog is a flat absolute-episode list
   * (no seasons — Japanese broadcast order), so seasonNumber is always 1 and
   * episodeNumber is the absolute position, matching how the scanner numbers
   * single-season series. Titles MAL leaves blank or generically ("Episode N")
   * are dropped so they can't clobber filename-derived ones.
   */
  async episodes(providerId: string): Promise<EpisodeMetadata[]> {
    const out: EpisodeMetadata[] = [];
    let page = 1;
    for (;;) {
      const res = await fetch(`${BASE_URL}/anime/${encodeURIComponent(providerId)}/episodes?page=${page}`);
      if (!res.ok) {
        if (res.status === 404) break;
        throw new Error(`Jikan episodes failed: ${res.status} ${res.statusText}`);
      }
      const body = (await res.json()) as JikanEpisodeResponse;
      for (const ep of body.data) {
        const title = ep.title?.trim();
        if (!title || /^episode\s*\d+$/i.test(title)) continue;
        out.push({ seasonNumber: 1, episodeNumber: ep.mal_id, title });
      }
      if (!body.pagination?.has_next_page) break;
      page += 1;
    }
    return out;
  }
}
