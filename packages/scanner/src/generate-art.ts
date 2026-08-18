import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hwDecodeArgs, type HwaccelState } from "@hokago/ffmpeg/hwaccel";
import { trackPid, untrackPid } from "./child-registry.js";

const POSTER_WIDTH = 1000;
const POSTER_HEIGHT = 1500; // 2:3
const CANDIDATE_COUNT = 5;

// Artwork extraction is decode-heavy on big files (cropdetect, candidate
// scans). Hardware decode args are process-set by the worker at boot and
// prepended to every pass; a runtime failure retires them (reportHwFailure
// mutates the shared state to "none", so hwDecodeArgs goes empty on its own).
let hwState: HwaccelState | null = null;

/** Called once at worker boot with the resolved hwaccel state (null/undefined → CPU). */
export function setArtworkHwaccel(state: HwaccelState | null): void {
  hwState = state;
}

// Global cap on live ffmpeg children in this process, whatever the job mix
// (artwork jobs × internal passes, trickplay jobs × per-job tile fan-out).
// An uncapped wave — 8 trickplay jobs × 4 tiles on a CPU-only box — stacks
// hundreds of MB per software HEVC-10bit decode and OOMs the host, and the
// SIGKILLed decodes then look like file failures. HOKAGO_FFMPEG_SPAWNS
// (default 12) bounds worst-case memory; excess spawns queue FIFO, never
// fail. CPU-bound decodes just take longer under the queue — correctness
// is untouched.
const MAX_FFMPEG_SPAWNS = Math.max(1, Number(process.env.HOKAGO_FFMPEG_SPAWNS ?? 12));
let activeFfmpegSpawns = 0;
const ffmpegSpawnWaiters: Array<() => void> = [];

async function withFfmpegSpawn<T>(fn: () => Promise<T>): Promise<T> {
  if (activeFfmpegSpawns >= MAX_FFMPEG_SPAWNS) {
    await new Promise<void>((resolve) => {
      ffmpegSpawnWaiters.push(resolve);
    });
  } else {
    activeFfmpegSpawns++;
  }
  try {
    return await fn();
  } finally {
    // Hand the freed slot straight to the next waiter (the active count
    // stays put); only decrement when nobody is waiting.
    const next = ffmpegSpawnWaiters.shift();
    if (next) next();
    else activeFfmpegSpawns--;
  }
}

