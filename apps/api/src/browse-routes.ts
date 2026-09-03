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

const fileWithVideoCodecSelect = {
  select: {
    id: true,
    bitrate: true,
    streams: { where: { type: "VIDEO" as const }, select: { codec: true }, take: 1 },
  },
  take: 1,
} as const;

const episodeSelect = {
  ...cardSelect,
  files: fileWithVideoCodecSelect,
  seasonNumber: true,
  episodeNumber: true,
  runtimeMs: true,
  extra: true,
} as const;

type BitrateQuality = "poor" | "ok" | "good";

// Calibrated against this library's own files (2026-09-03 audit in
// hokago-dev): AnimePahe/ani-cli h264 1080p rips measured 600-1100 kbps
// ("poor"); real WEB-DL scene h264 releases run 3,000-6,000+ kbps ("good" —
// e.g. the KonoSuba movie measured 8,122 kbps). HEVC is far more efficient
// at equal quality: a proper BD/scene x265 release (K-On [AniDL]) measured
// 1,233 kbps overall and is genuinely "good", not "poor" — a codec-blind
// flat kbps cutoff mislabels it, hence the branch below instead of one scale.
function classifyBitrateQuality(codec: string | null, kbps: number): BitrateQuality {
  const efficient = codec === "hevc" || codec === "av1";
  const okFloor = efficient ? 600 : 1500;
  const goodFloor = efficient ? 1200 : 3000;
  if (kbps < okFloor) return "poor";
  if (kbps < goodFloor) return "ok";
  return "good";
}

function fileBitrateQuality(file: { bitrate: number | null; streams: { codec: string | null }[] } | undefined): BitrateQuality | null {
  if (!file?.bitrate) return null;
  return classifyBitrateQuality(file.streams[0]?.codec ?? null, Math.round(file.bitrate / 1000));
}

// Series have no file of their own — summarize per-episode tiers by mode,
// ties resolved toward the better tier, rather than averaging raw kbps
// across (possibly mixed-codec) episodes, which classifyBitrateQuality's
// codec branch above would make meaningless.
function modeBitrateQuality(qualities: BitrateQuality[]): BitrateQuality | null {
  if (qualities.length === 0) return null;
  const counts = { poor: 0, ok: 0, good: 0 };
  for (const q of qualities) counts[q]++;
  if (counts.good >= counts.ok && counts.good >= counts.poor) return "good";
  return counts.ok >= counts.poor ? "ok" : "poor";
}

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
        files: fileWithVideoCodecSelect,
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
            where: { parent: { parentId: item.id }, kind: "EPISODE" },
            select: episodeSelect,
            orderBy: [{ seasonNumber: "asc" }, { episodeNumber: "asc" }],
          })
        : [];
    // Show-scoped movies: direct MOVIE children of the series (scanner's
    // anchor rule) plus legacy season-grandchild movies.
    const movies =
      item.kind === "SERIES"
        ? await db.mediaItem.findMany({
            where: { kind: "MOVIE", OR: [{ parentId: item.id }, { parent: { parentId: item.id } }] },
            select: episodeSelect,
            orderBy: { sortTitle: "asc" },
          })
        : [];
    const audioTracks = item.files[0]
      ? await db.mediaStream.findMany({
          where: { mediaFileId: item.files[0].id, type: "AUDIO" },
          select: { streamIndex: true, lang: true },
          orderBy: { streamIndex: "asc" },
        })
      : [];
    // SERIES has no file of its own: bitrateKbps is the mean of its
    // episodes' file bitrates (display number only — mixed codecs make a
    // raw average meaningless for a quality verdict, so bitrateQuality is
    // derived separately, per-episode, below).
    const episodeBitrates = episodes.map((ep) => ep.files[0]?.bitrate).filter((b): b is number => b != null);
    const bitrateKbps =
      item.kind === "SERIES"
        ? episodeBitrates.length > 0
          ? Math.round(episodeBitrates.reduce((sum, b) => sum + b, 0) / episodeBitrates.length / 1000)
          : null
        : item.files[0]?.bitrate != null
          ? Math.round(item.files[0].bitrate / 1000)
          : null;
    const bitrateQuality =
      item.kind === "SERIES"
        ? modeBitrateQuality(episodes.map((ep) => fileBitrateQuality(ep.files[0])).filter((q): q is BitrateQuality => q != null))
        : fileBitrateQuality(item.files[0]);

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
          where: {
            profileId: owned.id,
            mediaItemId: { in: [item.id, ...episodes.map((e) => e.id), ...movies.map((m) => m.id)] },
          },
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
      movies: movies.map((mv) => {
        const card = toCard(mv);
        const state = stateByItemId.get(mv.id);
        return {
          ...card,
          watched: state?.watched ?? false,
          positionMs: state?.positionMs ?? 0,
        };
      }),
      audioTracks,
      bitrateKbps,
      bitrateQuality,
      watch,
      externalIds: externalIds.map((e) => ({ provider: e.provider, providerId: e.providerId })),
      // A derived franchise is noise on a series detail page when it only
      // contains the series itself (plus its episodes/movies) — that's just
      // "this series". Drop it there; movie details keep their "Part of" row.
      collections: collectionEntries
        .filter((entry) => {
          if (item.kind !== "SERIES" || !entry.collection.derived || entry.collection.kind !== "FRANCHISE") return true;
          const known = new Set([item.id, ...episodes.map((e) => e.id), ...movies.map((m) => m.id)]);
          return entry.collection.entries.some((e) => !known.has(e.mediaItem.id));
        })
        .map((entry) => ({
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
