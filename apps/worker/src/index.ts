import path from "node:path";

import { PrismaClient } from "@hokago/db";
import {
  getConnection,
  Queue,
  Worker,
  QUEUE_NAMES,
  JOB_FAILURE_THRESHOLD,
  scanJobId,
  artworkJobId,
  metadataJobId,
  type ScanJobData,
  type ArtworkJobData,
  type MetadataJobData,
  type Job,
} from "@hokago/queue";
import { ingestLibrary, storeArtwork } from "@hokago/scanner/ingest";
import { resolveMetadataStep, buildProviderChain } from "@hokago/scanner/metadata";
import { probeFile } from "@hokago/scanner/probe";
import { killTrackedChildren, trackedPidCount } from "@hokago/scanner/child-registry";
import { AniListProvider, JikanProvider, TvMazeProvider, WikidataBridge } from "@hokago/providers";
import type { MetadataProvider } from "@hokago/metadata";

const db = new PrismaClient();
const connection = getConnection();

const scanQueue = new Queue<ScanJobData>(QUEUE_NAMES.SCAN, { connection });
const artworkQueue = new Queue<ArtworkJobData>(QUEUE_NAMES.ARTWORK, {
  connection,
  defaultJobOptions: {
    attempts: JOB_FAILURE_THRESHOLD,
    backoff: { type: "exponential", delay: 2000 },
  },
});

// One provider instance and one queue per provider (§8, §19 Step 6) — each
// queue gets its own BullMQ `limiter`, matching that provider's real rate
// budget exactly. A job only ever calls its own queue's provider; when that
// provider misses, the job itself enqueues the next provider in the chain
// (§8.2 "chain, not fan-out") rather than calling it inline, so every HTTP
// call to every provider is actually governed by its queue's limiter.
const METADATA_PROVIDERS: Record<string, MetadataProvider> = {
  TVMAZE: new TvMazeProvider(),
  ANILIST: new AniListProvider(),
  MAL: new JikanProvider(),
} as const;

const wikidataBridge = new WikidataBridge();