/** Registers the child's PID so a worker's SIGTERM handler can reap it . */
export async function runFfmpeg(args: string[], opts?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string }> {
  return withFfmpegSpawn(() => {
    const effective = hwState ? [...hwDecodeArgs(hwState), ...args] : args;
    return new Promise((resolve, reject) => {
      const child = execFile("ffmpeg", effective, { maxBuffer: 32 * 1024 * 1024, timeout: opts?.timeoutMs }, (err, stdout, stderr) => {
        untrackPid(child.pid);
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
      trackPid(child.pid);
    });
  });
}

/** Runs a single ffmpeg pass over a short window near sampleAtSec, parses the last crop=W:H:X:Y (— black bars would otherwise skew scoring and composition). */
async function detectCrop(filePath: string, sampleAtSec: number): Promise<string | null> {
  try {
    const { stderr } = await runFfmpeg([
      "-ss",
      String(sampleAtSec),
      "-i",
      filePath,
      "-t",
      "5",
      "-vf",
      "cropdetect=round=2",
      "-f",
      "null",
      "-",
    ]);
    const matches = [...stderr.matchAll(/crop=(\d+:\d+:\d+:\d+)/g)];
    return matches.length > 0 ? (matches.at(-1)![1] ?? null) : null;
  } catch {
    return null;
  }
}

async function extractCandidateFrame(
  filePath: string,
  atSec: number,
  cropFilter: string | null,
  outPath: string,
): Promise<boolean> {
  // JPEG is full-range-only; hw-decoded nv12 frames are limited-range and
  // mjpeg rejects them — append format=yuvj420p so a hardware decode can't
  // hang the candidate-frame extraction (and trip reportHwFailure).
  const vf = cropFilter ? `crop=${cropFilter},thumbnail=50,format=yuvj420p` : "thumbnail=50,format=yuvj420p";
  try {
    await runFfmpeg(["-y", "-ss", String(atSec), "-i", filePath, "-vf", vf, "-frames:v", "1", outPath]);
    return true;
  } catch {
    return false;
  }
}

interface FrameScore {
  yavg: number;
  yrange: number;
  satavg: number;
  rejected: boolean;
  score: number;
}

/** Classical scoring : reject near-black/near-white and low-variance frames, then score by colorfulness + contrast. No ML. */
async function scoreFrame(imgPath: string): Promise<FrameScore> {
  const { stdout } = await runFfmpeg(["-i", imgPath, "-vf", "signalstats,metadata=print:file=-", "-f", "null", "-"]);

  const grab = (key: string): number => {
    const m = new RegExp(`lavfi\\.signalstats\\.${key}=([0-9.]+)`).exec(stdout);
    return m ? Number.parseFloat(m[1]!) : 0;
  };

  const ymin = grab("YMIN");
  const ymax = grab("YMAX");
  const yavg = grab("YAVG");
  const satavg = grab("SATAVG");
  const yrange = ymax - ymin;

  const rejected = yavg < 20 || yavg > 235 || yrange < 20;
  const score = satavg + yrange * 0.5;

  return { yavg, yrange, satavg, rejected, score };
}

export interface SelectedFrame {
  path: string;
  atSec: number;
}

/**
 * Picks a real frame from the film for backdrop/still use . This is
 * the artwork kind that genuinely generates well — a frame from the movie
 * *is* a usable 16:9 image of the movie.
 */
export async function selectBestFrame(filePath: string, durationMs: number): Promise<SelectedFrame | null> {
  const durationSec = durationMs / 1000;
  const windowStart = durationSec * 0.05;
  const windowEnd = durationSec * 0.85;
  if (windowEnd <= windowStart) return null;

  const workDir = await mkdtemp(path.join(tmpdir(), "hokago-frame-"));
  try {
    const cropFilter = await detectCrop(filePath, windowStart + (windowEnd - windowStart) / 2);

    const timestamps = Array.from(
      { length: CANDIDATE_COUNT },
      (_, i) => windowStart + ((windowEnd - windowStart) * (i + 0.5)) / CANDIDATE_COUNT,
    );

    const candidates: { atSec: number; path: string; score: FrameScore }[] = [];
    for (const [i, atSec] of timestamps.entries()) {
      const outPath = path.join(workDir, `candidate-${i}.jpg`);
      const ok = await extractCandidateFrame(filePath, atSec, cropFilter, outPath);
      if (!ok) continue;
      const score = await scoreFrame(outPath);
      candidates.push({ atSec, path: outPath, score });
    }

    if (candidates.length === 0) return null;

    const usable = candidates.filter((c) => !c.score.rejected);
 // "cannot fail" — if every candidate got rejected, fall back to the
    // middle-most one rather than shipping no artwork at all.
    const pool = usable.length > 0 ? usable : candidates;
    const best = pool.reduce((a, b) => (b.score.score > a.score.score ? b : a));

    const stablePath = path.join(tmpdir(), `hokago-frame-${randomUUID()}.jpg`);
    await runFfmpeg(["-y", "-i", best.path, stablePath]);
    return { path: stablePath, atSec: best.atSec };
  } catch {
    return null;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Composes a 2:3 poster from a 16:9 (or arbitrary) source frame via
 * blur-extend (default): a blurred, darkened crop of the same frame
 * fills the background, the frame itself is centered on top at full width.
 * No text/gradient — baked-in title typography was explicitly dropped for
 * now (no drawtext filter in this ffmpeg build).
 */
export async function composePoster(sourceImagePath: string): Promise<Buffer> {
  const outPath = path.join(tmpdir(), `hokago-poster-${randomUUID()}.jpg`);
  const filterComplex =
    `[0:v]scale=${POSTER_WIDTH}:${POSTER_HEIGHT}:force_original_aspect_ratio=increase,` +
    `crop=${POSTER_WIDTH}:${POSTER_HEIGHT},boxblur=20:20,eq=brightness=-0.15[bg];` +
    `[0:v]scale=${POSTER_WIDTH}:-1[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2[out]`;

  try {
    await runFfmpeg([
      "-y",
      "-i",
      sourceImagePath,
      "-filter_complex",
      filterComplex,
      "-map",
      "[out]",
      "-frames:v",
      "1",
      outPath,
    ]);
    return await readFile(outPath);
  } finally {
    await rm(outPath, { force: true }).catch(() => {});
  }
}
