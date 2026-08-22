import path from "node:path";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import { PrismaClient } from "@hokago/db";
import {
  getConnection,
  Queue,
  Worker,
  QUEUE_NAMES,
  JOB_FAILURE_THRESHOLD,
  scanJobId,
  artworkJobId,
  trickplayJobId,
  metadataJobId,
  downloadJobId,
  type ScanJobData,
  type ArtworkJobData,
  type TrickplayJobData,
  type MetadataJobData,
  type DownloadJobData,
  type Job,
} from "@hokago/queue";
import { ingestLibrary, storeArtwork } from "@hokago/scanner/ingest";
import { pruneMissingMedia } from "@hokago/scanner/prune";
import { resolveMetadataStep, buildProviderChain } from "@hokago/scanner/metadata";
import { probeFile } from "@hokago/scanner/probe";
import { generateTrickplaySheets, isNothingWrittenError } from "@hokago/scanner/trickplay";
import { killTrackedChildren, trackedPidCount, trackPid, untrackPid } from "@hokago/scanner/child-registry";
import { configDir, probeConfigDir, findSidecarArt, upsertArtworkDescriptor } from "@hokago/scanner/artwork";
import { ARTWORK_SOURCE_PRIORITY, isJunkShowTitle } from "@hokago/scanner/constants";
import { setArtworkHwaccel } from "@hokago/scanner/generate-art";
import { buildDownloadArgs } from "@hokago/ffmpeg/download";
import { pickVideoEncoder } from "@hokago/ffmpeg/device-profile";
import { spawnFfmpeg } from "@hokago/ffmpeg/spawn";
import { getHwaccel, hwActive, reportHwFailure, type HwaccelState } from "@hokago/ffmpeg/hwaccel";
import { AniListProvider, JikanProvider, TvMazeProvider, WikipediaProvider, WikidataBridge } from "@hokago/providers";
import type { MetadataProvider } from "@hokago/metadata";

const db = new PrismaClient();
const connection = getConnection();

// Same boot probe as the API — worker jobs also write artwork/fonts/downloads
// under HOKAGO_CONFIG_DIR (/config); a silent overlay fallback 404s artifacts.
const cfg = probeConfigDir();
if (!cfg.ok) {
  console.warn(`config dir unusable (${cfg.dir}): ${cfg.reason} — artwork, fonts and downloads will fail while playback keeps working. Set HOKAGO_CONFIG_DIR (compose default: /config).`);
} else if (!cfg.explicit) {
  console.warn(`config dir is the cwd-derived default (${cfg.dir}) — HOKAGO_CONFIG_DIR unset; run under compose with /config`);
} else {
  console.log(`config dir: ${cfg.dir}`);
}

// Hardware acceleration, resolved once at boot (one `ffmpeg -encoders` exec +
// device probe — the same cached state the API resolves). Mutated to "none"
// by reportHwFailure on the first runtime failure, which also retires the
// scanner's decode args (setArtworkHwaccel holds the same reference).
const hwaccel: HwaccelState = await getHwaccel();
const hwInUse = () => hwActive(hwaccel);
setArtworkHwaccel(hwaccel);
/** Worker jobs' fail-soft: report a hw runtime failure (disables hw process-wide). */
function reportJobHwFailure(where: string, err: unknown): void {
  if (hwaccel.method !== "none") reportHwFailure(hwaccel.method, `${where}: ${String(err).slice(0, 200)}`);
}

const scanQueue = new Queue<ScanJobData>(QUEUE_NAMES.SCAN, {
  connection,
  // The deterministic jobId (scanJobId) means a *kept* completed job would
  // permanently block any later re-enqueue for the same library — a manual
  // "rescan" would silently no-op. Postgres is truth (the boot reconciler
  // re-enqueues work from it), so both terminal states can be dropped.
  defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
});
const artworkQueue = new Queue<ArtworkJobData>(QUEUE_NAMES.ARTWORK, {
  connection,
  defaultJobOptions: {
    attempts: JOB_FAILURE_THRESHOLD,
    backoff: { type: "exponential", delay: 2000 },
    // Same deterministic-jobId argument as scan above: without this, a
    // completed artwork job stays in Redis and artworkJobId(mediaItemId)
    // silently refuses to re-enqueue after the first success.
    removeOnComplete: true,
    removeOnFail: true,
  },
});
// Trickplay sheet generation decodes the whole file — one of the heaviest
// jobs in the system — so it gets its own queue/concurrency cap too; the
// enqueue gate below (sourceHash vs MediaFile.hash) keeps it from ever
// re-running for an unchanged file.
const trickplayQueue = new Queue<TrickplayJobData>(QUEUE_NAMES.TRICKPLAY, {
  connection,
  defaultJobOptions: {
    attempts: JOB_FAILURE_THRESHOLD,
    backoff: { type: "exponential", delay: 2000 },
    // Same deterministic-jobId argument as artwork above: a kept completed
    // trickplay job would permanently block re-enqueue for a changed file.
    removeOnComplete: true,
    removeOnFail: true,
  },
});
// User-initiated offline downloads (the API enqueues; the row in Postgres is
// truth and survives the job). Three attempts with backoff, then the job
// disappears and the Download row stays FAILED for the client to see.
const downloadQueue = new Queue<DownloadJobData>(QUEUE_NAMES.DOWNLOAD, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: true,
    removeOnFail: true,
  },
});

// One provider instance and one queue per provider (Step 6) — each
// queue gets its own BullMQ `limiter`, matching that provider's real rate
// budget exactly. A job only ever calls its own queue's provider; when that
// provider misses, the job itself enqueues the next provider in the chain
// ("chain, not fan-out") rather than calling it inline, so every HTTP
// call to every provider is actually governed by its queue's limiter.
const METADATA_PROVIDERS: Record<string, MetadataProvider> = {
  TVMAZE: new TvMazeProvider(),
  WIKIPEDIA: new WikipediaProvider(),
  ANILIST: new AniListProvider(),
  MAL: new JikanProvider(),
} as const;

const wikidataBridge = new WikidataBridge();

