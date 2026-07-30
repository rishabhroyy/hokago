import { PrismaClient } from "@hokago/db";
import { LibrarySummary, MediaCard, MediaItemDetail, LibraryItemsParams, MediaItemDetailParams, NotFoundError } from "@hokago/contract/browse";
import { z } from "zod";
import type { ZodFastifyInstance } from "./fastify-zod.js";
import { primaryArtworkUrl, type ArtworkRef } from "./artwork.js";

const db = new PrismaClient();

const cardSelect = {
  id: true,
  kind: true,
  title: true,
  sortTitle: true,
  year: true,
  createdAt: true,
  artwork: { select: { id: true, kind: true, priority: true } },
  files: { select: { id: true }, take: 1 },
} as const;

const episodeSelect = {
  ...cardSelect,
  seasonNumber: true,
  episodeNumber: true,
  runtimeMs: true,
} as const;

function toCard<T extends { artwork: ArtworkRef[]; files: { id: string }[] }>(
  item: T,
): Omit<T, "artwork" | "files"> & { posterUrl: string | null; backdropUrl: string | null; mediaFileId: string | null } {
  const { artwork, files, ...rest } = item;
  return {
    ...rest,
    posterUrl: primaryArtworkUrl(artwork, "POSTER"),
    backdropUrl: primaryArtworkUrl(artwork, "BACKDROP"),
    mediaFileId: files[0]?.id ?? null,
  };
}

/** §7.3/§7.6 — library browsing and item detail. No route existed before this. */
export async function registerBrowseRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get(
    "/libraries",
    { preHandler: app.authenticate, schema: { response: { 200: z.array(LibrarySummary) } } },
    async () => {
      return db.library.findMany({
        where: { enabled: true },
        select: { id: true, name: true, contentProfile: true, mediaKinds: true },
        orderBy: { name: "asc" },
      });
    },
  );

  // Top-level items only (MOVIE/SERIES) — SEASON/EPISODE nest under their
  // parent and are fetched via the item-detail route below.
  app.get(
    "/libraries/:id/items",
    {
      preHandler: app.authenticate,
      schema: { params: LibraryItemsParams, response: { 200: z.array(MediaCard) } },
    },
    async (req) => {
      const items = await db.mediaItem.findMany({
        where: { libraryId: req.params.id, parentId: null, kind: { in: ["MOVIE", "SERIES"] } },
        select: cardSelect,
        orderBy: { sortTitle: "asc" },
      });
      return items.map(toCard);
    },
  );

  app.get(
    "/media-items/:id",
    {
      preHandler: app.authenticate,
      schema: { params: MediaItemDetailParams, response: { 200: MediaItemDetail, 404: NotFoundError } },
    },
    async (req, reply) => {
    const item = await db.mediaItem.findUnique({
      where: { id: req.params.id },
      include: {
        artwork: { select: { id: true, kind: true, priority: true } },
        files: { select: { id: true }, take: 1 },
        children: { select: cardSelect, orderBy: { sortTitle: "asc" } },
        collectionEntries: {
          include: {
            collection: {
              include: {
                artwork: { select: { id: true, kind: true, priority: true } },
                entries: {
                  include: { mediaItem: { select: cardSelect } },
                  orderBy: { releaseOrder: "asc" },
                },
              },
            },
          },
        },
      },
    });
    if (!item) return reply.code(404).send({ error: "media item not found" });

    const { children, collectionEntries, ...rest } = item;

    const episodes =
      item.kind === "SERIES"
        ? await db.mediaItem.findMany({
            where: { parent: { parentId: item.id } },
            select: episodeSelect,
            orderBy: [{ seasonNumber: "asc" }, { episodeNumber: "asc" }],
          })
        : [];
    const audioTracks = item.files[0]
      ? await db.mediaStream.findMany({
          where: { mediaFileId: item.files[0].id, type: "AUDIO" },
          select: { streamIndex: true, lang: true },
          orderBy: { streamIndex: "asc" },
        })
      : [];

    return {
      ...toCard(rest),
      children: children.map(toCard),
      episodes: episodes.map(toCard),
      audioTracks,
      collections: collectionEntries.map((entry) => ({
        id: entry.collection.id,
        name: entry.collection.name,
        kind: entry.collection.kind,
        posterUrl: primaryArtworkUrl(entry.collection.artwork, "POSTER"),
        relationType: entry.relationType,
        entries: entry.collection.entries.map((e) => ({
          relationType: e.relationType,
          anchor: e.anchor,
          item: toCard(e.mediaItem),
        })),
      })),
    };
    },
  );
}
