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
import { generateTrickplaySheets } from "@hokago/scanner/trickplay";
import { killTrackedChildren, trackedPidCount, trackPid, untrackPid } from "@hokago/scanner/child-registry";
import { configDir, probeConfigDir } from "@hokago/scanner/artwork";
import { setArtworkHwaccel } from "@hokago/scanner/generate-art";
import { buildDownloadArgs } from "@hokago/ffmpeg/download";
import { pickVideoEncoder } from "@hokago/ffmpeg/device-profile";
import { spawnFfmpeg } from "@hokago/ffmpeg/spawn";
import { getHwaccel, hwActive, reportHwFailure, type HwaccelState } from "@hokago/ffmpeg/hwaccel";
import { AniListProvider, JikanProvider, TvMazeProvider, WikidataBridge } from "@hokago/providers";
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
 // the source of truth for "does this item still need resolving" (
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

// Backpressure : one add per file as the scan walks it, never a
// bulk dump of thousands of jobs — the artwork worker's concurrency cap below
// is what actually bounds ffmpeg load. Swallow failures here — the boot
// reconciler re-derives any artwork job that never got enqueued , so
// one bad enqueue must not fail the whole scan and lose every later directory.
async function enqueueArtwork(job: ArtworkJobData): Promise<void> {
  try {
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
    if (file?.trickplay && file.trickplay.sourceHash === file.hash) return;
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
 // Checkpointing : persist progress after every completed
    // directory so a killed scan resumes instead of restarting from zero.
    onDirectoryComplete: async (dir) => {
      await db.library.update({ where: { id: library.id }, data: { scanCursor: dir } });
    },
    onArtworkNeeded: enqueueArtwork,
    onTrickplayNeeded: enqueueTrickplay,
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
  const { mediaItemId, filePath, dir, durationMs } = job.data;
  try {
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
    const failure = await db.jobFailure.upsert({
      where: { mediaItemId_jobType: { mediaItemId, jobType: QUEUE_NAMES.ARTWORK } },
      create: { mediaItemId, jobType: QUEUE_NAMES.ARTWORK, attempts: 1, lastError: String(err) },
      update: { attempts: { increment: 1 }, lastError: String(err), lastFailedAt: new Date() },
    });
    if (failure.attempts >= JOB_FAILURE_THRESHOLD) {
 // Poison pill : stop retrying, stay playable, surface to admins.
      await db.mediaItem.update({ where: { id: mediaItemId }, data: { state: "NEEDS_ATTENTION" } });
      return; // swallow — no rethrow, so BullMQ won't keep retrying a dead job
    }
    throw err; // let BullMQ retry with backoff until the threshold is hit
  }
}

async function processTrickplay(job: Job<TrickplayJobData>): Promise<void> {
  const { mediaItemId, mediaFileId, filePath, durationMs } = job.data;
  try {
    // Re-probe rather than trust anything carried across the queue boundary
    // (re-derive, don't accumulate) — no probe result, or a file the probe
    // couldn't read, means "no sheets", not a poisoned item.
    const probe = await probeFile(filePath);
    const duration = durationMs ?? probe?.durationMs ?? null;
    const mediaFile = await db.mediaFile.findUnique({ where: { id: mediaFileId } });
    if (duration === null || !mediaFile) {
      await db.jobFailure.deleteMany({ where: { mediaItemId, jobType: QUEUE_NAMES.TRICKPLAY } });
      return;
    }

    const result = await generateTrickplaySheets(filePath, duration, mediaFileId, hwaccel);
    await db.trickplay.upsert({
      where: { mediaFileId },
      create: {
        mediaFileId,
        tileWidth: result.tileWidth,
        tileHeight: result.tileHeight,
        intervalMs: result.intervalMs,
        tilesPerSheet: result.tilesPerSheet,
        sheetPaths: result.sheetPaths,
        sourceHash: mediaFile.hash,
      },
      update: {
        tileWidth: result.tileWidth,
        tileHeight: result.tileHeight,
        intervalMs: result.intervalMs,
        tilesPerSheet: result.tilesPerSheet,
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
    const failure = await db.jobFailure.upsert({
      where: { mediaItemId_jobType: { mediaItemId, jobType: QUEUE_NAMES.TRICKPLAY } },
      create: { mediaItemId, jobType: QUEUE_NAMES.TRICKPLAY, attempts: 1, lastError: String(err) },
      update: { attempts: { increment: 1 }, lastError: String(err), lastFailedAt: new Date() },
    });
    if (failure.attempts >= JOB_FAILURE_THRESHOLD) {
      // Poison pill: stop retrying, stay playable, surface to admins.
      await db.mediaItem.update({ where: { id: mediaItemId }, data: { state: "NEEDS_ATTENTION" } });
      return; // swallow — no rethrow, so BullMQ won't keep retrying a dead job
    }
    throw err; // let BullMQ retry with backoff until the threshold is hit
  }
}

// ── Downloads ────────────────────────────────────────────────────────────────

const SUBTITLE_MUX: Record<string, string> = { ASS: "ass", SSA: "ass", SRT: "srt", VTT: "webvtt" };
const SUBTITLE_EXT: Record<string, string> = { ASS: "ass", SSA: "ass", SRT: "srt", VTT: "vtt" };
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
 // Poison pill : stop retrying this provider, stay playable —
        // the item just keeps whatever confidence/metadata it already has.
        return;
      }
      throw err; // let BullMQ retry with backoff until the threshold is hit
    }
  };
}

// One scan job per library; a single walk already parallelizes probe + leaf
// work internally. HOKAGO_SCAN_CONCURRENCY > 1 lets several libraries scan
// at once (each keeps its own pools — raise with caution on weak machines).
const scanConcurrency = Math.max(1, Number(process.env.HOKAGO_SCAN_CONCURRENCY ?? 1));
const scanWorker = new Worker<ScanJobData>(QUEUE_NAMES.SCAN, processScan, {
  connection,
  concurrency: scanConcurrency,
});
// Artwork extraction is ffmpeg/CPU-bound — cap via HOKAGO_ARTWORK_CONCURRENCY
// (default 4) so a big library scan fans out without melting the box. The
// scan walk itself is parallelized inside the scanner (probe + leaf ingestion
// pools), and this queue is what actually bounds total ffmpeg load.
const artworkConcurrency = Math.max(1, Number(process.env.HOKAGO_ARTWORK_CONCURRENCY ?? 4));
const artworkWorker = new Worker<ArtworkJobData>(QUEUE_NAMES.ARTWORK, processArtwork, {
  connection,
  concurrency: artworkConcurrency, // backpressure : bounded ffmpeg concurrency
});
// Trickplay decodes the whole file per job — the heaviest ffmpeg work in the
// system. Each job extracts one sheet at a time (sequential ffmpeg inside the
// job); HOKAGO_TRICKPLAY_CONCURRENCY (default 2) bounds concurrent decodes.
const trickplayConcurrency = Math.max(1, Number(process.env.HOKAGO_TRICKPLAY_CONCURRENCY ?? 2));
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
  // the current sheets were generated from) — stale sheets, regenerate.
  const staleTrickplay = await db.trickplay.findMany({ include: { mediaFile: true } });
  for (const row of staleTrickplay) {
    if (row.sourceHash === row.mediaFile.hash) continue;
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
      `${needingArtwork.length} artwork job(s) re-derived, ` +
      `${needingTrickplay.length + staleTrickplay.length} trickplay job(s) re-derived, ` +
      `${metadataReDerived} metadata job(s) re-derived`,
  );
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