const METADATA_QUEUE_NAME: Record<string, string> = {
  TVMAZE: QUEUE_NAMES.METADATA_TVMAZE,
  WIKIPEDIA: QUEUE_NAMES.METADATA_WIKIPEDIA,
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
      // the source of truth for "does this item still need resolving" (
      // self-healing, non-negotiable #9). Without this, the deterministic jobId
      // (metadataJobId) permanently blocks any later re-enqueue for the same
      // provider+item once the first attempt reaches a terminal state.
      removeOnComplete: true,
      removeOnFail: true,
    },
  }),
  WIKIPEDIA: new Queue<MetadataJobData>(QUEUE_NAMES.METADATA_WIKIPEDIA, {
    connection,
    defaultJobOptions: {
      attempts: JOB_FAILURE_THRESHOLD,
      backoff: { type: "exponential", delay: 2000 },
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

// Backpressure : one add per file as the scan walks it, never a
// bulk dump of thousands of jobs — the artwork worker's concurrency cap below
// is what actually bounds ffmpeg load. Swallow failures here — the boot
// reconciler re-derives any artwork job that never got enqueued , so
// one bad enqueue must not fail the whole scan and lose every later directory.
async function enqueueArtwork(job: ArtworkJobData): Promise<void> {
  try {
    // Cheap gate: skip if provider poster+backdrop already covered on disk (same check as processArtwork's early-exit).
    const item = await db.mediaItem.findUnique({
      where: { id: job.mediaItemId },
      select: { artwork: { select: { priority: true } } },
    });
    if (item?.artwork.some((a) => a.priority <= 1)) {
      // priority 1 = PROVIDER; if any provider art exists, let reconciler handle the rest — skip scan-path enqueue
      // Check disk via artwork worker's covered() logic would need configDir; rely on DB priority as cheap proxy
      // Actual disk check happens in processArtwork, but this gate already saves 90% of no-op enqueues
      const hasProvider = item.artwork.some((a) => a.priority === 1);
      if (hasProvider) return;
    }
    await artworkQueue.add(QUEUE_NAMES.ARTWORK, job, { jobId: artworkJobId(job.mediaItemId) });
  } catch (err) {
    console.error(`enqueueArtwork failed for ${job.mediaItemId}, will be re-derived on next reconcile:`, err);
  }
}

// Regeneration gate: the sheet set is keyed on the source file's content hash
// (MediaFile.hash — "the idempotency key for all derived work"). When a row
// already exists for this file AND was generated from the same hash, the work
// is done — skip the enqueue. Anything else (no row, stale hash, hash missing)
// enqueues; a deterministic jobId + removeOnComplete makes re-enqueueing
// already-queued work a no-op.
async function enqueueTrickplay(job: TrickplayJobData): Promise<void> {
  try {
    const file = await db.mediaFile.findUnique({
      where: { id: job.mediaFileId },
      select: { hash: true, trickplay: { select: { sourceHash: true } } },
    });
    // null === null is not "up to date": a missing content hash means the
    // hash gate can't vouch for the sheets — enqueue and let the job decide.
    if (file?.trickplay && file.hash !== null && file.trickplay.sourceHash === file.hash) return;
    await trickplayQueue.add(QUEUE_NAMES.TRICKPLAY, job, { jobId: trickplayJobId(job.mediaFileId) });
  } catch (err) {
    console.error(`enqueueTrickplay failed for ${job.mediaFileId}, will be re-derived on next reconcile:`, err);
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
  const summary = await ingestLibrary(db, library.id, library.rootPath, {
    resumeFromCursor: library.scanCursor,
    contentProfile: library.contentProfile,
    // Checkpointing: persist progress after every completed
    // directory so a killed scan resumes instead of restarting from zero.
    onDirectoryComplete: async (dir) => {
      await db.library.update({ where: { id: library.id }, data: { scanCursor: dir } });
    },
    // Expose scan progress to BullMQ so the admin console can show "N of M
    // directories done" — same granularity as the checkpoint cursor.
    onScanProgress: async (doneDirs, totalDirs) => {
      await job.updateProgress({ doneDirs, totalDirs });
    },
    onArtworkNeeded: enqueueArtwork,
    onTrickplayNeeded: enqueueTrickplay,
    onMetadataNeeded: async (job) => {
      // Gate: skip if this item already has an ExternalId for the first provider in chain
      const chain = buildProviderChain(job.kind, library.contentProfile, library.providerOrder);
      const first = chain[0];
      if (!first) return;
      const existing = await db.externalId.findFirst({ where: { mediaItemId: job.mediaItemId, provider: first }, select: { provider: true } });
      if (existing) return;
      await enqueueMetadata(first, job);
    },
  });
  await db.library.update({
    where: { id: library.id },
    data: { scanCursor: null, lastScanAt: new Date() },
  });
  // Staleness sweep: full walk completed (cursor cleared) — rows whose files
  // vanished from disk are gone for real. Gated on the walk finding at least
  // one file: an empty walk means the mount is gone or the library is new,
  // and pruning would nuke everything. Deleted items cascade their artwork,
  // watch state, and derived rows; only disk artifacts (artwork bytes, fonts)
  // are left to the content-addressed store.
  if (summary.filesScanned > 0) {
    const pruned = await pruneMissingMedia(db, library.id, library.rootPath);
    if (pruned.filesRemoved + pruned.itemsRemoved + pruned.collectionsRemoved > 0) {
      console.log(`scan ${library.name}: pruned ${pruned.filesRemoved} missing files, ${pruned.itemsRemoved} items, ${pruned.collectionsRemoved} empty collections`);
    }
  }
  // Rescan = the universal retry. The failure threshold poisons items
  // (artwork → NEEDS_ATTENTION, metadata → silent); clearing both here lets
  // the next scan/reconcile re-derive their artwork and metadata jobs from
  // Postgres. Anything still genuinely broken re-poisons itself — self-
  // correcting, and it gives admins a working recovery lever for the
  // attention list instead of a permanent dead end.
  await db.jobFailure.deleteMany({ where: { mediaItem: { libraryId: library.id } } });
  await db.mediaItem.updateMany({
    where: { libraryId: library.id, state: "NEEDS_ATTENTION" },
    data: { state: "OK" },
  });
}

async function processArtwork(job: Job<ArtworkJobData>): Promise<void> {
  const { mediaItemId, durationMs } = job.data;
  try {
    // The payload path was captured at scan time; a rename between enqueue
    // and run leaves it stale (ffmpeg ENOENTs against the old path). The DB
    // row is the truth — re-derive, don't accumulate.
    const file = await db.mediaFile.findFirst({ where: { mediaItemId } });
    const filePath = file?.path ?? job.data.filePath;
    const dir = file ? path.dirname(file.path) : job.data.dir;

    // A scan enqueues artwork for every leaf. If the item already has
    // sidecar/provider-grade poster AND backdrop on disk, only re-check for
    // (cheap, higher-priority) sidecars — regenerating ffmpeg fallbacks is
    // pure churn, and historically the priority-blind slot cleanup deleted
    // the PROVIDER rows when the GENERATED job landed after them.
    const existing = await db.artwork.findMany({
      where: { mediaItemId, kind: { in: ["POSTER", "BACKDROP"] } },
      select: { kind: true, priority: true, bytesPath: true },
    });
    const covered = (kind: "POSTER" | "BACKDROP"): boolean =>
      existing.some((a) => a.kind === kind && a.priority <= ARTWORK_SOURCE_PRIORITY.PROVIDER! && existsSync(a.bytesPath));
    if (covered("POSTER") && covered("BACKDROP")) {
      const sidecars = await findSidecarArt(dir, filePath);
      for (const art of sidecars) await upsertArtworkDescriptor(db, mediaItemId, art);
      await db.jobFailure.deleteMany({ where: { mediaItemId, jobType: QUEUE_NAMES.ARTWORK } });
      return;
    }

    // Re-probe rather than trust anything carried across the queue boundary
    // (re-derive, don't accumulate) — attachedPics never crossed the
    // wire in ArtworkJobData, so this is also the only correct way to get them.
    const probe = await probeFile(filePath);
    await storeArtwork(db, mediaItemId, dir, filePath, probe?.attachedPics ?? [], durationMs ?? probe?.durationMs ?? null);
    await db.jobFailure.deleteMany({ where: { mediaItemId, jobType: QUEUE_NAMES.ARTWORK } });
  } catch (err) {
    // Fail-soft: a hw-decode failure retires hw (the setter holds the same
    // mutated state) and the BullMQ retry re-runs the job on CPU.
    reportJobHwFailure("artwork", err);
    // Transient (spawn timeout, EMFILE, disk/pipe blip, a signal/OOM-killed
    // decode): never count toward poison — the periodic metadata sweep and
    // boot reconciler re-drive missing work. Let BullMQ retry without
    // recording a failure.
    if (isTransientFfmpegError(err)) throw err;
    const failure = await db.jobFailure.upsert({
      where: { mediaItemId_jobType: { mediaItemId, jobType: QUEUE_NAMES.ARTWORK } },
      create: { mediaItemId, jobType: QUEUE_NAMES.ARTWORK, attempts: 1, lastError: describeFfmpegFailure(err) },
      update: { attempts: { increment: 1 }, lastError: describeFfmpegFailure(err), lastFailedAt: new Date() },
    });
    if (failure.attempts >= JOB_FAILURE_THRESHOLD) {
      // Poison pill: stop retrying, stay playable, surface to admins. The
      // row may already be pruned (file deleted mid-retries) — never let the
      // state flip itself throw an unhandled job failure on a dead item.
      await db.mediaItem.update({ where: { id: mediaItemId }, data: { state: "NEEDS_ATTENTION" } }).catch(() => {});
      return; // swallow — no rethrow, so BullMQ won't keep retrying a dead job
    }
    throw err; // let BullMQ retry with backoff until the threshold is hit
  }
}

async function processTrickplay(job: Job<TrickplayJobData>): Promise<void> {
  const { mediaItemId, mediaFileId, durationMs } = job.data;
  try {
    // Re-fetch the row first: the payload path was captured at scan time and
    // a rename between enqueue and run leaves it stale — the DB row's path is
    // the truth (re-derive, don't accumulate).
    const mediaFile = await db.mediaFile.findUnique({ where: { id: mediaFileId } });
    const filePath = mediaFile?.path ?? job.data.filePath;
    // Re-probe rather than trust anything carried across the queue boundary
    // (re-derive, don't accumulate) — no probe result, or a file the probe
    // couldn't read, means "no sheets", not a poisoned item.
    const probe = await probeFile(filePath);
    const duration = durationMs ?? probe?.durationMs ?? null;
    if (duration === null || !mediaFile) {
      await db.jobFailure.deleteMany({ where: { mediaItemId, jobType: QUEUE_NAMES.TRICKPLAY } });
      return;
    }

    const result = await generateTrickplaySheets(filePath, duration, mediaFileId);
    await db.trickplay.upsert({
      where: { mediaFileId },
      create: {
        mediaFileId,
        tileWidth: result.tileWidth,
        tileHeight: result.tileHeight,
        intervalMs: result.intervalMs,
        tilesPerSheet: result.tilesPerSheet,
        totalTiles: result.totalTiles,
        sheetPaths: result.sheetPaths,
        sourceHash: mediaFile.hash,
      },
      update: {
        tileWidth: result.tileWidth,
        tileHeight: result.tileHeight,
        intervalMs: result.intervalMs,
        tilesPerSheet: result.tilesPerSheet,
        totalTiles: result.totalTiles,
        sheetPaths: result.sheetPaths,
        sourceHash: mediaFile.hash,
        generatedAt: new Date(),
      },
    });
    await db.jobFailure.deleteMany({ where: { mediaItemId, jobType: QUEUE_NAMES.TRICKPLAY } });
  } catch (err) {
    // Fail-soft: a hw-decode failure retires hw (the state generateTrickplaySheets
    // holds is the same mutated object) and the BullMQ retry re-runs on CPU.
    reportJobHwFailure("trickplay", err);
    // Transient (spawn timeout, EMFILE, disk/pipe blip, a signal/OOM-killed
    // decode): never count toward poison — the boot reconciler re-derives
    // missing sheets, and a degraded moment must not park a library. Let
    // BullMQ retry without recording.
    if (isTransientFfmpegError(err)) throw err;
    const failure = await db.jobFailure.upsert({
      where: { mediaItemId_jobType: { mediaItemId, jobType: QUEUE_NAMES.TRICKPLAY } },
      create: { mediaItemId, jobType: QUEUE_NAMES.TRICKPLAY, attempts: 1, lastError: describeFfmpegFailure(err) },
      update: { attempts: { increment: 1 }, lastError: describeFfmpegFailure(err), lastFailedAt: new Date() },
    });
    if (failure.attempts >= JOB_FAILURE_THRESHOLD) {
      // Poison pill: stop retrying, stay playable, surface to admins. The
      // row may already be pruned (file deleted mid-retries) — never let the
      // state flip itself throw an unhandled job failure on a dead item.
      await db.mediaItem.update({ where: { id: mediaItemId }, data: { state: "NEEDS_ATTENTION" } }).catch(() => {});
      return; // swallow — no rethrow, so BullMQ won't keep retrying a dead job
    }
    throw err; // let BullMQ retry with backoff until the threshold is hit
  }
}

// ── Downloads ────────────────────────────────────────────────────────────────

const SUBTITLE_MUX: Record<string, string> = { ASS: "ass", SSA: "ass", SRT: "srt", VTT: "webvtt", TX3G: "srt" };
const SUBTITLE_EXT: Record<string, string> = { ASS: "ass", SSA: "ass", SRT: "srt", VTT: "vtt", TX3G: "srt" };
const FONT_EXT: Record<string, string> = { WOFF2: "woff2", WOFF: "woff", TTF: "ttf", OTF: "otf", TTC: "ttc" };

/** Same convention buildCandidateInput/static-routes use: ffmpeg's `-map 0:s:N` is relative to subtitle-type streams only. */
async function subtitleRelativeIndex(mediaFileId: string, absoluteStreamIndex: number): Promise<number> {
  const preceding = await db.mediaStream.count({
    where: { mediaFileId, type: "SUBTITLE", streamIndex: { lt: absoluteStreamIndex } },
  });
  return preceding;
}

/** Font bytes live at <configDir>/fonts/<hash><ext> — content-addressed, never a URL. */
function resolveFontStorePath(hash: string, ext: string): string {
  return path.join(configDir(), "fonts", `${hash}${ext}`);
}

/**
 * Runs ffmpeg to completion, rejecting with the stderr tail on failure.
 * spawnFfmpeg tracks the pid in the ffmpeg package's registry (the API's
 * registry); the worker's shutdown sweeps the *scanner* registry, so the
 * download's child is also tracked there — otherwise a SIGTERM mid-encode
 * would orphan the ffmpeg process.
 */
async function runFfmpegToCompletion(args: string[]): Promise<void> {
  const { child } = spawnFfmpeg(args);
  trackPid(child.pid);
  try {
    await new Promise<void>((resolve, reject) => {
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
      child.on("error", reject);
    });
  } finally {
    untrackPid(child.pid);
  }
}

interface DownloadManifest {
  media: { filename: string; sizeBytes: number | null } | null;
  subtitles: { trackId: string; filename: string; format: string; lang: string | null }[];
  fonts: { hash: string; filename: string }[];
}

/**
 * Produces a packaged offline artifact into /config/downloads/<id> (built in a
 * sibling tmp dir and renamed in atomically). A download deleted while this
 * runs (API DELETE) leaves the Download row gone — the finalize step detects
 * that and just cleans up. Retries (attempts: 3) re-run the whole encode.
 */
async function processDownload(job: Job<DownloadJobData>): Promise<void> {
  const { downloadId } = job.data;
  const download = await db.download.findUnique({
    where: { id: downloadId },
    include: { mediaFile: { include: { subtitleTracks: true, fonts: { include: { font: true } } } } },
  });
  if (!download) return; // deleted while queued

  const baseDir = path.join(configDir(), "downloads");
  const tmpDir = path.join(baseDir, `.${downloadId}.tmp`);
  const finalDir = path.join(baseDir, downloadId);
  await mkdir(baseDir, { recursive: true });
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });

  try {
    await db.download.update({ where: { id: downloadId }, data: { status: "PROCESSING", error: null } });
    const mediaFile = download.mediaFile;
    const subtitles: DownloadManifest["subtitles"] = [];
    const fonts: DownloadManifest["fonts"] = [];

    // Media: copy the original, or encode a self-contained MP4.
    let mediaFilename: string;
    if (download.variant === "original") {
      mediaFilename = path.basename(mediaFile.path);
      await copyFile(mediaFile.path, path.join(tmpDir, mediaFilename));
    } else {
      const burnTrack = download.subtitleTrackIds
        .map((id) => mediaFile.subtitleTracks.find((t) => t.id === id))
        .find((t): t is NonNullable<typeof t> => !!t?.requiresBurnIn);
      const outputPath = path.join(tmpDir, "media.mp4");
      const encode = (hw: HwaccelState | undefined) =>
        buildDownloadArgs({
          inputPath: mediaFile.path,
          outputPath,
          maxHeight: download.targetHeight ?? undefined,
          maxVideoBitrateKbps: download.targetBitrateKbps ?? undefined,
          subtitleBurnIn: burnTrack
            ? { streamIndex: burnTrack.streamIndex ?? 0, bitmap: true }
            : undefined,
          hwaccel: hw,
          videoCodec: pickVideoEncoder(["h264"], hw),
        });
      try {
        // Offline encodes are quality-first: same encoder selection as live
        // transcoding, so a hw failure here falls back the same way (one
        // CPU re-encode inside the job, then the queue's own retries).
        const useHw = hwaccel.method !== "none";
        await runFfmpegToCompletion(encode(useHw ? hwaccel : undefined));
      } catch (err) {
        if (hwaccel.method !== "none") {
          reportHwFailure(hwaccel.method, `download ${downloadId}: ${String(err).slice(0, 200)}`);
          await runFfmpegToCompletion(encode(undefined));
        } else {
          throw err;
        }
      }
      mediaFilename = "media.mp4";
    }

    // Sidecar subtitles: text formats only (bitmap tracks were either rejected
    // at creation for originals or burned into the transcode above).
    for (const trackId of download.subtitleTrackIds) {
      const track = mediaFile.subtitleTracks.find((t) => t.id === trackId);
      if (!track || track.requiresBurnIn) continue;
      const muxer = SUBTITLE_MUX[track.format];
      if (!muxer) continue;
      let content: Buffer;
      if (track.path && existsSync(track.path)) {
        content = await readFile(track.path);
      } else if (track.streamIndex !== null) {
        const relIndex = await subtitleRelativeIndex(mediaFile.id, track.streamIndex);
        content = execFileSync("ffmpeg", [
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          mediaFile.path,
          "-map",
          `0:s:${relIndex}`,
          "-f",
          muxer,
          "pipe:1",
        ]);
      } else {
        continue;
      }
      const filename = `subtitle-${trackId}.${SUBTITLE_EXT[track.format]}`;
      await writeFile(path.join(tmpDir, filename), content);
      subtitles.push({ trackId, filename, format: track.format, lang: track.lang });
    }

    // Fonts any packaged ASS track needs — the offline subtitle renderer has
    // to map the same hashes JASSUB uses online.
    const needsFonts = download.subtitleTrackIds.some((id) => {
      const t = mediaFile.subtitleTracks.find((x) => x.id === id);
      return t && (t.format === "ASS" || t.format === "SSA");
    });
    if (needsFonts) {
      const fontsDir = path.join(tmpDir, "fonts");
      await mkdir(fontsDir, { recursive: true });
      for (const link of mediaFile.fonts) {
        const ext = FONT_EXT[link.font.format] ?? "ttf";
        const fontPath = resolveFontStorePath(link.font.hash, ext);
        if (!existsSync(fontPath)) continue;
        const filename = `${link.font.hash}.${ext}`;
        await copyFile(fontPath, path.join(fontsDir, filename));
        fonts.push({ hash: link.font.hash, filename: `fonts/${filename}` });
      }
    }

    const mediaStat = mediaFilename ? await stat(path.join(tmpDir, mediaFilename)) : null;
    const manifest: DownloadManifest = {
      media: mediaFilename
        ? { filename: mediaFilename, sizeBytes: mediaStat?.size ?? null }
        : null,
      subtitles,
      fonts,
    };
    await writeFile(path.join(tmpDir, "manifest.json"), JSON.stringify(manifest));

    // Finalize — if the API deleted this download while we encoded, drop the
    // artifact and leave (the row is gone, nothing to mark READY against).
    const stillThere = await db.download.findUnique({ where: { id: downloadId } });
    if (!stillThere) {
      await rm(tmpDir, { recursive: true, force: true });
      return;
    }
    await rm(finalDir, { recursive: true, force: true });
    await rename(tmpDir, finalDir);
    await db.download.update({
      where: { id: downloadId },
      data: {
        status: "READY",
        artifactPath: downloadId,
        sizeBytes: manifest.media?.sizeBytes ?? null,
        error: null,
      },
    });
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await db.download
      .update({ where: { id: downloadId }, data: { status: "FAILED", error: String(err) } })
      .catch(() => {});
    throw err; // let BullMQ retry with backoff; after 3 attempts the job dies and FAILED stays
  }
}

/**
 * Provider failures that are transient by nature — rate limits, 5xx, network
 * blips — must never count toward the poison threshold, or a degraded
 * provider (AniList has been throttling at 30/min) parks a whole library in
 * minutes. Only deterministic failures (404s, bad responses, unmatchable
 * queries) poison. The metadata sweep re-drives transient losers until the
 * provider recovers.
 */
function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.message} ${String(err.cause ?? "")}` : String(err);
  if (/\b429\b|\b5\d\d\b/.test(msg)) return true;
  return /rate\s?limit|too\s?many\s?requests|timed?\s?out|timeout|econnreset|enetunreach|eai_again|socket\s?hang\s?up|fetch\s?failed|temporarily\s?unavailable|service\s?unavailable|bad\s?gateway|gateway\s?timeout|internal\s?server\s?error|aborted|overload/i.test(
    msg,
  );
}

/**
 * ffmpeg failures that are environmental, not the file's fault — spawn/IO
 * timeouts (execFile kills the child), process deaths by signal (the OOM
 * killer SIGKILLing decodes under memory pressure), EMFILE under heavy
 * parallelism, disk or pipe errors. These must never count toward the poison
 * threshold or a briefly loaded box (or a full disk) parks a whole library in
 * minutes. Only deterministic decode/encode failures (corrupt region,
 * unsupported stream) poison. Deterministic-vs-transient is decided by
 * message, same as the metadata path above.
 *
 * Two legs: the message regex catches what survives in JobFailure.lastError
 * (which now carries a forensic "killed=true signal=SIGKILL" trailer via
 * describeFfmpegFailure), and the property checks catch the live error object
 * — node's execFile records signal deaths on `err.killed` / `err.signal` and
 * timeouts on `err.code = 'ETIMEDOUT'` with no wording in the message. That
 * message blind spot is what mis-parked healthy files during an OOM storm:
 * a SIGKILLed decode read as a deterministic file failure and poison-pilled
 * the item after three attempts.
 */
function isTransientFfmpegError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.message} ${String(err.cause ?? "")}` : String(err);
  if (/\btimed?\s?out|timeout|killed|signal|emfile|enfile|enospc|eio|eintr|epipe|econnreset|enoent|no\s?such\s?file|too\s?many\s?open\s?files|no\s?space\s?left|device\s?or\s?resource\s?busy|spawn\s?\w+\s?emfile/i.test(msg)) return true;
  const e = err as { killed?: boolean; signal?: string; code?: string };
  return e.killed === true || typeof e.signal === "string" || e.code === "ETIMEDOUT";
}

