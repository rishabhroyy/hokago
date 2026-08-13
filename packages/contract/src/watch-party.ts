/** Watch parties — synchronized group playback.
 *
 * The server is the timekeeper. `WatchParty.positionMs` is the media position
 * at wall-clock `issuedAt`; the current position while PLAYING is
 * `positionMs + (now - issuedAt)`, flat while PAUSED. Clients self-correct
 * against that estimate on every command and re-sync (seek to the estimate)
 * when their drift exceeds playback tolerance.
 */

import { z } from "zod";

export const PartyState = z.enum(["WAITING", "PLAYING", "PAUSED", "ENDED"]);
export type PartyState = z.infer<typeof PartyState>;

/** Control states the host may command. WAITING lets the host scrub the
 *  room's start position before everybody starts. */
export const PartyControlState = z.enum(["WAITING", "PLAYING", "PAUSED"]);
export type PartyControlState = z.infer<typeof PartyControlState>;

export const PartyMemberInfo = z.object({
  profileId: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  /** Set once the member's playback session is linked — null before that. */
  sessionId: z.string().nullable(),
  ready: z.boolean(),
  /** Last reported media position (ms), from that member's heartbeats. */
  positionMs: z.number(),
  /** ISO timestamp of the member's last heartbeat. */
  reportedAt: z.string().nullable(),
});
export type PartyMemberInfo = z.infer<typeof PartyMemberInfo>;

export const WatchPartyResponse = z.object({
  id: z.string(),
  mediaItemId: z.string(),
  mediaTitle: z.string(),
  /** The item's first playable file — what joining members are routed to. */
  mediaFileId: z.string().nullable(),
  inviteCode: z.string(),
  hostProfileId: z.string(),
  state: PartyState,
  /** Media position at `issuedAt` — the sync anchor. */
  positionMs: z.number(),
  /** ISO timestamp of the last control command (or party creation). */
  issuedAt: z.string(),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
  members: z.array(PartyMemberInfo),
});
export type WatchPartyResponse = z.infer<typeof WatchPartyResponse>;

export const CreatePartyBody = z.object({
  profileId: z.string(),
  mediaItemId: z.string(),
});
export type CreatePartyBody = z.infer<typeof CreatePartyBody>;

export const JoinPartyBody = z.object({
  inviteCode: z.string().min(1).max(16),
  profileId: z.string(),
});
export type JoinPartyBody = z.infer<typeof JoinPartyBody>;

export const PartyParams = z.object({ partyId: z.string() });
export type PartyParams = z.infer<typeof PartyParams>;

export const ControlPartyBody = z.object({
  state: PartyControlState,
  positionMs: z.number(),
});
export type ControlPartyBody = z.infer<typeof ControlPartyBody>;

export const ReadyPartyBody = z.object({ ready: z.boolean().default(true) });
export type ReadyPartyBody = z.infer<typeof ReadyPartyBody>;

/** Links a just-started playback session to the member so positions flow
 *  from heartbeats into the party. */
export const LinkSessionBody = z.object({ sessionId: z.string() });
export type LinkSessionBody = z.infer<typeof LinkSessionBody>;

export const PartyOkResponse = z.object({ ok: z.boolean() });

export const ErrorResponse = z.object({ error: z.string() });