import type {
  MetadataLifecycleState,
  MetadataMatch,
  MetadataProvider,
  MetadataQuery,
  MetadataSearchOptions,
  MetadataSearchResult,
  MetadataTitle,
} from "@hokago/metadata";

const BASE_URL = process.env.HOKAGO_ANILIST_BASE_URL ?? "https://graphql.anilist.co";

const SEARCH_QUERY = `
query ($search: String) {
  Page(page: 1, perPage: 10) {
    media(search: $search, type: ANIME) {
      id
      title { romaji english native }
      startDate { year }
      status
      description(asHtml: false)
      coverImage { extraLarge }
    }
  }
}`;

interface AniListTitle {
  romaji: string | null;
  english: string | null;
  native: string | null;
}

interface AniListMedia {
  id: number;
  title: AniListTitle;
  startDate: { year: number | null } | null;
  status: string | null;
  description: string | null;
  coverImage: { extraLarge: string | null } | null;
}

interface AniListResponse {
  data?: { Page: { media: AniListMedia[] } };
}

function lifecycleFromStatus(status: string | null): MetadataLifecycleState {
  switch (status) {
    case "FINISHED":
    case "CANCELLED":
      return "ENDED";
    case "RELEASING":
    case "HIATUS":
      return "ONGOING";
    case "NOT_YET_RELEASED":
      return "UNRELEASED";
    default:
      return "UNKNOWN";
  }
}

function primaryTitle(title: AniListTitle): string {
  return title.romaji ?? title.english ?? title.native ?? "";
}

function titleVariants(title: AniListTitle): MetadataTitle[] {
  const variants: MetadataTitle[] = [];
  if (title.romaji) variants.push({ type: "ROMAJI", value: title.romaji });
  if (title.english) variants.push({ type: "ENGLISH", value: title.english });
  if (title.native) variants.push({ type: "NATIVE", value: title.native });
  return variants;
}

/** Anime SERIES+MOVIE identity/descriptive/artwork provider (§8.2, free GraphQL, no key, rate-limited at the queue layer). */
export class AniListProvider implements MetadataProvider {
  readonly provider = "ANILIST" as const;

  async search(query: MetadataQuery, _options?: MetadataSearchOptions): Promise<MetadataSearchResult> {
    const res = await fetch(BASE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query: SEARCH_QUERY, variables: { search: query.title } }),
    });
    if (!res.ok) throw new Error(`AniList search failed: ${res.status} ${res.statusText}`);

    const body = (await res.json()) as AniListResponse;
    const media = body.data?.Page.media ?? [];
    const matches: MetadataMatch[] = media.map((m) => ({
      providerId: String(m.id),
      title: primaryTitle(m.title),
      year: m.startDate?.year ?? undefined,
      overview: m.description ?? undefined,
      lifecycleState: lifecycleFromStatus(m.status),
      titles: titleVariants(m.title),
      artwork: m.coverImage?.extraLarge ? [{ kind: "POSTER", url: m.coverImage.extraLarge }] : undefined,
    }));
    return { matches };
  }
}
