import type { FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import type { WebSocket } from "ws";
import { PrismaClient } from "@hokago/db";

const db = new PrismaClient();
const sockets = new Set<WebSocket>();

/** Real-time "who's watching now" (§11.4) — the WS layer watch parties (§17) will ride later. */
export async function registerPresence(app: FastifyInstance): Promise<void> {
  await app.register(websocketPlugin);

  app.get("/ws/presence", { websocket: true }, (socket) => {
    sockets.add(socket);
    void broadcastPresence(); // snapshot on connect, not just on the next state change
    socket.on("close", () => sockets.delete(socket));
  });
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
