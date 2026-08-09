import { PrismaClient } from "@hokago/db";
import { broadcastPresence } from "./presence.js";
import { stopSession } from "./playback-routes.js";
import { loadContinueWatching } from "./continue-watching.js";
import {
  HeartbeatBody,
  HeartbeatResponse,
  StopResponse,
  ContinueWatchingQuery,
  ContinueWatchingResponse,
  WatchHistoryQuery,
  WatchHistoryResponse,
  SetWatchedParams,
  SetWatchedBody,
  SetWatchedResponse,
  ErrorResponse,
} from "@hokago/contract/playback";
import { PlaybackSessionParams } from "@hokago/contract/playback";
import type { ZodFastifyInstance } from "./fastify-zod.js";

const db = new PrismaClient();

// Anything past this fraction of the runtime counts as "finished" — matches
// the industry-standard "credits are rolling" heuristic, not literal 100%.
// 0.95 = watching through the credits; a few extra seconds past 90% is the
// difference between "the episode actually ended" and "stopped with scenes
// left", and the watched mark drives rollover + grayed-out episodes.
const WATCHED_THRESHOLD = 0.95;

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

  // Manual watched-marking from the right-click menu — idempotent upsert on
  // the same PlaybackState row heartbeats write. Marking watched bumps the
  // play count (once); unwatching clears position + count so the item reads
  // as never started. No watchDay credit either way — that's real watch time.
  app.post(
    "/watch-state/:mediaItemId",
    {
      schema: {
        params: SetWatchedParams,
        body: SetWatchedBody,
        response: { 200: SetWatchedResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      const { profileId, watched } = req.body;
      const item = await db.mediaItem.findUnique({
        where: { id: req.params.mediaItemId },
        select: { id: true },
      });
      if (!item) return reply.code(404).send({ error: "media item not found" });

      const prev = await db.playbackState.findUnique({
        where: { profileId_mediaItemId: { profileId, mediaItemId: item.id } },
      });

      if (watched) {
        const completed = !(prev?.watched ?? false);
        await db.playbackState.upsert({
          where: { profileId_mediaItemId: { profileId, mediaItemId: item.id } },
          create: {
            profileId,
            mediaItemId: item.id,
            positionMs: 0,
            durationMs: prev?.durationMs ?? null,
            watched: true,
            playCount: 1,
            lastWatchedAt: new Date(),
          },
          update: {
            watched: true,
            ...(completed ? { playCount: { increment: 1 }, lastWatchedAt: new Date() } : {}),
          },
        });
      } else {
        await db.playbackState.upsert({
          where: { profileId_mediaItemId: { profileId, mediaItemId: item.id } },
          create: {
            profileId,
            mediaItemId: item.id,
            positionMs: 0,
            watched: false,
            playCount: 0,
            lastWatchedAt: null,
          },
          update: { watched: false, positionMs: 0, playCount: 0, lastWatchedAt: null },
        });
      }

      return { ok: true, watched };
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
      return loadContinueWatching(db, req.query.profileId);
    },
  );
}
