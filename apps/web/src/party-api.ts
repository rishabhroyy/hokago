/** Watch-party API + realtime socket — the client half of apps/api's
 *  watch-party-routes.ts. The server is the timekeeper: every WS message is a
 *  full party snapshot, and clients self-correct against positionMs/issuedAt.
 */

import type { WatchPartyResponse } from "@hokago/contract/watch-party";
import { api, ensureAccessToken } from "./api-client";

export async function createParty(profileId: string, mediaItemId: string): Promise<WatchPartyResponse | null> {
  const { data, error } = await api.POST("/parties", { body: { profileId, mediaItemId } });
  if (error || !data) return null;
  return data as WatchPartyResponse;
}

export async function joinParty(inviteCode: string, profileId: string): Promise<WatchPartyResponse | null> {
  const { data, error } = await api.POST("/parties/join", { body: { inviteCode, profileId } });
  if (error || !data) return null;
  return data as WatchPartyResponse;
}

export async function leaveParty(partyId: string): Promise<void> {
  await api.POST("/parties/{partyId}/leave", { params: { path: { partyId } } }).catch(() => {});
}

export async function setPartyReady(partyId: string, ready: boolean): Promise<void> {
  await api.POST("/parties/{partyId}/ready", { params: { path: { partyId } }, body: { ready } }).catch(() => {});
}

export async function linkPartySession(partyId: string, sessionId: string): Promise<void> {
  await api
    .POST("/parties/{partyId}/session", { params: { path: { partyId } }, body: { sessionId } })
    .catch(() => {});
}

export async function controlParty(
  partyId: string,
  state: "WAITING" | "PLAYING" | "PAUSED",
  positionMs: number,
): Promise<WatchPartyResponse | null> {
  const { data } = await api.POST("/parties/{partyId}/control", {
    params: { path: { partyId } },
    body: { state, positionMs },
  });
  return (data as WatchPartyResponse | undefined) ?? null;
}

/**
 * Opens (and keeps open) the party's realtime socket. The access JWT rides as
 * a query param — browsers can't set WS handshake headers. Reconnects with
 * backoff; the returned closer stops the whole loop.
 */
export function connectPartySocket(
  partyId: string,
  onParty: (party: WatchPartyResponse) => void,
): () => void {
  let closed = false;
  let socket: WebSocket | null = null;
  let retry = 0;
  let retryTimer: number | null = null;

  const open = async () => {
    if (closed) return;
    const token = await ensureAccessToken();
    if (!token || closed) return;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(
      `${scheme}://${location.host}/ws/party/${encodeURIComponent(partyId)}?token=${encodeURIComponent(token)}`,
    );
    socket = ws;

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { type: string; party?: WatchPartyResponse };
        if (message.type === "party" && message.party) onParty(message.party);
      } catch {
        /* malformed frame — ignore */
      }
    };
    ws.onopen = () => {
      retry = 0;
    };
    ws.onclose = () => {
      if (closed) return;
      // Exponential backoff, capped at 10s — a network blip reconnects and
      // the server snapshot re-syncs everything.
      retry = Math.min(retry + 1, 6);
      retryTimer = window.setTimeout(open, 250 * 2 ** retry);
    };
    ws.onerror = () => ws.close();
  };

  void open();

  return () => {
    closed = true;
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    socket?.close();
  };
}