import { execFileSync, execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import path from "node:path";
import { z } from "zod";

import { PrismaClient } from "@hokago/db";
import { decidePlaybackMethod, type PlaybackMethod } from "@hokago/ffmpeg/decision";
import {
  type DeviceProfile,
  type PlaybackCandidateInput,
  normalizeContainer,
  pickVideoEncoder,
  pickAudioEncoder,
  needsToneMap,
  HLS_SEGMENT_SECONDS,
} from "@hokago/ffmpeg/device-profile";
import { buildM3u8, buildTruncatedM3u8, buildFfmpegArgs } from "@hokago/ffmpeg/hls";
import { buildRemuxArgs, buildResumeInput, patchRemuxMehd } from "@hokago/ffmpeg/remux";
import { spawnFfmpeg, type RunningTranscode } from "@hokago/ffmpeg/spawn";
import { getHwaccel, reportHwFailure, type HwaccelState } from "@hokago/ffmpeg/hwaccel";
import { broadcastPresence } from "./presence.js";
import { acquireTranscodeSlot, releaseTranscodeSlot } from "./transcode-slot.js";
import { configDir } from "./config.js";
import {
  StartPlaybackBody,
  StartPlaybackResponse,
  PlaybackSessionParams,
  SeekBody,
  SeekResponse,
  AudioTrackSwitchBody,
  AudioTrackSwitchResponse,
  QualitySwitchBody,
  QualitySwitchResponse,
  ErrorResponse,
} from "@hokago/contract/playback";
import type { ZodFastifyInstance } from "./fastify-zod.js";

function transcodeDir(sessionId: string): string {
  return path.join(configDir(), "transcode", sessionId);
}

interface LiveSession {
  transcode: RunningTranscode;
  outDir: string;
  mediaFile: { path: string; durationMs: number; bitrateKbps: number | null; videoCodec: string | null };
  method: "DIRECT_STREAM" | "REMUX" | "TRANSCODE";
  deviceProfile: DeviceProfile;
  currentSegmentFrom: number;
  /** Media sequence the current playlist.m3u8 was written with — seeks below this need a playlist rewrite. */
  playlistStartSegment: number;
  currentTranscodeJobId: string;
  /** Set while a restart is replacing this session's child — the old child's
   *  exit callback must not truncate the playlist the restart is about to
   *  write (the pid guard alone can't tell a killed-for-restart child apart
   *  from a legitimately terminated one: the map entry is stale until the
   *  restart completes). */
  restarting?: boolean;
  toneMap: boolean;
  subtitleBurnIn?: { streamIndex: number; bitmap: boolean };
  audioStreamIndex: number;
  /** Codec of the selected audio stream — drives REMUX copy-vs-encode. */
  audioCodec: string | null;
  /** REMUX only: the live fragmented-MP4 output + where its timeline starts. */
  remux: { outFile: string; startMs: number; patched: boolean } | null;
  /**
   * Hardware acceleration state this session's transcode was (or is) running
   * with. Undefined = CPU. The object is the process-cached one — a runtime
   * failure mutates it to "none", so every later arg build (seeks, quality
   * switches) automatically stays on CPU without extra bookkeeping.
   */
  hwaccel?: HwaccelState;
}

// Each audio selection gets its own segment subdirectory — switching tracks
// mid-stream must never reuse (and silently overwrite with different audio
// content) segment files a player may still rewind into.
function audioOutDir(sessionId: string, audioStreamIndex: number): string {
  return path.join(transcodeDir(sessionId), `a${audioStreamIndex}`);
}

// Quality switches get their own subdirectory for the same reason as audio
// tracks: a player rewinding into the old resolution's segments must not
// get the new encode's content under the old segment numbers.
function qualityOutDir(sessionId: string, maxWidth: number, maxHeight: number): string {
  return path.join(transcodeDir(sessionId), `q${maxWidth}x${maxHeight}`);
}

// PGS/VOBSUB/DVBSUB are bitmap subtitle formats — burned in via ffmpeg's
// `overlay` filter (decodes the bitmap and composites it). Everything else is
// text, burned in via libass's `subtitles` filter.
const BITMAP_SUBTITLE_FORMATS = new Set(["PGS", "VOBSUB", "DVBSUB"]);

// ffmpeg's `0:a:N` addresses the Nth AUDIO-type stream, not the absolute
// container stream index MediaStream.streamIndex stores — same conversion
// subtitleBurnIn already does for `si=N` above.
function relativeAudioIndex(streams: { type: string; streamIndex: number }[], absoluteIndex: number): number {
  return streams.filter((s) => s.type === "AUDIO" && s.streamIndex < absoluteIndex).length;
}

/**
 * Transcoding without caps encodes at full source resolution and default
 * bitrate — a 4K source pins every core for minutes. Defaults keep any
 * client, even one that sends an empty profile, at a sane 1080p / 8 Mbps
 * ceiling (ffmpeg's scale filter and -maxrate only ever cap, never upscale).
 */
function normalizeDeviceProfile(p: DeviceProfile): DeviceProfile {
  // Clamp, not just default: negative caps flow straight into ffmpeg's
  // scale/-maxrate args and kill the encode (or, with -1 auto-resolution,
  // silently blow past the ceiling). Bounds are generous — the caps only
  // ever *cap* output, and every real client sits well inside them.
  const clamp = (v: number | undefined, lo: number, hi: number, dflt: number): number =>
    Math.min(hi, Math.max(lo, v ?? dflt));
  return {
    ...p,
    maxWidth: clamp(p.maxWidth, 64, 7680, 1920),
    maxHeight: clamp(p.maxHeight, 64, 4320, 1080),
    maxVideoBitrateKbps: clamp(p.maxVideoBitrateKbps, 200, 100_000, 8000),
  };
}

const db = new PrismaClient();
const liveSessions = new Map<string, LiveSession>();

async function buildCandidateInput(
  mediaFileId: string,
  subtitleTrackId?: string,
  audioStreamIndex?: number,
): Promise<{
  input: PlaybackCandidateInput;
  path: string;
  durationMs: number;
  bitrateKbps: number | null;
  subtitleBurnIn?: { streamIndex: number; bitmap: boolean };
  relativeAudioIndex: number;
} | null> {
  const mediaFile = await db.mediaFile.findUnique({
    where: { id: mediaFileId },
    include: { streams: true, subtitleTracks: true },
  });
  if (!mediaFile) return null;

  const videoStream = mediaFile.streams.find((s) => s.type === "VIDEO");
  // The selected audio stream's codec drives the DIRECT_PLAY/DIRECT_STREAM/
  // TRANSCODE decision — picking a non-default track with an
  // incompatible codec must be able to force a remux/transcode same as the
  // default track would.
  const audioStream =
    (audioStreamIndex !== undefined
      ? mediaFile.streams.find((s) => s.type === "AUDIO" && s.streamIndex === audioStreamIndex)
      : undefined) ??
    mediaFile.streams.find((s) => s.type === "AUDIO" && s.isDefault) ??
    mediaFile.streams.find((s) => s.type === "AUDIO");
  const subtitleTrack = subtitleTrackId
    ? mediaFile.subtitleTracks.find((t) => t.id === subtitleTrackId)
    : undefined;

  // External sidecar tracks have no embedded stream index to reference from
  // an ffmpeg filtergraph — burn-in wiring below only covers embedded tracks.
  //
  // ffmpeg's `0:s:N` / subtitles filter `si=N` both address the Nth stream of
  // that TYPE, not the absolute container stream index SubtitleTrack.streamIndex
  // stores (same convention MediaStream.streamIndex uses) — has to be converted
  // by counting subtitle-type streams that precede it.
  const subtitleBurnIn =
    subtitleTrack?.requiresBurnIn && subtitleTrack.streamIndex !== null
      ? {
          streamIndex: mediaFile.streams.filter(
            (s) => s.type === "SUBTITLE" && s.streamIndex < subtitleTrack.streamIndex!,
          ).length,
          bitmap: BITMAP_SUBTITLE_FORMATS.has(subtitleTrack.format),
        }
      : undefined;

  return {
    input: {
      container: normalizeContainer(mediaFile.container ?? ""),
      videoCodec: videoStream?.codec ?? null,
      audioCodec: audioStream?.codec ?? null,
      width: videoStream?.width ?? null,
      height: videoStream?.height ?? null,
      bitrateKbps: mediaFile.bitrate ? Math.round(mediaFile.bitrate / 1000) : null,
      isHdr: videoStream?.hdrMeta !== null && videoStream?.hdrMeta !== undefined,
      subtitleRequiresBurnIn: subtitleTrack?.requiresBurnIn ?? false,
    },
    path: mediaFile.path,
    durationMs: mediaFile.durationMs ?? 0,
    bitrateKbps: mediaFile.bitrate ? Math.round(mediaFile.bitrate / 1000) : null,
    subtitleBurnIn,
    relativeAudioIndex: audioStream ? relativeAudioIndex(mediaFile.streams, audioStream.streamIndex) : 0,
  };
}

/** How far into the media timeline the live remux has already written (ms). */
function remuxCoveredMs(live: LiveSession): number {
  const remux = live.remux;
  const bitrate = live.mediaFile.bitrateKbps;
  if (!remux || !bitrate) return 0;
  let size = 0;
  try {
    size = statSync(remux.outFile).size;
  } catch {
    // not created yet
  }
  return remux.startMs + (size * 8) / bitrate;
}

/**
 * Rough wall-clock seconds until the remux child finishes writing the file,
 * from source bitrate vs. measured copy throughput (~60MB/s). Drives the
 * stream route's serve-after-complete wait — a movie gets a proportionally
 * longer wait, not a fixed timeout.
 */
function estRemuxRemainingSec(live: LiveSession): number {
  const remux = live.remux;
  if (!remux) return 0;
  const bitrateKbps = live.mediaFile.bitrateKbps ?? 8000;
  const remainingMs = Math.max(0, live.mediaFile.durationMs - remux.startMs);
  const bytes = (remainingMs / 1000) * bitrateKbps * 125;
  return bytes / 60_000_000;
}

/** Segment index for a wall-clock position, clamped inside the media's range. */
function segmentFor(positionMs: number, durationMs: number): number {
  const total = Math.max(1, Math.floor(durationMs / 1000 / HLS_SEGMENT_SECONDS));
  return Math.min(Math.max(0, Math.floor(positionMs / 1000 / HLS_SEGMENT_SECONDS)), total - 1);
}

/** Resume position from PlaybackState — only when genuinely mid-way (not finished, not just-started). */
async function resumePositionMs(profileId: string, mediaItemId: string, durationMs: number): Promise<number> {
  const state = await db.playbackState.findUnique({
    where: { profileId_mediaItemId: { profileId, mediaItemId } },
  });
  if (!state || state.watched || durationMs <= 0) return 0;
  // A stored duration that disagrees with the actual file is garbage from a
  // stream-relative report (older heartbeats sent the *remaining* time, so
  // resumed sessions persisted hours-in positions). Treat the row as fresh
  // and heal it — resume must never land mid-file on a phantom position.
  if (state.durationMs != null && Math.abs(state.durationMs - durationMs) > 60_000) {
    await db.playbackState.update({
      where: { profileId_mediaItemId: { profileId, mediaItemId } },
      data: { positionMs: 0, durationMs },
    });
    return 0;
  }
  if (state.positionMs < 30_000) return 0;
  return Math.min(state.positionMs, Math.max(0, durationMs - 30_000));
}

/**
 * The keyframe ffmpeg's fast input seek (`-ss`) lands on for a target: the
 * last keyframe at-or-before it. REMUX-only now: copy mode can only begin at
 * a keyframe packet, and the mp4 muxer normalizes the output timeline to 0,
 * so REMUX streams start at exactly this keyframe's media time and the
 * reported startMs equals the browser's actual timeline origin. TRANSCODE no
 * longer probes: it uses an accurate seek (`-ss` after `-i`) whose origin is
 * the exact requested timestamp by construction, so its startMs is the raw
 * resume/target — no keyframe round-trip, no container-seek-table ambiguity
 * (sparse indexes can land at a different keyframe than the bitstream probe
 * reports, which is what drifted sub/clock sync chronically). Bounded read
 * keeps the scan to the resume position. Async: an ffprobe of a long file can
 * take seconds, and a synchronous spawn would freeze the whole API.
 */
async function keyframeAtOrBeforeMs(path: string, positionMs: number): Promise<number> {
  if (positionMs <= 0) return 0;
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-skip_frame",
          "nokey",
          "-show_entries",
          "frame=pts_time",
          "-of",
          "csv=p=0",
          "-read_intervals",
          `%${positionMs / 1000}`,
          path,
        ],
        { maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });
    let last = 0;
    for (const line of out.trim().split("\n")) {
      const t = Number(line);
      if (!Number.isNaN(t) && t > last) last = t;
    }
    return Math.round(last * 1000);
  } catch {
    // Probe failure — fall back to the requested position (current behavior).
    return positionMs;
  }
}

