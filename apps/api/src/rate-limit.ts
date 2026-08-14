import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Real client IP for rate limiting. Behind Cloudflare/Tailscale/nginx the
 * socket peer is the proxy: CF-Connecting-IP is Cloudflare-set and trusted
 * unconditionally; any other X-Forwarded-For handling is delegated to
 * Fastify's trustProxy (configured from HOKAGO_TRUST_PROXY — "true", a hop
 * count, or a proxy IP list), whose proxy-addr walk on req.ip resolves the
 * real client exactly for each trust shape. Plain, no trust proxy configured:
 * the socket peer is the client.
 */
export function clientIp(req: FastifyRequest): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.length > 0) return cf;
  return req.ip ?? "unknown";
}

/**
 * Sliding-window rate limiter (in-memory — per-API-process, which is fine:
 * brute-force protection is a tripwire, not an exact quota, and a single API
 * process is the deployment shape). `hit` records and returns whether the
 * key is still under the cap.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  hit(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const arr = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    arr.push(now);
    this.hits.set(key, arr);
    // Opportunistic cleanup so a busy server can't grow the map without bound.
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) {
        const last = v[v.length - 1];
        if (last === undefined || last <= cutoff) this.hits.delete(k);
      }
    }
    return arr.length <= this.max;
  }
}

/** Fastify preHandler factory backed by a RateLimiter. */
export function rateLimited(limiter: RateLimiter, keyOf: (req: FastifyRequest) => string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!limiter.hit(keyOf(req))) {
      return reply.code(429).send({ error: "too many attempts — slow down and try again" });
    }
  };
}