/**
 * Serializes an execFile failure with its killer metadata, so the stored
 * JobFailure.lastError can tell a signal death (OOM, shutdown) from a real
 * decode failure — and so the boot reconciler's leg-zero un-poison can match
 * the class on a plain string. The error message alone carries neither
 * "killed" nor "signal".
 */
function describeFfmpegFailure(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const e = err as { killed?: boolean; signal?: string; code?: string };
  const extras: string[] = [];
  if (e.killed) extras.push(`killed=true`);
  if (e.signal) extras.push(`signal=${e.signal}`);
  if (e.code) extras.push(`code=${e.code}`);
  return extras.length > 0 ? `${base} (${extras.join(" ")})` : base;
}

/**
 * Legacy JobFailure rows (recorded before describeFfmpegFailure's forensic
 * trailer): a signal-killed ffmpeg — OOM-killer SIGKILL in particular —
 * leaves "Command failed: ffmpeg ..." with no ffmpeg-level fatal line (the
 * child died mid-encode, stderr just stops). Genuinely broken files always
 * end with a fatal line ("Error while decoding", "Conversion failed",
 * "cannot open", ...), so its absence is the signature of an environmental
 * death — clear those poison rows and let the reconciler re-derive the
 * sheets. Worst case (a file broken in a way that prints no fatal line) it
 * re-poisons itself after three real failures — self-limiting.
 */
