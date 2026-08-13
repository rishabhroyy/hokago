import { createHash, randomBytes } from "node:crypto";
import { argon2id, argon2Verify } from "hash-wasm";
import fastifyJwt from "@fastify/jwt";
import { PrismaClient } from "@hokago/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

// Pure-WASM argon2id (hash-wasm), not the native `argon2` package — avoids a
// node-gyp dependency that would complicate multi-arch Docker builds.
const ARGON2_SALT_BYTES = 16;
const ARGON2_OUTPUT_BYTES = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(ARGON2_SALT_BYTES);
  return argon2id({
    password,
    salt,
    parallelism: 1,
    iterations: 3,
    memorySize: 19456, // ~19MB, OWASP argon2id minimum recommendation
    hashLength: ARGON2_OUTPUT_BYTES,
    outputType: "encoded",
  });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2Verify({ hash, password });
}

// Refresh tokens are high-entropy random values, not user-chosen secrets —
// a fast hash is fine for at-rest storage/lookup ('s `refresh_token_hash`).
export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const ACCESS_TOKEN_TTL = "15m";
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Media-routes access cookie: <video>/<img>/etc. can't attach an Authorization
// header, so the web app mirrors the access JWT into a cookie (SameSite=Lax —
// cross-site subresource requests never carry it) and every same-origin
// element request authenticates like any fetch.
export const ACCESS_TOKEN_COOKIE = "hokago_access";

export interface AccessTokenPayload {
  accountId: string;
  isAdmin: boolean;
  /** Session row backing this token — lets the guard re-check revocation/disable live. */
  sessionId?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    accountId?: string;
    isAdmin?: boolean;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AccessTokenPayload;
  }
}

function cookieToken(req: FastifyRequest): string | null {
  const cookie = req.headers.cookie
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${ACCESS_TOKEN_COOKIE}=`));
  return cookie ? decodeURIComponent(cookie.slice(ACCESS_TOKEN_COOKIE.length + 1)) : null;
}

// The JWT carries accountId/isAdmin frozen at sign time (15m TTL), so a
// revoked session or a disabled account would otherwise keep API access until
// the token expires. Re-check both against the DB on every authenticated
// request, via a short-TTL in-memory cache (segment/media routes authenticate
// every few seconds per stream — a point query per request would hammer the DB
// for no real win). Revoke/logout call invalidateSessionLiveness to make the
// kill immediate.
const db = new PrismaClient();
const LIVENESS_TTL_MS = 30_000;
interface Liveness {
  accountDisabled: boolean;
  revoked: boolean;
}
const livenessCache = new Map<string, { value: Liveness; expires: number }>();

export async function sessionIsLive(sessionId: string): Promise<boolean> {
  const now = Date.now();
  const cached = livenessCache.get(sessionId);
  if (cached && cached.expires > now) {
    return !cached.value.accountDisabled && !cached.value.revoked;
  }
  const session = await db.session.findUnique({
    where: { id: sessionId },
    select: { revokedAt: true, account: { select: { disabled: true } } },
  });
  const value: Liveness = {
    // A missing session is a revoked session.
    accountDisabled: session?.account.disabled ?? true,
    revoked: !session || session.revokedAt !== null,
  };
  livenessCache.set(sessionId, { value, expires: now + LIVENESS_TTL_MS });
  return !value.accountDisabled && !value.revoked;
}

/** Drop the cached liveness verdict so a revocation takes effect immediately. */
export function invalidateSessionLiveness(sessionId: string): void {
  livenessCache.delete(sessionId);
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  const secret = process.env.HOKAGO_JWT_SECRET;
  if (!secret) {
    app.log.warn("HOKAGO_JWT_SECRET not set — using an insecure dev-only default. Set it in production.");
  }
  await app.register(fastifyJwt, {
    secret: secret ?? "dev-insecure-secret-do-not-use-in-production",
    sign: { expiresIn: ACCESS_TOKEN_TTL },
  });

  app.decorate("authenticate", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      // jwtVerify reads the Authorization header; the cookie token verifies
      // via the same secret. Try the header first (fetch client), fall back
      // to the cookie (media elements).
      let payload: AccessTokenPayload | null = null;
      try {
        payload = await req.jwtVerify<AccessTokenPayload>();
      } catch {
        // Header auth failed (missing/expired) — try the media cookie next.
        const token = cookieToken(req);
        if (token) payload = app.jwt.verify<AccessTokenPayload>(token);
      }
      if (!payload) throw new Error("no valid token");
      // Re-check the session+account live state carried by the token. Tokens
      // minted before sessionId existed (rolling deploys, old sessions) skip
      // the check until their next refresh re-mints with a sessionId.
      if (payload.sessionId && !(await sessionIsLive(payload.sessionId))) {
        reply.code(401).send({ error: "unauthorized" });
        return;
      }
      req.accountId = payload.accountId;
      req.isAdmin = payload.isAdmin;
    } catch {
      reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.decorate("requireAdmin", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.isAdmin) reply.code(403).send({ error: "admin only" });
  });
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
