import { createHash, randomBytes } from "node:crypto";
import { argon2id, argon2Verify } from "hash-wasm";
import fastifyJwt from "@fastify/jwt";
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
// a fast hash is fine for at-rest storage/lookup (§7.1's `refresh_token_hash`).
export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const ACCESS_TOKEN_TTL = "15m";
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface AccessTokenPayload {
  accountId: string;
  isAdmin: boolean;
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
      const payload = await req.jwtVerify<AccessTokenPayload>();
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