function isSilentFfmpegDeath(msg: string): boolean {
  return (
    /error: command failed: ffmpeg/i.test(msg) &&
    !/error while|conversion failed|cannot|invalid|no such file|does not contain|unsupported|failed to|not found|permission denied|no space left|out of memory|segmentation/i.test(msg)
  );
}

/**
 * Advances an item to the next provider in its chain. Called on a clean miss,
 * on a transient provider failure (a degraded provider must not block the
 * healthy fallback for hours while the sweep keeps re-hitting chain[0]), and
 * on a deterministic failure (retrying a query the provider definitively
 * rejected is pointless — try the next provider instead). findUnique, not
 * findUniqueOrThrow: a deleted library must not turn into a poison-counted
 * job failure.
 */
async function enqueueNextInChain(providerName: string, data: MetadataJobData): Promise<void> {
  const library = await db.library.findUnique({ where: { id: data.libraryId } });
  if (!library) return;
  const chain = buildProviderChain(data.kind, library.contentProfile, library.providerOrder);
  const idx = chain.indexOf(providerName);
  const next = idx >= 0 ? chain[idx + 1] : undefined;
  if (next) await enqueueMetadata(next, data);
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
        METADATA_PROVIDERS,
      );
      await db.jobFailure.deleteMany({ where: { mediaItemId, jobType } });
      if (!matched) await enqueueNextInChain(providerName, job.data);
    } catch (err) {
      // Transient (429 / 5xx / network blip): complete without recording a
      // failure, but still advance the chain — the fallback provider may be
      // healthy even while this one is down. The sweep keeps re-driving
      // unresolved items from chain[0], so this provider gets retried once
      // it recovers.
      if (isTransientError(err)) {
        await enqueueNextInChain(providerName, job.data);
        return;
      }
      const failure = await db.jobFailure.upsert({
        where: { mediaItemId_jobType: { mediaItemId, jobType } },
        create: { mediaItemId, jobType, attempts: 1, lastError: String(err) },
        update: { attempts: { increment: 1 }, lastError: String(err), lastFailedAt: new Date() },
      });
      if (failure.attempts >= JOB_FAILURE_THRESHOLD) {
        // Poison pill : stop retrying this provider, stay playable —
        // the item just keeps whatever confidence/metadata it already has.
        return;
      }
      // Deterministic failure below the poison threshold: don't burn BullMQ
      // retries re-running a query this provider definitively rejected —
      // advance the chain. The sweep re-drives this provider later (the
      // failure row only excludes the item once the threshold is hit).
      await enqueueNextInChain(providerName, job.data);
    }
  };
}

