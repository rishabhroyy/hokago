import type {
  MetadataLifecycleState,
  MetadataMatch,
  MetadataProvider,
  MetadataQuery,
  MetadataSearchOptions,
  MetadataSearchResult,
} from "@hokago/metadata";

import { htmlToPlainText } from "./util.js";

const BASE_URL = process.env.HOKAGO_TVMAZE_BASE_URL ?? "https://api.tvmaze.com";

interface TvMazeShow {
  id: number;
  name: string;
  premiered: string | null;
  status: string;
  image: { medium: string | null; original: string | null } | null;
  summary: string | null;
}

interface TvMazeSearchHit {
  score: number;
  show: TvMazeShow;
}

function lifecycleFromStatus(status: string): MetadataLifecycleState {
  switch (status) {
    case "Ended":
      return "ENDED";
    case "Running":
      return "ONGOING";
    case "To Be Determined":
    case "In Development":
      return "UNRELEASED";
    default:
      return "UNKNOWN";
  }
}

/** SERIES-only identity/descriptive/artwork provider (§8.2, CC BY-SA 4.0, ≥20/10s rate limit at the queue layer). */
export class TvMazeProvider implements MetadataProvider {
  readonly provider = "TVMAZE" as const;

  async search(query: MetadataQuery, _options?: MetadataSearchOptions): Promise<MetadataSearchResult> {
    if (query.kind !== "SERIES") return { matches: [] }; // TVmaze has no movie catalog

    const url = `${BASE_URL}/search/shows?q=${encodeURIComponent(query.title)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TVmaze search failed: ${res.status} ${res.statusText}`);

    const hits = (await res.json()) as TvMazeSearchHit[];
    const matches: MetadataMatch[] = hits.map(({ show }) => ({
      providerId: String(show.id),
      title: show.name,
      year: show.premiered ? Number(show.premiered.slice(0, 4)) : undefined,
      overview: show.summary ? htmlToPlainText(show.summary) : undefined,
      premieredAt: show.premiered ?? undefined,
      lifecycleState: lifecycleFromStatus(show.status),
      artwork: show.image?.original ? [{ kind: "POSTER", url: show.image.original }] : undefined,
    }));
    return { matches };
  }
}
