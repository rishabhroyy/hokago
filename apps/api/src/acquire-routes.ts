import { PrismaClient } from "@hokago/db";
import { Queue, getConnection, QUEUE_NAMES, anicliJobId, parseAnicliQuery, type AnicliDownloadJobData } from "@hokago/queue";
import { AniListProvider } from "@hokago/providers";
import type { MetadataQuery } from "@hokago/metadata";
import { statfs } from "node:fs/promises";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AcquireSearchQuery,
  AcquireSearchResponse,
  AcquireDownloadBody,
  AcquireDownloadInfo,
  AcquireDownloadParams,
  AcquireProviderId,
  AcquireProviderDownloadParams,
  AcquireProviderRegisterBody,
  AcquireProviderInfo,
  AcquireOkResponse,
  ErrorResponse,
} from "@hokago/contract/acquire";
import { RevokedResponse } from "@hokago/contract/auth";
import type { ZodFastifyInstance } from "./fastify-zod.js";
import {
  registerProvider,
  deregisterProvider,
  listHealthyProviders,
  proxyToProvider,
  checkRegisterKey,
  canClaim,
  RESERVED_PROVIDER_ID,
} from "./acquire-provider-registry.js";

const db = new PrismaClient();

/**
 * ani-cli internet acquisition — admin-only. Robustness invariants enforced
 * here (and mirrored in the worker): the ANICLI queue runs each job exactly
 * once (attempts:1), so a failed download lands terminal and is never
 * auto-re-driven; free-space + concurrency + dedup gates all fail-closed so a
 * request that could wear the disk or hammer a source is rejected up front.
 */
const anicliQueue = new Queue<AnicliDownloadJobData>(QUEUE_NAMES.ANICLI, {
  connection: getConnection(),
  defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: true },
});
export async function closeAnicliQueue(): Promise<void> {
  await anicliQueue.close().catch(() => {});
}

// Keep in step with the worker's gate (HOKAGO_ANICLI_MIN_FREE).
const MIN_FREE_BYTES = (() => {
  const v = Number(process.env.HOKAGO_ANICLI_MIN_FREE);
  return Number.isFinite(v) && v > 0 ? v : 2 * 1024 * 1024 * 1024;
})();
const MAX_EPISODES = 100;
const SEARCH_TIMEOUT_MS = 12_000;
const anilist = new AniListProvider();

const ACTIVE: ("QUEUED" | "SEARCHING" | "DOWNLOADING" | "IMPORTING")[] = ["QUEUED", "SEARCHING", "DOWNLOADING", "IMPORTING"];
const ACTIVE_CAP_ACCOUNT = 3;
const ACTIVE_CAP_GLOBAL = 5;

async function requireAdmin(req: { accountId?: string }): Promise<boolean> {
  const acct = await db.account.findUnique({ where: { id: req.accountId! }, select: { isAdmin: true } });
  return acct?.isAdmin === true;
}

/** Live DB check, not the JWT's frozen isAdmin claim (app.requireAdmin) — an
 * admin demoted mid-token-lifetime (up to 15 minutes) should lose access to
 * these routes immediately, same standard the anicli routes above already
 * hold themselves to inline. */
async function requireLiveAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!(await requireAdmin(req))) reply.code(403).send({ error: "admin only" });
}