/**
 * Playlist replacement must be atomic — the playlist route reads the file
 * concurrently, and a torn in-place write would break hls.js parsing.
 * rename() within the same directory is atomic on POSIX.
 */
async function writePlaylistAtomically(outDir: string, body: string): Promise<void> {
  const file = path.join(outDir, "playlist.m3u8");
  const tmp = `${file}.tmp`;
  await writeFile(tmp, body);
  await rename(tmp, file).catch(async (err) => {
    // Keep the tmp file from masking future writes on rename failure.
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  });
}

async function killSessionTranscode(sessionId: string): Promise<void> {
  const live = liveSessions.get(sessionId);
  if (!live) return;
  liveSessions.delete(sessionId);
  if (live.transcode.child.exitCode === null && live.transcode.child.signalCode === null) {
    live.transcode.child.kill("SIGKILL");
  }
  // NB: the transcode slot is released by the child's exit callback
  // (spawnFfmpeg), never here — SIGKILLing a live child fires it, and an
  // already-dead child's callback already ran. An explicit release here
  // would double-release when waiters are queued, bypassing the cap.
  await db.transcodeJob.update({
    where: { id: live.currentTranscodeJobId },
    data: { state: "CANCELLED", endedAt: new Date() },
  });
}

/**
 * Ends a playback session: kills its ffmpeg child (if any), frees its
 * transcode slot, marks the PlaybackSession ended — and deletes the session's
 * transcode files (a 24-minute 8 Mbps episode is ~1.4 GB of segments). Called
 * by the /stop route, the idle reaper, and shutdown — without this, every
 * watched title leaves its full transcode on disk forever.
 */
export async function stopSession(sessionId: string): Promise<void> {
  await killSessionTranscode(sessionId);
  await db.playbackSession.updateMany({
    where: { id: sessionId, endedAt: null },
    data: { endedAt: new Date() },
  });
  await rm(transcodeDir(sessionId), { recursive: true, force: true });
}

/** Marks a session dead *without* killing anything the caller is about to replace. */
async function cancelCurrentJob(sessionId: string): Promise<void> {
  const live = liveSessions.get(sessionId);
  if (!live) return;
  await db.transcodeJob.update({
    where: { id: live.currentTranscodeJobId },
    data: { state: "CANCELLED", endedAt: new Date() },
  });
}

/**
 * Records a job's terminal state — unless a cancel path already marked it
 * CANCELLED. The exit callback races the cancel (the SIGKILL fires the
 * callback after cancelCurrentJob wrote CANCELLED) and would otherwise
 * clobber the deliberate CANCELLED with a spurious FAILED.
 */
async function setTranscodeJobTerminal(
  jobId: string,
  state: "DONE" | "FAILED",
  lastError: string | null,
): Promise<void> {
  await db.transcodeJob.updateMany({
    where: { id: jobId, state: { not: "CANCELLED" } },
    data: { state, endedAt: new Date(), lastError },
  });
}

/**
 * Rewrites a session's HLS playlist to only the segments that actually exist
 * on disk, once its ffmpeg child has exited. The up-front VOD playlist
 * advertises the whole future; if the encoder died mid-file, the unwritten
 * tail would have clients retry segment-N forever and stall at the last
 * surviving segment's boundary. (A natural full-file completion writes every
 * segment, so this is a no-op shape-wise then.) Guarded: only when the
 * exited pid is still this session's live child — a restart's old child
 * exiting after its successor started must not clobber the new playlist.
 */
/** Highest segment index a session's outDir has on disk (mirrors what the
 *  segment muxer promises: segment-N.ts files). -1 when nothing was written. */
async function lastWrittenSegment(outDir: string): Promise<number> {
  let last = -1;
  try {
    for (const entry of await readdir(outDir)) {
      const m = /^segment-(\d+)\.ts$/.exec(entry);
      if (m) last = Math.max(last, Number(m[1]));
    }
  } catch {
    return -1; // dir already cleaned (stopSession) — nothing to enumerate
  }
  return last;
}

