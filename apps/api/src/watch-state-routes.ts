import { PrismaClient } from "@hokago/db";
import { broadcastPresence } from "./presence.js";
import {
  HeartbeatBody,
  HeartbeatResponse,
  StopResponse,
  ContinueWatchingQuery,
  ContinueWatchingResponse,
  type ContinueWatchingEntry,
  ErrorResponse,
} from "@hokago/contract/playback";
import { PlaybackSessionParams } from "@hokago/contract/playback";
import type { ZodFastifyInstance } from "./fastify-zod.js";
import { primaryArtworkUrl, type ArtworkRef } from "./artwork.js";

const db = new PrismaClient();

const itemInclude = {
  artwork: { select: { id: true, kind: true, priority: true } },
  files: { select: { id: true }, take: 1 },
} as const;

function toRef<
  T extends {
    id: string;
    kind: string;
    title: string;
    sortTitle: string;
    parentId: string | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
    year: number | null;
    artwork: ArtworkRef[];
    files: { id: string }[];
  },
>(item: T) {
  return {
    id: item.id,
    kind: item.kind as "MOVIE" | "SERIES" | "SEASON" | "EPISODE",
    title: item.title,
    sortTitle: item.sortTitle,
    parentId: item.parentId,
    seasonNumber: item.seasonNumber,
    episodeNumber: item.episodeNumber,
    year: item.year,
    posterUrl: primaryArtworkUrl(item.artwork, "POSTER"),
    backdropUrl: primaryArtworkUrl(item.artwork, "BACKDROP"),
    mediaFileId: item.files[0]?.id ?? null,
  };
}

// Anything past this fraction of the runtime counts as "finished" — matches
// the industry-standard "credits are rolling" heuristic, not literal 100%.
const WATCHED_THRESHOLD = 0.9;

/** / — PlaybackState updates live during playback, continue-watching, next-episode rollover. */
export async function registerWatchStateRoutes(app: ZodFastifyInstance): Promise<void> {
  app.post(
    "/playback/:sessionId/heartbeat",
    {
      schema: {
        params: PlaybackSessionParams,
        body: HeartbeatBody,
        response: { 200: HeartbeatResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      const session = await db.playbackSession.findUnique({ where: { id: req.params.sessionId } });
      if (!session) return reply.code(404).send({ error: "session not found" });

      const { positionMs, durationMs } = req.body;
      const watched = durationMs ? positionMs / durationMs >= WATCHED_THRESHOLD : false;

      await db.$transaction([
        db.playbackSession.update({
          where: { id: session.id },
          data: { positionMs, lastHeartbeatAt: new Date() },
        }),
        db.playbackState.upsert({
          where: { profileId_mediaItemId: { profileId: session.profileId, mediaItemId: session.mediaItemId } },
          create: {
            profileId: session.profileId,
            mediaItemId: session.mediaItemId,
            positionMs,
            durationMs,
            watched,
          },
          update: { positionMs, durationMs, watched },
        }),
      ]);

      await broadcastPresence();
      return { ok: true, watched };
    },
  );

  app.post(
    "/playback/:sessionId/stop",
    { schema: { params: PlaybackSessionParams, response: { 200: StopResponse, 404: ErrorResponse } } },
    async (req, reply) => {
      const session = await db.playbackSession.findUnique({ where: { id: req.params.sessionId } });
      if (!session) return reply.code(404).send({ error: "session not found" });

      await db.playbackSession.update({ where: { id: session.id }, data: { endedAt: new Date() } });
      await broadcastPresence();
      return { ok: true };
    },
  );

  app.get(
    "/continue-watching",
    { schema: { querystring: ContinueWatchingQuery, response: { 200: ContinueWatchingResponse } } },
    async (req) => {
    const { profileId } = req.query;

    const states = await db.playbackState.findMany({
      where: { profileId },
      include: { mediaItem: { include: itemInclude } },
      orderBy: { updatedAt: "desc" },
    });

    const bySeries = new Map<string, { updatedAt: Date; entry: ContinueWatchingEntry }>();

    for (const state of states) {
      const item = state.mediaItem;

      if (!state.watched) {
        // In progress, not finished — surfaced as-is. Series key groups by
        // parent so a stale earlier-updated episode of the same show doesn't
        // also show up further down the list once a newer one is in progress.
        const seriesKey = item.kind === "EPISODE" ? (item.parentId ?? item.id) : item.id;
        if (!bySeries.has(seriesKey) || bySeries.get(seriesKey)!.updatedAt < state.updatedAt) {
          bySeries.set(seriesKey, {
            updatedAt: state.updatedAt,
            entry: { mediaItem: toRef(item), positionMs: state.positionMs, durationMs: state.durationMs, upNext: false },
          });
        }
        continue;
      }

      // Fully watched: a movie just drops off. An episode rolls onto the next
      // unwatched episode in the series, so continue-watching still has
      // something for that show instead of silently going empty.
      if (item.kind !== "EPISODE") continue;

      const next = await findNextEpisode(item);
      if (!next) continue; // series finished — nothing to roll onto

      const seriesKey = item.parentId ?? item.id;
      if (!bySeries.has(seriesKey) || bySeries.get(seriesKey)!.updatedAt < state.updatedAt) {
        bySeries.set(seriesKey, {
          updatedAt: state.updatedAt,
          entry: { mediaItem: toRef(next), positionMs: 0, durationMs: null, upNext: true },
        });
      }
    }

    return [...bySeries.values()].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).map((v) => v.entry);
    },
  );
}

async function findNextEpisode(episode: {
  id: string;
  parentId: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
}) {
  if (!episode.parentId || episode.episodeNumber === null) return null;

  const nextInSeason = await db.mediaItem.findFirst({
    where: { parentId: episode.parentId, kind: "EPISODE", episodeNumber: { gt: episode.episodeNumber } },
    orderBy: { episodeNumber: "asc" },
    include: itemInclude,
  });
  if (nextInSeason) return nextInSeason;

  // No next episode in this season — try episode 1 of the next season, if any.
  const season = await db.mediaItem.findUnique({ where: { id: episode.parentId } });
  if (!season?.parentId || season.seasonNumber === null) return null;

  const nextSeason = await db.mediaItem.findFirst({
    where: { parentId: season.parentId, kind: "SEASON", seasonNumber: { gt: season.seasonNumber } },
    orderBy: { seasonNumber: "asc" },
  });
  if (!nextSeason) return null;

  return db.mediaItem.findFirst({
    include: itemInclude,
    where: { parentId: nextSeason.id, kind: "EPISODE" },
    orderBy: { episodeNumber: "asc" },
  });
}
