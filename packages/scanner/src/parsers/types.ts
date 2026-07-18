export interface ParsedFilename {
  title: string | null;
  year: number | null;
  season: number | null;
  episode: number | null;
  /** Anime absolute numbering (e.g. "Series - 38"), resolved to seasonal via IdMapping.episodeOffset (§7.4). */
  absoluteNumber: number | null;
  /** Anime fansub release group, e.g. "[Group]" — anitomy-only, null from the scene parser. */
  releaseGroup: string | null;
}
