import { PrismaClient } from "@hokago/db";
import { Queue, getConnection, QUEUE_NAMES, anicliJobId, parseAnicliQuery, type AnicliDownloadJobData } from "@hokago/queue";
import { AniListProvider } from "@hokago/providers";
import type { MetadataQuery } from "@hokago/metadata";
import { statfs } from "node:fs/promises";
import { z } from "zod";
import {
  AnicliSearchQuery,
  AnicliSearchResponse,
  AnicliDownloadBody,
  AnicliDownloadInfo,
  AnicliParams,
  ErrorResponse,
} from "@hokago/contract/anicli";
import type { ZodFastifyInstance } from "./fastify-zod.js";

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

export async function registerAnicliRoutes(app: ZodFastifyInstance): Promise<void> {
  // ── Search ───────────────────────────────────────────────────────────
  // Real title search via AniList (keyless GraphQL, reliable) — NOT ani-cli's
  // Cloudflare-fragile AniDB scrape. The worker later resolves the exact title
  // through ani-cli. Admin-only.
  app.post(
    "/anicli/search",
    {
      preHandler: app.authenticate,
      schema: { body: AnicliSearchQuery, response: { 200: AnicliSearchResponse, 403: ErrorResponse } },
    },
    async (req, reply) => {
      if (!(await requireAdmin(req))) return reply.code(403).send({ error: "admin only" });
      const query: MetadataQuery = { title: req.body.query, kind: "SERIES" };
      let candidates: { title: string; year: number | null; posterUrl: string | null }[] = [];
      try {
        const { matches } = (await Promise.race([
          anilist.search(query),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("search timed out")), SEARCH_TIMEOUT_MS)),
        ])) as Awaited<ReturnType<AniListProvider["search"]>>;
        candidates = matches.map((m) => ({
          title: m.title,
          year: m.year ?? null,
          posterUrl: m.artwork?.find((a) => a.kind === "POSTER")?.url ?? m.artwork?.[0]?.url ?? null,
        }));
      } catch {
        // provider down/blocked — return what we have (possibly empty); the
        // worker still attempts the exact title via ani-cli on submit.
      }
      return { candidates };
    },
  );

  // ── Enqueue download ──────────────────────────────────────────────────
  app.post(
    "/anicli/downloads",
    {
      preHandler: app.authenticate,
      schema: { body: AnicliDownloadBody, response: { 201: AnicliDownloadInfo, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse, 429: ErrorResponse, 507: ErrorResponse } },
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

      // Episode range guard.
      if (body.episodeRange) {
        const parts = body.episodeRange.split("-").map(Number);
        const count = parts.length === 2 ? parts[1]! - parts[0]! + 1 : 1;
        if (parts[0]! < 1 || (parts.length === 2 && parts[1]! < parts[0]!) || count > MAX_EPISODES) {
          return reply.code(422).send({ error: `episodeRange must be 1-based ascending and ≤ ${MAX_EPISODES} episodes` });
        }
      }

      const job = await db.anicliDownload.create({
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
    "/anicli/downloads",
    { preHandler: app.authenticate, schema: { response: { 200: z.array(AnicliDownloadInfo) } } },
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
    "/anicli/downloads/:id",
    { preHandler: app.authenticate, schema: { params: AnicliParams, response: { 200: AnicliDownloadInfo, 404: ErrorResponse } } },
    async (req, reply) => {
      const row = await db.anicliDownload.findUnique({ where: { id: req.params.id } });
      if (!row || row.accountId !== req.accountId) return reply.code(404).send({ error: "not found" });
      return toInfo(row);
    },
  );

  // ── Cancel / delete ───────────────────────────────────────────────────
  app.delete(
    "/anicli/downloads/:id",
    { preHandler: app.authenticate, schema: { params: AnicliParams, response: { 200: z.object({ revoked: z.boolean() }), 404: ErrorResponse } } },
    async (req, reply) => {
      const { id } = req.params;
      const row = await db.anicliDownload.findUnique({ where: { id } });
      if (!row || row.accountId !== req.accountId) return reply.code(404).send({ error: "not found" });
      await anicliQueue.remove(anicliJobId(id)).catch(() => {});
      if (row.status === "QUEUED" || row.status === "SEARCHING") {
        await db.anicliDownload.update({ where: { id }, data: { status: "CANCELLED" } }).catch(() => {});
      } else {
        // A completed/failed download leaves no artifact to delete (files were
        // imported into the library and are owned by the scanner); just drop
        // the row. In-flight DOWNLOADING rows are killed + cleaned by the worker.
        await db.anicliDownload.delete({ where: { id } }).catch(() => {});
      }
      return { revoked: true };
    },
  );
}

type AnicliInfo = z.infer<typeof AnicliDownloadInfo>;
type AnicliStatusValue = AnicliInfo["status"];

function toInfo(r: {
  id: string;
  libraryId: string;
  query: string;
  title: string | null;
  episodeRange: string | null;
  dub: boolean;
  status: AnicliStatusValue;
  progress: unknown;
  bytesWritten: bigint;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}): AnicliInfo {
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
