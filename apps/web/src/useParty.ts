/** Party state + control for the watch page — the client half of the
 *  timekeeper contract. The hook owns the socket, echoes, and the controls;
 *  playback application stays with the caller (WatchPage) via callbacks.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WatchPartyResponse } from "@hokago/contract/watch-party";
import {
  connectPartySocket,
  controlParty,
  leaveParty,
  linkPartySession,
  setPartyReady,
} from "./party-api";

export interface PartyCommand {
  state: "WAITING" | "PLAYING" | "PAUSED";
  positionMs: number;
  issuedAt: string;
}

export interface PartyController {
  party: WatchPartyResponse | null;
  connected: boolean;
  isHost: boolean;
  /** True while the server drives this client's playback (guest in a live
   *  party) — seeks are locked, play/pause revert to the party state. */
  locked: boolean;
  /** Commands issued by the server, excluding echoes of this client's own
   *  control POSTs. Consumed (and cleared) by the caller. */
  command: PartyCommand | null;
  control: (state: "WAITING" | "PLAYING" | "PAUSED", positionMs: number) => void;
  setReady: (ready: boolean) => void;
  leave: () => void;
  linkSession: (sessionId: string) => void;
}

/**
 * Live watch-party membership for one profile.
 * - Connects the party socket and forwards server-issued commands (state
 *   changes / position anchors) to `command`, while suppressing the echo of
 *   this client's own control POSTs.
 * - `control` is the host's timekeeper call: the server stamps issuedAt and
 *   re-broadcasts to everyone (including us, suppressed as an echo).
 */
export function useParty(partyId: string | null, profileId: string | null): PartyController {
  const [party, setParty] = useState<WatchPartyResponse | null>(null);
  const [connected, setConnected] = useState(false);
  // Latest server-issued command, consumed (and cleared) by the caller.
  // Echoes of our own control POSTs never land here.
  const [command, setCommand] = useState<PartyCommand | null>(null);
  // Echo gate: issuedAt of the last control POST that succeeded server-side.
  const lastSentIssuedAtRef = useRef<string | null>(null);
  const isHostRef = useRef(false);

  const isHost = party?.hostProfileId === profileId;
  const locked = party != null && !isHost && party.state !== "ENDED";

  useEffect(() => {
    isHostRef.current = isHost;
  }, [isHost]);

  useEffect(() => {
    if (!partyId || !profileId) return;
    const close = connectPartySocket(partyId, (incoming) => {
      const echo = isHostRef.current && incoming.issuedAt === lastSentIssuedAtRef.current;
      setParty(incoming);
      setConnected(true);
      if (!echo && incoming.state !== "ENDED") {
        setCommand({ state: incoming.state, positionMs: incoming.positionMs, issuedAt: incoming.issuedAt });
      }
    });
    return close;
  }, [partyId, profileId]);

  const control = useCallback(
    (state: "WAITING" | "PLAYING" | "PAUSED", positionMs: number) => {
      if (!partyId) return;
      void controlParty(partyId, state, positionMs).then((updated) => {
        if (updated) lastSentIssuedAtRef.current = updated.issuedAt;
      });
    },
    [partyId],
  );

  const setReady = useCallback(
    (ready: boolean) => {
      if (partyId) void setPartyReady(partyId, ready);
    },
    [partyId],
  );

  const leave = useCallback(() => {
    if (partyId) void leaveParty(partyId);
  }, [partyId]);

  const linkSession = useCallback(
    (sessionId: string) => {
      if (partyId) void linkPartySession(partyId, sessionId);
    },
    [partyId],
  );

  // Clear state when the party id goes away (left the room / unmounted).
  useEffect(() => {
    if (!partyId) {
      setParty(null);
      setCommand(null);
      setConnected(false);
    }
  }, [partyId]);

  return useMemo(
    () => ({ party, connected, isHost, locked, command, control, setReady, leave, linkSession }),
    [party, connected, isHost, locked, command, control, setReady, leave, linkSession],
  );
}