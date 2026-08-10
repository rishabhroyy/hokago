import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

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
import { buildM3u8, buildFfmpegArgs } from "@hokago/ffmpeg/hls";
import { buildRemuxArgs, patchRemuxMehd } from "@hokago/ffmpeg/remux";
import { spawnFfmpeg, type RunningTranscode } from "@hokago/ffmpeg/spawn";
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
  mediaFile: { path: string; durationMs: number; bitrateKbps: number | null };
  method: "DIRECT_STREAM" | "REMUX" | "TRANSCODE";
  deviceProfile: DeviceProfile;
  currentSegmentFrom: number;
  /** Media sequence the current playlist.m3u8 was written with — seeks below this need a playlist rewrite. */
  playlistStartSegment: number;
  currentTranscodeJobId: string;
  toneMap: boolean;
  subtitleBurnIn?: { streamIndex: number; bitmap: boolean };
  audioStreamIndex: number;
  /** Codec of the selected audio stream — drives REMUX copy-vs-encode. */
  audioCodec: string | null;
  /** REMUX only: the live fragmented-MP4 output + where its timeline starts. */
  remux: { outFile: string; startMs: number; patched: boolean } | null;
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
  return {
    ...p,
    maxWidth: p.maxWidth ?? 1920,
    maxHeight: p.maxHeight ?? 1080,
    maxVideoBitrateKbps: p.maxVideoBitrateKbps ?? 8000,
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
  if (state.positionMs < 30_000) return 0;
  return Math.min(state.positionMs, Math.max(0, durationMs - 30_000));
}

/**
 * The keyframe ffmpeg's fast input seek (`-ss`) actually lands on for a target:
 * the last keyframe at-or-before it. REMUX resumes with that exact packet, so
 * the client's timeline↔media offset (and the stored session position) must
 * use K, not the requested resume point — otherwise subs/positions drift by
 * the whole keyframe gap (seconds on sparsely-keyed sources). Bounded read
 * keeps the scan to the resume position.
 */
function keyframeAtOrBeforeMs(path: string, positionMs: number): number {
  if (positionMs <= 0) return 0;
  try {
    const out = execFileSync(
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
    );
    let last = 0;
    for (const line of out.toString().trim().split("\n")) {
      const t = Number(line.trim());
      if (!Number.isNaN(t) && t > last) last = t;
    }
    return Math.round(last * 1000);
  } catch {
    // Probe failure — fall back to the requested position (current behavior).
    return positionMs;
  }
}

async function killSessionTranscode(sessionId: string): Promise<void> {
  const live = liveSessions.get(sessionId);
  if (!live) return;
  liveSessions.delete(sessionId);
  if (live.transcode.child.exitCode === null && live.transcode.child.signalCode === null) {
    live.transcode.child.kill("SIGKILL");
  }
  releaseTranscodeSlot();
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
    void db.transcodeJob.update({
      where: { id: job.id },
      data: {
        state: result.code === 0 ? "DONE" : "FAILED",
        endedAt: new Date(),
        lastError: result.code === 0 ? null : result.stderr.slice(0, 2000),
      },
    });
  });
  await db.transcodeJob.update({ where: { id: job.id }, data: { pid: transcode.pid } });

  return { transcode, jobId: job.id };
}