async function truncatePlaylistOnExit(
  sessionId: string,
  pid: number,
  outDir: string,
  durationMs: number,
  startSegment: number,
): Promise<void> {
  const live = liveSessions.get(sessionId);
  if (!live || live.method === "REMUX" || live.restarting || live.transcode.pid !== pid) return;
  const lastSegment = await lastWrittenSegment(outDir);
  // lastSegment -1 → buildTruncatedM3u8 emits an empty playlist (ENDLIST
  // only) so the player errors out loudly instead of wedging on missing
  // segments — the hw fallback below rewrites the full promise before the
  // client ever refetches, so this only bites a genuinely dead session.
  const body = buildTruncatedM3u8(durationMs, HLS_SEGMENT_SECONDS, startSegment, lastSegment);
  await writePlaylistAtomically(outDir, body).catch(() => {});
}

/**
 * Immich-style fail-soft: when a transcode that was running with hardware
 * acceleration dies non-zero, disable hw for the process and respawn the
 * session's encoder on CPU, continuing from the last written segment — the
 * client's already-fetched VOD playlist keeps promising the same segment
 * numbers, so playback resumes seamlessly (no client involvement, no reload).
 * Fires only for genuine failures (exit code ≠ 0 — kills are signalled and
 * skipped), only once per session (the shared hw state is now "none", and
 * the session entry's hwaccel is cleared), and only for TRANSCODE (REMUX
 * never touches the GPU). Nothing written yet resumes at segment 0.
 */
async function attemptHwFallback(sessionId: string, outDir: string): Promise<void> {
  const live = liveSessions.get(sessionId);
  if (!live || live.restarting || live.method !== "TRANSCODE" || !live.hwaccel || live.hwaccel.method === "none") return;
  reportHwFailure(live.hwaccel.method, `transcode for session ${sessionId} exited non-zero`);

  const lastSegment = await lastWrittenSegment(outDir);
  const targetMs = (lastSegment + 1) * HLS_SEGMENT_SECONDS * 1000;
  let restarted: Awaited<ReturnType<typeof restartTranscode>>;
  try {
    restarted = await restartTranscode(sessionId, live, targetMs);
  } catch (e) {
    // The session is left truncated at the last written segment (the
    // playlist rewrite below never ran) — the client stops at the surviving
    // boundary and can reload. Never let a respawn hiccup take the API down.
    console.warn(`hwaccel: CPU fallback restart for session ${sessionId} failed: ${String(e).slice(0, 300)}`);
    return;
  }
  if ("cancelled" in restarted) return;
  const { transcode, jobId, startMs, segmentFrom } = restarted;

  // Undo the truncate that just ran: the respawned encoder continues the
  // original full-VOD promise from the new anchor segment.
  const playlist = buildM3u8(live.mediaFile.durationMs, HLS_SEGMENT_SECONDS, segmentFrom);
  await writePlaylistAtomically(outDir, playlist).catch(() => {});

  liveSessions.set(sessionId, {
    ...live,
    transcode,
    currentSegmentFrom: segmentFrom,
    playlistStartSegment: segmentFrom,
    currentTranscodeJobId: jobId,
    hwaccel: undefined,
  });
  console.warn(`hwaccel: session ${sessionId} fell back to CPU transcode from segment ${segmentFrom} (startMs ${startMs})`);
}

/**
 * Spawns a session's first ffmpeg child and records its TranscodeJob. The
 * caller already holds the transcode slot (released here when the child
 * exits) and is responsible for the outDir, HLS playlist, and liveSessions
 * entry. Shared by /start and the quality route's DIRECT_PLAY→TRANSCODE
 * fallback, so both legs record jobs the same way.
 */
async function spawnTranscodeJob(
  sessionId: string,
  mediaFileId: string,
  method: "REMUX" | "TRANSCODE",
  profile: DeviceProfile,
  args: string[],
  segmentFrom: number,
  outDir: string,
  durationMs: number,
  input?: Readable,
  hwaccel?: HwaccelState,
): Promise<{ transcode: RunningTranscode; jobId: string }> {
  const job = await db.transcodeJob.create({
    data: {
      sessionId,
      mediaFileId,
      method,
      deviceProfile: profile as object,
      state: "RUNNING",
      segmentFrom,
      startedAt: new Date(),
    },
  });

  const transcode = spawnFfmpeg(args, (result) => {
    // The slot guards live ffmpeg *processes* — release it the moment the
    // child exits (finished a whole file, died, or was killed). Without
    // this, every finished transcode pins a slot forever and later
    // sessions queue behind ghosts until /stop or the 5-minute reaper.
    releaseTranscodeSlot();
    void setTranscodeJobTerminal(job.id, result.code === 0 ? "DONE" : "FAILED", result.code === 0 ? null : result.stderr.slice(0, 2000))
      .catch((e) => console.warn(`failed to persist transcode job ${job.id} terminal state: ${e.message}`));
    void (async () => {
      // This runs off the request stack — a throw here is an unhandled
      // rejection, which by default takes the whole API process down (the
      // "crashed the server" report: a db blip while respawning hw→CPU
      // after a failed transcode). Everything below is best-effort recovery;
      // log and keep serving.
      try {
        await truncatePlaylistOnExit(sessionId, transcode.pid, outDir, durationMs, segmentFrom);
        // A real (non-signalled) hw-transcode failure gets one CPU retry —
        // after this the session either runs software or dies for real.
        if (result.code !== 0 && hwaccel) await attemptHwFallback(sessionId, outDir);
      } catch (e) {
        console.warn(`session ${sessionId}: post-exit fallback failed: ${String(e).slice(0, 300)}`);
      }
    })();
  }, input);
  await db.transcodeJob.update({ where: { id: job.id }, data: { pid: transcode.pid } });
  return { transcode, jobId: job.id };
}

