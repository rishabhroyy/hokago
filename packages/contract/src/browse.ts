/** / — library browsing and item detail contracts. */

import { z } from "zod";

export const MediaKind = z.enum(["MOVIE", "SERIES", "SEASON", "EPISODE"]);
export const ContentProfile = z.enum(["GENERAL", "ANIME"]);
export const RelationType = z.enum([
  "MAIN",
  "MOVIE",
  "OVA",
  "SPECIAL",
  "RECAP",
  "SIDE_STORY",
  "PREQUEL",
  "SEQUEL",
]);

export const LibrarySummary = z.object({
  id: z.string(),
  name: z.string(),
  contentProfile: ContentProfile,
  mediaKinds: z.array(MediaKind),
});
export type LibrarySummary = z.infer<typeof LibrarySummary>;

export const MediaCard = z.object({
  id: z.string(),
  kind: MediaKind,
  title: z.string(),
  sortTitle: z.string(),
  year: z.number().int().nullable(),
  posterUrl: z.string().nullable(),
  backdropUrl: z.string().nullable(),
  /** Primary playable file, if any (leaf MOVIE/EPISODE items only) — null for SERIES/SEASON. */
  mediaFileId: z.string().nullable(),
  /** False for a bare folder item (empty dir) with no episodes/files — "not downloaded" in the UI. */
  isDownloaded: z.boolean(),
  genres: z.array(z.string()),
  createdAt: z.coerce.date(),
});
export type MediaCard = z.infer<typeof MediaCard>;

export const LibraryItemsParams = z.object({ id: z.string() });

export const MediaItemDetailParams = z.object({ id: z.string() });

/** Optional profileId scopes the detail response's watch data (episode watched marks, resume positions, item summary). */
export const MediaItemDetailQuery = z.object({ profileId: z.string().optional() });

export const CollectionEntry = z.object({
  relationType: RelationType,
  anchor: z.string().nullable(),
  item: MediaCard,
});

export const EpisodeCard = MediaCard.extend({
  seasonNumber: z.number().int().nullable(),
  episodeNumber: z.number().int().nullable(),
  runtimeMs: z.number().int().nullable(),
  /** Whether the requesting profile has watched this episode to completion. */
  watched: z.boolean().default(false),
  /** Resume position for the requesting profile — 0 when never started. */
  positionMs: z.number().default(0),
});
export type EpisodeCard = z.infer<typeof EpisodeCard>;

/** Per-profile watch summary for a media item (from PlaybackState). */
export const MediaItemWatch = z.object({
  watched: z.boolean(),
  positionMs: z.number(),
  durationMs: z.number().nullable(),
  /** Rewatch count — times watched to completion. */
  playCount: z.number(),
  lastWatchedAt: z.coerce.date().nullable(),
});
export type MediaItemWatch = z.infer<typeof MediaItemWatch>;

export const AudioTrackInfo = z.object({ streamIndex: z.number().int(), lang: z.string().nullable() });
export type AudioTrackInfo = z.infer<typeof AudioTrackInfo>;

export const MediaItemDetail = MediaCard.extend({
  overview: z.string().nullable(),
  originalTitle: z.string().nullable(),
  /** 0–10 normalized aggregate from the matched provider (TVmaze average, AniList averageScore/10, Jikan score). */
  rating: z.number().nullable(),
  genres: z.array(z.string()),
  studio: z.string().nullable(),
  children: z.array(MediaCard),
  /** Flattened grandchildren (episodes across all seasons) — empty unless kind === SERIES. */
  episodes: z.array(EpisodeCard),
  /** Primary file's audio streams — empty for SERIES/SEASON (no file of their own). */
  audioTracks: z.array(AudioTrackInfo),
  /** Watch summary for the requesting profile — null when no profileId was passed. */
  watch: MediaItemWatch.nullable().default(null),
  collections: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.enum(["FRANCHISE", "MOVIE_SET"]),
      posterUrl: z.string().nullable(),
      relationType: RelationType,
      entries: z.array(CollectionEntry),
    }),
  ),
});
export type MediaItemDetail = z.infer<typeof MediaItemDetail>;

export const NotFoundError = z.object({ error: z.string() });
