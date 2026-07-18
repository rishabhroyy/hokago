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

function toMatch(show: TvMazeShow): MetadataMatch {
  return {
    providerId: String(show.id),
    title: show.name,
    year: show.premiered ? Number(show.premiered.slice(0, 4)) : undefined,
    overview: show.summary ? htmlToPlainText(show.summary) : undefined,
    premieredAt: show.premiered ?? undefined,
    lifecycleState: lifecycleFromStatus(show.status),
    artwork: show.image?.original ? [{ kind: "POSTER", url: show.image.original }] : undefined,
  };
}

/** SERIES-only identity/descriptive/artwork provider (§8.2, CC BY-SA 4.0, ≥20/10s rate limit at the queue layer). */
export class TvMazeProvider implements MetadataProvider {
  readonly provider = "TVMAZE" as const;

  async search(query: MetadataQuery, options?: MetadataSearchOptions): Promise<MetadataSearchResult> {
    if (query.kind !== "SERIES") return { matches: [] }; // TVmaze has no movie catalog

    if (options?.existingProviderId) {
      return this.revalidate(options.existingProviderId, options.lastModified);
    }

    const url = `${BASE_URL}/search/shows?q=${encodeURIComponent(query.title)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TVmaze search failed: ${res.status} ${res.statusText}`);

    const hits = (await res.json()) as TvMazeSearchHit[];
    const matches: MetadataMatch[] = hits.map(({ show }) => toMatch(show));
    return { matches };
  }

  /**
   * Revalidates an already-matched show via the incremental /updates/shows
   * endpoint (§8.3) instead of re-running a fuzzy title search: one bulk poll
   * tells us which shows changed in the last day, so an unchanged show costs
   * zero per-show requests, and a changed one costs one direct /shows/{id}
   * fetch — never the fuzzy /search/shows call every rescan used to make.
   */
  private async revalidate(showId: string, lastModified?: string): Promise<MetadataSearchResult> {
    const updatesRes = await fetch(`${BASE_URL}/updates/shows?since=day`);
    if (!updatesRes.ok) throw new Error(`TVmaze updates check failed: ${updatesRes.status} ${updatesRes.statusText}`);
    const updates = (await updatesRes.json()) as Record<string, number>;
    const updatedAt = updates[showId];

    if (updatedAt === undefined || (lastModified && String(updatedAt) <= lastModified)) {
      return { matches: [], notModified: true, lastModified: lastModified ?? String(Math.floor(Date.now() / 1000)) };
    }

    const showRes = await fetch(`${BASE_URL}/shows/${showId}`);
    if (!showRes.ok) throw new Error(`TVmaze show fetch failed: ${showRes.status} ${showRes.statusText}`);
    const show = (await showRes.json()) as TvMazeShow;
    return { matches: [toMatch(show)], lastModified: String(updatedAt) };
  }
}
