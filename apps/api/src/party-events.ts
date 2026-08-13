import type { PrismaClient } from "@hokago/db";
import type { WebSocket } from "ws";
import type { WatchPartyResponse } from "@hokago/contract/watch-party";

/**
 * Watch-party realtime layer. One socket set per party; every message is a
 * full party snapshot (small groups, so no delta encoding). Members connect
 * over /ws/party/:id with their access JWT as a query param (browsers can't
 * set WS handshake headers).
 */

interface PartySocket {
  socket: WebSocket;
  profileId: string;
}

const socketsByParty = new Map<string, Set<PartySocket>>();

export function joinPartySocket(partyId: string, profileId: string, socket: WebSocket): void {
  let set = socketsByParty.get(partyId);
  if (!set) {
    set = new Set();
    socketsByParty.set(partyId, set);
  }
  set.add({ socket, profileId });
  socket.on("close", () => {
    set.delete({ socket, profileId });
    if (set.size === 0) socketsByParty.delete(partyId);
  });
}

/** True when a profile has a live socket on the party — the reaper uses this
 *  to tell "tab closed" from "tab throttled". */
export function partyHasLiveSocket(partyId: string, profileId: string): boolean {
  const set = socketsByParty.get(partyId);
  if (!set) return false;
  for (const entry of set) if (entry.profileId === profileId && entry.socket.readyState === 1) return true;
  return false;
}

/** Shapes a party row + relations into the contract response. */
export async function serializeParty(db: PrismaClient, partyId: string): Promise<WatchPartyResponse | null> {
  const party = await db.watchParty.findUnique({
    where: { id: partyId },
    include: {
      mediaItem: {
        select: { id: true, title: true, files: { orderBy: { createdAt: "asc" as const }, take: 1, select: { id: true } } },
      },
      members: {
        include: { profile: { select: { name: true, avatarPath: true } } },
        orderBy: { joinedAt: "asc" as const },
      },
    },
  });
  if (!party) return null;
  return {
    id: party.id,
    mediaItemId: party.mediaItemId,
    mediaTitle: party.mediaItem.title,
    mediaFileId: party.mediaItem.files[0]?.id ?? null,
    inviteCode: party.inviteCode,
    hostProfileId: party.hostProfileId,
    state: party.state,
    positionMs: party.positionMs,
    issuedAt: party.issuedAt.toISOString(),
    createdAt: party.createdAt.toISOString(),
    endedAt: party.endedAt?.toISOString() ?? null,
    members: party.members.map((m) => ({
      profileId: m.profileId,
      name: m.profile.name,
      avatarUrl: m.profile.avatarPath,
      sessionId: m.sessionId,
      ready: m.ready,
      positionMs: m.positionMs,
      reportedAt: m.reportedAt.toISOString(),
    })),
  };
}

/** Pushes the latest party snapshot to every live socket on the party. */
export async function broadcastParty(db: PrismaClient, partyId: string): Promise<void> {
  const set = socketsByParty.get(partyId);
  if (!set || set.size === 0) return;
  const payload = await serializeParty(db, partyId);
  if (!payload) return;
  const message = JSON.stringify({ type: "party", party: payload });
  for (const entry of set) {
    if (entry.socket.readyState === 1) entry.socket.send(message);
  }
}