const METADATA_QUEUE_NAME: Record<string, string> = {
  TVMAZE: QUEUE_NAMES.METADATA_TVMAZE,
  ANILIST: QUEUE_NAMES.METADATA_ANILIST,
  MAL: QUEUE_NAMES.METADATA_MAL,
};
const metadataQueues: Record<string, Queue<MetadataJobData>> = {
  TVMAZE: new Queue<MetadataJobData>(QUEUE_NAMES.METADATA_TVMAZE, {
    connection,
    defaultJobOptions: {
      attempts: JOB_FAILURE_THRESHOLD,
      backoff: { type: "exponential", delay: 2000 },
      // Postgres (ExternalId/JobFailure), not this terminal job's Redis key, is
      // the source of truth for "does this item still need resolving" (§9.6.2
      // self-healing, non-negotiable #9). Without this, the deterministic jobId
      // (metadataJobId) permanently blocks any later re-enqueue for the same
      // provider+item once the first attempt reaches a terminal state.
      removeOnComplete: true,
      removeOnFail: true,
    },
  }),
  ANILIST: new Queue<MetadataJobData>(QUEUE_NAMES.METADATA_ANILIST, {
    connection,
    defaultJobOptions: {
      attempts: JOB_FAILURE_THRESHOLD,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  }),
  MAL: new Queue<MetadataJobData>(QUEUE_NAMES.METADATA_MAL, {
    connection,
    defaultJobOptions: {
      attempts: JOB_FAILURE_THRESHOLD,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  }),
};

async function enqueueScan(libraryId: string): Promise<void> {
  await scanQueue.add(QUEUE_NAMES.SCAN, { libraryId }, { jobId: scanJobId(libraryId) });
}

// Backpressure (§9.6.5): one add() per file as the scan walks it, never a
// bulk dump of thousands of jobs — the artwork worker's concurrency cap below
// is what actually bounds ffmpeg load. Swallow failures here — the boot
// reconciler re-derives any artwork job that never got enqueued (§9.6.2), so
// one bad enqueue must not fail the whole scan and lose every later directory.
async function enqueueArtwork(job: ArtworkJobData): Promise<void> {
  try {
    await artworkQueue.add(QUEUE_NAMES.ARTWORK, job, { jobId: artworkJobId(job.mediaItemId) });
  } catch (err) {
    console.error(`enqueueArtwork failed for ${job.mediaItemId}, will be re-derived on next reconcile:`, err);
  }
}

async function enqueueMetadata(providerName: string, job: MetadataJobData): Promise<void> {
  const queue = metadataQueues[providerName];
  if (!queue) return;
  try {
    await queue.add(METADATA_QUEUE_NAME[providerName]!, job, { jobId: metadataJobId(providerName, job.mediaItemId) });
  } catch (err) {
    console.error(`enqueueMetadata(${providerName}) failed for ${job.mediaItemId}, will be re-derived on next reconcile:`, err);
  }
}

async function processScan(job: Job<ScanJobData>): Promise<void> {
  const library = await db.library.findUniqueOrThrow({ where: { id: job.data.libraryId } });
  await ingestLibrary(db, library.id, library.rootPath, {
    resumeFromCursor: library.scanCursor,
    contentProfile: library.contentProfile,
    // Checkpointing (§9.6.3): persist progress after every completed
    // directory so a killed scan resumes instead of restarting from zero.
    onDirectoryComplete: async (dir) => {
      await db.library.update({ where: { id: library.id }, data: { scanCursor: dir } });
    },
    onArtworkNeeded: enqueueArtwork,
    onMetadataNeeded: async (job) => {
      const chain = buildProviderChain(job.kind, library.contentProfile, library.providerOrder);
      const first = chain[0];
      if (first) await enqueueMetadata(first, job);
    },
  });
  await db.library.update({
    where: { id: library.id },
    data: { scanCursor: null, lastScanAt: new Date() },
  });
}

async function processArtwork(job: Job<ArtworkJobData>): Promise<void> {
  const { mediaItemId, filePath, dir, durationMs } = job.data;
  try {
    // Re-probe rather than trust anything carried across the queue boundary
    // (§9.6.2 re-derive, don't accumulate) — attachedPics never crossed the
    // wire in ArtworkJobData, so this is also the only correct way to get them.
    const probe = await probeFile(filePath);
    await storeArtwork(db, mediaItemId, dir, filePath, probe?.attachedPics ?? [], durationMs ?? probe?.durationMs ?? null);
    await db.jobFailure.deleteMany({ where: { mediaItemId, jobType: QUEUE_NAMES.ARTWORK } });
  } catch (err) {
    const failure = await db.jobFailure.upsert({
      where: { mediaItemId_jobType: { mediaItemId, jobType: QUEUE_NAMES.ARTWORK } },
      create: { mediaItemId, jobType: QUEUE_NAMES.ARTWORK, attempts: 1, lastError: String(err) },
      update: { attempts: { increment: 1 }, lastError: String(err), lastFailedAt: new Date() },
    });
    if (failure.attempts >= JOB_FAILURE_THRESHOLD) {
      // Poison pill (§9.6.6): stop retrying, stay playable, surface to admins.
      await db.mediaItem.update({ where: { id: mediaItemId }, data: { state: "NEEDS_ATTENTION" } });
      return; // swallow — no rethrow, so BullMQ won't keep retrying a dead job
    }
    throw err; // let BullMQ retry with backoff until the threshold is hit
  }
}

/**
 * Same degrade-never-error/poison-pill shape as processArtwork. `providerName`
 * is baked in per-queue (one handler instance per provider) — a miss doesn't
 * retry here, it enqueues the next provider in that item's chain, so BullMQ's
 * own attempts/backoff only ever governs retries against *this* provider.
 */
function makeProcessMetadata(providerName: string) {
  const jobType = METADATA_QUEUE_NAME[providerName]!;
  return async function processMetadata(job: Job<MetadataJobData>): Promise<void> {
    const { mediaItemId, libraryId, kind, title, year } = job.data;
    try {
      const provider = METADATA_PROVIDERS[providerName];
      if (!provider) return;
      const matched = await resolveMetadataStep(
        db,
        { mediaItemId, libraryId, kind, title, year },
        providerName,
        provider,
        wikidataBridge,
      );
      await db.jobFailure.deleteMany({ where: { mediaItemId, jobType } });
      if (!matched) {
        const library = await db.library.findUniqueOrThrow({ where: { id: libraryId } });
        const chain = buildProviderChain(kind, library.contentProfile, library.providerOrder);
        const next = chain[chain.indexOf(providerName) + 1];
        if (next) await enqueueMetadata(next, job.data);
      }
    } catch (err) {
      const failure = await db.jobFailure.upsert({
        where: { mediaItemId_jobType: { mediaItemId, jobType } },
        create: { mediaItemId, jobType, attempts: 1, lastError: String(err) },
        update: { attempts: { increment: 1 }, lastError: String(err), lastFailedAt: new Date() },
      });
      if (failure.attempts >= JOB_FAILURE_THRESHOLD) {
        // Poison pill (§9.6.6): stop retrying this provider, stay playable —
        // the item just keeps whatever confidence/metadata it already has.
        return;
      }
      throw err; // let BullMQ retry with backoff until the threshold is hit
    }
  };
}

const scanWorker = new Worker<ScanJobData>(QUEUE_NAMES.SCAN, processScan, {
  connection,
  concurrency: 1,
});
const artworkWorker = new Worker<ArtworkJobData>(QUEUE_NAMES.ARTWORK, processArtwork, {
  connection,
  concurrency: 2, // backpressure (§9.6.5): bounded ffmpeg concurrency
});

// Per-provider rate budgets (§8, doc's real published limits) enforced by
// BullMQ's own limiter — reused, not hand-rolled.
const metadataWorkers: Record<string, Worker<MetadataJobData>> = {
  TVMAZE: new Worker<MetadataJobData>(QUEUE_NAMES.METADATA_TVMAZE, makeProcessMetadata("TVMAZE"), {
    connection,
    concurrency: 2,
    limiter: { max: 20, duration: 10_000 }, // TVmaze: ≥20 calls/10s per IP
  }),
  ANILIST: new Worker<MetadataJobData>(QUEUE_NAMES.METADATA_ANILIST, makeProcessMetadata("ANILIST"), {
    connection,
    concurrency: 2,
    limiter: { max: 30, duration: 60_000 }, // AniList: currently degraded to 30/min
  }),
  MAL: new Worker<MetadataJobData>(QUEUE_NAMES.METADATA_MAL, makeProcessMetadata("MAL"), {
    connection,
    concurrency: 2,
    limiter: { max: 60, duration: 60_000 }, // Jikan: ~60/min
  }),
};

/**
 * Boot reconciler (§9.6.2): Valkey/BullMQ state is a cache, Postgres is truth.
 * Re-derive missing work from Postgres on every start instead of trusting
 * whatever's still queued — deterministic jobIds make re-enqueueing
 * already-queued work a no-op, so this is safe to run every time.
 */
async function reconcile(): Promise<void> {
  const libraries = await db.library.findMany({ where: { enabled: true } });
  for (const library of libraries) await enqueueScan(library.id);

  const needingArtwork = await db.mediaItem.findMany({
    where: {
      kind: { in: ["MOVIE", "EPISODE"] },
      state: "OK",
      artwork: { none: { kind: "POSTER" } },
      jobFailures: { none: { jobType: QUEUE_NAMES.ARTWORK, attempts: { gte: JOB_FAILURE_THRESHOLD } } },
    },
    include: { files: { take: 1 } },
  });
  for (const item of needingArtwork) {
    const file = item.files[0];
    if (!file) continue;
    await enqueueArtwork({
      mediaItemId: item.id,
      filePath: file.path,
      dir: path.dirname(file.path),
      durationMs: file.durationMs,
    });
  }

  // A MOVIE/SERIES missing an ExternalId for every provider in its own
  // chain has never been successfully resolved (or its match was lost) —
  // re-enqueue against the first provider, same as a fresh onMetadataNeeded.
  let metadataReDerived = 0;
  for (const library of libraries) {
    for (const kind of ["MOVIE", "SERIES"] as const) {
      const chain = buildProviderChain(kind, library.contentProfile, library.providerOrder);
      if (chain.length === 0) continue;
      const jobTypes = chain.map((p) => METADATA_QUEUE_NAME[p]).filter((t): t is string => t !== undefined);
      const needingMetadata = await db.mediaItem.findMany({
        where: {
          libraryId: library.id,
          kind,
          state: "OK",
          externalIds: { none: { provider: { in: chain } } },
          jobFailures: { none: { jobType: { in: jobTypes }, attempts: { gte: JOB_FAILURE_THRESHOLD } } },
        },
      });
      for (const item of needingMetadata) {
        await enqueueMetadata(chain[0]!, {
          mediaItemId: item.id,
          libraryId: library.id,
          kind,
          title: item.title,
          year: item.year,
        });
      }
      metadataReDerived += needingMetadata.length;
    }
  }

  console.log(
    `reconciler: ${libraries.length} librar${libraries.length === 1 ? "y" : "ies"} re-enqueued, ` +
      `${needingArtwork.length} artwork job(s) re-derived, ${metadataReDerived} metadata job(s) re-derived`,
  );
}

/**
 * Graceful shutdown (§9.6.4): stop taking new jobs, give in-flight jobs a
 * short grace period, then reap any ffmpeg/ffprobe child still running —
 * BullMQ closing does not kill children spawned by a job's own code.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: closing workers (tracked children: ${trackedPidCount()})...`);

  await Promise.race([
    Promise.all([scanWorker.close(), artworkWorker.close(), ...Object.values(metadataWorkers).map((w) => w.close())]),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);

  killTrackedChildren("SIGKILL");

  await Promise.all([
    scanQueue.close(),
    artworkQueue.close(),
    ...Object.values(metadataQueues).map((q) => q.close()),
    connection.quit(),
  ]);
  await db.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await reconcile();
console.log("hokago-worker: up");