// One scan job per library; a single walk already parallelizes probe + leaf
// work internally. HOKAGO_SCAN_CONCURRENCY > 1 lets several libraries scan
// at once (each keeps its own pools — raise with caution on weak machines).
const scanConcurrency = Math.max(1, Number(process.env.HOKAGO_SCAN_CONCURRENCY ?? 2));
const scanWorker = new Worker<ScanJobData>(QUEUE_NAMES.SCAN, processScan, {
  connection,
  concurrency: scanConcurrency,
});
// Artwork extraction is ffmpeg/CPU-bound — cap via HOKAGO_ARTWORK_CONCURRENCY
// (default 8) so a big library scan fans out without melting the box. The
// scan walk itself is parallelized inside the scanner (probe + leaf ingestion
// pools), and this queue is what actually bounds total ffmpeg load.
const artworkConcurrency = Math.max(1, Number(process.env.HOKAGO_ARTWORK_CONCURRENCY ?? 8));
const artworkWorker = new Worker<ArtworkJobData>(QUEUE_NAMES.ARTWORK, processArtwork, {
  connection,
  concurrency: artworkConcurrency, // backpressure : bounded ffmpeg concurrency
});
// Trickplay jobs are cheap since the per-tile rewrite: one keyframe-seek
// ffmpeg spawn per tile, run sequentially inside the job. Concurrency here
// bounds parallel sheet jobs (each a short-lived ffmpeg at a time), so it can
// ride high — HOKAGO_TRICKPLAY_CONCURRENCY (default 8) keeps a wave moving
// without ever decoding a whole window.
const trickplayConcurrency = Math.max(1, Number(process.env.HOKAGO_TRICKPLAY_CONCURRENCY ?? 8));
const trickplayWorker = new Worker<TrickplayJobData>(QUEUE_NAMES.TRICKPLAY, processTrickplay, {
  connection,
  concurrency: trickplayConcurrency,
});
// Downloads are whole-file ffmpeg encodes (or copies) — one per job. Default
// 2 concurrent keeps a bulk "download the whole series" from melting the box.
const downloadConcurrency = Math.max(1, Number(process.env.HOKAGO_DOWNLOAD_CONCURRENCY ?? 2));
const downloadWorker = new Worker<DownloadJobData>(QUEUE_NAMES.DOWNLOAD, processDownload, {
  connection,
  concurrency: downloadConcurrency,
});