async function restartTranscode(
  sessionId: string,
  live: LiveSession,
  targetMs: number,
  overrides?: { profile?: DeviceProfile; method?: "REMUX" | "TRANSCODE" },
): Promise<{ transcode: RunningTranscode; jobId: string; startMs: number } | { cancelled: true }> {
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
    return { cancelled: true };
  }
  // Torn down (stop/reap) while the old child was being killed — don't
  // orphan a fresh ffmpeg for a dead session.
  if (!liveSessions.has(sessionId)) {
    releaseTranscodeSlot();
    return { cancelled: true };
  }

  const profile = overrides?.profile ?? live.deviceProfile;
  // The live entry's *method* is the source of truth; the quality route
  // forces method via overrides (REMUX→TRANSCODE→REMUX round trips leave
  // live.remux null from the TRANSCODE leg — consulting it here would
  // silently start a transcode and report REMUX).
  const isRemux = (overrides?.method ?? live.method) === "REMUX";
  // REMUX restarts fast-seek to the keyframe at-or-before the target — that
  // actual keyframe is what the restarted stream starts at (and what the
  // client's offset must use), so probe it here and report it in the response.
  const startMs = isRemux ? keyframeAtOrBeforeMs(live.mediaFile.path, targetMs) : targetMs;
  const segmentFrom = Math.floor(startMs / 1000 / HLS_SEGMENT_SECONDS);
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
      })
    : buildFfmpegArgs({
        inputPath: live.mediaFile.path,
        outputDir: live.outDir,
        startSegment: segmentFrom,
        segmentSeconds: HLS_SEGMENT_SECONDS,
        videoCodec: pickVideoEncoder(profile.supportedVideoCodecs),
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
    void db.transcodeJob.update({
      where: { id: job.id },
      data: {
        state: result.code === 0 ? "DONE" : "FAILED",
        endedAt: new Date(),
        lastError: result.code === 0 ? null : result.stderr.slice(0, 2000),
      },
    });
  });
  await db.transcodeJob.update({ where: { id: job.id }, data: { pid: transcode.pid } });

  return { transcode, jobId: job.id, startMs };
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
      schema: {
        body: StartPlaybackBody,
        response: { 200: StartPlaybackResponse, 404: ErrorResponse, 503: ErrorResponse },
      },
    },
    async (req, reply) => {
    const { profileId, mediaItemId, mediaFileId, deviceProfile, subtitleTrackId, audioStreamIndex } = req.body;
    const profile = normalizeDeviceProfile(deviceProfile);
    const candidate = await buildCandidateInput(mediaFileId, subtitleTrackId, audioStreamIndex);
    if (!candidate) return reply.code(404).send({ error: "media file not found" });

    const decision = decidePlaybackMethod(candidate.input, profile);
    const resumeMs = await resumePositionMs(profileId, mediaItemId, candidate.durationMs);

    // REMUX fast-seeks to the keyframe at-or-before the resume point — the
    // file (and therefore the client's timeline offset + stored position) must
    // use that actual keyframe, or subs/positions drift by the keyframe gap.
    const isRemux = decision.method === "REMUX";
    const startMs = isRemux ? keyframeAtOrBeforeMs(candidate.path, resumeMs) : resumeMs;

    const session = await db.playbackSession.create({
      data: {
        profileId,
        mediaItemId,
        mediaFileId,
        method: decision.method,
        deviceProfile: profile as object,
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
      };
    }

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
    const args = isRemux
      ? buildRemuxArgs({
          inputPath: candidate.path,
          outputPath: outFile,
          startMs,
          durationMs: candidate.durationMs,
          audioStreamIndex: audioIndex,
          audioCodec: candidate.input.audioCodec,
        })
      : buildFfmpegArgs({
          inputPath: candidate.path,
          outputDir: outDir,
          startSegment: segmentFrom,
          segmentSeconds: HLS_SEGMENT_SECONDS,
          videoCodec: pickVideoEncoder(profile.supportedVideoCodecs),
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
    const { transcode, jobId } = await spawnTranscodeJob(
      session.id,
      mediaFileId,
      encodeMethod,
      profile,
      args,
      segmentFrom,
    );

    let playlistUrl: string | null = null;
    if (!isRemux) {
      // Playlist starts at the resume segment (EXT-X-MEDIA-SEQUENCE) so the
      // player never waits on segment-0, which a resumed session never writes.
      const playlist = buildM3u8(candidate.durationMs, HLS_SEGMENT_SECONDS, segmentFrom);
      await writeFile(path.join(outDir, "playlist.m3u8"), playlist);
      playlistUrl = `/playback/${session.id}/playlist.m3u8`;
    }

    liveSessions.set(session.id, {
      transcode,
      outDir,
      mediaFile: { path: candidate.path, durationMs: candidate.durationMs, bitrateKbps: candidate.bitrateKbps },
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
    });

    return {
      sessionId: session.id,
      method: decision.method,
      reasons: decision.reasons,
      playlistUrl,
      streamUrl: isRemux ? `/playback/${session.id}/stream.mp4` : null,
      // For REMUX this is the actual keyframe the file starts at (== startMs),
      // which the client uses as its timeline offset — exactly synced subs.
      resumePositionMs: isRemux ? startMs : resumeMs,
    };
    },
  );

  app.get<{ Params: { sessionId: string } }>("/playback/:sessionId/playlist.m3u8", async (req, reply) => {
    const live = liveSessions.get(req.params.sessionId);
    if (!live) return reply.code(404).send({ error: "no active session" });
    const body = await readFile(path.join(live.outDir, "playlist.m3u8"), "utf-8");
    reply.type("application/vnd.apple.mpegurl").send(body);
  });

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
  app.get<{ Params: { sessionId: string } }>("/playback/:sessionId/stream.mp4", async (req, reply) => {
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
    // take the stream down.
    if (!live.remux.patched) {
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
      while (Date.now() < deadline) {
        // exitCode and signalCode are mutually exclusive — a SIGKILLed child
        // (seek/audio-switch restart) sets signalCode, never exitCode. `||`
        // is the "is the child dead at all" check; `&&` here would poll a
        // killed child's missing segments for the full 120s.
        if ((live.transcode.child.exitCode ?? live.transcode.child.signalCode) !== null && !existsSync(segPath)) {
          break;
        }
        let size = 0;
        try {
          size = statSync(segPath).size;
        } catch {
          // not created yet
        }
        if (size > 0 && size === lastSize) break;
        lastSize = size;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!existsSync(segPath)) return reply.code(404).send({ error: "segment not ready" });

      const body = await readFile(segPath);
      reply.type("video/mp2t").send(body);
    },
  );

  app.post(
    "/playback/:sessionId/seek",
    {
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
        const { transcode, jobId } = restarted;
        // Seeking backwards below the original media sequence — rewrite the
        // playlist so the player knows segments before it exist again.
        const playlist = buildM3u8(live.mediaFile.durationMs, HLS_SEGMENT_SECONDS, targetSegment);
        await writeFile(path.join(live.outDir, "playlist.m3u8"), playlist);

        liveSessions.set(req.params.sessionId, {
          ...live,
          transcode,
          currentSegmentFrom: targetSegment,
          playlistStartSegment: targetSegment,
          currentTranscodeJobId: jobId,
        });

        await db.playbackSession.update({ where: { id: req.params.sessionId }, data: { positionMs: targetMs } });
        return { restarted: true, segmentFrom: targetSegment, pid: transcode.pid, killedPid: oldPid };
      }

      // REMUX: seeks within what the live file has already written are
      // native browser seeks (range requests) — no restart, no stall.
      // Forward seeks beyond the written frontier need the remux to restart
      // from the target keyframe (copy-speed, sub-second).
      if (targetMs <= remuxCoveredMs(live) - 30_000) {
        await db.playbackSession.update({ where: { id: req.params.sessionId }, data: { positionMs: targetMs } });
        return {
          restarted: false,
          segmentFrom: Math.floor(targetMs / 1000 / HLS_SEGMENT_SECONDS),
          pid: live.transcode.pid,
        };
      }

      const oldPid = live.transcode.pid;
      await cancelCurrentJob(req.params.sessionId);

      const restarted = await restartTranscode(req.params.sessionId, live, targetMs);
      if ("cancelled" in restarted) {
        return reply.code(503).send({ error: "transcoder busy or session ended — retry shortly" });
      }
      const { transcode, jobId, startMs } = restarted;

      liveSessions.set(req.params.sessionId, {
        ...live,
        transcode,
        currentSegmentFrom: Math.floor(targetMs / 1000 / HLS_SEGMENT_SECONDS),
        currentTranscodeJobId: jobId,
        remux: { outFile: live.remux.outFile, startMs, patched: false },
      });

      await db.playbackSession.update({ where: { id: req.params.sessionId }, data: { positionMs: targetMs } });
      return {
        restarted: true,
        segmentFrom: Math.floor(targetMs / 1000 / HLS_SEGMENT_SECONDS),
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
      if (!isRemux) {
        const m3u8 = buildM3u8(live.mediaFile.durationMs, HLS_SEGMENT_SECONDS, targetSegment);
        await writeFile(path.join(newOutDir, "playlist.m3u8"), m3u8);
      }

      const restarted = await restartTranscode(
        req.params.sessionId,
        { ...live, outDir: newOutDir, audioStreamIndex: audioIndex, audioCodec },
        targetMs,
      );
      if ("cancelled" in restarted) {
        return reply.code(503).send({ error: "transcoder busy or session ended — retry shortly" });
      }
      const { transcode, jobId, startMs } = restarted;

      liveSessions.set(req.params.sessionId, {
        ...live,
        transcode,
        outDir: newOutDir,
        currentSegmentFrom: targetSegment,
        playlistStartSegment: targetSegment,
        currentTranscodeJobId: jobId,
        audioStreamIndex: audioIndex,
        audioCodec,
        remux: isRemux ? { outFile: path.join(newOutDir, "stream.mp4"), startMs, patched: false } : null,
      });

      await db.playbackSession.update({ where: { id: req.params.sessionId }, data: { positionMs: targetMs } });
      return {
        restarted: true,
        segmentFrom: targetSegment,
        pid: transcode.pid,
        killedPid: oldPid,
        actualStartMs: isRemux ? startMs : undefined,
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
      schema: {
        params: PlaybackSessionParams,
        body: QualitySwitchBody,
        response: { 200: QualitySwitchResponse, 404: ErrorResponse, 503: ErrorResponse },
      },
    },
    async (req, reply) => {
      const live = liveSessions.get(req.params.sessionId);
      const session = await db.playbackSession.findUniqueOrThrow({ where: { id: req.params.sessionId } });
      // The DB row keeps the session's *start* profile — reset restores it.
      const startProfile = session.deviceProfile as unknown as DeviceProfile;

      // reset drops the forced caps and re-decides with the start profile;
      // otherwise merge the new caps over whatever the session runs now.
      const newProfile = req.body.reset
        ? normalizeDeviceProfile(startProfile)
        : normalizeDeviceProfile({
            ...(live?.deviceProfile ?? startProfile),
            ...(req.body.maxWidth !== undefined ? { maxWidth: req.body.maxWidth } : {}),
            ...(req.body.maxHeight !== undefined ? { maxHeight: req.body.maxHeight } : {}),
            ...(req.body.maxVideoBitrateKbps !== undefined ? { maxVideoBitrateKbps: req.body.maxVideoBitrateKbps } : {}),
          });

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
      const decision = decidePlaybackMethod(candidate.input, newProfile);

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

        const startMs = newMethod === "REMUX" ? keyframeAtOrBeforeMs(candidate.path, targetMs) : targetMs;
        const segmentFrom = Math.floor(startMs / 1000 / HLS_SEGMENT_SECONDS);
        const toneMap = needsToneMap(candidate.input.isHdr, newProfile.supportsHdr);
        const args =
          newMethod === "REMUX"
            ? buildRemuxArgs({
                inputPath: candidate.path,
                outputPath: path.join(newOutDir, "stream.mp4"),
                startMs,
                durationMs: candidate.durationMs,
                audioStreamIndex: candidate.relativeAudioIndex,
                audioCodec: candidate.input.audioCodec,
              })
            : buildFfmpegArgs({
                inputPath: candidate.path,
                outputDir: newOutDir,
                startSegment: segmentFrom,
                segmentSeconds: HLS_SEGMENT_SECONDS,
                videoCodec: pickVideoEncoder(newProfile.supportedVideoCodecs),
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
          await writeFile(path.join(newOutDir, "playlist.m3u8"), playlist);
        }

        const { transcode, jobId } = await spawnTranscodeJob(
          req.params.sessionId,
          session.mediaFileId,
          newMethod,
          newProfile,
          args,
          segmentFrom,
        );

        liveSessions.set(req.params.sessionId, {
          transcode,
          outDir: newOutDir,
          mediaFile: { path: candidate.path, durationMs: candidate.durationMs, bitrateKbps: candidate.bitrateKbps },
          method: newMethod,
          deviceProfile: newProfile,
          currentSegmentFrom: targetSegment,
          playlistStartSegment: targetSegment,
          currentTranscodeJobId: jobId,
          toneMap,
          subtitleBurnIn: candidate.subtitleBurnIn,
          audioStreamIndex: candidate.relativeAudioIndex,
          audioCodec: candidate.input.audioCodec,
          remux: newMethod === "REMUX" ? { outFile: path.join(newOutDir, "stream.mp4"), startMs, patched: false } : null,
        });

        await db.playbackSession.update({
          where: { id: session.id },
          data: { method: newMethod, positionMs: targetMs },
        });
        return {
          restarted: true,
          method: newMethod,
          segmentFrom: targetSegment,
          pid: transcode.pid,
          actualStartMs: newMethod === "REMUX" ? startMs : undefined,
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

      if (newMethod === "TRANSCODE") {
        const playlist = buildM3u8(live.mediaFile.durationMs, HLS_SEGMENT_SECONDS, targetSegment);
        await writeFile(path.join(newOutDir, "playlist.m3u8"), playlist);
      }

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
      const { transcode, jobId, startMs } = restarted;

      liveSessions.set(req.params.sessionId, {
        ...live,
        transcode,
        outDir: newOutDir,
        currentSegmentFrom: targetSegment,
        playlistStartSegment: targetSegment,
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
        segmentFrom: targetSegment,
        pid: transcode.pid,
        killedPid: oldPid,
        actualStartMs: newMethod === "REMUX" ? startMs : undefined,
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
