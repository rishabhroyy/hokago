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
  type ScanJobData,
  type ArtworkJobData,
  type Job,
} from "@hokago/queue";
import { ingestLibrary, storeArtwork } from "@hokago/scanner/ingest";
import { probeFile } from "@hokago/scanner/probe";
import { killTrackedChildren, trackedPidCount } from "@hokago/scanner/child-registry";

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

const scanWorker = new Worker<ScanJobData>(QUEUE_NAMES.SCAN, processScan, {
  connection,
  concurrency: 1,
});
const artworkWorker = new Worker<ArtworkJobData>(QUEUE_NAMES.ARTWORK, processArtwork, {
  connection,
  concurrency: 2, // backpressure (§9.6.5): bounded ffmpeg concurrency
});

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

  console.log(
    `reconciler: ${libraries.length} librar${libraries.length === 1 ? "y" : "ies"} re-enqueued, ` +
      `${needingArtwork.length} artwork job(s) re-derived`,
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
    Promise.all([scanWorker.close(), artworkWorker.close()]),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);

  killTrackedChildren("SIGKILL");

  await Promise.all([scanQueue.close(), artworkQueue.close(), connection.quit()]);
  await db.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await reconcile();
console.log("hokago-worker: up");
