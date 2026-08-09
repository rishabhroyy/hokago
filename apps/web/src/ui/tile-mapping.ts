import type { MediaCard } from "../browse-api";
import type { ContinueWatchingEntry } from "@hokago/contract/playback";
import type { TileItem } from "./Tile";

function kindLabel(kind: string): string {
  return kind === "MOVIE" ? "Movie" : kind === "SERIES" ? "Series" : kind === "SEASON" ? "Season" : "Episode";
}

export function cardToTile(item: MediaCard): TileItem {
  return {
    id: item.id,
    title: item.title,
    posterUrl: item.posterUrl,
    subLabel: kindLabel(item.kind),
    badge: item.isDownloaded ? undefined : "NOT DOWNLOADED",
  };
}

export function continueWatchingToTile(entry: ContinueWatchingEntry): TileItem {
  const item = entry.mediaItem;
  const subLabel =
    item.kind === "EPISODE" && item.seasonNumber != null && item.episodeNumber != null
      ? `S${item.seasonNumber}·E${item.episodeNumber}`
      : kindLabel(item.kind);
  return {
    id: item.id,
    title: item.title,
    // Episodes have both posters and backdrops — a continuing episode reads
    // as a landscape "watched so far" card (backdrop), not a vertical poster.
    posterUrl: item.kind === "EPISODE" ? (item.backdropUrl ?? item.posterUrl) : item.posterUrl,
    landscape: item.kind === "EPISODE",
    subLabel,
    detailId: entry.detailItemId,
    badge: entry.upNext ? "NEXT" : undefined,
    progress: !entry.upNext && entry.durationMs ? entry.positionMs / entry.durationMs : undefined,
  };
}
