import { PrismaClient } from "@hokago/db";
import {
  generateOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  verifyPassword,
  REFRESH_TOKEN_TTL_MS,
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
  CreateInviteBody,
  InviteResponse,
  ErrorResponse,
} from "@hokago/contract/auth";
import { z } from "zod";
import type { ZodFastifyInstance } from "./fastify-zod.js";

const db = new PrismaClient();

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
    { schema: { body: LoginBody, response: { 200: LoginResponse, 401: ErrorResponse } } },
    async (req, reply) => {
      const { username, password, device } = req.body;
      const account = await db.account.findUnique({ where: { username } });
      if (!account || account.disabled) return reply.code(401).send({ error: "invalid credentials" });

      const valid = await verifyPassword(account.passwordHash, password);
      if (!valid) return reply.code(401).send({ error: "invalid credentials" });

      const refreshToken = generateOpaqueToken();
      const session = await db.session.create({
        data: {
          accountId: account.id,
          refreshTokenHash: hashOpaqueToken(refreshToken),
          device: device ?? null,
          userAgent: req.headers["user-agent"] ?? null,
          expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        },
      });
      await db.account.update({ where: { id: account.id }, data: { lastLoginAt: new Date() } });

      const payload: AccessTokenPayload = { accountId: account.id, isAdmin: account.isAdmin };
      const accessToken = app.jwt.sign(payload);

      return { accessToken, refreshToken, sessionId: session.id };
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

      const payload: AccessTokenPayload = { accountId: session.accountId, isAdmin: session.account.isAdmin };
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
        select: { id: true, device: true, userAgent: true, createdAt: true, expiresAt: true, revokedAt: true },
        orderBy: { createdAt: "desc" },
      });
      return sessions;
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
}
