/** / — library browsing and item detail contracts. */

import { z } from "zod";
import {
  AudioTrackInfo as MediaFileAudioTrackInfo,
  SubtitleTrackInfo as MediaFileSubtitleTrackInfo,
} from "./media-files.js";

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
  /** Show-scoped movies parented to this series (direct MOVIE children + legacy season-grandchild movies) — empty unless kind === SERIES. */
  movies: z.array(EpisodeCard),
  /** Primary file's audio streams — empty for SERIES/SEASON (no file of their own). */
  audioTracks: z.array(AudioTrackInfo),
  /** Video bitrate in kbps — primary file for MOVIE/EPISODE, mean across episode files for SERIES. Null when unprobed. */
  bitrateKbps: z.number().int().nullable(),
  /** Watch summary for the requesting profile — null when no profileId was passed. */
  watch: MediaItemWatch.nullable().default(null),
  /** Identity rows — what this item is currently matched to, for the "fix match" UI. */
  externalIds: z.array(z.object({ provider: z.string(), providerId: z.string() })),
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

/** One playable file of a media item — everything a download/version picker needs. */
export const MediaFileDescriptor = z.object({
  mediaFileId: z.string(),
  /** The file browse/detail's `mediaFileId` points at — the primary playable. */
  isPrimary: z.boolean(),
  container: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  sizeBytes: z.number().nullable(),
  bitrate: z.number().int().nullable(),
  video: z
    .object({
      codec: z.string().nullable(),
      width: z.number().int().nullable(),
      height: z.number().int().nullable(),
      frameRate: z.number().nullable(),
      isHdr: z.boolean(),
    })
    .nullable(),
  audioTracks: z.array(MediaFileAudioTrackInfo),
  subtitleTracks: z.array(MediaFileSubtitleTrackInfo),
});
export type MediaFileDescriptor = z.infer<typeof MediaFileDescriptor>;

export const MediaItemFilesParams = z.object({ id: z.string() });

export const MediaItemFilesResponse = z.array(MediaFileDescriptor);
