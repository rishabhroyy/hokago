import type { FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import type { WebSocket } from "ws";
import { PrismaClient } from "@hokago/db";
import type { AccessTokenPayload } from "./auth.js";

const db = new PrismaClient();
const sockets = new Set<WebSocket>();

/**
 * Real-time "who's watching now" (§11.4) — an admin view, not a per-account
 * feed, so every connection must present an admin JWT before the upgrade
 * completes. Browsers can't set an Authorization header on a WS handshake,
 * so the token travels as a query param instead.
 */
export async function registerPresence(app: FastifyInstance): Promise<void> {
  await app.register(websocketPlugin);

  app.get<{ Querystring: { token?: string } }>(
    "/ws/presence",
    {
      websocket: true,
      preValidation: async (req, reply) => {
        const token = req.query.token;
        if (!token) return reply.code(401).send({ error: "unauthorized" });
        try {
          const payload = app.jwt.verify<AccessTokenPayload>(token);
          if (!payload.isAdmin) return reply.code(403).send({ error: "admin only" });
        } catch {
          return reply.code(401).send({ error: "unauthorized" });
        }
      },
    },
    (socket) => {
      sockets.add(socket);
      void broadcastPresence(); // snapshot on connect, not just on the next state change
      socket.on("close", () => sockets.delete(socket));
    },
  );
}

// Called after every real PlaybackSession write (start/heartbeat/stop) — never
// on a timer, so this is a push driven by actual state change, not polling.
export async function broadcastPresence(): Promise<void> {
  if (sockets.size === 0) return;

  const active = await db.playbackSession.findMany({
    where: { endedAt: null },
    include: { profile: true, mediaItem: true },
    orderBy: { startedAt: "desc" },
  });

  const payload = JSON.stringify({
    type: "presence",
    sessions: active.map((s) => ({
      sessionId: s.id,
      profileName: s.profile.name,
      mediaTitle: s.mediaItem.title,
      method: s.method,
      positionMs: s.positionMs,
      startedAt: s.startedAt,
    })),
  });

  for (const socket of sockets) socket.send(payload);
}