async function restartTranscode(
  sessionId: string,
  live: LiveSession,
  targetMs: number,
  overrides?: { profile?: DeviceProfile; method?: "REMUX" | "TRANSCODE" },
): Promise<
    { transcode: RunningTranscode; jobId: string; startMs: number; segmentFrom: number } | { cancelled: true }
  > {
  // Mark the session as restarting *before* the kill: the old child's exit
  // callback runs during the kill-await below, while the map still holds the
  // old entry — without the flag its truncatePlaylistOnExit would rewrite the
  // playlist the caller is about to replace (pid guard can't tell it apart).
  const current = liveSessions.get(sessionId);
  if (current) liveSessions.set(sessionId, { ...current, restarting: true });

  // The ffmpeg child may have already finished on its own (e.g. it reached
  // the end of the file) before this restart arrived — `exit` only ever fires
  // once, so attaching a listener after the fact would hang forever.
  if (live.transcode.child.exitCode === null && live.transcode.child.signalCode === null) {
    await new Promise<void>((resolve) => {
      live.transcode.child.once("exit", () => resolve());
      live.transcode.child.kill("SIGKILL");
    });
  }
  // The dead child's exit callback already released its slot (see start
  // route) — take a fresh one for the replacement process. The kill above
  // resolves on 'exit', so the release has deterministically run by now.
  if (!(await acquireTranscodeSlot())) {
    // Restore the entry without the flag so future natural exits truncate.
    if (liveSessions.has(sessionId)) liveSessions.set(sessionId, live);
    return { cancelled: true };
  }
  // Torn down (stop/reap) while the old child was being killed — don't
  // orphan a fresh ffmpeg for a dead session.
  if (!liveSessions.has(sessionId)) {
    releaseTranscodeSlot();
    return { cancelled: true };
  }
  // The slot is released by the new child's exit callback — until one is
  // spawned, any failure below must release it or the slot leaks forever
  // (a phantom: the wakeup logic in spawnTeardown can't recover what never
  // had a process).
  try {
    const profile = overrides?.profile ?? live.deviceProfile;
    // The live entry's *method* is the source of truth; the quality route
    // forces method via overrides (REMUX→TRANSCODE→REMUX round trips leave
    // live.remux null from the TRANSCODE leg — consulting it here would
    // silently start a transcode and report REMUX).
    const isRemux = (overrides?.method ?? live.method) === "REMUX";
    // The stream origin must equal the client's reported offset exactly, or
    // sub/clock sync drifts. REMUX fast-seeks and can only start at the probed
    // keyframe; TRANSCODE accurate-seeks, so its origin is the raw target.
    const startMs = isRemux ? await keyframeAtOrBeforeMs(live.mediaFile.path, targetMs) : targetMs;
    const segmentFrom = Math.floor(startMs / 1000 / HLS_SEGMENT_SECONDS);
    // Resume via a piped stub (header + tail from the exact keyframe cluster):
    // the container seek table lies (Cue → different keyframe than the bitstream
    // probe), so -ss on mkv would start at a different media time than startMs
    // and subs drift. Falls back to the legacy -ss remux when probing fails.
    const resumeInput = isRemux ? await buildResumeInput(live.mediaFile.path, startMs) : null;
    const args = isRemux
      ? buildRemuxArgs({
          inputPath: live.mediaFile.path,
          // Derive from outDir, not live.remux.outFile: the audio-track route
          // restarts into a fresh per-track outDir (spread sets live.outDir,
          // leaving remux.outFile pointing at the previous track's dir), and
          // writing the new stream there means it lands on the disk the stream
          // route then serves. Seek-restarts keep outDir unchanged, so this is
          // the same file either way.
          outputPath: path.join(live.outDir, "stream.mp4"),
          startMs,
          durationMs: live.mediaFile.durationMs,
          audioStreamIndex: live.audioStreamIndex,
          audioCodec: live.audioCodec,
          videoCodec: live.mediaFile.videoCodec,
          pipedInput: resumeInput !== null,
        })
      : buildFfmpegArgs({
          inputPath: live.mediaFile.path,
          outputDir: live.outDir,
          startSegment: segmentFrom,
          segmentSeconds: HLS_SEGMENT_SECONDS,
          // -ss targets the stream origin exactly — the reported startMs — so
          // the browser timeline origin matches the client offset.
          seekMs: startMs,
          // live.hwaccel is the process-cached state: mutated to "none" by a
          // prior runtime failure, so seek restarts stay on CPU automatically.
          hwaccel: live.hwaccel,
          videoCodec: pickVideoEncoder(profile.supportedVideoCodecs, live.hwaccel),
          audioCodec: pickAudioEncoder(profile.supportedAudioCodecs),
          audioStreamIndex: live.audioStreamIndex,
          maxWidth: profile.maxWidth,
          maxHeight: profile.maxHeight,
          maxVideoBitrateKbps: profile.maxVideoBitrateKbps,
          toneMap: live.toneMap,
          subtitleBurnIn: live.subtitleBurnIn,
        });
  
    const job = await db.transcodeJob.create({
      data: {
        sessionId,
        mediaFileId: (await db.playbackSession.findUniqueOrThrow({ where: { id: sessionId } })).mediaFileId,
        method: isRemux ? "REMUX" : "TRANSCODE",
        deviceProfile: profile as object,
        state: "RUNNING",
        segmentFrom,
        startedAt: new Date(),
      },
    });
  
    const transcode = spawnFfmpeg(args, (result) => {
      releaseTranscodeSlot();
      // Never overwrite a deliberate CANCELLED (stop/restart already marked
      // it) — the exit callback races the cancel path and would otherwise
      // clobber the real reason with a spurious FAILED. A freshly killed
      // child's SIGKILL (signalCode, exitCode null) stays DONE-eligible via
      // the code===0 check below; that's intentional — killed-for-restart is
      // not a failure.
      void setTranscodeJobTerminal(
        job.id,
        result.code === 0 ? "DONE" : "FAILED",
        result.code === 0 ? null : result.stderr.slice(0, 2000),
      ).catch((e) => console.warn(`failed to persist transcode job ${job.id} terminal state: ${e.message}`));
      // Truthful playlist for the *session's current* outDir — the caller's
      // spread object (fresh per-track/per-quality dir) is what's live.
      // Same unhandled-rejection guard as spawnTranscodeJob: this callback
      // runs off the request stack, a throw would kill the API process.
      void (async () => {
        try {
          await truncatePlaylistOnExit(sessionId, transcode.pid, live.outDir, live.mediaFile.durationMs, segmentFrom);
          if (result.code !== 0 && live.hwaccel) await attemptHwFallback(sessionId, live.outDir);
        } catch (e) {
          console.warn(`session ${sessionId}: post-exit fallback failed: ${String(e).slice(0, 300)}`);
        }
      })();
    }, resumeInput?.input);
    await db.transcodeJob.update({ where: { id: job.id }, data: { pid: transcode.pid } });
  
    return { transcode, jobId: job.id, startMs, segmentFrom };
  } catch (e) {
    releaseTranscodeSlot();
    throw e;
  }
}

/**
 * — three-tier playback decision, on-demand HLS, seek-restart, auto-resume.
 * apps/api owns the live ffmpeg process directly (separate container/PID
 * namespace from apps/worker). Transcode concurrency is capped via the
 * transcode slot — a new session queues behind it instead of spawning ffmpeg
 * unboundedly.
 */
