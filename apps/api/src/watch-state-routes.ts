import { PrismaClient } from "@hokago/db";
import { broadcastPresence } from "./presence.js";
import { stopSession } from "./playback-routes.js";
import {
  HeartbeatBody,
  HeartbeatResponse,
  StopResponse,
  ContinueWatchingQuery,
  ContinueWatchingResponse,
  WatchHistoryQuery,
  WatchHistoryResponse,
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

// Watch time credited per heartbeat is position delta — a forward seek between
// heartbeats would otherwise count as watch time. 10s heartbeats mean any
// delta over ~10s is a seek; 2 minutes is a generous ceiling that still
// absorbs pause/seek slop without crediting a whole jump.
const MAX_HEARTBEAT_CREDIT_MS = 120_000;

/** Server-local calendar day for `date` — the WatchDay aggregation key. */
function dayStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

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
      const now = new Date();
      const watched = durationMs ? positionMs / durationMs >= WATCHED_THRESHOLD : false;

      // Watch-time credit: delta since the last persisted position, capped so
      // a forward seek between heartbeats doesn't count as watched time.
      const deltaMs = Math.max(0, Math.min(positionMs - session.positionMs, MAX_HEARTBEAT_CREDIT_MS));

      const prevState = await db.playbackState.findUnique({
        where: { profileId_mediaItemId: { profileId: session.profileId, mediaItemId: session.mediaItemId } },
      });
      const completed = watched && !(prevState?.watched ?? false);
      const day = dayStart(now);

      await db.$transaction([
        db.playbackSession.update({
          where: { id: session.id },
          data: { positionMs, lastHeartbeatAt: now },
        }),
        db.playbackState.upsert({
          where: { profileId_mediaItemId: { profileId: session.profileId, mediaItemId: session.mediaItemId } },
          create: {
            profileId: session.profileId,
            mediaItemId: session.mediaItemId,
            positionMs,
            durationMs,
            watched,
            playCount: completed ? 1 : 0,
            lastWatchedAt: completed ? now : null,
          },
          update: {
            positionMs,
            durationMs,
            watched,
            ...(completed
              ? { playCount: { increment: 1 }, lastWatchedAt: now }
              : {}),
          },
        }),
        db.watchDay.upsert({
          where: {
            profileId_mediaItemId_date: { profileId: session.profileId, mediaItemId: session.mediaItemId, date: day },
          },
          create: {
            profileId: session.profileId,
            mediaItemId: session.mediaItemId,
            date: day,
            watchedMs: deltaMs,
            firstStartedAt: now,
            lastEndedAt: now,
            completions: completed ? 1 : 0,
          },
          update: {
            watchedMs: { increment: deltaMs },
            lastEndedAt: now,
            ...(completed ? { completions: { increment: 1 } } : {}),
          },
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

      // Kills the session's ffmpeg child (if any) and frees its transcode
      // slot — without this every stopped playback leaves ffmpeg running.
      await stopSession(session.id);
      await broadcastPresence();
      return { ok: true };
    },
  );

  app.get(
    "/watch-history",
    {
      preHandler: app.authenticate,
      schema: { querystring: WatchHistoryQuery, response: { 200: WatchHistoryResponse, 404: ErrorResponse } },
    },
    async (req, reply) => {
      const { profileId, mediaItemId } = req.query;

      // Watch state is per-profile; only allow querying a profile this
      // account owns (mirrors the profiles routes' ownership rule).
      const owned = await db.profile.findFirst({
        where: { id: profileId, accountId: req.accountId },
        select: { id: true },
      });
      if (!owned) return reply.code(404).send({ error: "profile not found" });

      const rows = await db.watchDay.findMany({
        where: { profileId, mediaItemId },
        orderBy: { date: "desc" },
        select: {
          date: true,
          watchedMs: true,
          firstStartedAt: true,
          lastEndedAt: true,
          completions: true,
        },
      });
      return rows;
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
