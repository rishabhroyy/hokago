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
});
export type MediaCard = z.infer<typeof MediaCard>;

export const LibraryItemsParams = z.object({ id: z.string() });

export const MediaItemDetailParams = z.object({ id: z.string() });

export const CollectionEntry = z.object({
  relationType: RelationType,
  anchor: z.string().nullable(),
  item: MediaCard,
});

export const MediaItemDetail = MediaCard.extend({
  children: z.array(MediaCard),
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
