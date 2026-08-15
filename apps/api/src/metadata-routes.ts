import { PrismaClient } from "@hokago/db";
import { getConnection, Queue, QUEUE_NAMES, metadataJobId, JOB_FAILURE_THRESHOLD } from "@hokago/queue";
import { AniListProvider, JikanProvider, TvMazeProvider } from "@hokago/providers";
import { syncEvidenceAndConfidence } from "@hokago/scanner/evidence";
import type { MetadataMatch, MetadataProvider, MetadataQuery } from "@hokago/metadata";
import {
  MetadataSearchQuery,
  MetadataSearchResponse,
  MetadataMatchPinParams,
  MetadataMatchPinBody,
  MetadataMatchPinResponse,
  MetadataMatchDeleteParams,
  MetadataMatchDeleteBody,
  MetadataMatchDeleteResponse,
  ErrorResponse,
} from "@hokago/contract/metadata";
import type { ZodFastifyInstance } from "./fastify-zod.js";

const db = new PrismaClient();

/**
 * /metadata — the manual "fix match" flow. Getter-free keyless providers only
 * (the license firewall still stands: packages-optional datasets never ride
 * along). Search is a thin passthrough to the same provider clients the
 * worker uses; pinning writes the identity (ExternalId + PROVIDER_MATCH
 * evidence) and enqueues the item's resolve job, so artwork bytes, descriptive
 * fields and episode titles all flow through the existing pipeline — the API
 * never reimplements matching.
 */