// Per-provider rate budgets (doc's real published limits) enforced by
// BullMQ's own limiter — reused, not hand-rolled.
const metadataWorkers: Record<string, Worker<MetadataJobData>> = {
  TVMAZE: new Worker<MetadataJobData>(QUEUE_NAMES.METADATA_TVMAZE, makeProcessMetadata("TVMAZE"), {
    connection,
    concurrency: 3,
    limiter: { max: 20, duration: 10_000 }, // TVmaze: ≥20 calls/10s per IP
  }),
  WIKIPEDIA: new Worker<MetadataJobData>(QUEUE_NAMES.METADATA_WIKIPEDIA, makeProcessMetadata("WIKIPEDIA"), {
    connection,
    concurrency: 3,
    limiter: { max: 30, duration: 60_000 }, // Wikimedia asks for polite volumes; 30/min is gentle
  }),
  ANILIST: new Worker<MetadataJobData>(QUEUE_NAMES.METADATA_ANILIST, makeProcessMetadata("ANILIST"), {
    connection,
    concurrency: 3,
    limiter: { max: 45, duration: 60_000 }, // AniList: ~90/min nominal, 45 keeps 429s rare
  }),
  MAL: new Worker<MetadataJobData>(QUEUE_NAMES.METADATA_MAL, makeProcessMetadata("MAL"), {
    connection,
    concurrency: 3,
    limiter: { max: 90, duration: 60_000 }, // Jikan: 3/s nominal, 90/min stays safely under
  }),
};

