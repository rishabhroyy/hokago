import { PrismaClient } from "@hokago/db";
import type { ContinueWatchingEntry } from "@hokago/contract/playback";
import { primaryArtworkUrl, type ArtworkRef } from "./artwork.js";

const itemInclude = {
  artwork: { select: { id: true, kind: true, priority: true } },
  files: { select: { id: true }, take: 1 },
  parent: { select: { parentId: true } },
} as const;

/**
 * Detail-page target: for an EPISODE that's its series (parent → parent),
 * everything else the item itself — continue-watching must land on the show,
 * not on the episode's own (non-existent) detail page.
 */
function detailItemId(item: { kind: string; id: string; parentId: string | null; parent: { parentId: string | null } | null }): string {
  if (item.kind === "EPISODE") return item.parent?.parentId ?? item.parentId ?? item.id;
  return item.id;
}

function toRef<
  T extends {
    id: string;
    kind: string;
    title: string;
    sortTitle: string;
    parentId: string | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
    year: number | null;
    artwork: ArtworkRef[];
    files: { id: string }[];
    parent: { parentId: string | null } | null;
    extra?: unknown;
  },
>(item: T) {
  return {
    id: item.id,
    kind: item.kind as "MOVIE" | "SERIES" | "SEASON" | "EPISODE",
    // Episodes keep their filename-derived title as identity; the provider's
    // real title rides in extra.episodeTitle and is what gets displayed.
    title:
      item.kind === "EPISODE"
        ? ((item.extra as { episodeTitle?: string } | null | undefined)?.episodeTitle ?? item.title)
        : item.title,
    sortTitle: item.sortTitle,
    parentId: item.parentId,
    seasonNumber: item.seasonNumber,
    episodeNumber: item.episodeNumber,
    year: item.year,
    posterUrl: primaryArtworkUrl(item.artwork, "POSTER"),
    backdropUrl: primaryArtworkUrl(item.artwork, "BACKDROP"),
    mediaFileId: item.files[0]?.id ?? null,
  };
}

async function findNextEpisode(
  db: PrismaClient,
  episode: {
    id: string;
    parentId: string | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
  },
) {
  if (!episode.parentId || episode.episodeNumber === null) return null;

  const nextInSeason = await db.mediaItem.findFirst({
    where: { parentId: episode.parentId, kind: "EPISODE", episodeNumber: { gt: episode.episodeNumber } },
    orderBy: { episodeNumber: "asc" },
    include: itemInclude,
  });
  if (nextInSeason) return nextInSeason;

  // No next episode in this season — try episode 1 of the next season, if any.
  const season = await db.mediaItem.findUnique({ where: { id: episode.parentId } });
  if (!season?.parentId || season.seasonNumber === null) return null;

  const nextSeason = await db.mediaItem.findFirst({
    where: { parentId: season.parentId, kind: "SEASON", seasonNumber: { gt: season.seasonNumber } },
    orderBy: { seasonNumber: "asc" },
  });
  if (!nextSeason) return null;

  return db.mediaItem.findFirst({
    include: itemInclude,
    where: { parentId: nextSeason.id, kind: "EPISODE" },
    orderBy: { episodeNumber: "asc" },
  });
}

/**
 * Continue-watching rail for a profile: in-progress items first (grouped by
 * series so a stale earlier-updated episode of the same show doesn't also
 * appear), then fully-watched episodes rolled onto their next unwatched
 * episode (upNext). Shared by /continue-watching and the /home discovery
 * surface.
 */
export async function loadContinueWatching(db: PrismaClient, profileId: string): Promise<ContinueWatchingEntry[]> {
  const states = await db.playbackState.findMany({
    where: { profileId },
    include: { mediaItem: { include: itemInclude } },
    orderBy: { updatedAt: "desc" },
  });

  const bySeries = new Map<string, { updatedAt: Date; entry: ContinueWatchingEntry }>();

  for (const state of states) {
    const item = state.mediaItem;

    if (!state.watched) {
      // In progress, not finished — surfaced as-is. Series key groups by
      // parent so a stale earlier-updated episode of the same show doesn't
      // also show up further down the list once a newer one is in progress.
      const seriesKey = item.kind === "EPISODE" ? (item.parentId ?? item.id) : item.id;
      if (!bySeries.has(seriesKey) || bySeries.get(seriesKey)!.updatedAt < state.updatedAt) {
        bySeries.set(seriesKey, {
          updatedAt: state.updatedAt,
          entry: {
            mediaItem: toRef(item),
            detailItemId: detailItemId(item),
            positionMs: state.positionMs,
            durationMs: state.durationMs,
            upNext: false,
          },
        });
      }
      continue;
    }

    // Fully watched: a movie just drops off. An episode rolls onto the next
    // unwatched episode in the series, so continue-watching still has
    // something for that show instead of silently going empty.
    if (item.kind !== "EPISODE") continue;

    const next = await findNextEpisode(db, item);
    if (!next) continue; // series finished — nothing to roll onto

    const seriesKey = item.parentId ?? item.id;
    if (!bySeries.has(seriesKey) || bySeries.get(seriesKey)!.updatedAt < state.updatedAt) {
      bySeries.set(seriesKey, {
        updatedAt: state.updatedAt,
        entry: { mediaItem: toRef(next), detailItemId: detailItemId(next), positionMs: 0, durationMs: null, upNext: true },
      });
    }
  }

  return [...bySeries.values()].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).map((v) => v.entry);
}