export async function registerMetadataRoutes(app: ZodFastifyInstance): Promise<void> {
  const providers: Record<string, MetadataProvider> = {
    TVMAZE: new TvMazeProvider(),
    ANILIST: new AniListProvider(),
    MAL: new JikanProvider(),
  } as const;

  const METADATA_QUEUE_NAME: Record<string, string> = {
    TVMAZE: QUEUE_NAMES.METADATA_TVMAZE,
    ANILIST: QUEUE_NAMES.METADATA_ANILIST,
    MAL: QUEUE_NAMES.METADATA_MAL,
  };

  // Same defaults as the worker's metadata queues — notably removeOnComplete/
  // Fail, without which the deterministic jobId would permanently block a
  // re-pin of the same provider+item.
  const connection = getConnection();
  const metadataQueues: Record<string, Queue> = {
    TVMAZE: new Queue(QUEUE_NAMES.METADATA_TVMAZE, {
      connection,
      defaultJobOptions: { attempts: JOB_FAILURE_THRESHOLD, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: true, removeOnFail: true },
    }),
    ANILIST: new Queue(QUEUE_NAMES.METADATA_ANILIST, {
      connection,
      defaultJobOptions: { attempts: JOB_FAILURE_THRESHOLD, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: true, removeOnFail: true },
    }),
    MAL: new Queue(QUEUE_NAMES.METADATA_MAL, {
      connection,
      defaultJobOptions: { attempts: JOB_FAILURE_THRESHOLD, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: true, removeOnFail: true },
    }),
  };

  // A hung provider must not hang the endpoint — race each search against a
  // hard deadline; a timed-out provider reports itself unavailable for this
  // request instead of failing the whole search.
  const SEARCH_TIMEOUT_MS = 12_000;
  async function searchOne(name: string, query: MetadataQuery) {
    return Promise.race([
      providers[name]!.search(query),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${name} search timed out`)), SEARCH_TIMEOUT_MS)),
    ]);
  }

  function toCandidate(provider: "TVMAZE" | "ANILIST" | "MAL", match: MetadataMatch) {
    return {
      provider,
      providerId: match.providerId,
      title: match.title,
      year: match.year ?? null,
      overview: match.overview ?? null,
      artworkUrl: match.artwork?.find((a) => a.kind === "POSTER")?.url ?? match.artwork?.[0]?.url ?? null,
    };
  }

  // ── Search ───────────────────────────────────────────────────────────────
  app.get(
    "/metadata/search",
    {
      preHandler: app.authenticate,
      schema: { querystring: MetadataSearchQuery, response: { 200: MetadataSearchResponse } },
    },
    async (req) => {
      const query: MetadataQuery = { title: req.query.title, year: req.query.year ?? undefined, kind: req.query.kind };
      // TVmaze has no movie catalog — skip it for MOVIE searches rather than
      // waste a request that can only come back empty (its own guard would
      // return no matches, same result, one call more).
      const names: ("TVMAZE" | "ANILIST" | "MAL")[] =
        req.query.kind === "MOVIE" ? ["ANILIST", "MAL"] : ["TVMAZE", "ANILIST", "MAL"];

      const candidates = [];
      for (const name of names) {
        try {
          const { matches } = await searchOne(name, query);
          candidates.push(...matches.map((m) => toCandidate(name, m)));
        } catch {
          // one provider down (rate-limited, unreachable) must not kill the search
        }
      }
      return { candidates };
    },
  );

  // ── Pin ──────────────────────────────────────────────────────────────────
  app.post(
    "/media-items/:id/metadata-match",
    {
      preHandler: app.authenticate,
      schema: {
        params: MetadataMatchPinParams,
        body: MetadataMatchPinBody,
        response: { 200: MetadataMatchPinResponse, 404: ErrorResponse, 400: ErrorResponse },
      },
    },
    async (req, reply) => {
      const item = await db.mediaItem.findUnique({
        where: { id: req.params.id },
        select: { id: true, libraryId: true, kind: true, title: true, year: true },
      });
      if (!item) return reply.code(404).send({ error: "media item not found" });
      if (item.kind !== "MOVIE" && item.kind !== "SERIES") {
        return reply.code(400).send({ error: "only MOVIE and SERIES items can be matched" });
      }

      // The identity itself — written before the job is enqueued, so even a
      // race between this response and the worker sees the pinned row.
      await db.externalId.upsert({
        where: { mediaItemId_provider: { mediaItemId: item.id, provider: req.body.provider } },
        create: { mediaItemId: item.id, provider: req.body.provider, providerId: req.body.providerId, confidence: 1 },
        update: { providerId: req.body.providerId, confidence: 1, lastResolvedAt: new Date() },
      });
      // Same shape applyMatch writes — a later auto-heal pass can re-confirm
      // the pin instead of fighting it. ownedTypes ["PROVIDER_MATCH"] prunes
      // stale auto-match evidence for other providers, like the resolver does.
      await syncEvidenceAndConfidence(
        db,
        item.id,
        [
          {
            signalType: "PROVIDER_MATCH",
            source: req.body.provider,
            value: { providerId: req.body.providerId, title: req.body.title, year: req.body.year ?? null },
          },
        ],
        ["PROVIDER_MATCH"],
      );

      // Re-drive resolution for this one item now — the resolve job applies
      // artwork/fields/episode titles via the existing chain. Best-effort:
      // a failed enqueue leaves the pin intact; the next scan wave or
      // reconcile re-derives the job from the ExternalId row.
      try {
        await metadataQueues[req.body.provider]!.add(
          METADATA_QUEUE_NAME[req.body.provider]!,
          {
            mediaItemId: item.id,
            libraryId: item.libraryId,
            kind: item.kind as "MOVIE" | "SERIES",
            title: item.title,
            year: item.year,
          },
          { jobId: metadataJobId(req.body.provider, item.id) },
        );
      } catch (err) {
        console.error(`pin: enqueue ${req.body.provider} resolve failed for ${item.id}`, err);
      }

      return { pinned: true };
    },
  );

  // ── Unpin ────────────────────────────────────────────────────────────────
  app.delete(
    "/media-items/:id/metadata-match",
    {
      preHandler: app.authenticate,
      schema: {
        params: MetadataMatchDeleteParams,
        body: MetadataMatchDeleteBody,
        response: { 200: MetadataMatchDeleteResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      const item = await db.mediaItem.findUnique({ where: { id: req.params.id }, select: { id: true } });
      if (!item) return reply.code(404).send({ error: "media item not found" });

      await db.externalId.deleteMany({ where: { mediaItemId: item.id, provider: req.body.provider } });
      await db.evidence.deleteMany({
        where: { mediaItemId: item.id, signalType: "PROVIDER_MATCH", source: req.body.provider },
      });
      // Recompute confidence from whatever evidence remains (empty inputs,
      // no owned types — sync only, no pruning).
      await syncEvidenceAndConfidence(db, item.id, [], []);

      // No ExternalId left in the chain → the next reconcile/scan wave treats
      // the item as unmatched again and re-attempts auto-resolution.
      return { unpinned: true };
    },
  );
}