/** Free bytes the process can actually write (respects reserved blocks). Fail-closed. */
async function hasFreeSpace(dir: string): Promise<boolean> {
  try {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize) > MIN_FREE_BYTES;
  } catch {
    return false;
  }
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export async function registerAcquireRoutes(app: ZodFastifyInstance): Promise<void> {
  // ── Search ───────────────────────────────────────────────────────────
  // Real title search via AniList (keyless GraphQL, reliable) — NOT ani-cli's
  // Cloudflare-fragile AniDB scrape. The worker later resolves the exact title
  // through ani-cli. Admin-only.
  app.post(
    "/acquire/anicli/search",
    {
      preHandler: app.authenticate,
      schema: { body: AcquireSearchQuery, response: { 200: AcquireSearchResponse, 403: ErrorResponse } },
    },
    async (req, reply) => {
      if (!(await requireAdmin(req))) return reply.code(403).send({ error: "admin only" });
      const query: MetadataQuery = { title: req.body.query, kind: "SERIES" };
      let candidates: { title: string; year: number | null; posterUrl: string | null }[] = [];
      try {
        // AbortSignal.timeout both bounds the call AND aborts the underlying
        // fetch — a plain Promise.race would reject on timeout but leave the
        // AniList request running, holding a connection until it hung/returned.
        const { matches } = await anilist.search(query, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
        candidates = matches.map((m) => ({
          title: m.title,
          year: m.year ?? null,
          posterUrl: m.artwork?.find((a) => a.kind === "POSTER")?.url ?? m.artwork?.[0]?.url ?? null,
        }));
      } catch {
        // provider down/blocked/timed out — return what we have (possibly
        // empty); the worker still attempts the exact title via ani-cli on submit.
      }
      return { candidates };
    },
  );

  // ── Enqueue download ──────────────────────────────────────────────────
  app.post(
    "/acquire/anicli/downloads",
    {
      preHandler: app.authenticate,
      schema: { body: AcquireDownloadBody, response: { 201: AcquireDownloadInfo, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse, 429: ErrorResponse, 507: ErrorResponse } },
    },
    async (req, reply) => {
      if (!(await requireAdmin(req))) return reply.code(403).send({ error: "admin only" });
      const body = req.body;

      const lib = await db.library.findUnique({ where: { id: body.libraryId } });
      if (!lib) return reply.code(404).send({ error: "library not found" });
      if (lib.contentProfile !== "ANIME") return reply.code(422).send({ error: "anicli is only for ANIME libraries" });

      // Disk gate — fail-closed before we spend any work.
      if (!(await hasFreeSpace(lib.rootPath))) {
        return reply.code(507).send({ error: "insufficient disk space — free up at least 2 GiB on the library drive" });
      }

      // Concurrency / politeness caps — prevents IP bans and disk-write storms.
      const [active, global] = await Promise.all([
        db.anicliDownload.count({ where: { accountId: req.accountId!, status: { in: ACTIVE } } }),
        db.anicliDownload.count({ where: { status: { in: ACTIVE } } }),
      ]);
      if (active >= ACTIVE_CAP_ACCOUNT) return reply.code(429).send({ error: "too many active downloads (max 3 per account)" });
      if (global >= ACTIVE_CAP_GLOBAL) return reply.code(429).send({ error: "server busy — max 5 concurrent anicli downloads" });

      // Dedup — block an already-on-server show, but allow a NEW season and
      // allow re-downloading a placeholder tile that never got files. The
      // series identity the scanner will create is the folder basename we land
      // in ("Frieren S2" → series "Frieren"; "Demon Slayer (2019)" → series
      // "Demon Slayer (2019)"), so match against that — not the raw query.
      const parsed = parseAnicliQuery(body.query);
      const seriesFolder = parsed.year !== null ? `${parsed.title} (${parsed.year})` : parsed.title;
      const qNorm = norm(seriesFolder);
      const qSeason = parsed.season;
      const existing = await db.mediaItem.findMany({
        where: { libraryId: body.libraryId },
        select: { title: true, seasonNumber: true, titles: { select: { value: true } }, files: { select: { id: true } } },
      });
      for (const it of existing) {
        const names = [it.title, ...it.titles.map((t) => t.value)].map(norm);
        if (!names.includes(qNorm)) continue;
        if (it.files.length === 0) continue; // placeholder / not-downloaded tile — allowed
        if (qSeason !== null) {
          // Season 0 (specials/OVA/ONA) lands in a distinct "Specials" folder
          // that never collides with episode numbering — always allow it.
          if (qSeason === 0) continue;
          const sameShow = existing.filter((e) => {
            const en = [e.title, ...e.titles.map((t) => t.value)].map(norm);
            return en.some((n) => names.includes(n));
          });
          const maxSeason = Math.max(1, ...sameShow.map((e) => e.seasonNumber ?? 1));
          if (qSeason > maxSeason) continue; // new season — allowed
        }
        return reply.code(409).send({ error: "show already exists on the server — new seasons allowed (e.g. \"Frieren S2\")" });
      }

      // Episode range guard — must be a single episode ("5") or an ascending
      // "A-B" of positive integers, ≤ MAX_EPISODES total. Anything else
      // (garbage, non-integers, multi-hyphen "1-12-3", descending) is rejected
      // before it reaches ani-cli's -r flag.
      if (body.episodeRange) {
        const raw = body.episodeRange.trim();
        if (!/^\d+(-\d+)?$/.test(raw)) {
          return reply.code(422).send({ error: `episodeRange must be like "5" or "1-12"` });
        }
        const [a, b] = raw.split("-").map(Number);
        const count = b === undefined ? 1 : b! - a! + 1;
        if (a! < 1 || (b !== undefined && b! < a!) || count > MAX_EPISODES) {
          return reply.code(422).send({ error: `episodeRange must be 1-based ascending and ≤ ${MAX_EPISODES} episodes` });
        }
      }

      let job;
      try {
        job = await db.anicliDownload.create({
          data: {
            accountId: req.accountId!,
            libraryId: body.libraryId,
            query: body.query.trim(),
            title: body.title ?? null,
            episodeRange: body.episodeRange ?? null,
            dub: body.dub ?? false,
            status: "QUEUED",
          },
        });
      } catch (err) {
        // Partial unique index (active downloads per library+query) — the
        // check-then-create window closed a concurrent duplicate. Map the
        // Prisma unique violation (P2002) to a clean 409, not a 500.
        if ((err as { code?: string }).code === "P2002") {
          return reply.code(409).send({ error: "a download for this title is already in progress" });
        }
        throw err;
      }
      await anicliQueue
        .add(QUEUE_NAMES.ANICLI, { jobId: job.id }, { jobId: anicliJobId(job.id) })
        .catch(async (e) => {
          await db.anicliDownload.update({ where: { id: job.id }, data: { status: "FAILED", error: String(e) } }).catch(() => {});
        });
      return reply.code(201).send(toInfo(job));
    },
  );

  // ── List ──────────────────────────────────────────────────────────────
  app.get(
    "/acquire/anicli/downloads",
    { preHandler: app.authenticate, schema: { response: { 200: z.array(AcquireDownloadInfo) } } },
    async (req) => {
      const rows = await db.anicliDownload.findMany({
        where: { accountId: req.accountId },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      return rows.map(toInfo);
    },
  );

  // ── Get one ───────────────────────────────────────────────────────────
  app.get(
    "/acquire/anicli/downloads/:id",
    { preHandler: app.authenticate, schema: { params: AcquireDownloadParams, response: { 200: AcquireDownloadInfo, 404: ErrorResponse } } },
    async (req, reply) => {
      const row = await db.anicliDownload.findUnique({ where: { id: req.params.id } });
      if (!row || row.accountId !== req.accountId) return reply.code(404).send({ error: "not found" });
      return toInfo(row);
    },
  );

  // ── Cancel / delete ───────────────────────────────────────────────────
  app.delete(
    "/acquire/anicli/downloads/:id",
    { preHandler: app.authenticate, schema: { params: AcquireDownloadParams, response: { 200: z.object({ revoked: z.boolean() }), 404: ErrorResponse } } },
    async (req, reply) => {
      const { id } = req.params;
      const row = await db.anicliDownload.findUnique({ where: { id } });
      if (!row || row.accountId !== req.accountId) return reply.code(404).send({ error: "not found" });
      await anicliQueue.remove(anicliJobId(id)).catch(() => {});
      // In-flight rows must be flipped to CANCELLED (not deleted) so the
      // worker's mid-download cancel re-check observes it and kills the
      // process tree. Deleting the row would leave the download running to
      // completion and importing files anyway.
      if (row.status === "QUEUED" || row.status === "SEARCHING" || row.status === "DOWNLOADING" || row.status === "IMPORTING") {
        await db.anicliDownload
          .update({ where: { id }, data: { status: "CANCELLED", error: null } })
          .catch(() => {});
      } else {
        // A completed/failed download leaves no artifact to delete (files were
        // imported into the library and are owned by the scanner); just drop
        // the row.
        await db.anicliDownload.delete({ where: { id } }).catch(() => {});
      }
      return { revoked: true };
    },
  );

  // ── Pluggable providers ──────────────────────────────────────────────
  // Registration is in-memory only (see acquire-provider-registry.ts) — any
  // external service can offer itself as an additional search/download
  // source alongside the built-in one above, for the lifetime of its own
  // process. Nothing here knows or cares what a provider actually is.
  const adminOnly = { preHandler: [app.authenticate, requireLiveAdmin] };

  // Register/deregister are gated solely by a static HOKAGO_KEY (an
  // X-Register-Key header) — not a fallback alongside admin-session
  // auth, the only mechanism. Unset (the default for every deployment that
  // doesn't opt in) means external-provider registration doesn't exist on
  // this instance at all, full stop, independent of who's logged in.
  const registerOrKey = {
    preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
      const result = checkRegisterKey(req.headers["x-register-key"], process.env.HOKAGO_KEY);
      if (result === "not-enabled") reply.code(404).send({ error: "not found" });
      else if (result === "unauthorized") reply.code(401).send({ error: "unauthorized" });
    },
  };

  app.post(
    "/acquire/providers/:providerId",
    { ...registerOrKey, schema: { params: AcquireProviderId, body: AcquireProviderRegisterBody, response: { 200: AcquireOkResponse, 409: ErrorResponse } } },
    async (req, reply) => {
      // The register key alone proves "registration is allowed on this
      // deployment" — it does not prove ownership of THIS id. An id that
      // already has its own token can only be replaced by presenting that
      // same token back; a brand-new id, or one that never set a token,
      // stays open to anyone holding the register key (unchanged).
      if (!canClaim(req.params.providerId, req.headers["x-provider-token"])) {
        return reply.code(409).send({ error: "provider id already registered with a different token" });
      }
      if (!registerProvider(req.params.providerId, req.body)) {
        return reply.code(409).send({ error: `"${RESERVED_PROVIDER_ID}" is a reserved provider id` });
      }
      return { ok: true };
    },
  );

  app.delete(
    "/acquire/providers/:providerId",
    { ...registerOrKey, schema: { params: AcquireProviderId, response: { 200: AcquireOkResponse, 409: ErrorResponse } } },
    async (req, reply) => {
      if (!canClaim(req.params.providerId, req.headers["x-provider-token"])) {
        return reply.code(409).send({ error: "provider id registered with a different token" });
      }
      const ok = deregisterProvider(req.params.providerId);
      return { ok };
    },
  );

  app.get(
    "/acquire/providers",
    { ...adminOnly, schema: { response: { 200: z.array(AcquireProviderInfo) } } },
    () => listHealthyProviders(),
  );

  // Generic proxy for any registered (non-built-in) provider — forwards
  // verbatim and relays the status/body back. Fastify prefers the static
  // /acquire/anicli/* routes above over this parametric one, so the
  // built-in source is never shadowed.
  //
  // A provider's response is only ever trusted as-is on a non-2xx status
  // (relayed verbatim so the provider's own error detail reaches the UI); on
  // 2xx it's validated against the schema the caller expects before being
  // relayed — a malformed body becomes a clean 502 here instead of reaching
  // AcquireSection.tsx as, say, a `.candidates` a null-deref away.
  async function relayProxy(
    reply: FastifyReply,
    providerId: string,
    method: string,
    upstreamPath: string,
    body: unknown,
    responseSchema?: z.ZodTypeAny,
  ): Promise<void> {
    const result = await proxyToProvider(providerId, upstreamPath, { method, body });
    if (!result) {
      reply.code(404).send({ error: "provider not found" });
      return;
    }
    if (responseSchema && result.status >= 200 && result.status < 300) {
      const parsed = responseSchema.safeParse(result.body);
      if (!parsed.success) {
        reply.code(502).send({ error: "provider returned a malformed response" });
        return;
      }
      reply.code(result.status).send(parsed.data);
      return;
    }
    reply.code(result.status).send(result.body);
  }

  app.post(
    "/acquire/:providerId/search",
    { ...adminOnly, schema: { params: AcquireProviderId, body: AcquireSearchQuery } },
    (req, reply) => relayProxy(reply, req.params.providerId, "POST", "/search", req.body, AcquireSearchResponse),
  );

  app.post(
    "/acquire/:providerId/downloads",
    // .partial(): an external provider has no notion of hokago's libraryId,
    // unlike the built-in ani-cli route above — but whatever fields it IS
    // given (query length, episodeRange shape, etc.) still get the same
    // limits as the built-in route, not an unconstrained z.record.
    { ...adminOnly, schema: { params: AcquireProviderId, body: AcquireDownloadBody.partial() } },
    (req, reply) => relayProxy(reply, req.params.providerId, "POST", "/downloads", req.body, AcquireDownloadInfo),
  );

  app.get(
    "/acquire/:providerId/downloads",
    { ...adminOnly, schema: { params: AcquireProviderId } },
    (req, reply) => relayProxy(reply, req.params.providerId, "GET", "/downloads", undefined, z.array(AcquireDownloadInfo)),
  );

  app.delete(
    "/acquire/:providerId/downloads/:id",
    { ...adminOnly, schema: { params: AcquireProviderDownloadParams } },
    (req, reply) => relayProxy(reply, req.params.providerId, "DELETE", `/downloads/${req.params.id}`, undefined, RevokedResponse),
  );
}

type AcquireInfo = z.infer<typeof AcquireDownloadInfo>;
type AcquireStatusValue = AcquireInfo["status"];

function toInfo(r: {
  id: string;
  libraryId: string;
  query: string;
  title: string | null;
  episodeRange: string | null;
  dub: boolean;
  status: AcquireStatusValue;
  progress: unknown;
  bytesWritten: bigint;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}): AcquireInfo {
  return {
    id: r.id,
    libraryId: r.libraryId,
    query: r.query,
    title: r.title,
    episodeRange: r.episodeRange,
    dub: r.dub,
    status: r.status,
    progress: (r.progress as { bytes: number; files: number; percent: number | null } | null) ?? null,
    bytesWritten: Number(r.bytesWritten),
    error: r.error,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
