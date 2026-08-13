import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { PrismaClient } from "@hokago/db";
import type { AccessTokenPayload } from "./auth.js";
import { broadcastParty, joinPartySocket, partyHasLiveSocket, serializeParty } from "./party-events.js";
import {
  PartyParams,
  CreatePartyBody,
  JoinPartyBody,
  ControlPartyBody,
  ReadyPartyBody,
  LinkSessionBody,
  PartyOkResponse,
  WatchPartyResponse,
  ErrorResponse,
} from "@hokago/contract/watch-party";
import type { ZodFastifyInstance } from "./fastify-zod.js";

const db = new PrismaClient();

// Unambiguous alphabet — no 0/O/1/I — for codes people read aloud to each other.
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const INVITE_LENGTH = 6;

// A member whose heartbeats stopped this long ago AND has no live socket is
// presumed gone (crash, killed tab) and reaped. Socket liveness is the real
// signal; reportedAt is the fallback while a socket is mid-reconnect.
const STALE_MEMBER_MS = 3 * 60_000;

function generateInviteCode(): string {
  const bytes = randomBytes(INVITE_LENGTH);
  let code = "";
  for (const b of bytes) code += INVITE_ALPHABET[b % INVITE_ALPHABET.length];
  return code;
}

/** Every party mutation requires the caller to own the profile they act as. */
async function ownedProfile(accountId: string, profileId: string) {
  return db.profile.findFirst({ where: { id: profileId, accountId }, select: { id: true } });
}