export async function registerPlaybackRoutes(app: ZodFastifyInstance): Promise<void> {
  app.post(
    "/playback/start",
    {
      preHandler: app.authenticate,
      schema: {
        body: StartPlaybackBody,
        response: { 200: StartPlaybackResponse, 404: ErrorResponse, 503: ErrorResponse },
      },
    },
    async (req, reply) => {
    const { profileId, mediaItemId, mediaFileId, deviceProfile, subtitleTrackId, audioStreamIndex } = req.body;
    const candidate = await buildCandidateInput(mediaFileId, subtitleTrackId, audioStreamIndex);
    if (!candidate) return reply.code(404).send({ error: "media file not found" });

    // Decide on the *raw* profile: what matters for can-it-play is the client's
    // codec/container support, not encode caps. normalizeDeviceProfile fills a
    // 1080p ceiling for encode args — deciding on that would block 4K files
    // from DIRECT_PLAY/REMUX even though browsers decode 4K h264/hevc
    // natively. The raw profile is also what the DB row stores, so quality
    // "reset" re-decides without any leftover ceiling.
    const decision = decidePlaybackMethod(candidate.input, deviceProfile);
    const profile = normalizeDeviceProfile(deviceProfile);
    const resumeMs = await resumePositionMs(profileId, mediaItemId, candidate.durationMs);

    // The stream origin must equal the client's reported offset exactly, or
    // sub/clock sync drifts. REMUX fast-seeks and can only start at the
    // probed keyframe; TRANSCODE accurate-seeks (`-ss` after `-i`), so its
    // origin is the raw resume position — frame-exact, no keyframe
    // round-trip.
    const isRemux = decision.method === "REMUX";
    const startMs = isRemux ? await keyframeAtOrBeforeMs(candidate.path, resumeMs) : resumeMs;

    const session = await db.playbackSession.create({
      data: {
        profileId,
        mediaItemId,
        mediaFileId,
        method: decision.method,
        deviceProfile: deviceProfile as object,
        positionMs: startMs,
      },
    });
    await broadcastPresence();

    if (decision.method === "DIRECT_PLAY") {
      // No ffmpeg involved — the client seeks itself using resumePositionMs.
      return {
        sessionId: session.id,
        method: decision.method,
        reasons: decision.reasons,
        playlistUrl: null,
        streamUrl: null,
        resumePositionMs: resumeMs,
        absoluteDurationMs: candidate.durationMs,
      };
    }

    // Hardware acceleration resolution (process-cached after the first call) —
    // only real encodes need it, so resolve after the DIRECT_PLAY early-out.
    const hwaccel = await getHwaccel();

    // Bounded ffmpeg concurrency: wait for a slot instead of stacking
    // transcodes on the box. 503 tells the client to retry shortly.
    if (!(await acquireTranscodeSlot())) {
      await db.playbackSession.updateMany({ where: { id: session.id }, data: { endedAt: new Date() } });
      return reply.code(503).send({ error: "transcoder busy — too many concurrent transcodes, retry shortly" });
    }

    const audioIndex = candidate.relativeAudioIndex;
    const outDir = audioOutDir(session.id, audioIndex);
    await mkdir(outDir, { recursive: true });
    const toneMap = needsToneMap(candidate.input.isHdr, profile.supportsHdr);

    const segmentFrom = Math.floor(startMs / 1000 / HLS_SEGMENT_SECONDS);
    const outFile = path.join(outDir, "stream.mp4");
    // REMUX resume via a piped stub (header + tail from the exact keyframe
    // cluster): the mkv Cue table can point at a different keyframe than the
    // bitstream probe, so -ss would start elsewhere than the reported startMs
    // and subs drift. Falls back to the legacy -ss remux when probing fails.
    const resumeInput = isRemux ? await buildResumeInput(candidate.path, startMs) : null;
    const args = isRemux
      ? buildRemuxArgs({
          inputPath: candidate.path,
          outputPath: outFile,
          startMs,
          durationMs: candidate.durationMs,
          audioStreamIndex: audioIndex,
          audioCodec: candidate.input.audioCodec,
          videoCodec: candidate.input.videoCodec,
          pipedInput: resumeInput !== null,
        })
      : buildFfmpegArgs({
          inputPath: candidate.path,
          outputDir: outDir,
          startSegment: segmentFrom,
          segmentSeconds: HLS_SEGMENT_SECONDS,
          // -ss targets the stream origin exactly — the reported startMs —
          // so the browser timeline origin matches the client offset.
          seekMs: startMs,
          hwaccel,
          videoCodec: pickVideoEncoder(profile.supportedVideoCodecs, hwaccel),
          audioCodec: pickAudioEncoder(profile.supportedAudioCodecs),
          audioStreamIndex: audioIndex,
          maxWidth: profile.maxWidth,
          maxHeight: profile.maxHeight,
          maxVideoBitrateKbps: profile.maxVideoBitrateKbps,
          toneMap,
          subtitleBurnIn: candidate.subtitleBurnIn,
        });

    // DIRECT_PLAY returned early above; the decider never emits DIRECT_STREAM,
    // so this is always a real encode or copy.
    const encodeMethod: "REMUX" | "TRANSCODE" = decision.method === "REMUX" ? "REMUX" : "TRANSCODE";
    // The slot is released by the child's exit callback — any failure before
    // a child exists would otherwise leak it (a phantom slot that bricks the
    // transcode cap until the API restarts — matches the wedged-counter
    // stalls seen in practice).
    let spawned: Awaited<ReturnType<typeof spawnTranscodeJob>>;
    try {
      spawned = await spawnTranscodeJob(
        session.id,
        mediaFileId,
        encodeMethod,
        profile,
        args,
        segmentFrom,
        outDir,
        candidate.durationMs,
        resumeInput?.input,
        hwaccel,
      );
    } catch (e) {
      releaseTranscodeSlot();
      throw e;
    }
    const { transcode, jobId } = spawned;

    let playlistUrl: string | null = null;
    if (!isRemux) {
      // Playlist starts at the resume segment (EXT-X-MEDIA-SEQUENCE) so the
      // player never waits on segment-0, which a resumed session never writes.
      const playlist = buildM3u8(candidate.durationMs, HLS_SEGMENT_SECONDS, segmentFrom);
      await writePlaylistAtomically(outDir, playlist);
      playlistUrl = `/playback/${session.id}/playlist.m3u8`;
    }

    liveSessions.set(session.id, {
      transcode,
      outDir,
      mediaFile: {
        path: candidate.path,
        durationMs: candidate.durationMs,
        bitrateKbps: candidate.bitrateKbps,
        videoCodec: candidate.input.videoCodec,
      },
      method: decision.method,
      deviceProfile: profile,
      currentSegmentFrom: segmentFrom,
      playlistStartSegment: segmentFrom,
      currentTranscodeJobId: jobId,
      toneMap,
      subtitleBurnIn: candidate.subtitleBurnIn,
      audioStreamIndex: audioIndex,
      audioCodec: candidate.input.audioCodec,
      remux: isRemux ? { outFile, startMs, patched: false } : null,
      hwaccel,
    });

    return {
      sessionId: session.id,
      method: decision.method,
      reasons: decision.reasons,
      playlistUrl,
      streamUrl: isRemux ? `/playback/${session.id}/stream.mp4` : null,
      // The exact stored resume position (ms) — the client self-seeks to it
      // once the stream is open; actualStartMs carries the anchored origin.
      resumePositionMs: resumeMs,
      absoluteDurationMs: candidate.durationMs,
      // Exact media time the stream starts at: the raw resume position for
      // TRANSCODE (accurate seek), the keyframe at-or-before it for REMUX —
      // the client's timeline offset.
      actualStartMs: startMs,
    };
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/playback/:sessionId/playlist.m3u8",
    { preHandler: app.authenticate },
    async (req, reply) => {
      const live = liveSessions.get(req.params.sessionId);
      if (!live) return reply.code(404).send({ error: "no active session" });
      const body = await readFile(path.join(live.outDir, "playlist.m3u8"), "utf-8");
      reply.type("application/vnd.apple.mpegurl").send(body);
    },
  );

  // REMUX: the live fragmented-MP4 file, still growing under ffmpeg. sendFile
  // handles Range/206 for native <video> seeking; noCache keeps a restarted
  // (truncated + rewritten) file from being served from a browser cache — the
  // client also busts via `?r=` nonce on restarts, this is the backstop.
  //
  // Growing-file race: Chrome's first fetch is `Range: bytes=0-` — a 206
  // against a half-written file is treated as authoritative, so it never
  // re-fetches and the player stalls at the written frontier with the wrong
  // duration. Instead, block until the remux child exits (the file is
  // complete) — copy-speed makes this ~3s for an episode, seconds-to-a-minute
  // for movies — then serve a file whose content-range can never lie.
  app.get<{ Params: { sessionId: string } }>(
    "/playback/:sessionId/stream.mp4",
    { preHandler: app.authenticate },
    async (req, reply) => {
      const live = liveSessions.get(req.params.sessionId);
      if (!live?.remux) return reply.code(404).send({ error: "no active remux session" });

    const child = live.transcode.child;
    const waitMs = Math.min(60_000, Math.max(5_000, estRemuxRemainingSec(live) * 1000 + 3_000));
    const deadline = Date.now() + waitMs;
    // A seek-restart kills the child (SIGKILL → signalCode, not exitCode) and
    // rewrites the file — treat that as "wait's over", the client is
    // nonce-reloading a fresh URL anyway.
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (child.exitCode !== null && child.exitCode !== 0) {
      return reply.code(500).send({ error: "remux failed" });
    }

    // The file is complete — inject the mehd duration into moov so the player
    // knows the real length up-front instead of deriving it from downloaded
    // fragments (a slow connection shows a fraction of the episode). One
    // 20-byte in-place insert per remux (seek/audio-switch restarts rewrite
    // the file, so patched resets to false there); a failed patch must never
    // take the stream down. Patching a *live* file (wait deadline expired
    // with the child still writing) would shift every byte after moov while
    // ffmpeg writes — corruption. Serve it unpatched; the client plays with
    // progressive duration until the next restart.
    if (child.exitCode === 0 && !live.remux.patched) {
      if (patchRemuxMehd(live.remux.outFile, live.mediaFile.durationMs, live.remux.startMs)) {
        live.remux.patched = true;
      }
    }

    return reply.sendFile(path.basename(live.remux.outFile), path.dirname(live.remux.outFile), {
      maxAge: 0,
      acceptRanges: true,
      cacheControl: true,
    });
  });

  app.get<{ Params: { sessionId: string; n: string } }>(
    "/playback/:sessionId/segment-:n.ts",
    {
      // `n` is joined straight into a path below — a plain string param would
      // accept `..%2F..%2Fetc%2Fpasswd` and path.join would resolve it out of
      // the transcode dir (arbitrary file disclosure, unauthenticated).
      preHandler: app.authenticate,
      schema: {
        params: z.object({ sessionId: z.string(), n: z.string().regex(/^\d+$/) }),
      },
    },
    async (req, reply) => {
      const live = liveSessions.get(req.params.sessionId);
      if (!live) return reply.code(404).send({ error: "no active session" });
      const segPath = path.join(live.outDir, `segment-${req.params.n}.ts`);

      // The segment muxer creates each segment file and fills it as frames
      // are encoded — `existsSync` alone passes mid-write, and serving a
      // half-written segment makes hls.js probe/parse garbage (fragParsingError,
      // stalled playback). Slow encodes (1080p+) make the race almost
      // guaranteed, which is why they "never stream". Wait for the file to be
      // stable (size unchanged across two polls) instead — that only happens
      // when ffmpeg finished writing it. First segment can take a while on a
      // CPU encode, so fail fast the moment the child dies instead of holding
      // the request 120s for a file that will never appear.
      const deadline = Date.now() + 120_000;
      let lastSize = -1;
      let stablePolls = 0;
      while (Date.now() < deadline) {
        const child = live.transcode.child;
        // exitCode and signalCode are mutually exclusive — a SIGKILLed child
        // (seek/audio-switch restart) sets signalCode, never exitCode. `||`
        // is the "is the child dead at all" check; `&&` here would poll a
        // killed child's missing segments for the full 120s.
        const dead = (child.exitCode ?? child.signalCode) !== null;
        if (dead && child.exitCode !== 0) {
          // Child died mid-write (killed or errored): any existing file is
          // only a partial segment — serving it poisons hls.js's parser.
          // 404 instead; the client's restart reloads a fresh manifest with
          // the new anchor's segment numbers anyway.
          break;
        }
        let size = 0;
        try {
          size = statSync(segPath).size;
        } catch {
          // not created yet
          if (dead) break;
        }
        if (dead && size > 0 && size === lastSize) {
          // Clean exit = the file it wrote is final on disk — no need to wait
          // the stability polls out.
          break;
        }
        if (size > 0 && size === lastSize) {
          stablePolls += 1;
          if (stablePolls >= 3) break;
        } else {
          stablePolls = 0;
        }
        lastSize = size;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!existsSync(segPath)) return reply.code(404).send({ error: "segment not ready" });

      const body = await readFile(segPath);
      reply.type("video/mp2t").send(body);
    },
  );

  app.post(
    "/playback/:sessionId/seek",
    {
      preHandler: app.authenticate,
      schema: {
        params: PlaybackSessionParams,
        body: SeekBody,
        response: { 200: SeekResponse, 404: ErrorResponse, 503: ErrorResponse },
      },
    },
    async (req, reply) => {
      const live = liveSessions.get(req.params.sessionId);
      if (!live) return reply.code(404).send({ error: "no active transcode session" });

      // Seek past the media end is a no-op stop position — clamp like the
      // HLS path clamps its segment index.
      const targetMs = Math.min(req.body.positionMs, Math.max(0, live.mediaFile.durationMs - 1000));

      if (live.method !== "REMUX" || live.remux === null) {
        // TRANSCODE: already-produced (and listed by the current playlist)
        // segments need no ffmpeg restart — the player just moves within
        // its buffer.
        const targetSegment = segmentFor(targetMs, live.mediaFile.durationMs);
        const targetPath = path.join(live.outDir, `segment-${targetSegment}.ts`);
        if (existsSync(targetPath) && targetSegment >= live.playlistStartSegment) {
          await db.playbackSession.update({
            where: { id: req.params.sessionId },
            data: { positionMs: targetMs },
          });
          return { restarted: false, segmentFrom: live.currentSegmentFrom, pid: live.transcode.pid };
        }

        const oldPid = live.transcode.pid;
        await cancelCurrentJob(req.params.sessionId);

        const restarted = await restartTranscode(req.params.sessionId, live, targetMs);
        if ("cancelled" in restarted) {
          return reply.code(503).send({ error: "transcoder busy or session ended — retry shortly" });
        }
        const { transcode, jobId, startMs, segmentFrom: actualSegmentFrom } = restarted;
        // Seeking backwards below the original media sequence — rewrite the
        // playlist so the player knows segments before it exist again. Uses
        // the actual keyframe-anchored segment the new child starts at (it
        // may differ from the requested target's floored segment by one).
        const playlist = buildM3u8(live.mediaFile.durationMs, HLS_SEGMENT_SECONDS, actualSegmentFrom);
        await writePlaylistAtomically(live.outDir, playlist);

        liveSessions.set(req.params.sessionId, {
          ...live,
          transcode,
          currentSegmentFrom: actualSegmentFrom,
          playlistStartSegment: actualSegmentFrom,
          currentTranscodeJobId: jobId,
        });

        await db.playbackSession.update({ where: { id: req.params.sessionId }, data: { positionMs: targetMs } });
        return {
          restarted: true,
          segmentFrom: actualSegmentFrom,
          pid: transcode.pid,
          killedPid: oldPid,
          actualStartMs: startMs,
        };
      }

      // REMUX: seeks within what the live file has already written are
      // native browser seeks (range requests) — no restart, no stall.
      // Forward seeks beyond the written frontier simply wait for the copy
      // to reach the target: the remux copies at far above playback rate
      // (~60MB/s), so the frontier crosses the target in seconds without a
      // single restart — the mounted element keeps its patched mehd and its
      // range machinery, and Chrome's follow-up byte-range request is served
      // once the bytes physically exist. A restart would recopy the whole
      // remainder and force a fresh mount that the stream route blocks on
      // (serve-after-complete) — that freeze is what made far-forward REMUX
      // clicks look dead. Restart only for seeks BELOW the file's start:
      // the file only spans [startMs, end] — anything earlier physically
      // doesn't exist in it, the browser clamps to its start, and a
      // "restarted:false" there would silently dead-end the user's backward
      // scrub (the client can't reach the target natively).
      if (targetMs >= live.remux.startMs) {
        // +15s margin past the size-derived estimate: the target's fragment
        // (moof+mdat) must exist in full, not just its moof header, or the
        // element's range request ends the fragment early (mid-mdat).
        // Clamp the goal to the media end (-2s playback tail): a seek to the
        // final seconds can never make a size-derived estimate reach
        // durationMs+15s, and must not burn the full deadline waiting.
        const goalMs = Math.min(targetMs + 15_000, live.mediaFile.durationMs - 2_000);
        const deadline = Date.now() + 30_000;
        let covered = remuxCoveredMs(live);
        while (covered < goalMs && Date.now() < deadline) {
          // Refresh per iteration: a quality/audio restart swaps the entry
          // (and the file) mid-wait; wait on what's live, not the snapshot.
          const child = (liveSessions.get(req.params.sessionId) ?? live).transcode.child;
          // Child done (clean exit) = file final on disk — everything is
          // seekable, margin irrelevant (the estimate's last fragments are
          // fully written). A failed/signaled child leaves a truncated or
          // empty file on disk — do NOT treat that as covered; bail out of
          // the wait so the restart path below recovers the seek.
          if (child.exitCode === 0) {
            covered = goalMs;
            break;
          }
          if ((child.exitCode ?? child.signalCode) !== null) break;
          await new Promise((resolve) => setTimeout(resolve, 150));
          covered = remuxCoveredMs(live);
        }
        if (covered >= goalMs) {
          await db.playbackSession.update({ where: { id: req.params.sessionId }, data: { positionMs: targetMs } });
          return {
            restarted: false,
            segmentFrom: Math.floor(targetMs / 1000 / HLS_SEGMENT_SECONDS),
            pid: live.transcode.pid,
          };
        }
        // Frontier never made it (child died / disk stalled) — fall through
        // to a real restart so the seek still lands.
      }

      const oldPid = live.transcode.pid;
      await cancelCurrentJob(req.params.sessionId);

      const restarted = await restartTranscode(req.params.sessionId, live, targetMs);
      if ("cancelled" in restarted) {
        return reply.code(503).send({ error: "transcoder busy or session ended — retry shortly" });
      }
      const { transcode, jobId, startMs } = restarted;
      const segmentFrom = Math.floor(startMs / 1000 / HLS_SEGMENT_SECONDS);

      liveSessions.set(req.params.sessionId, {
        ...live,
        transcode,
        currentSegmentFrom: segmentFrom,
        currentTranscodeJobId: jobId,
        remux: { outFile: live.remux.outFile, startMs, patched: false },
      });

      await db.playbackSession.update({ where: { id: req.params.sessionId }, data: { positionMs: targetMs } });
      return {
        restarted: true,
        segmentFrom,
        pid: transcode.pid,
        killedPid: oldPid,
        actualStartMs: startMs,
      };
    },
  );

  // Audio-track switch — always restarts ffmpeg, unlike /seek,
  // because the target segment may already exist on disk with the *previous*
  // audio track muxed in and reusing it would silently serve the wrong audio.
  // A fresh per-track outDir (audioOutDir) sidesteps that instead of trying to
  // invalidate/overwrite segments a player might still rewind into.
  app.post(
    "/playback/:sessionId/audio-track",
    {
      preHandler: app.authenticate,
      schema: {
        params: PlaybackSessionParams,
        body: AudioTrackSwitchBody,
        response: { 200: AudioTrackSwitchResponse, 404: ErrorResponse, 503: ErrorResponse },
      },
    },
    async (req, reply) => {
      const live = liveSessions.get(req.params.sessionId);
      if (!live) return reply.code(404).send({ error: "no active transcode session" });

      const playbackSession = await db.playbackSession.findUniqueOrThrow({ where: { id: req.params.sessionId } });
      const mediaFile = await db.mediaFile.findUniqueOrThrow({
        where: { id: playbackSession.mediaFileId },
        include: { streams: true },
      });
      const audioIndex = relativeAudioIndex(mediaFile.streams, req.body.audioStreamIndex);
      const audioCodec = mediaFile.streams.find(
        (s) => s.type === "AUDIO" && s.streamIndex === req.body.audioStreamIndex,
      )?.codec ?? null;

      const targetMs = Math.min(req.body.positionMs, Math.max(0, live.mediaFile.durationMs - 1000));
      const targetSegment = segmentFor(targetMs, live.mediaFile.durationMs);
      const newOutDir = audioOutDir(req.params.sessionId, audioIndex);
      await mkdir(newOutDir, { recursive: true });

      const oldPid = live.transcode.pid;
      await cancelCurrentJob(req.params.sessionId);

      // New outDir → the media sequence starts at the target segment (HLS)
      // or the stream file lives in the fresh per-track dir (REMUX).
      const isRemux = live.method === "REMUX";

      const restarted = await restartTranscode(
        req.params.sessionId,
        { ...live, outDir: newOutDir, audioStreamIndex: audioIndex, audioCodec },
        targetMs,
      );
      if ("cancelled" in restarted) {
        return reply.code(503).send({ error: "transcoder busy or session ended — retry shortly" });
      }
      const { transcode, jobId, startMs, segmentFrom: actualSegmentFrom } = restarted;
      if (!isRemux) {
        // Written after the restart so the first listed segment matches the
        // segment the new child actually starts at.
        const m3u8 = buildM3u8(live.mediaFile.durationMs, HLS_SEGMENT_SECONDS, actualSegmentFrom);
        await writePlaylistAtomically(newOutDir, m3u8);
      }

      liveSessions.set(req.params.sessionId, {
        ...live,
        transcode,
        outDir: newOutDir,
        currentSegmentFrom: actualSegmentFrom,
        playlistStartSegment: actualSegmentFrom,
        currentTranscodeJobId: jobId,
        audioStreamIndex: audioIndex,
        audioCodec,
        remux: isRemux ? { outFile: path.join(newOutDir, "stream.mp4"), startMs, patched: false } : null,
      });

      await db.playbackSession.update({ where: { id: req.params.sessionId }, data: { positionMs: targetMs } });
      return {
        restarted: true,
        segmentFrom: actualSegmentFrom,
        pid: transcode.pid,
        killedPid: oldPid,
        actualStartMs: startMs,
      };
    },
  );

  // Quality switch — restarts ffmpeg with new encode caps, in a fresh per-quality
  // outDir (see qualityOutDir). Unlike /seek this may also change the METHOD:
  // requesting 720p of a 1080p REMUX source falls through to a real TRANSCODE
  // (a copy-remux can't deliver below source resolution — decision engine
  // enforces this), so the response carries the new stream/playlist URLs.
  app.post(
    "/playback/:sessionId/quality",
    {
      preHandler: app.authenticate,
      schema: {
        params: PlaybackSessionParams,
        body: QualitySwitchBody,
        response: { 200: QualitySwitchResponse, 404: ErrorResponse, 503: ErrorResponse },
      },
    },
    async (req, reply) => {
      const live = liveSessions.get(req.params.sessionId);
      const session = await db.playbackSession.findUniqueOrThrow({ where: { id: req.params.sessionId } });
      // The DB row keeps the session's *start* profile — the raw, un-normalized
      // profile (no 1080p ceiling) — so reset re-decides exactly like /start did.
      const startRawProfile = session.deviceProfile as unknown as DeviceProfile;

      // reset drops the forced caps and re-decides with the start profile;
      // otherwise merge the new caps over whatever the session runs now.
      const mergedRaw = req.body.reset
        ? startRawProfile
        : {
            ...(live?.deviceProfile ?? startRawProfile),
            ...(req.body.maxWidth !== undefined ? { maxWidth: req.body.maxWidth } : {}),
            ...(req.body.maxHeight !== undefined ? { maxHeight: req.body.maxHeight } : {}),
            ...(req.body.maxVideoBitrateKbps !== undefined ? { maxVideoBitrateKbps: req.body.maxVideoBitrateKbps } : {}),
          };
      const newProfile = normalizeDeviceProfile(mergedRaw);

      // Same caps as the running encode — nothing to do; report current state
      // so the client can just sync its menu.
      if (live) {
        const capsSame =
          newProfile.maxWidth === live.deviceProfile.maxWidth &&
          newProfile.maxHeight === live.deviceProfile.maxHeight &&
          newProfile.maxVideoBitrateKbps === live.deviceProfile.maxVideoBitrateKbps;
        if (capsSame) {
          return {
            restarted: false,
            // Live sessions only ever run REMUX/TRANSCODE (DIRECT_STREAM is
            // vestigial in the type) — widen to the response's method set.
            method: live.method as PlaybackMethod,
            segmentFrom: live.currentSegmentFrom,
            pid: live.transcode.pid,
            playlistUrl: live.method === "REMUX" ? null : `/playback/${req.params.sessionId}/playlist.m3u8`,
            streamUrl: live.method === "REMUX" ? `/playback/${req.params.sessionId}/stream.mp4` : null,
          };
        }
      }

      const mediaFile = await db.mediaFile.findUniqueOrThrow({
        where: { id: session.mediaFileId },
        include: { streams: true },
      });
      const audioStreams = mediaFile.streams.filter((s) => s.type === "AUDIO");
      const absoluteAudio = live ? audioStreams[live.audioStreamIndex]?.streamIndex : undefined;
      const candidate = await buildCandidateInput(session.mediaFileId, undefined, absoluteAudio);
      if (!candidate) return reply.code(404).send({ error: "media file not found" });

      const targetMs = Math.min(req.body.positionMs, Math.max(0, candidate.durationMs - 1000));
      // Decide on the raw merged profile (never the normalized one): a reset
      // must re-decide without the encode ceiling (4K direct/remux), and a
      // caps request only needs the decider to see the caps being asked for.
      const decision = decidePlaybackMethod(candidate.input, mergedRaw);

      // Easiest tier first: the decider only lands on DIRECT_PLAY when the
      // source actually direct-plays at these caps. A reset drops the forced
      // caps, so a capped TRANSCODE walks back up the ladder to the file
      // itself — kill the transcode and let the client serve the file.
      if (decision.method === "DIRECT_PLAY") {
        if (live) await killSessionTranscode(req.params.sessionId);
        await db.playbackSession.update({
          where: { id: session.id },
          data: { method: "DIRECT_PLAY", positionMs: targetMs },
        });
        return {
          restarted: true,
          method: "DIRECT_PLAY" as const,
          segmentFrom: null,
          pid: null,
          playlistUrl: null,
          streamUrl: null,
        };
      }

      const newMethod: "REMUX" | "TRANSCODE" = decision.method === "REMUX" ? "REMUX" : "TRANSCODE";

      // A DIRECT_PLAY session has no live entry yet — this caps request is
      // the first time the source can't meet the ask, so spawn the session's
      // first ffmpeg (mirror of /start's spawn block; the shared helper keeps
      // the job recording identical).
      if (!live) {
        const hwaccel = await getHwaccel();
        if (!(await acquireTranscodeSlot())) {
          return reply.code(503).send({ error: "transcoder busy — too many concurrent transcodes, retry shortly" });
        }
        const targetSegment = segmentFor(targetMs, candidate.durationMs);
        const newOutDir = qualityOutDir(
          req.params.sessionId,
          newProfile.maxWidth ?? 1920,
          newProfile.maxHeight ?? 1080,
        );
        await mkdir(newOutDir, { recursive: true });

        // REMUX fast-seeks and must start at the probed keyframe; TRANSCODE
        // accurate-seeks, so its origin is the raw target position.
        const startMs = newMethod === "REMUX" ? await keyframeAtOrBeforeMs(candidate.path, targetMs) : targetMs;
        const segmentFrom = Math.floor(startMs / 1000 / HLS_SEGMENT_SECONDS);
        const toneMap = needsToneMap(candidate.input.isHdr, newProfile.supportsHdr);
        // REMUX resume via a piped stub — the mkv Cue table can point at a
        // different keyframe than the bitstream probe, which would drift subs
        // against the reported startMs. Falls back to -ss when probing fails.
        const resumeInput =
          newMethod === "REMUX" ? await buildResumeInput(candidate.path, startMs) : null;
        const args =
          newMethod === "REMUX"
            ? buildRemuxArgs({
                inputPath: candidate.path,
                outputPath: path.join(newOutDir, "stream.mp4"),
                startMs,
                durationMs: candidate.durationMs,
                audioStreamIndex: candidate.relativeAudioIndex,
                audioCodec: candidate.input.audioCodec,
                videoCodec: candidate.input.videoCodec,
                pipedInput: resumeInput !== null,
              })
            : buildFfmpegArgs({
                inputPath: candidate.path,
                outputDir: newOutDir,
                startSegment: segmentFrom,
                segmentSeconds: HLS_SEGMENT_SECONDS,
                // -ss targets the stream origin exactly — the reported
                // startMs.
                seekMs: startMs,
                hwaccel,
                videoCodec: pickVideoEncoder(newProfile.supportedVideoCodecs, hwaccel),
                audioCodec: pickAudioEncoder(newProfile.supportedAudioCodecs),
                audioStreamIndex: candidate.relativeAudioIndex,
                maxWidth: newProfile.maxWidth,
                maxHeight: newProfile.maxHeight,
                maxVideoBitrateKbps: newProfile.maxVideoBitrateKbps,
                toneMap,
                subtitleBurnIn: candidate.subtitleBurnIn,
              });

        if (newMethod === "TRANSCODE") {
          const playlist = buildM3u8(candidate.durationMs, HLS_SEGMENT_SECONDS, segmentFrom);
          await writePlaylistAtomically(newOutDir, playlist);
        }

        const { transcode, jobId } = await spawnTranscodeJob(
          req.params.sessionId,
          session.mediaFileId,
          newMethod,
          newProfile,
          args,
          segmentFrom,
          newOutDir,
          candidate.durationMs,
          resumeInput?.input,
          hwaccel,
        );

        liveSessions.set(req.params.sessionId, {
          transcode,
          outDir: newOutDir,
          mediaFile: {
            path: candidate.path,
            durationMs: candidate.durationMs,
            bitrateKbps: candidate.bitrateKbps,
            videoCodec: candidate.input.videoCodec,
          },
          method: newMethod,
          deviceProfile: newProfile,
          currentSegmentFrom: segmentFrom,
          playlistStartSegment: segmentFrom,
          currentTranscodeJobId: jobId,
          toneMap,
          subtitleBurnIn: candidate.subtitleBurnIn,
          audioStreamIndex: candidate.relativeAudioIndex,
          audioCodec: candidate.input.audioCodec,
          remux: newMethod === "REMUX" ? { outFile: path.join(newOutDir, "stream.mp4"), startMs, patched: false } : null,
          hwaccel,
        });

        await db.playbackSession.update({
          where: { id: session.id },
          data: { method: newMethod, positionMs: targetMs },
        });
        return {
          restarted: true,
          method: newMethod,
          segmentFrom,
          pid: transcode.pid,
          actualStartMs: startMs,
          playlistUrl: newMethod === "TRANSCODE" ? `/playback/${req.params.sessionId}/playlist.m3u8` : null,
          streamUrl: newMethod === "REMUX" ? `/playback/${req.params.sessionId}/stream.mp4` : null,
        };
      }

      const targetSegment = segmentFor(targetMs, live.mediaFile.durationMs);
      const newOutDir = qualityOutDir(
        req.params.sessionId,
        newProfile.maxWidth ?? 1920,
        newProfile.maxHeight ?? 1080,
      );
      await mkdir(newOutDir, { recursive: true });

      const oldPid = live.transcode.pid;
      await cancelCurrentJob(req.params.sessionId);

      const restarted = await restartTranscode(
        req.params.sessionId,
        { ...live, outDir: newOutDir, deviceProfile: newProfile },
        targetMs,
        { method: newMethod },
      );
      if ("cancelled" in restarted) {
        return reply.code(503).send({ error: "transcoder busy or session ended — retry shortly" });
      }
      const { transcode, jobId, startMs, segmentFrom: actualSegmentFrom } = restarted;
      if (newMethod === "TRANSCODE") {
        // Written after the restart: the first listed segment must be the
        // keyframe-anchored one the new child actually starts at.
        const playlist = buildM3u8(live.mediaFile.durationMs, HLS_SEGMENT_SECONDS, actualSegmentFrom);
        await writePlaylistAtomically(newOutDir, playlist);
      }

      liveSessions.set(req.params.sessionId, {
        ...live,
        transcode,
        outDir: newOutDir,
        currentSegmentFrom: actualSegmentFrom,
        playlistStartSegment: actualSegmentFrom,
        currentTranscodeJobId: jobId,
        deviceProfile: newProfile,
        method: newMethod,
        remux: newMethod === "REMUX" ? { outFile: path.join(newOutDir, "stream.mp4"), startMs, patched: false } : null,
      });

      await db.playbackSession.update({
        where: { id: req.params.sessionId },
        data: { method: newMethod, positionMs: targetMs },
      });
      return {
        restarted: true,
        method: newMethod,
        segmentFrom: actualSegmentFrom,
        pid: transcode.pid,
        killedPid: oldPid,
        actualStartMs: startMs,
        playlistUrl: newMethod === "TRANSCODE" ? `/playback/${req.params.sessionId}/playlist.m3u8` : null,
        streamUrl: newMethod === "REMUX" ? `/playback/${req.params.sessionId}/stream.mp4` : null,
      };
    },
  );
}

export function livePlaybackPids(): number[] {
  return [...liveSessions.values()].map((s) => s.transcode.pid);
}

/**
 * Idle reaper: any session that hasn't heartbeated in 5 minutes is dead —
 * kill its ffmpeg child, free its slot, mark it ended. Without this, closed
 * tabs / crashed players leave ffmpeg processes running forever.
 */
export async function reapStaleSessions(): Promise<number> {
  const stale = await db.playbackSession.findMany({
    where: { endedAt: null, lastHeartbeatAt: { lt: new Date(Date.now() - 5 * 60_000) } },
    select: { id: true },
  });
  for (const s of stale) {
    await stopSession(s.id);
  }
  // Jobs orphaned by an API restart: the in-memory liveSessions map is gone,
  // so neither the exit callback nor killSessionTranscode ever resolves them.
  // A RUNNING job whose session is already ended can never finish on its own.
  await db.transcodeJob.updateMany({
    where: {
      state: "RUNNING",
      session: { endedAt: { not: null } },
    },
    data: { state: "CANCELLED", endedAt: new Date() },
  });
  return stale.length;
}

/**
 * Deletes transcode directories orphaned by a previous API process. Sessions
 * are tracked in the in-memory liveSessions map — after a restart every dir
 * under config/transcode is garbage, whatever its PlaybackSession row says
 * (stopSession only runs while live). Runs once at boot, where the sweep cost
 * is invisible; the per-session rm in stopSession covers the steady state.
 */
export async function cleanOrphanedTranscodeDirs(): Promise<number> {
  const root = path.join(configDir(), "transcode");
  let removed = 0;
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      await rm(path.join(root, entry.name), { recursive: true, force: true });
      removed += 1;
    }
  } catch {
    // no transcode root yet — nothing to clean
  }
  return removed;
}

