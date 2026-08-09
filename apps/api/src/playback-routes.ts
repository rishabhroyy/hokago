import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { PrismaClient } from "@hokago/db";
import { decidePlaybackMethod } from "@hokago/ffmpeg/decision";
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
  ErrorResponse,
} from "@hokago/contract/playback";
import type { ZodFastifyInstance } from "./fastify-zod.js";

function transcodeDir(sessionId: string): string {
  return path.join(configDir(), "transcode", sessionId);
}

interface LiveSession {
  transcode: RunningTranscode;
  outDir: string;
  mediaFile: { path: string; durationMs: number };
  method: "DIRECT_STREAM" | "TRANSCODE";
  deviceProfile: DeviceProfile;
  currentSegmentFrom: number;
  /** Media sequence the current playlist.m3u8 was written with — seeks below this need a playlist rewrite. */
  playlistStartSegment: number;
  currentTranscodeJobId: string;
  toneMap: boolean;
  subtitleBurnIn?: { streamIndex: number; bitmap: boolean };
  audioStreamIndex: number;
}

// Each audio selection gets its own segment subdirectory — switching tracks
// mid-stream must never reuse (and silently overwrite with different audio
// content) segment files a player may still rewind into.
function audioOutDir(sessionId: string, audioStreamIndex: number): string {
  return path.join(transcodeDir(sessionId), `a${audioStreamIndex}`);
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
    subtitleBurnIn,
    relativeAudioIndex: audioStream ? relativeAudioIndex(mediaFile.streams, audioStream.streamIndex) : 0,
  };
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
 * transcode slot, and marks the PlaybackSession ended. Called by the /stop
 * route, the idle reaper, and shutdown — without this, ffmpeg keeps burning
 * CPU forever for every tab that stops playing.
 */
