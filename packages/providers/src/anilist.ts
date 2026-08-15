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
      idMal
      title { romaji english native }
      startDate { year }
      status
      description(asHtml: false)
      coverImage { extraLarge }
      genres
      averageScore
      studios(isMain: true) { nodes { name } }
    }
  }
}`;

const ALTERNATE_ID_QUERY = `
query ($id: Int) {
  Media(id: $id) {
    idMal
  }
}`;

/** Full detail for an exact id — used for revalidation/pins (Media(id:) is exact, no search ambiguity). */
const ID_QUERY = `
query ($id: Int) {
  Media(id: $id) {
    id
    idMal
    title { romaji english native }
    startDate { year }
    status
    description(asHtml: false)
    coverImage { extraLarge }
    genres
    averageScore
    studios(isMain: true) { nodes { name } }
  }
}`;

interface AniListTitle {
  romaji: string | null;
  english: string | null;
  native: string | null;
}

interface AniListMedia {
  id: number;
  idMal: number | null;
  title: AniListTitle;
  startDate: { year: number | null } | null;
  status: string | null;
  description: string | null;
  coverImage: { extraLarge: string | null } | null;
  genres: string[] | null;
  averageScore: number | null;
  studios: { nodes: { name: string | null }[] | null } | null;
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

function toMatch(m: AniListMedia): MetadataMatch {
  return {
    providerId: String(m.id),
    title: primaryTitle(m.title),
    year: m.startDate?.year ?? undefined,
    overview: m.description ?? undefined,
    lifecycleState: lifecycleFromStatus(m.status),
    titles: titleVariants(m.title),
    artwork: m.coverImage?.extraLarge ? [{ kind: "POSTER", url: m.coverImage.extraLarge }] : undefined,
    originalTitle: m.title.native ?? undefined,
    genres: m.genres && m.genres.length > 0 ? m.genres : undefined,
    rating: m.averageScore != null ? m.averageScore / 10 : undefined,
    studio: m.studios?.nodes?.find((n) => n.name)?.name ?? undefined,
    // idMal is authoritative — lets the resolver persist a MAL ExternalId so
    // episode titles (which AniList doesn't carry) can be pulled from Jikan.
    alternateIds: m.idMal != null ? [{ provider: "MAL", id: String(m.idMal) }] : undefined,
  };
}

/** Anime SERIES+MOVIE identity/descriptive/artwork provider (free GraphQL, no key, rate-limited at the queue layer). */
export class AniListProvider implements MetadataProvider {
  readonly provider = "ANILIST" as const;

  async search(query: MetadataQuery, options?: MetadataSearchOptions): Promise<MetadataSearchResult> {
    // An already-known id revalidates exactly — never a fuzzy title search
    // (revalidation of a renamed show or a manually pinned id must not miss).
    if (options?.existingProviderId) {
      const res = await fetch(BASE_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ query: ID_QUERY, variables: { id: Number(options.existingProviderId) } }),
      });
      // A gone/never-existing id is a deterministic miss (AniList answers 404
      // with data.Media null), not an infrastructure failure — no match, move on.
      if (res.status === 404) {
        const body = (await res.json().catch(() => null)) as { data?: { Media?: AniListMedia | null } } | null;
        return { matches: [] };
      }
      if (!res.ok) throw new Error(`AniList id lookup failed: ${res.status} ${res.statusText}`);
      const body = (await res.json()) as { data?: { Media?: AniListMedia | null } };
      if (body.data?.Media == null) return { matches: [] };
      return { matches: [toMatch(body.data.Media)] };
    }

    const res = await fetch(BASE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query: SEARCH_QUERY, variables: { search: query.title } }),
    });
    if (!res.ok) throw new Error(`AniList search failed: ${res.status} ${res.statusText}`);

    const body = (await res.json()) as AniListResponse;
    const media = body.data?.Page.media ?? [];
    return { matches: media.map(toMatch) };
  }

  /** Direct id→idMal lookup for an already-matched AniList id (Media(id:) is exact, no search ambiguity). */
  async alternateIds(providerId: string): Promise<Array<{ provider: string; id: string }>> {
    const res = await fetch(BASE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query: ALTERNATE_ID_QUERY, variables: { id: Number(providerId) } }),
    });
    if (!res.ok) throw new Error(`AniList alternateIds failed: ${res.status} ${res.statusText}`);
    const body = (await res.json()) as { data?: { Media?: { idMal: number | null } | null } };
    const idMal = body.data?.Media?.idMal;
    return idMal != null ? [{ provider: "MAL", id: String(idMal) }] : [];
  }
}
