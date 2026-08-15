import { PrismaClient } from "@hokago/db";
import {
  LibrarySummary,
  MediaCard,
  MediaItemDetail,
  LibraryItemsParams,
  MediaItemDetailParams,
  MediaItemDetailQuery,
  MediaItemFilesParams,
  MediaItemFilesResponse,
  NotFoundError,
} from "@hokago/contract/browse";
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
  genres: true,
  createdAt: true,
  artwork: { select: { id: true, kind: true, priority: true } },
  files: { select: { id: true }, take: 1 },
  _count: { select: { children: true } },
} as const;

const episodeSelect = {
  ...cardSelect,
  seasonNumber: true,
  episodeNumber: true,
  runtimeMs: true,
  extra: true,
} as const;

function toCard<
  T extends {
    kind: string;
    title: string;
    artwork: ArtworkRef[];
    files: { id: string }[];
    _count: { children: number };
    extra?: unknown;
  },
>(
  item: T,
): Omit<T, "artwork" | "files" | "_count"> & {
  posterUrl: string | null;
  backdropUrl: string | null;
  mediaFileId: string | null;
  isDownloaded: boolean;
} {
  const { artwork, files, _count, ...rest } = item;
  return {
    ...rest,
    title:
      item.kind === "EPISODE"
        ? ((item.extra as { episodeTitle?: string } | null | undefined)?.episodeTitle ?? item.title)
        : item.title,
    posterUrl: primaryArtworkUrl(artwork, "POSTER"),
    backdropUrl: primaryArtworkUrl(artwork, "BACKDROP"),
    mediaFileId: files[0]?.id ?? null,
    isDownloaded: item.kind === "SERIES" ? _count.children > 0 : files.length > 0,
  };
}

/** / — library browsing and item detail. No route existed before this. */
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
      schema: {
        params: MediaItemDetailParams,
        querystring: MediaItemDetailQuery,
        response: { 200: MediaItemDetail, 404: NotFoundError },
      },
    },
    async (req, reply) => {
    const item = await db.mediaItem.findUnique({
      where: { id: req.params.id },
      include: {
        artwork: { select: { id: true, kind: true, priority: true } },
        files: { select: { id: true }, take: 1 },
        externalIds: { select: { provider: true, providerId: true } },
        _count: { select: { children: true } },
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

    const { children, collectionEntries, externalIds, ...rest } = item;

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

    // Watch data is per-profile — only load it when the caller passes a
    // profile they own. Everything defaults to "not watched / position 0".
    let watch = null;
    const stateByItemId = new Map<string, { watched: boolean; positionMs: number }>();
    if (req.query.profileId) {
      const owned = await db.profile.findFirst({
        where: { id: req.query.profileId, accountId: req.accountId },
        select: { id: true },
      });
      if (owned) {
        const allStates = await db.playbackState.findMany({
          where: { profileId: owned.id, mediaItemId: { in: [item.id, ...episodes.map((e) => e.id)] } },
          select: { mediaItemId: true, watched: true, positionMs: true, durationMs: true, playCount: true, lastWatchedAt: true },
        });
        const self = allStates.find((s) => s.mediaItemId === item.id);
        watch = self
          ? {
              watched: self.watched,
              positionMs: self.positionMs,
              durationMs: self.durationMs,
              playCount: self.playCount,
              lastWatchedAt: self.lastWatchedAt,
            }
          : { watched: false, positionMs: 0, durationMs: null, playCount: 0, lastWatchedAt: null };
        for (const s of allStates) {
          if (s.mediaItemId !== item.id) stateByItemId.set(s.mediaItemId, { watched: s.watched, positionMs: s.positionMs });
        }
      }
    }

    return {
      ...toCard(rest),
      children: children.map(toCard),
      episodes: episodes.map((ep) => {
        const card = toCard(ep);
        const state = stateByItemId.get(ep.id);
        return {
          ...card,
          watched: state?.watched ?? false,
          positionMs: state?.positionMs ?? 0,
        };
      }),
      audioTracks,
      watch,
      externalIds: externalIds.map((e) => ({ provider: e.provider, providerId: e.providerId })),
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

  // Every playable file of an item, not just the primary one browse exposes.
  // The download/version picker needs this: multi-file episodes, alternate
  // files, and the full track listing per file.
  app.get(
    "/media-items/:id/files",
    {
      preHandler: app.authenticate,
      schema: { params: MediaItemFilesParams, response: { 200: MediaItemFilesResponse, 404: NotFoundError } },
    },
    async (req, reply) => {
      const item = await db.mediaItem.findUnique({ where: { id: req.params.id }, select: { id: true } });
      if (!item) return reply.code(404).send({ error: "media item not found" });

      const files = await db.mediaFile.findMany({
        where: { mediaItemId: item.id },
        include: { streams: true, subtitleTracks: true },
        orderBy: { createdAt: "asc" },
      });

      return files.map((f, i) => {
        const video = f.streams.find((s) => s.type === "VIDEO");
        return {
          mediaFileId: f.id,
          isPrimary: i === 0,
          container: f.container,
          durationMs: f.durationMs,
          sizeBytes: Number(f.sizeBytes),
          bitrate: f.bitrate,
          video: video
            ? {
                codec: video.codec,
                width: video.width,
                height: video.height,
                frameRate: video.frameRate,
                isHdr: video.hdrMeta != null,
              }
            : null,
          audioTracks: f.streams
            .filter((s) => s.type === "AUDIO")
            .map((s) => ({
              streamIndex: s.streamIndex,
              codec: s.codec,
              lang: s.lang,
              title: s.title,
              isDefault: s.isDefault,
            })),
          subtitleTracks: f.subtitleTracks.map((t) => ({
            id: t.id,
            lang: t.lang,
            title: t.title,
            format: t.format,
            forced: t.forced,
            sdh: t.sdh,
            requiresBurnIn: t.requiresBurnIn,
          })),
        };
      });
    },
  );
}
