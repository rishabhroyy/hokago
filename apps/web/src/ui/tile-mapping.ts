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
    posterUrl: item.posterUrl,
    subLabel,
    badge: entry.upNext ? "NEXT" : undefined,
    progress: !entry.upNext && entry.durationMs ? entry.positionMs / entry.durationMs : undefined,
  };
}
