import { PrismaClient } from "@hokago/db";
import {
  generateOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  verifyPassword,
  REFRESH_TOKEN_TTL_MS,
  invalidateSessionLiveness,
  type AccessTokenPayload,
} from "./auth.js";
import {
  RegisterBody,
  RegisterResponse,
  LoginBody,
  LoginResponse,
  RefreshBody,
  RefreshResponse,
  RevokedResponse,
  ChangePasswordBody,
  ChangePasswordResponse,
  SessionSummary,
  SessionParams,
  DeviceSummary,
  DeviceParams,
  PairingRequestBody,
  PairingRequestResponse,
  PairingVerifyBody,
  PairingVerifyResponse,
  PairingStatusBody,
  PairingStatusResponse,
  CreateInviteBody,
  InviteResponse,
  RegisterDeviceBody,
  RegisterDeviceResponse,
  ErrorResponse,
} from "@hokago/contract/auth";
import { RateLimiter, rateLimited, clientIp } from "./rate-limit.js";
import { z } from "zod";
import type { ZodFastifyInstance } from "./fastify-zod.js";

const db = new PrismaClient();

// Brute-force tripwire on the unauthenticated auth surface. In-memory and
// per-API-process on purpose — it's a tripwire, not a quota, and the deploy
// shape is a single API process. Honors real client IPs behind Cloudflare
// (CF-Connecting-IP) and, when HOKAGO_TRUST_PROXY=true, reverse proxies.
const loginIpLimiter = new RateLimiter(15 * 60 * 1000, Number(process.env.HOKAGO_LOGIN_RATE_LIMIT_IP ?? 30));
const loginUserLimiter = new RateLimiter(15 * 60 * 1000, Number(process.env.HOKAGO_LOGIN_RATE_LIMIT_USERNAME ?? 10));
const pairRequestLimiter = new RateLimiter(60 * 60 * 1000, 10);
const pairStatusLimiter = new RateLimiter(60 * 1000, 20);

// How long a code stays valid on the TV screen before it must be re-requested.
const PAIRING_TTL_MS = 10 * 60 * 1000;

/**
 * Every account has a primary profile (profiles[0] by creation order) — the
 * whole frontend treats it as the account. Registration and bootstrap-admin
 * seed one, but accounts created through arbitrary scripts or old seeds may
 * lack it; lazily provisioning here heals any such account on its first
 * login rather than silently disabling prefs/avatar features.
 */
async function ensurePrimaryProfile(accountId: string, username: string): Promise<void> {
  const profile = await db.profile.findFirst({ where: { accountId }, orderBy: { createdAt: "asc" } });
  if (profile) return;
  await db.profile.create({ data: { accountId, name: username } });
}

/**
 * Native clients present a stable per-install clientKey. Upsert the Device row
 * against the given account — a clientKey that appears under a different
 * account (app reinstalled, handed-off device) is moved, so a re-login heals
 * it rather than erroring. Returns the device id, or null when no clientKey
 * was provided (the web client).
 *
 * Every pairing also writes a DeviceAccount link row — a shared device (a TV
 * household) keeps every account it was ever approved for, so the client can
 * switch between them without re-auth. The Device.accountId owner moves to
 * the newest pairer, but links are never dropped by pairing.
 */
async function upsertDevice(opts: {
  accountId: string;
  clientKey: string;
  name: string;
  platform: "WEB" | "IOS" | "IPADOS" | "ANDROID" | "MACOS" | "WINDOWS" | "LINUX" | "TVOS" | "ANDROIDTV" | "GOOGLETV";
}): Promise<string> {
  const existing = await db.device.findUnique({ where: { clientKey: opts.clientKey } });
  const deviceId = existing
    ? (
        await db.device.update({
          where: { id: existing.id },
          data: { accountId: opts.accountId, name: opts.name, platform: opts.platform, lastSeenAt: new Date() },
        })
      ).id
    : (
        await db.device.create({
          data: {
            accountId: opts.accountId,
            clientKey: opts.clientKey,
            name: opts.name,
            platform: opts.platform,
            lastSeenAt: new Date(),
          },
        })
      ).id;
  await db.deviceAccount
    .upsert({
      where: { deviceId_accountId: { deviceId, accountId: opts.accountId } },
      create: { deviceId, accountId: opts.accountId },
      update: {},
    })
    .catch(() => {});
  return deviceId;
}