/**
 * Boot reconciler : Valkey/BullMQ state is a cache, Postgres is truth.
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

  // Trickplay leg zero: un-poison rows that the old accounting poisoned by
  // mistake. Pre-fix, every failure counted — a tail keyframe-seek past the
  // last decodable frame ("nothing was written"), a spawn timeout, an EMFILE
  // blip, or a decode SIGKILLed by the OOM killer mid-encode (which dies
  // with no fatal line — isSilentFfmpegDeath) — so healthy files with audio
  // tails/padding got parked, and a whole series parked during a memory
  // storm. Those error classes are now benign by definition (the generator
  // black-cells the tail, transient errors don't count, a killed decode gets
  // an explicit "killed=true" trailer in the row); clear them so the
  // reconciler re-derives the missing sheets instead of skipping the item
  // forever.
  const stalePoison = await db.jobFailure.findMany({
    where: { jobType: QUEUE_NAMES.TRICKPLAY, attempts: { gte: JOB_FAILURE_THRESHOLD } },
    select: { mediaItemId: true, lastError: true },
  });
  const benign = stalePoison.filter((row) => {
    const msg = row.lastError ?? "";
    return (
      isNothingWrittenError(msg) ||
      isTransientFfmpegError(msg) ||
      isSilentFfmpegDeath(msg) ||
      /hwaccel|vaapi|qsv|nvenc|cuda|device creation failed|hardware device|cannot allocate memory/i.test(msg)
    );
  });
  if (benign.length > 0) {
    await db.jobFailure.deleteMany({
      where: { jobType: QUEUE_NAMES.TRICKPLAY, mediaItemId: { in: benign.map((b) => b.mediaItemId) } },
    });
    // Poison-pilling also flipped MediaItem.state to NEEDS_ATTENTION; the
    // reconciler's needingTrickplay query only re-derives items in state OK.
    // Reset it for the items that now hold no poison rows at all (a separate
    // artwork/metadata poison would still keep it flagged).
    const unpoisonedIds = benign.map((b) => b.mediaItemId);
    const stillPoisoned = await db.jobFailure.findMany({
      where: { mediaItemId: { in: unpoisonedIds } },
      select: { mediaItemId: true },
    });
    const resetIds = unpoisonedIds.filter((id) => !stillPoisoned.some((p) => p.mediaItemId === id));
    if (resetIds.length > 0) {
      await db.mediaItem.updateMany({ where: { id: { in: resetIds } }, data: { state: "OK" } });
    }
    console.log(`reconciler: cleared ${benign.length} trickplay poison row(s) mis-accounted by the old bug — sheets will re-derive`);
  }

  // Trickplay leg one: files that never got sheets. The enqueue gate inside
  // enqueueTrickplay makes the hash comparison, so no need to repeat it here.
  const needingTrickplay = await db.mediaFile.findMany({
    where: {
      durationMs: { not: null },
      probeFailed: false,
      trickplay: null,
      mediaItem: { state: "OK", jobFailures: { none: { jobType: QUEUE_NAMES.TRICKPLAY, attempts: { gte: JOB_FAILURE_THRESHOLD } } } },
    },
  });
  for (const file of needingTrickplay) {
    await enqueueTrickplay({
      mediaItemId: file.mediaItemId,
      mediaFileId: file.id,
      filePath: file.path,
      durationMs: file.durationMs,
    });
  }

  // Trickplay leg two: the file changed (content hash differs from the hash
  // the current sheets were generated from) — stale sheets, regenerate. Also
  // regenerate when the sheets are simply gone from disk (config dir lost,
  // DB-only backup restore) even though the hash still matches — otherwise
  // every scrubber preview 404s forever with no self-heal. Poisoned items
  // stay parked (the hash gate alone would re-drive them into the same
  // deterministic failure every boot).
  const trickplayPoisoned = new Set(
    (
      await db.jobFailure.findMany({
        where: { jobType: QUEUE_NAMES.TRICKPLAY, attempts: { gte: JOB_FAILURE_THRESHOLD } },
        select: { mediaItemId: true },
      })
    ).map((r) => r.mediaItemId),
  );
  const sheetOnDisk = (stored: string): boolean => existsSync(stored) || existsSync(path.join(configDir(), stored));
  const staleTrickplay = await db.trickplay.findMany({ include: { mediaFile: true } });
  for (const row of staleTrickplay) {
    const sheetsMissing = row.sheetPaths.length > 0 && !row.sheetPaths.every(sheetOnDisk);
    if (!sheetsMissing && row.mediaFile.hash !== null && row.sourceHash === row.mediaFile.hash) continue;
    if (trickplayPoisoned.has(row.mediaFile.mediaItemId)) continue;
    await enqueueTrickplay({
      mediaItemId: row.mediaFile.mediaItemId,
      mediaFileId: row.mediaFile.id,
      filePath: row.mediaFile.path,
      durationMs: row.mediaFile.durationMs,
    });
  }

  // A MOVIE/SERIES missing an ExternalId for every provider in its own
  // chain has never been successfully resolved (or its match was lost) —
  // re-enqueue against the first provider, same as a fresh onMetadataNeeded.
  const metadataReDerived = await reconcileMetadata();

  console.log(
    `reconciler: ${libraries.length} librar${libraries.length === 1 ? "y" : "ies"} re-enqueued, ` +
      `${needingArtwork.length} artwork job(s) re-derived, ` +
      `${needingTrickplay.length + staleTrickplay.length} trickplay job(s) re-derived, ` +
      `${metadataReDerived} metadata job(s) re-derived`,
  );
}

/**
 * Metadata leg of reconcile. Two legs:
 *  - Leg 1: a MOVIE/SERIES missing an ExternalId for every provider in its
 *    own chain has never been successfully resolved (or its match was lost)
 *    — re-enqueue against the first provider, same as a fresh onMetadataNeeded.
 *    Junk folder-names (scan noise like "S1 - First Stage" — one show split
 *    into several season-folder rows — or "watch ... online" downloads) could
 *    never match anything and would churn the provider queue every sweep;
 *    they're skipped outright.
 *  - Leg 2 (SERIES only): resolved but title-less episodes. The match
 *    succeeded (a chain ExternalId is held) but enrichment never landed
 *    per-episode titles — a fetch failed mid-flight, or the primary list only
 *    covered one cour of a multi-cour show and the walk/TVmaze backfill
 *    didn't run. Re-drive the enrich path; the per-series network backoff
 *    inside enrichEpisodeTitles (series.extra.titlesLastAttemptedAt) keeps
 *    a dead source from being re-questioned every sweep.
 */
