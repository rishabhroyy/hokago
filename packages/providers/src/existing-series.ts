import { acceptMatch } from "./match.js";
import type { MetadataMatch, MetadataQuery } from "@hokago/metadata";

export interface ExistingSeriesDeps {
  db: {
    mediaItem: {
      // Series-level lookup for findExistingSeries.
      findMany(args: {
        where: { libraryId: string; kind: "SERIES" };
      }): Promise<{ id: string; title: string; originalTitle: string | null; year: number | null }[]>;
    };
  };
}

/**
 * Reuses a show a library already has instead of always deriving a fresh
 * title from whatever text one request happens to carry — the same
 * acceptance logic (acceptMatch) the scanner's own metadata step already
 * trusts for "is this the same show", applied locally against the library's
 * existing items instead of a remote provider's search results. No network
 * call: the library's own history is the candidate list. A near-duplicate
 * folder for a show hokago already knows about (different release,
 * different raw title, same actual anime) is exactly what this prevents.
 *
 * The one shared implementation — apps/worker's acquire-import.ts (file
 * placement) and apps/api's acquire-routes.ts (season/episode dedup, see
 * checkSeasonDedup below) both call this instead of each keeping their own
 * copy, so "is this the same show" is answered exactly one way everywhere.
 */
export async function findExistingSeries(
  deps: ExistingSeriesDeps,
  libraryId: string,
  title: string,
  year: number | null,
): Promise<{ id: string; title: string; year: number | null } | undefined> {
  const existing = await deps.db.mediaItem.findMany({ where: { libraryId, kind: "SERIES" } });
  const query: MetadataQuery = { title, year: year ?? undefined, kind: "SERIES" };
  const match = existing.find((item) => {
    const candidate: MetadataMatch = {
      providerId: "local",
      title: item.title,
      year: item.year ?? undefined,
      titles: item.originalTitle ? [{ type: "SYNONYM", value: item.originalTitle }] : undefined,
    };
    if (acceptMatch(query, candidate)) return true;
    // Bidirectional: acceptMatch only checks "query in candidate" (short
    // folder in fuller provider title). Library-vs-request has no such
    // direction — the stored row can be the short form ("Anohana") while
    // the request carries the fuller one ("Anohana The Flower We Saw That
    // Day BD 1080p" → cleaned to the full title), or vice versa. Without
    // the reverse check the longer side never matches the shorter and the
    // import forks a duplicate folder for the same show.
    const reverseQueryBase = { kind: "SERIES" as const, year: item.year ?? undefined };
    const reverseCandidate: MetadataMatch = {
      providerId: "local",
      title,
      year: year ?? undefined,
    };
    if (acceptMatch({ ...reverseQueryBase, title: item.title }, reverseCandidate)) return true;
    if (item.originalTitle && acceptMatch({ ...reverseQueryBase, title: item.originalTitle }, reverseCandidate)) return true;
    return false;
  });
  return match ? { id: match.id, title: match.title, year: match.year } : undefined;
}

export interface SeasonBreakdown {
  /** 0 = specials, per TVDB/Kodi convention (matches MediaItem.seasonNumber). */
  season: number;
  /** Sorted ascending. */
  episodeNumbers: number[];
}

export interface SeasonsForSeriesDeps {
  db: {
    mediaItem: {
      findMany(args: {
        where: { parent: { parentId: string }; kind: "EPISODE" };
      }): Promise<{ seasonNumber: number | null; episodeNumber: number | null }[]>;
    };
  };
}

/**
 * Real per-season episode presence for a SERIES row — walks the actual
 * SERIES -> SEASON -> EPISODE hierarchy (parent.parentId, two hops down)
 * rather than matching by title across mixed item kinds the way the old
 * anicli-only dedup check used to.
 */
export async function seasonsForSeries(deps: SeasonsForSeriesDeps, seriesId: string): Promise<SeasonBreakdown[]> {
  const episodes = await deps.db.mediaItem.findMany({ where: { parent: { parentId: seriesId }, kind: "EPISODE" } });
  const bySeason = new Map<number, Set<number>>();
  for (const ep of episodes) {
    if (ep.episodeNumber == null) continue;
    const season = ep.seasonNumber ?? 1;
    if (!bySeason.has(season)) bySeason.set(season, new Set());
    bySeason.get(season)!.add(ep.episodeNumber);
  }
  return [...bySeason.entries()]
    .map(([season, nums]) => ({ season, episodeNumbers: [...nums].sort((a, b) => a - b) }))
    .sort((a, b) => a.season - b.season);
}

/** Single episode ("5") or an ascending "A-B" of positive integers — same shape acquire-routes.ts already validates episodeRange against before it ever reaches ani-cli's -r flag. Returns null for anything else. */
function parseEpisodeRangeSet(range: string | undefined): Set<number> | null {
  if (!range) return null;
  const m = /^(\d+)(?:-(\d+))?$/.exec(range.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : start;
  if (end < start) return null;
  const set = new Set<number>();
  for (let n = start; n <= end; n++) set.add(n);
  return set;
}

export type SeasonDedupDeps = ExistingSeriesDeps & SeasonsForSeriesDeps;

/**
 * Provider-agnostic season/episode dedup gate — the one check both the
 * built-in ani-cli route and every external-provider route run before
 * enqueueing a download, so external providers get the same protection
 * ani-cli already had (previously they had none at all).
 *
 * Season 0 (specials) always clears — its folder never collides with
 * numbered-season episodes. A season with no existing episodes clears too
 * (a genuinely new season, or one emptied via the admin
 * delete-files-keep-folder action — either way there's nothing to collide
 * with). When the target season DOES already have episodes: an explicit
 * episodeRange not fully covered by what's already present is allowed
 * through (grabbing the next batch of an airing show); a fully-covered
 * range, or no range at all against a partially-filled season, fails closed
 * rather than guessing what the caller actually wants.
 */
export async function checkSeasonDedup(
  deps: SeasonDedupDeps,
  libraryId: string,
  title: string,
  year: number | null,
  season: number | null,
  episodeRange: string | undefined,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (season === 0) return { ok: true };
  const match = await findExistingSeries(deps, libraryId, title, year);
  if (!match) return { ok: true };

  const breakdown = await seasonsForSeries(deps, match.id);
  const targetSeason = season ?? 1;
  const existing = breakdown.find((b) => b.season === targetSeason);
  if (!existing || existing.episodeNumbers.length === 0) return { ok: true };

  const requested = parseEpisodeRangeSet(episodeRange);
  if (requested === null) {
    return {
      ok: false,
      reason: `season ${targetSeason} already has ${existing.episodeNumbers.length} episode(s) on the server — specify an episode range to grab only what's missing`,
    };
  }
  const already = new Set(existing.episodeNumbers);
  if ([...requested].every((n) => already.has(n))) {
    return { ok: false, reason: `episodes ${episodeRange} of season ${targetSeason} are already on the server` };
  }
  return { ok: true };
}