export async function stopSession(sessionId: string): Promise<void> {
  await killSessionTranscode(sessionId);
  await db.playbackSession.updateMany({
    where: { id: sessionId, endedAt: null },
    data: { endedAt: new Date() },
  });
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

async function restartTranscode(
  sessionId: string,
  live: LiveSession,
  targetSegment: number,
): Promise<{ transcode: RunningTranscode; jobId: string } | { cancelled: true }> {
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

  const args = buildFfmpegArgs({
    inputPath: live.mediaFile.path,
    outputDir: live.outDir,
    method: live.method,
    startSegment: targetSegment,
    segmentSeconds: HLS_SEGMENT_SECONDS,
    videoCodec: pickVideoEncoder(live.deviceProfile.supportedVideoCodecs),
    audioCodec: pickAudioEncoder(live.deviceProfile.supportedAudioCodecs),
    audioStreamIndex: live.audioStreamIndex,
    maxWidth: live.deviceProfile.maxWidth,
    maxHeight: live.deviceProfile.maxHeight,
    maxVideoBitrateKbps: live.deviceProfile.maxVideoBitrateKbps,
    toneMap: live.toneMap,
    subtitleBurnIn: live.subtitleBurnIn,
  });

  const job = await db.transcodeJob.create({
    data: {
      sessionId,
      mediaFileId: (await db.playbackSession.findUniqueOrThrow({ where: { id: sessionId } })).mediaFileId,
      method: live.method,
      deviceProfile: live.deviceProfile as object,
      state: "RUNNING",
      segmentFrom: targetSegment,
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

  return { transcode, jobId: job.id };
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

    const session = await db.playbackSession.create({
      data: {
        profileId,
        mediaItemId,
        mediaFileId,
        method: decision.method,
        deviceProfile: profile as object,
        positionMs: resumeMs,
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
        resumePositionMs: resumeMs,
      };
    }

    // Bounded ffmpeg concurrency: wait for a slot instead of stacking
    // transcodes on the box. 503 tells the client to retry shortly.
    if (!(await acquireTranscodeSlot())) {
      await db.playbackSession.updateMany({ where: { id: session.id }, data: { endedAt: new Date() } });
      return reply.code(503).send({ error: "transcoder busy — too many concurrent transcodes, retry shortly" });
    }

    const startSegment = resumeMs > 0 ? segmentFor(resumeMs, candidate.durationMs) : 0;
    const audioIndex = candidate.relativeAudioIndex;
    const outDir = audioOutDir(session.id, audioIndex);
    await mkdir(outDir, { recursive: true });

    const toneMap = needsToneMap(candidate.input.isHdr, profile.supportsHdr);
    const args = buildFfmpegArgs({
      inputPath: candidate.path,
      outputDir: outDir,
      method: decision.method,
      startSegment,
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

    const job = await db.transcodeJob.create({
      data: {
        sessionId: session.id,
        mediaFileId,
        method: decision.method,
        deviceProfile: profile as object,
        state: "RUNNING",
        segmentFrom: startSegment,
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

    // Playlist starts at the resume segment (EXT-X-MEDIA-SEQUENCE) so the
    // player never waits on segment-0, which a resumed session never writes.
    const playlist = buildM3u8(candidate.durationMs, HLS_SEGMENT_SECONDS, startSegment);
    await writeFile(path.join(outDir, "playlist.m3u8"), playlist);

    liveSessions.set(session.id, {
      transcode,
      outDir,
      mediaFile: { path: candidate.path, durationMs: candidate.durationMs },
      method: decision.method,
      deviceProfile: profile,
      currentSegmentFrom: startSegment,
      playlistStartSegment: startSegment,
      currentTranscodeJobId: job.id,
      toneMap,
      subtitleBurnIn: candidate.subtitleBurnIn,
      audioStreamIndex: audioIndex,
    });

    return {
      sessionId: session.id,
      method: decision.method,
      reasons: decision.reasons,
      playlistUrl: `/playback/${session.id}/playlist.m3u8`,
      resumePositionMs: resumeMs,
    };
    },
  );

  app.get<{ Params: { sessionId: string } }>("/playback/:sessionId/playlist.m3u8", async (req, reply) => {
    const live = liveSessions.get(req.params.sessionId);
    if (!live) return reply.code(404).send({ error: "no active session" });
    const body = await readFile(path.join(live.outDir, "playlist.m3u8"), "utf-8");
    reply.type("application/vnd.apple.mpegurl").send(body);
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
        if (
          live.transcode.child.exitCode !== null &&
          live.transcode.child.signalCode !== null &&
          !existsSync(segPath)
        ) {
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

      const targetSegment = segmentFor(req.body.positionMs, live.mediaFile.durationMs);
      const targetPath = path.join(live.outDir, `segment-${targetSegment}.ts`);

      // Already produced (and listed by the current playlist) — nothing to do.
      if (existsSync(targetPath) && targetSegment >= live.playlistStartSegment) {
        await db.playbackSession.update({ where: { id: req.params.sessionId }, data: { positionMs: req.body.positionMs } });
        return { restarted: false, segmentFrom: live.currentSegmentFrom, pid: live.transcode.pid };
      }

      const oldPid = live.transcode.pid;
      await cancelCurrentJob(req.params.sessionId);

      const restarted = await restartTranscode(req.params.sessionId, live, targetSegment);
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

      await db.playbackSession.update({ where: { id: req.params.sessionId }, data: { positionMs: req.body.positionMs } });
      return { restarted: true, segmentFrom: targetSegment, pid: transcode.pid, killedPid: oldPid };
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

      const targetSegment = segmentFor(req.body.positionMs, live.mediaFile.durationMs);
      const newOutDir = audioOutDir(req.params.sessionId, audioIndex);
      await mkdir(newOutDir, { recursive: true });

      const oldPid = live.transcode.pid;
      await cancelCurrentJob(req.params.sessionId);

      // New outDir → the media sequence starts at the target segment.
      const playlist = buildM3u8(live.mediaFile.durationMs, HLS_SEGMENT_SECONDS, targetSegment);
      await writeFile(path.join(newOutDir, "playlist.m3u8"), playlist);

      const restarted = await restartTranscode(
        req.params.sessionId,
        { ...live, outDir: newOutDir },
        targetSegment,
      );
      if ("cancelled" in restarted) {
        return reply.code(503).send({ error: "transcoder busy or session ended — retry shortly" });
      }
      const { transcode, jobId } = restarted;

      liveSessions.set(req.params.sessionId, {
        ...live,
        transcode,
        outDir: newOutDir,
        currentSegmentFrom: targetSegment,
        playlistStartSegment: targetSegment,
        currentTranscodeJobId: jobId,
        audioStreamIndex: audioIndex,
      });

      await db.playbackSession.update({ where: { id: req.params.sessionId }, data: { positionMs: req.body.positionMs } });
      return { restarted: true, segmentFrom: targetSegment, pid: transcode.pid, killedPid: oldPid };
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
