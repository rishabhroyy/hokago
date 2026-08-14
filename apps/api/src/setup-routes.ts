import { PrismaClient } from "@hokago/db";
import {
  SetupState,
  SetupCompleteBody,
  SetupCompleteResponse,
  ErrorResponse,
} from "@hokago/contract/setup";
import {
  hashPassword,
  generateOpaqueToken,
  hashOpaqueToken,
  REFRESH_TOKEN_TTL_MS,
  type AccessTokenPayload,
} from "./auth.js";
import { RateLimiter, rateLimited } from "./rate-limit.js";
import type { ZodFastifyInstance } from "./fastify-zod.js";

const db = new PrismaClient();

// Creating the first admin is the keys to the kingdom — tripwire it harder
// than login. Public + unguarded admin creation would be a straight takeover.
// Keyed on req.ip (not clientIp): CF-Connecting-IP is attacker-spoofable
// whenever the server isn't actually behind Cloudflare (e.g. directly
// exposed on :3000), and this limiter is the ONLY barrier between a fresh
// install and a created admin — a spoofed header would make it unlimited
// attempts. req.ip resolves the real client behind any proxy per
// HOKAGO_TRUST_PROXY, and is the raw socket peer otherwise.
const setupLimiter = new RateLimiter(60 * 60 * 1000, 5);

export async function registerSetupRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get("/setup/state", { schema: { response: { 200: SetupState } } }, async () => {
    // Materialize the singleton on first read so the wizard's completion
    // write and the admin settings page always have a row to hit.
    await db.serverSetting.upsert({
      where: { id: "singleton" },
      create: { id: "singleton" },
      update: {},
    });
    const accounts = await db.account.count();
    return {
      setupRequired: accounts === 0,
    };
  });

  app.post(
    "/setup/complete",
    {
      preHandler: [rateLimited(setupLimiter, (req) => req.ip ?? "unknown")],
      schema: {
        body: SetupCompleteBody,
        response: { 201: SetupCompleteResponse, 400: ErrorResponse, 409: ErrorResponse, 429: ErrorResponse },
      },
    },
    async (req, reply) => {
      const username = req.body.username.trim();

      // Accounts exist → setup was already done (CLI bootstrap, or the wizard
      // ran elsewhere). Never stamp over a live install.
      const accounts = await db.account.count();
      if (accounts > 0) return reply.code(409).send({ error: "setup already complete" });

      // Atomic claim on the singleton stamp: two concurrent completions can't
      // both pass the count check, but only the first updateMany wins. The
      // loser gets the same 409 as a completed install.
      const claimed = await db.serverSetting.updateMany({
        where: { id: "singleton", setupCompletedAt: null },
        data: { setupCompletedAt: new Date() },
      });
      if (claimed.count === 0) return reply.code(409).send({ error: "setup already complete" });

      try {
        const passwordHash = await hashPassword(req.body.password);
        const account = await db.$transaction(async (tx) => {
          const created = await tx.account.create({ data: { username, passwordHash, isAdmin: true } });
          // Same rule as registration: every account gets a primary profile
          // named after the username, or prefs/avatar features silently no-op.
          await tx.profile.create({ data: { accountId: created.id, name: username } });
          return created;
        });

        // Mint a session exactly like a login — the wizard continues with the
        // standard admin API (libraries, scans) instead of a second auth step.
        const refreshToken = generateOpaqueToken();
        const session = await db.session.create({
          data: {
            accountId: account.id,
            refreshTokenHash: hashOpaqueToken(refreshToken),
            device: "web",
            userAgent: req.headers["user-agent"] ?? null,
            expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
          },
        });
        await db.account.update({ where: { id: account.id }, data: { lastLoginAt: new Date() } });

        const payload: AccessTokenPayload = { accountId: account.id, isAdmin: true, sessionId: session.id };
        const accessToken = app.jwt.sign(payload);

        return reply.code(201).send({ ok: true, accessToken, refreshToken, sessionId: session.id });
      } catch (err) {
        // Account creation failed after we stamped the claim (DB issue, or a
        // concurrent bootstrap raced us) — release the stamp so the wizard
        // stays retryable instead of soft-locking setup.
        await db.serverSetting
          .update({ where: { id: "singleton" }, data: { setupCompletedAt: null } })
          .catch(() => {});
        throw err;
      }
    },
  );
}