/** username/password auth, argon2id, JWT access + opaque refresh token, sessions table makes tokens genuinely revocable. */
export async function registerAuthRoutes(app: ZodFastifyInstance): Promise<void> {
  app.post(
    "/auth/register",
    { schema: { body: RegisterBody, response: { 201: RegisterResponse, 400: ErrorResponse, 409: ErrorResponse } } },
    async (req, reply) => {
    const { inviteCode, username, password } = req.body;

    const invite = await db.invite.findUnique({ where: { code: inviteCode } });
    if (!invite) return reply.code(400).send({ error: "invalid invite code" });
    if (invite.usedAt) return reply.code(400).send({ error: "invite already used" });
    if (invite.expiresAt && invite.expiresAt < new Date()) {
      return reply.code(400).send({ error: "invite expired" });
    }

    const existing = await db.account.findUnique({ where: { username } });
    if (existing) return reply.code(409).send({ error: "username taken" });

    const passwordHash = await hashPassword(password);
    const account = await db.$transaction(async (tx) => {
      const created = await tx.account.create({ data: { username, passwordHash } });
      // Every account gets a first profile named after the username — the
      // frontend treats profiles[0] as the primary profile everywhere.
      await tx.profile.create({ data: { accountId: created.id, name: username } });
      await tx.invite.update({ where: { id: invite.id }, data: { usedAt: new Date() } });
      return created;
    });

    return reply.code(201).send({ accountId: account.id });
    },
  );

  app.post(
    "/auth/login",
    {
      preHandler: [
        rateLimited(loginIpLimiter, (req) => clientIp(req)),
        rateLimited(loginUserLimiter, (req) => `user:${(req.body as { username?: string }).username ?? ""}`),
      ],
      schema: { body: LoginBody, response: { 200: LoginResponse, 401: ErrorResponse, 429: ErrorResponse } },
    },
    async (req, reply) => {
      const { username, password, device, clientKey, deviceName, platform } = req.body;
      const account = await db.account.findUnique({ where: { username } });
      if (!account || account.disabled) return reply.code(401).send({ error: "invalid credentials" });

      const valid = await verifyPassword(account.passwordHash, password);
      if (!valid) return reply.code(401).send({ error: "invalid credentials" });

      await ensurePrimaryProfile(account.id, account.username);

      let deviceId: string | null = null;
      if (clientKey && platform) {
        deviceId = await upsertDevice({
          accountId: account.id,
          clientKey,
          name: deviceName ?? device ?? "unknown device",
          platform,
        });
      }

      const refreshToken = generateOpaqueToken();
      const session = await db.session.create({
        data: {
          accountId: account.id,
          refreshTokenHash: hashOpaqueToken(refreshToken),
          device: device ?? deviceName ?? null,
          deviceId,
          userAgent: req.headers["user-agent"] ?? null,
          expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        },
      });
      await db.account.update({ where: { id: account.id }, data: { lastLoginAt: new Date() } });

      const payload: AccessTokenPayload = { accountId: account.id, isAdmin: account.isAdmin, sessionId: session.id };
      const accessToken = app.jwt.sign(payload);

      return { accessToken, refreshToken, sessionId: session.id, deviceId };
    },
  );

  app.post(
    "/auth/refresh",
    { schema: { body: RefreshBody, response: { 200: RefreshResponse, 401: ErrorResponse } } },
    async (req, reply) => {
      const session = await db.session.findUnique({
        where: { refreshTokenHash: hashOpaqueToken(req.body.refreshToken) },
        include: { account: true },
      });
      if (!session || session.revokedAt || session.expiresAt < new Date()) {
        return reply.code(401).send({ error: "refresh token invalid or revoked" });
      }

      // Sliding expiry: every successful refresh rolls the session forward
      // another REFRESH_TOKEN_TTL_MS, so an actively-used session never
      // silently dies after its first 30 days.
      await db.session.update({
        where: { id: session.id },
        data: { expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS) },
      });
      // Keep the device's lastSeenAt honest for the devices management UI.
      if (session.deviceId) {
        await db.device.update({ where: { id: session.deviceId }, data: { lastSeenAt: new Date() } }).catch(() => {});
      }

      const payload: AccessTokenPayload = {
        accountId: session.accountId,
        isAdmin: session.account.isAdmin,
        sessionId: session.id,
      };
      const accessToken = app.jwt.sign(payload);
      return { accessToken };
    },
  );

  app.post(
    "/auth/logout",
    { schema: { body: RefreshBody, response: { 200: RevokedResponse, 404: ErrorResponse } } },
    async (req, reply) => {
      const hash = hashOpaqueToken(req.body.refreshToken);
      const session = await db.session.findUnique({ where: { refreshTokenHash: hash } });
      if (!session) return reply.code(404).send({ error: "session not found" });
      await db.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      invalidateSessionLiveness(session.id);
      return { revoked: true };
    },
  );

  app.post(
    "/auth/password",
    {
      preHandler: app.authenticate,
      schema: { body: ChangePasswordBody, response: { 200: ChangePasswordResponse, 401: ErrorResponse } },
    },
    async (req, reply) => {
      const account = await db.account.findUnique({ where: { id: req.accountId } });
      if (!account) return reply.code(401).send({ error: "invalid credentials" });
      const valid = await verifyPassword(account.passwordHash, req.body.currentPassword);
      if (!valid) return reply.code(401).send({ error: "current password is incorrect" });
      const passwordHash = await hashPassword(req.body.newPassword);
      await db.account.update({ where: { id: account.id }, data: { passwordHash } });
      return { changed: true };
    },
  );

  app.get(
    "/auth/sessions",
    { preHandler: app.authenticate, schema: { response: { 200: z.array(SessionSummary) } } },
    async (req) => {
      const sessions = await db.session.findMany({
        where: { accountId: req.accountId },
        include: { authDevice: { select: { platform: true } } },
        orderBy: { createdAt: "desc" },
      });
      return sessions.map((s) => ({
        id: s.id,
        device: s.device,
        deviceId: s.deviceId,
        platform: s.authDevice?.platform ?? null,
        userAgent: s.userAgent,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        revokedAt: s.revokedAt,
      }));
    },
  );

  app.post(
    "/auth/sessions/:id/revoke",
    {
      preHandler: app.authenticate,
      schema: { params: SessionParams, response: { 200: RevokedResponse, 404: ErrorResponse } },
    },
    async (req, reply) => {
      const session = await db.session.findUnique({ where: { id: req.params.id } });
      if (!session || session.accountId !== req.accountId) {
        return reply.code(404).send({ error: "session not found" });
      }
      await db.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      invalidateSessionLiveness(session.id);
      return { revoked: true };
    },
  );

  app.get(
    "/auth/devices",
    { preHandler: app.authenticate, schema: { response: { 200: z.array(DeviceSummary) } } },
    async (req) => {
      // The devices list is the union of: devices this account owns, and
      // shared devices (TVs) it was paired to (DeviceAccount links). A
      // shared TV shows up for every household member, not just its owner.
      const [owned, linked] = await Promise.all([
        db.device.findMany({
          where: { accountId: req.accountId },
          select: { id: true, name: true, platform: true, createdAt: true, lastSeenAt: true },
          orderBy: { createdAt: "desc" },
        }),
        db.deviceAccount.findMany({
          where: { accountId: req.accountId },
          include: { device: { select: { id: true, name: true, platform: true, createdAt: true, lastSeenAt: true } } },
        }),
      ]);
      const ownedIds = new Set(owned.map((d) => d.id));
      const merged = [...owned];
      for (const link of linked) {
        if (!ownedIds.has(link.device.id)) merged.push(link.device);
      }
      return merged;
    },
  );

  // Links the current session's install to a Device row, same upsert
  // /auth/login does for clientKey — for a session that was established
  // before this device existed (older app version, or a login whose
  // clientKey/platform raced the bridge). Without it, that install can never
  // pass canDownload()'s deviceId check short of a full log-out/log-in.
  app.post(
    "/auth/device",
    { preHandler: app.authenticate, schema: { body: RegisterDeviceBody, response: { 200: RegisterDeviceResponse } } },
    async (req) => {
      const deviceId = await upsertDevice({
        accountId: req.accountId!,
        clientKey: req.body.clientKey,
        name: req.body.deviceName ?? "unknown device",
        platform: req.body.platform,
      });
      return { deviceId };
    },
  );

  app.delete(
    "/auth/devices/:id",
    {
      preHandler: app.authenticate,
      schema: { params: DeviceParams, response: { 200: RevokedResponse, 404: ErrorResponse } },
    },
    async (req, reply) => {
      const device = await db.device.findUnique({ where: { id: req.params.id } });
      const linked = device
        ? await db.deviceAccount.findUnique({
            where: { deviceId_accountId: { deviceId: device.id, accountId: req.accountId! } },
          })
        : null;
      // Either the owner or any paired account may revoke a shared device.
      if (!device || (device.accountId !== req.accountId && !linked)) {
        return reply.code(404).send({ error: "device not found" });
      }
      // Revoke every session bound to the device, then drop the device (which
      // cascades its downloads and account links). Sessions would otherwise
      // survive the delete (ON DELETE SET NULL) as orphaned-but-live sessions.
      const sessions = await db.session.findMany({ where: { deviceId: device.id, revokedAt: null }, select: { id: true } });
      await db.$transaction([
        db.session.updateMany({ where: { deviceId: device.id }, data: { revokedAt: new Date() } }),
        db.device.delete({ where: { id: device.id } }),
      ]);
      for (const s of sessions) invalidateSessionLiveness(s.id);
      return { revoked: true };
    },
  );

  app.post(
    "/auth/invites",
    {
      preHandler: [app.authenticate, app.requireAdmin],
      schema: { body: CreateInviteBody.optional(), response: { 200: InviteResponse } },
    },
    async (req) => {
      const code = generateOpaqueToken().slice(0, 12);
      const expiresAt = req.body?.expiresInDays
        ? new Date(Date.now() + req.body.expiresInDays * 24 * 60 * 60 * 1000)
        : null;
      const invite = await db.invite.create({
        data: { code, createdById: req.accountId!, expiresAt },
      });
      return { code: invite.code, expiresAt: invite.expiresAt };
    },
  );

  // ── TV pairing: TVs can't type passwords, so a logged-in phone/PC approves
  // a code the TV displays. request (TV) → verify (phone/PC) → status poll
  // (TV, mints the session exactly once). ──────────────────────────────────
  app.post(
    "/auth/pair/request",
    {
      preHandler: [rateLimited(pairRequestLimiter, (req) => clientIp(req))],
      schema: { body: PairingRequestBody, response: { 200: PairingRequestResponse, 429: ErrorResponse } },
    },
    async (req) => {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const pairing = await db.pairingCode.create({
        data: {
          code,
          status: "PENDING",
          deviceName: req.body.name,
          platform: req.body.platform,
          clientKey: req.body.clientKey ?? null,
          expiresAt: new Date(Date.now() + PAIRING_TTL_MS),
        },
      });
      return { pairingId: pairing.id, code, expiresAt: pairing.expiresAt };
    },
  );

  app.post(
    "/auth/pair/verify",
    {
      preHandler: app.authenticate,
      schema: { body: PairingVerifyBody, response: { 200: PairingVerifyResponse, 404: ErrorResponse } },
    },
    async (req, reply) => {
      const pairing = await db.pairingCode.findUnique({ where: { code: req.body.code.trim() } });
      if (!pairing || pairing.expiresAt < new Date()) {
        return reply.code(404).send({ error: "invalid or expired code" });
      }
      if (pairing.status === "COMPLETE" || pairing.status === "EXPIRED") {
        return reply.code(404).send({ error: "invalid or expired code" });
      }

      // Register the TV's device (if it sent a clientKey) under the approving
      // account, then approve the code so the TV's next status poll mints a
      // session bound to that device.
      let deviceId: string | null = null;
      if (pairing.clientKey) {
        deviceId = await upsertDevice({
          accountId: req.accountId!,
          clientKey: pairing.clientKey,
          name: pairing.deviceName,
          platform: pairing.platform,
        });
      }
      await db.pairingCode.update({
        where: { id: pairing.id },
        data: { status: "APPROVED", accountId: req.accountId, verifiedAt: new Date() },
      });
      return { ok: true, deviceId };
    },
  );

  app.post(
    "/auth/pair/status",
    {
      preHandler: [rateLimited(pairStatusLimiter, (req) => clientIp(req))],
      schema: { body: PairingStatusBody, response: { 200: PairingStatusResponse, 404: ErrorResponse } },
    },
    async (req, reply) => {
      const pairing = await db.pairingCode.findUnique({ where: { id: req.body.pairingId } });
      if (!pairing) return reply.code(404).send({ error: "unknown pairing" });

      if (pairing.expiresAt < new Date() && pairing.status !== "COMPLETE") {
        if (pairing.status !== "EXPIRED") {
          await db.pairingCode.update({ where: { id: pairing.id }, data: { status: "EXPIRED" } });
        }
        return { status: "EXPIRED" as const };
      }
      if (pairing.status === "PENDING") return { status: "PENDING" as const };
      if (pairing.status === "COMPLETE") return { status: "COMPLETE" as const };

      // APPROVED → claim it atomically; only the winning poll mints a session
      // (a double-poll race must not mint two sessions from one code).
      const claimed = await db.pairingCode.updateMany({
        where: { id: pairing.id, status: "APPROVED" },
        data: { status: "COMPLETE", consumedAt: new Date() },
      });
      if (claimed.count === 0) return { status: "COMPLETE" as const };

      const account = await db.account.findUnique({ where: { id: pairing.accountId! } });
      // Disabled between approve and poll — don't mint a session for them.
      if (!account || account.disabled) return { status: "EXPIRED" as const };

      const device =
        pairing.clientKey != null
          ? await db.device.findFirst({ where: { accountId: account.id, clientKey: pairing.clientKey } })
          : null;
      const refreshToken = generateOpaqueToken();
      const session = await db.session.create({
        data: {
          accountId: account.id,
          refreshTokenHash: hashOpaqueToken(refreshToken),
          device: pairing.deviceName,
          deviceId: device?.id ?? null,
          userAgent: req.headers["user-agent"] ?? null,
          expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        },
      });
      await db.account.update({ where: { id: account.id }, data: { lastLoginAt: new Date() } });

      const payload: AccessTokenPayload = { accountId: account.id, isAdmin: account.isAdmin, sessionId: session.id };
      const accessToken = app.jwt.sign(payload);
      return {
        status: "COMPLETE" as const,
        accessToken,
        refreshToken,
        sessionId: session.id,
        deviceId: device?.id ?? undefined,
        username: account.username,
      };
    },
  );
}