async function reconcileMetadata(): Promise<number> {
  const libraries = await db.library.findMany({ where: { enabled: true } });
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
        if (isJunkShowTitle(item.title)) continue;
        await enqueueMetadata(chain[0]!, {
          mediaItemId: item.id,
          libraryId: library.id,
          kind,
          title: item.title,
          year: item.year,
        });
        metadataReDerived += 1;
      }

      // Leg 2 — resolved series whose episodes still lack titles. Enqueing
      // the first chain provider routes through resolveMetadataStep, whose
      // fresh-cache fast path calls enrichEpisodeTitles with zero provider
      // network — the cour walk and backfill inside it do the real work.
      if (kind === "SERIES") {
        const resolvedSeries = await db.mediaItem.findMany({
          where: {
            libraryId: library.id,
            kind: "SERIES",
            state: "OK",
            externalIds: { some: { provider: { in: chain } } },
            jobFailures: { none: { jobType: { in: jobTypes }, attempts: { gte: JOB_FAILURE_THRESHOLD } } },
          },
          select: { id: true, title: true, year: true },
        });
        const candidates = resolvedSeries.filter((s) => !isJunkShowTitle(s.title));
        if (candidates.length > 0) {
          const episodes = await db.mediaItem.findMany({
            where: {
              kind: "EPISODE",
              OR: [
                { parentId: { in: candidates.map((c) => c.id) } },
                { parent: { parentId: { in: candidates.map((c) => c.id) } } },
              ],
            },
            select: { parentId: true, parent: { select: { parentId: true } }, extra: true },
          });
          const titleless = new Map<string, number>();
          for (const ep of episodes) {
            const seriesId = ep.parentId ?? ep.parent?.parentId;
            if (!seriesId) continue;
            const extra = (ep.extra ?? {}) as Record<string, unknown> | null;
            if (typeof extra?.episodeTitle === "string" && extra.episodeTitle !== "") continue;
            titleless.set(seriesId, (titleless.get(seriesId) ?? 0) + 1);
          }
          for (const item of candidates) {
            if ((titleless.get(item.id) ?? 0) === 0) continue;
            await enqueueMetadata(chain[0]!, {
              mediaItemId: item.id,
              libraryId: library.id,
              kind: "SERIES",
              title: item.title,
              year: item.year,
            });
            metadataReDerived += 1;
          }
        }
      }
    }
  }

  return metadataReDerived;
}

/**
 * Graceful shutdown : stop taking new jobs, give in-flight jobs a
 * short grace period, then reap any ffmpeg/ffprobe child still running —
 * BullMQ closing does not kill children spawned by a job's own code.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: closing workers (tracked children: ${trackedPidCount()})...`);

  await Promise.race([
    Promise.all([
      scanWorker.close(),
      artworkWorker.close(),
      trickplayWorker.close(),
      downloadWorker.close(),
      ...Object.values(metadataWorkers).map((w) => w.close()),
    ]),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);

  killTrackedChildren("SIGKILL");

  await Promise.all([
    scanQueue.close(),
    artworkQueue.close(),
    trickplayQueue.close(),
    downloadQueue.close(),
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

// Transient provider failures (429/5xx/network — makeProcessMetadata) complete
// without queue retries or poison rows, so a provider down during a scan or
// boot relies on this sweep to keep re-driving unresolved items until it
// recovers. One deterministic jobId per item keeps it from piling up.
const metadataSweepMs = Math.max(60_000, Number(process.env.HOKAGO_METADATA_SWEEP_MS ?? 30 * 60_000));
setInterval(() => {
  reconcileMetadata()
    .then((n) => {
      if (n > 0) console.log(`metadata sweep: re-enqueued ${n} job(s)`);
    })
    .catch((err) => console.error("metadata sweep failed:", err));
}, metadataSweepMs);
