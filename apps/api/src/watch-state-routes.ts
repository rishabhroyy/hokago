import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@hokago/db";
import { broadcastPresence } from "./presence.js";

const db = new PrismaClient();

// Anything past this fraction of the runtime counts as "finished" — matches
// the industry-standard "credits are rolling" heuristic, not literal 100%.
const WATCHED_THRESHOLD = 0.9;

interface HeartbeatBody {
  positionMs: number;
  durationMs?: number;
}

/** §7.7/§11.4 — PlaybackState updates live during playback, continue-watching, next-episode rollover. */
export async function registerWatchStateRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { sessionId: string }; Body: HeartbeatBody }>(
    "/playback/:sessionId/heartbeat",
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

  app.post<{ Params: { sessionId: string } }>("/playback/:sessionId/stop", async (req, reply) => {
    const session = await db.playbackSession.findUnique({ where: { id: req.params.sessionId } });
    if (!session) return reply.code(404).send({ error: "session not found" });

    await db.playbackSession.update({ where: { id: session.id }, data: { endedAt: new Date() } });
    await broadcastPresence();
    return { ok: true };
  });

  app.get<{ Querystring: { profileId: string } }>("/continue-watching", async (req, reply) => {
    const { profileId } = req.query;
    if (!profileId) return reply.code(400).send({ error: "profileId required" });

    const states = await db.playbackState.findMany({
      where: { profileId },
      include: { mediaItem: true },
      orderBy: { updatedAt: "desc" },
    });

    const bySeries = new Map<string, { updatedAt: Date; entry: unknown }>();

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
            entry: { mediaItem: item, positionMs: state.positionMs, durationMs: state.durationMs, upNext: false },
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
          entry: { mediaItem: next, positionMs: 0, durationMs: null, upNext: true },
        });
      }
    }

    return [...bySeries.values()].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).map((v) => v.entry);
  });
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
    where: { parentId: nextSeason.id, kind: "EPISODE" },
    orderBy: { episodeNumber: "asc" },
  });
}