/** Cmdline of `pid`, or null if it's already gone (or not ours to inspect). */
function processCmdline(pid: number): string | null {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { stdio: ["ignore", "ignore", "pipe"] }).toString().trim();
  } catch {
    return null;
  }
}

/**
 * Kills ffmpeg children orphaned by a previous API process (crash, dev
 * restart, `kill -9`). Their pids are recorded in transcode_jobs, but no
 * exit callback survives to release them — they'd burn CPU until the input
 * file ends. The cmdline guard (contains "ffmpeg" and this session's
 * transcode dir) makes PID-reuse after a long-dead process safe.
 */
export async function killOrphanedTranscodes(): Promise<number> {
  const running = await db.transcodeJob.findMany({
    where: { state: "RUNNING", pid: { not: null } },
    select: { id: true, pid: true, sessionId: true },
  });
  let killed = 0;
  for (const job of running) {
    const pid = job.pid as number | null;
    if (pid != null) {
      const cmdline = processCmdline(pid);
      const ours = cmdline?.includes("ffmpeg") && cmdline.includes(`transcode/${job.sessionId}`);
      if (ours) {
        try {
          process.kill(pid, "SIGKILL");
          killed += 1;
        } catch {
          // already gone
        }
      }
    }
    await db.transcodeJob.update({
      where: { id: job.id },
      data: { state: "CANCELLED", endedAt: new Date() },
    });
  }
  return killed;
}
