/** §7.3/§7.6 — library browsing and item detail contracts. */

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
  createdAt: z.coerce.date(),
});
export type MediaCard = z.infer<typeof MediaCard>;

export const LibraryItemsParams = z.object({ id: z.string() });

export const MediaItemDetailParams = z.object({ id: z.string() });

export const CollectionEntry = z.object({
  relationType: RelationType,
  anchor: z.string().nullable(),
  item: MediaCard,
});

export const EpisodeCard = MediaCard.extend({
  seasonNumber: z.number().int().nullable(),
  episodeNumber: z.number().int().nullable(),
  runtimeMs: z.number().int().nullable(),
});
export type EpisodeCard = z.infer<typeof EpisodeCard>;

export const AudioTrackInfo = z.object({ streamIndex: z.number().int(), lang: z.string().nullable() });
export type AudioTrackInfo = z.infer<typeof AudioTrackInfo>;

export const MediaItemDetail = MediaCard.extend({
  overview: z.string().nullable(),
  children: z.array(MediaCard),
  /** Flattened grandchildren (episodes across all seasons) — empty unless kind === SERIES. */
  episodes: z.array(EpisodeCard),
  /** Primary file's audio streams — empty for SERIES/SEASON (no file of their own). */
  audioTracks: z.array(AudioTrackInfo),
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
