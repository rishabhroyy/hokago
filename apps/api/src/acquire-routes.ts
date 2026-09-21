import { PrismaClient } from "@hokago/db";
import {
  Queue,
  getConnection,
  QUEUE_NAMES,
  anicliJobId,
  acquireImportJobId,
  isSeriesLikeTitle,
  parseAnicliQuery,
  type AnicliDownloadJobData,
  type AcquireImportJobData,
} from "@hokago/queue";
import {
  AniListProvider,
  checkSeasonDedup,
  findExistingSeries,
  findSeriesByExternalIds,
  resolveQueryExternalIds,
  seasonsForSeries,
} from "@hokago/providers";
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
  AcquireExistingQuery,
  AcquireExistingResponse,
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
  getProviderConnection,
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

/**
 * External-provider streams land through this queue instead: the provider
 * only ever hands back JSON (AcquireDownloadInfo-shaped), so something has
 * to actually fetch and place the bytes — the worker does that, matching
 * ani-cli's own placement convention exactly (see apps/worker/src/index.ts).
 * Same attempts:1 philosophy as anicliQueue above: a failed transfer is
 * terminal, never silently re-driven.
 */
const acquireImportQueue = new Queue<AcquireImportJobData>(QUEUE_NAMES.ACQUIRE_IMPORT, {
  connection: getConnection(),
  defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: true },
});
export async function closeAcquireImportQueue(): Promise<void> {
  await acquireImportQueue.close().catch(() => {});
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


/**
 * Library match with metadata-as-king ordering, shared by the preview and
 * both dedup gates so all three answer "is this the same show" identically.
 * Local string matching first (fast, offline, zero extra requests), then —
 * only when nothing matched — best-effort provider-identity resolution
 * (AniList + acceptMatch alias graph) mapped back through the library's own
 * ExternalIds. Network never fails the lookup: resolve swallows, DB errors
 * propagate so gates stay fail-closed exactly as before.
 */
async function findLibraryMatch(
  libraryId: string,
  candidates: { title: string; year: number | null }[],
): Promise<{ id: string; title: string; year: number | null } | undefined> {
  const uniq: { title: string; year: number | null }[] = [];
  for (const c of candidates) {
    if (!c.title.trim()) continue;
    if (uniq.some((u) => u.title === c.title && u.year === c.year)) continue;
    uniq.push(c);
  }
  // Collect every hit, then prefer series-like-titled rows — same rule the
  // worker's placement uses, so preview/gate never pick a legacy junk row
  // ("01") the import step would deprioritize.
  const hits: { id: string; title: string; year: number | null }[] = [];
  for (const c of uniq) {
    const m = await findExistingSeries({ db }, libraryId, c.title, c.year);
    if (m && !hits.some((h) => h.id === m.id)) hits.push(m);
  }
  const pick = () => hits.find((h) => isSeriesLikeTitle(h.title)) ?? hits[0];
  let match = pick();
  if (!match || !isSeriesLikeTitle(match.title)) {
    // No hit, or only junk-titled hits (legacy fork rows): the alias graph
    // may still know the real show, so try it before settling.
    const resolved = await Promise.all(
      uniq.map((c) => resolveQueryExternalIds(c.title, c.year).catch(() => undefined)),
    );
    for (const ids of resolved) {
      if (!ids || ids.length === 0) continue;
      const hit = await findSeriesByExternalIds({ db }, libraryId, ids);
      if (hit && !hits.some((h) => h.id === hit.id)) hits.push(hit);
    }
    match = pick();
  }
  return match;
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

      // Episode range guard — must be a single episode ("5") or an ascending
      // "A-B" of positive integers, ≤ MAX_EPISODES total. Anything else
      // (garbage, non-integers, multi-hyphen "1-12-3", descending) is rejected
      // before it reaches ani-cli's -r flag. Runs BEFORE dedup below: dedup
      // also parses episodeRange internally, and a malformed range against
      // an already-partially-filled season would otherwise surface as a
      // misleading 409 ("specify a range") instead of the real 422.
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

      // Dedup — the shared engine (@hokago/providers) walks the real
      // SERIES -> SEASON -> EPISODE hierarchy for this show (found via the
      // same acceptMatch-based matching findExistingSeries already uses for
      // file placement, both here and in the worker) rather than matching
      // by flat title equality across every item kind the way this used to.
      // Blocks an already-fully-downloaded season; allows a new season, an
      // episode range not yet fully present, and specials (season 0) always.
      // Match once through the shared matcher (query + picked title, then
      // provider identity), then run the season/episode gate against the
      // canonical row with the *requested* season from the query: the query
      // carries "Season 2", the title does not, but either naming can be
      // the one that matches the library's canonical row.
      const parsed = parseAnicliQuery(body.query);
      const candidates = [{ title: parsed.title, year: parsed.year }];
      if (body.title) {
        const titleParsed = parseAnicliQuery(body.title);
        if (titleParsed.title !== parsed.title || titleParsed.year !== parsed.year) {
          candidates.push({ title: titleParsed.title, year: titleParsed.year });
        }
      }
      const match = await findLibraryMatch(body.libraryId, candidates);
      if (match) {
        const dedup = await checkSeasonDedup(
          { db },
          body.libraryId,
          match.title,
          match.year,
          parsed.season,
          body.episodeRange,
        );
        if (!dedup.ok) return reply.code(409).send({ error: dedup.reason });
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

  // Register/deregister are gated solely by a static HOKAGO_ACQUIRE_KEY (an
  // X-Register-Key header) — not a fallback alongside admin-session
  // auth, the only mechanism. Unset (the default for every deployment that
  // doesn't opt in) means external-provider registration doesn't exist on
  // this instance at all, full stop, independent of who's logged in.
  const registerOrKey = {
    preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
      const result = checkRegisterKey(req.headers["x-register-key"], process.env.HOKAGO_ACQUIRE_KEY);
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

  // ── What the library already has ────────────────────────────────────
  // Same matcher the dedup gates use (query + picked title, then provider
  // identity), exposed as a read so the UI can show "already have Season 1
  // (12 ep)..." while the user is still typing — and keep showing it after
  // a pick replaces the box with the candidate's noisier title — instead of
  // only ever finding out at submit time.
  app.get(
    "/acquire/existing",
    { ...adminOnly, schema: { querystring: AcquireExistingQuery, response: { 200: AcquireExistingResponse } } },
    async (req) => {
      const parsed = parseAnicliQuery(req.query.query);
      const candidates = [{ title: parsed.title, year: parsed.year }];
      if (req.query.title) {
        const titleParsed = parseAnicliQuery(req.query.title);
        if (titleParsed.title !== parsed.title || titleParsed.year !== parsed.year) {
          candidates.push({ title: titleParsed.title, year: titleParsed.year });
        }
      }
      const match = await findLibraryMatch(req.query.libraryId, candidates);
      if (!match) return { matched: null, seasons: [] };
      const breakdown = await seasonsForSeries({ db }, match.id);
      return {
        matched: { id: match.id, title: match.title, year: match.year },
        seasons: breakdown.map((b) => ({ season: b.season, episodeCount: b.episodeNumbers.length, episodeNumbers: b.episodeNumbers })),
      };
    },
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
    // Fires once, only after a validated 2xx, before the reply is sent —
    // lets one specific call site (the download-enqueue route below) react
    // to a successful relay without every other route needing to know
    // about it.
    onSuccess?: (parsed: unknown) => void,
    // Submitting a download can legitimately take longer than every other
    // proxied call (a provider may need to search, add, and wait on its own
    // metadata resolution before it can answer) — override per call site
    // rather than raising the shared default for the fast paths too.
    timeoutMs?: number,
  ): Promise<void> {
    const result = await proxyToProvider(providerId, upstreamPath, { method, body, timeoutMs });
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
      onSuccess?.(parsed.data);
      reply.code(result.status).send(parsed.data);
      return;
    }
    reply.code(result.status).send(result.body);
  }

  /**
   * The provider only ever hands back JSON acknowledging the request — this
   * is what actually gets hokago a file. Enqueued after a successful
   * relay, using the provider's baseUrl/token as they stood at THIS moment
   * (see getProviderConnection's own doc for why that has to travel in the
   * job payload rather than be re-looked-up by the worker later). A
   * provider that vanished between the relay and this call, or a request
   * with no libraryId/query to place the file by, just skips enqueueing —
   * logged, not surfaced to the caller, since the HTTP response for the
   * enqueue itself already succeeded on the provider's own terms.
   */
  function enqueueOneAcquireImport(
    providerId: string,
    info: { id: string; title?: string | null; episodeRange?: string | null },
    body: Partial<z.infer<typeof AcquireDownloadBody>>,
  ): void {
    if (!body.libraryId || !body.query) {
      console.error(`acquire import: skipped for ${providerId}/${info.id} -- no libraryId/query on the request`);
      return;
    }
    const conn = getProviderConnection(providerId);
    if (!conn) {
      console.error(`acquire import: skipped for ${providerId}/${info.id} -- provider deregistered before the job could be queued`);
      return;
    }
    const data: AcquireImportJobData = {
      providerId,
      downloadId: info.id,
      baseUrl: conn.baseUrl,
      token: conn.token,
      libraryId: body.libraryId,
      query: body.query,
      // Each item's own resolved value, not the shared original request --
      // this is exactly what distinguishes sibling files from one another
      // in the import step's own destination-path computation. Using
      // body's here unconditionally (the bug this replaces) meant every
      // sibling from one request built the identical destination path
      // regardless of what the provider actually returned per item.
      title: info.title ?? body.title,
      episodeRange: info.episodeRange ?? body.episodeRange,
      dub: body.dub,
      // Request-level picked title, preserved apart from the per-item value
      // above: series identity prefers this (user intent + library
      // canonical) over provider per-item text (which can be episode-level
      // junk like "01"). The worker falls back to it whenever the item
      // title is not series-like.
      requestTitle: body.title ?? null,
    };
    acquireImportQueue
      .add(QUEUE_NAMES.ACQUIRE_IMPORT, data, { jobId: acquireImportJobId(providerId, info.id) })
      .catch((e) => console.error(`acquire import: enqueue failed for ${providerId}/${info.id}:`, e));
  }

  // Most providers resolve one item per request; a provider that resolved
  // more lists the rest under `also`, each queued exactly like the primary.
  function enqueueAcquireImport(providerId: string, info: z.infer<typeof AcquireDownloadInfo>, body: Partial<z.infer<typeof AcquireDownloadBody>>): void {
    enqueueOneAcquireImport(providerId, info, body);
    for (const extra of info.also ?? []) enqueueOneAcquireImport(providerId, extra, body);
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
    { ...adminOnly, schema: { params: AcquireProviderId, body: AcquireDownloadBody.partial(), response: { 409: ErrorResponse, 507: ErrorResponse } } },
    async (req, reply) => {
      // Same coarse free-space floor as the built-in route below -- it was
      // never about knowing the download's exact size (ani-cli doesn't
      // either), just refusing to even start when the drive is basically
      // full. Only applies when there's a libraryId to place a file under;
      // enqueueAcquireImport already no-ops without one.
      if (req.body.libraryId) {
        const lib = await db.library.findUnique({ where: { id: req.body.libraryId } });
        if (lib && !(await hasFreeSpace(lib.rootPath))) {
          return reply.code(507).send({ error: "insufficient disk space — free up at least 2 GiB on the library drive" });
        }
      }
      // Same shared season/episode dedup gate the built-in ani-cli route
      // uses (checkSeasonDedup, @hokago/providers) — previously external
      // providers had no protection against re-downloading an already-
      // complete season at all. Only meaningful once there's both a library
      // to check against and a query to parse a title/season out of.
      // Like the built-in route above, the picked title is a second match
      // candidate (same requested season): provider search candidates can
      // carry the fuller title ("... Beyond Journey's End") while the query
      // is the short form, or vice versa after release-junk cleaning.
      if (req.body.libraryId && req.body.query) {
        const parsed = parseAnicliQuery(req.body.query);
        const candidates = [{ title: parsed.title, year: parsed.year }];
        if (req.body.title) {
          const titleParsed = parseAnicliQuery(req.body.title);
          if (titleParsed.title !== parsed.title || titleParsed.year !== parsed.year) {
            candidates.push({ title: titleParsed.title, year: titleParsed.year });
          }
        }
        const match = await findLibraryMatch(req.body.libraryId, candidates);
        if (match) {
          const dedup = await checkSeasonDedup(
            { db },
            req.body.libraryId,
            match.title,
            match.year,
            parsed.season,
            req.body.episodeRange,
          );
          if (!dedup.ok) return reply.code(409).send({ error: dedup.reason });
        }
      }
      return relayProxy(
        reply,
        req.params.providerId,
        "POST",
        "/downloads",
        req.body,
        AcquireDownloadInfo,
        (parsed) => enqueueAcquireImport(req.params.providerId, parsed as z.infer<typeof AcquireDownloadInfo>, req.body),
        60_000,
      );
    },
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