export async function registerWatchPartyRoutes(app: ZodFastifyInstance): Promise<void> {
  // ── REST ──────────────────────────────────────────────────────────────────

  // Host starts a party for a playable media item. The host is member #1.
  app.post(
    "/parties",
    {
      preHandler: app.authenticate,
      schema: {
        body: CreatePartyBody,
        response: { 201: WatchPartyResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      const { profileId, mediaItemId } = req.body;
      if (!(await ownedProfile(req.accountId!, profileId))) {
        return reply.code(404).send({ error: "profile not found" });
      }
      const item = await db.mediaItem.findUnique({
        where: { id: mediaItemId },
        select: { id: true },
      });
      if (!item) return reply.code(404).send({ error: "media item not found" });

      const now = new Date();
      const party = await db.watchParty.create({
        data: {
          hostProfileId: profileId,
          mediaItemId,
          state: "WAITING",
          positionMs: 0,
          issuedAt: now,
          inviteCode: generateInviteCode(),
          members: {
            create: { profileId, joinedAt: now, reportedAt: now },
          },
        },
      });
      // The party row was just created — the null branch can't happen here.
      return reply.code(201).send((await serializeParty(db, party.id))!);
    },
  );

  app.get(
    "/parties/:partyId",
    {
      preHandler: app.authenticate,
      schema: { params: PartyParams, response: { 200: WatchPartyResponse, 404: ErrorResponse } },
    },
    async (req, reply) => {
      const member = await memberOf(req.accountId!, req.params.partyId);
      if (!member) return reply.code(404).send({ error: "party not found" });
      // The membership just confirmed the row exists — the null branch of
      // serializeParty is a vanish-race the reaper could still win, so the
      // fallback is a plain 404.
      return (await serializeParty(db, req.params.partyId)) ?? reply.code(404).send({ error: "party not found" });
    },
  );

  // Join by invite code — the code is the address, so no party id is needed.
  app.post(
    "/parties/join",
    {
      preHandler: app.authenticate,
      schema: {
        body: JoinPartyBody,
        response: { 200: WatchPartyResponse, 404: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (req, reply) => {
      const { inviteCode, profileId } = req.body;
      if (!(await ownedProfile(req.accountId!, profileId))) {
        return reply.code(404).send({ error: "profile not found" });
      }
      const party = await db.watchParty.findUnique({ where: { inviteCode: inviteCode.trim().toUpperCase() } });
      if (!party) return reply.code(404).send({ error: "invite code not found" });
      if (party.state === "ENDED") return reply.code(409).send({ error: "party ended" });

      const already = await db.partyMember.findUnique({
        where: { partyId_profileId: { partyId: party.id, profileId } },
      });
      if (!already) {
        await db.partyMember.create({
          data: { partyId: party.id, profileId, joinedAt: new Date(), reportedAt: new Date() },
        });
      }
      await broadcastParty(db, party.id);
      return (await serializeParty(db, party.id)) ?? reply.code(404).send({ error: "party not found" });
    },
  );

  // Leaving: guests drop quietly; the host leaving ends the party for everyone.
  app.post(
    "/parties/:partyId/leave",
    {
      preHandler: app.authenticate,
      schema: { params: PartyParams, response: { 200: PartyOkResponse, 404: ErrorResponse } },
    },
    async (req, reply) => {
      const member = await memberOf(req.accountId!, req.params.partyId);
      if (!member) return reply.code(404).send({ error: "party not found" });
      const partyId = req.params.partyId;

      if (member.party.hostProfileId === member.profileId) {
        await endParty(partyId);
      } else {
        await db.partyMember.delete({ where: { partyId_profileId: { partyId, profileId: member.profileId } } });
      }
      await broadcastParty(db, partyId);
      return { ok: true };
    },
  );

  // Host command — the timekeeper. WAITING lets the host scrub the room's
  // start position before anyone starts; PLAYING/PAUSED drive everyone.
  app.post(
    "/parties/:partyId/control",
    {
      preHandler: app.authenticate,
      schema: {
        params: PartyParams,
        body: ControlPartyBody,
        response: { 200: WatchPartyResponse, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      const member = await memberOf(req.accountId!, req.params.partyId);
      if (!member) return reply.code(404).send({ error: "party not found" });
      if (member.party.hostProfileId !== member.profileId) {
        return reply.code(403).send({ error: "host only" });
      }
      if (member.party.state === "ENDED") return reply.code(404).send({ error: "party ended" });

      const { state, positionMs } = req.body;
      await db.watchParty.update({
        where: { id: req.params.partyId },
        data: { state, positionMs: Math.max(0, Math.round(positionMs)), issuedAt: new Date() },
      });
      await broadcastParty(db, req.params.partyId);
      return (await serializeParty(db, req.params.partyId)) ?? reply.code(404).send({ error: "party not found" });
    },
  );

  // Waiting-room signalling so the host knows when the room is full.
  app.post(
    "/parties/:partyId/ready",
    {
      preHandler: app.authenticate,
      schema: {
        params: PartyParams,
        body: ReadyPartyBody,
        response: { 200: WatchPartyResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      const member = await memberOf(req.accountId!, req.params.partyId);
      if (!member) return reply.code(404).send({ error: "party not found" });
      if (member.party.state === "ENDED") return reply.code(404).send({ error: "party ended" });

      await db.partyMember.update({
        where: { partyId_profileId: { partyId: req.params.partyId, profileId: member.profileId } },
        data: { ready: req.body.ready },
      });
      await broadcastParty(db, req.params.partyId);
      return (await serializeParty(db, req.params.partyId)) ?? reply.code(404).send({ error: "party not found" });
    },
  );

  // Links the member's just-started playback session — afterwards their
  // heartbeats flow position into the party and the member list shows live.
  app.post(
    "/parties/:partyId/session",
    {
      preHandler: app.authenticate,
      schema: {
        params: PartyParams,
        body: LinkSessionBody,
        response: { 200: WatchPartyResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      const member = await memberOf(req.accountId!, req.params.partyId);
      if (!member) return reply.code(404).send({ error: "party not found" });
      if (member.party.state === "ENDED") return reply.code(404).send({ error: "party ended" });

      const session = await db.playbackSession.findUnique({ where: { id: req.body.sessionId } });
      // The session must belong to the same profile as the membership — a
      // party can't be hijacked by linking someone else's session.
      if (!session || session.profileId !== member.profileId) {
        return reply.code(404).send({ error: "playback session not found" });
      }
      await db.partyMember.update({
        where: { partyId_profileId: { partyId: req.params.partyId, profileId: member.profileId } },
        data: { sessionId: session.id, positionMs: session.positionMs, reportedAt: new Date() },
      });
      await broadcastParty(db, req.params.partyId);
      return (await serializeParty(db, req.params.partyId)) ?? reply.code(404).send({ error: "party not found" });
    },
  );

  // ── Realtime ──────────────────────────────────────────────────────────────
  // Members keep a live socket for state commands + member-list updates. The
  // JWT rides as a query param (no WS handshake headers in browsers).
  // Connecting (re)asserts membership: the partyId in the watch URL acts as a
  // share link (a UUID — far stronger than the invite code), so a reload, a
  // dev StrictMode double-mount, or a reaper race all self-heal to "in the
  // room" — which is also what makes reconnect-after-network-blip seamless.
  // The websocket shorthand only merges with the plain FastifyInstance shape
  // (see presence.ts) — cast; the route needs no zod body/response schemas.
  const wsApp = app as unknown as FastifyInstance;
  wsApp.get<{ Params: PartyParams; Querystring: { token?: string } }>(
    "/ws/party/:partyId",
    {
      websocket: true,
      preValidation: async (req, reply) => {
        const token = req.query.token;
        if (!token) return reply.code(401).send({ error: "unauthorized" });
        try {
          app.jwt.verify<AccessTokenPayload>(token);
        } catch {
          return reply.code(401).send({ error: "unauthorized" });
        }
      },
    },
    async (socket: WebSocket, req) => {
      const partyId = req.params.partyId;
      const payload = app.jwt.verify<AccessTokenPayload>(req.query.token!);
      const party = await db.watchParty.findUnique({ where: { id: partyId } });
      if (!party || party.state === "ENDED") {
        socket.close(1008, "party unavailable");
        return;
      }
      const member = await db.partyMember.findFirst({
        where: { partyId, profile: { accountId: payload.accountId } },
        select: { profileId: true },
      });
      let profileId = member?.profileId ?? null;
      if (!profileId) {
        // First contact with this party: join as the account's first profile
        // (the profile picker is unbuilt — the app runs on the primary one).
        const owned = await db.profile.findFirst({
          where: { accountId: payload.accountId },
          select: { id: true },
          orderBy: { createdAt: "asc" },
        });
        if (!owned) {
          socket.close(1008, "no profile");
          return;
        }
        profileId = owned.id;
        await db.partyMember.create({
          data: { partyId, profileId, joinedAt: new Date(), reportedAt: new Date() },
        });
      }
      joinPartySocket(partyId, profileId, socket);
      // Snapshot on connect — joining mid-playback syncs from here.
      void broadcastParty(db, partyId);
      socket.on("close", () => {
        // Clean leaves go through POST /leave; the reaper handles crashed
        // tabs. Republish so the member list reads fresh without the socket.
        void broadcastParty(db, partyId);
      });
    },
  );
}

/** The account's membership row for a party, or null (which the caller maps
 *  to 404 — membership is the only way to know a party exists). */
async function memberOf(accountId: string, partyId: string) {
  return db.partyMember.findFirst({
    where: {
      partyId,
      profile: { accountId },
    },
    include: { party: { select: { hostProfileId: true, state: true } } },
  });
}

async function endParty(partyId: string): Promise<void> {
  await db.$transaction([
    db.watchParty.update({
      where: { id: partyId },
      data: { state: "ENDED", endedAt: new Date() },
    }),
    db.partyMember.deleteMany({ where: { partyId } }),
  ]);
}

/**
 * Idle sweep, run from the same 60s loop as the playback-session reaper:
 * - members with no live socket whose heartbeats stopped >3min ago are
 *   removed (tab crashed / network gone without a leave);
 * - the host being reaped ends the party — no host, no party;
 * - ENDED parties older than a day are deleted outright.
 */
export async function reapStalePartyMembers(): Promise<number> {
  let reaped = 0;
  const active = await db.watchParty.findMany({
    where: { state: { not: "ENDED" } },
    include: { members: { select: { profileId: true, reportedAt: true } } },
  });
  const cutoff = new Date(Date.now() - STALE_MEMBER_MS);

  for (const party of active) {
    let changed = false;
    for (const m of party.members) {
      if (m.reportedAt >= cutoff) continue;
      if (partyHasLiveSocket(party.id, m.profileId)) continue;
      if (m.profileId === party.hostProfileId) {
        await endParty(party.id);
        reaped++;
        changed = true;
        break;
      }
      await db.partyMember.delete({
        where: { partyId_profileId: { partyId: party.id, profileId: m.profileId } },
      });
      reaped++;
      changed = true;
    }
    if (changed) await broadcastParty(db, party.id);
  }

  const oldEnded = await db.watchParty.deleteMany({
    where: { state: "ENDED", endedAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
  });
  return reaped + oldEnded.count;
}