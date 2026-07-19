import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FastifyInstance } from "fastify";
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

function configDir(): string {
  return process.env.HOKAGO_CONFIG_DIR ?? "./data/config";
}

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
  currentTranscodeJobId: string;
  toneMap: boolean;
  subtitleBurnIn?: { streamIndex: number; bitmap: boolean };
  audioStreamIndex: number;
}

// Each audio selection gets its own segment subdirectory — switching tracks
// mid-stream must never reuse (and silently overwrite with different audio
// content) segment files a player may still rewind into (§11.4).
function audioOutDir(sessionId: string, audioStreamIndex: number): string {
  return path.join(transcodeDir(sessionId), `a${audioStreamIndex}`);
}

// PGS/VOBSUB/DVBSUB are bitmap subtitle formats — burned in via ffmpeg's
// `overlay` filter (decodes the bitmap and composites it). Everything else is
// text, burned in via libass's `subtitles` filter (§13.4).
const BITMAP_SUBTITLE_FORMATS = new Set(["PGS", "VOBSUB", "DVBSUB"]);

// ffmpeg's `0:a:N` addresses the Nth AUDIO-type stream, not the absolute
// container stream index MediaStream.streamIndex stores — same conversion
// subtitleBurnIn already does for `si=N` above.
function relativeAudioIndex(streams: { type: string; streamIndex: number }[], absoluteIndex: number): number {
  return streams.filter((s) => s.type === "AUDIO" && s.streamIndex < absoluteIndex).length;
}

const db = new PrismaClient();
const liveSessions = new Map<string, LiveSession>();

interface StartBody {
  profileId: string;
  mediaItemId: string;
  mediaFileId: string;
  deviceProfile: DeviceProfile;
  subtitleTrackId?: string;
  audioStreamIndex?: number;
}

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
  // TRANSCODE decision (§11.4) — picking a non-default track with an
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

/** §11.1/§11.2 — three-tier playback decision, on-demand HLS, seek-restart. apps/api owns the live ffmpeg process directly (separate container/PID namespace from apps/worker). */
export async function registerPlaybackRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: StartBody }>("/playback/start", async (req, reply) => {
    const { profileId, mediaItemId, mediaFileId, deviceProfile, subtitleTrackId, audioStreamIndex } = req.body;
    const candidate = await buildCandidateInput(mediaFileId, subtitleTrackId, audioStreamIndex);
    if (!candidate) return reply.code(404).send({ error: "media file not found" });

    const decision = decidePlaybackMethod(candidate.input, deviceProfile);

    const session = await db.playbackSession.create({
      data: {
        profileId,
        mediaItemId,
        mediaFileId,
        method: decision.method,
        deviceProfile: deviceProfile as object,
      },
    });

    if (decision.method === "DIRECT_PLAY") {
      return { sessionId: session.id, method: decision.method, reasons: decision.reasons, playlistUrl: null };
    }

    const audioIndex = candidate.relativeAudioIndex;
    const outDir = audioOutDir(session.id, audioIndex);
    await mkdir(outDir, { recursive: true });

    const toneMap = needsToneMap(candidate.input.isHdr, deviceProfile.supportsHdr);
    const args = buildFfmpegArgs({
      inputPath: candidate.path,
      outputDir: outDir,
      method: decision.method,
      startSegment: 0,
      segmentSeconds: HLS_SEGMENT_SECONDS,
      videoCodec: pickVideoEncoder(deviceProfile.supportedVideoCodecs),
      audioCodec: pickAudioEncoder(deviceProfile.supportedAudioCodecs),
      audioStreamIndex: audioIndex,
      maxWidth: deviceProfile.maxWidth,
      maxHeight: deviceProfile.maxHeight,
      maxVideoBitrateKbps: deviceProfile.maxVideoBitrateKbps,
      toneMap,
      subtitleBurnIn: candidate.subtitleBurnIn,
    });

    const job = await db.transcodeJob.create({
      data: {
        sessionId: session.id,
        mediaFileId,
        method: decision.method,
        deviceProfile: deviceProfile as object,
        state: "RUNNING",
        segmentFrom: 0,
        startedAt: new Date(),
      },
    });

    const transcode = spawnFfmpeg(args, (code) => {
      void db.transcodeJob.update({
        where: { id: job.id },
        data: { state: code === 0 ? "DONE" : "FAILED", endedAt: new Date() },
      });
    });
    await db.transcodeJob.update({ where: { id: job.id }, data: { pid: transcode.pid } });

    const playlist = buildM3u8(candidate.durationMs, HLS_SEGMENT_SECONDS);
    await writeFile(path.join(outDir, "playlist.m3u8"), playlist);

    liveSessions.set(session.id, {
      transcode,
      outDir,
      mediaFile: { path: candidate.path, durationMs: candidate.durationMs },
      method: decision.method,
      deviceProfile,
      currentSegmentFrom: 0,
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
    };
  });

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

      const deadline = Date.now() + HLS_SEGMENT_SECONDS * 2 * 1000;
      while (!existsSync(segPath) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!existsSync(segPath)) return reply.code(404).send({ error: "segment not ready" });

      const body = await readFile(segPath);
      reply.type("video/mp2t").send(body);
    },
  );

  app.post<{ Params: { sessionId: string }; Body: { positionMs: number } }>(
    "/playback/:sessionId/seek",
    async (req, reply) => {
      const live = liveSessions.get(req.params.sessionId);
      if (!live) return reply.code(404).send({ error: "no active transcode session" });

      const targetSegment = Math.floor(req.body.positionMs / 1000 / HLS_SEGMENT_SECONDS);
      const targetPath = path.join(live.outDir, `segment-${targetSegment}.ts`);

      if (existsSync(targetPath)) {
        return { restarted: false, segmentFrom: live.currentSegmentFrom, pid: live.transcode.pid };
      }

      const oldPid = live.transcode.pid;
      // The ffmpeg child may have already finished on its own (e.g. it reached
      // the end of the file) before this seek arrived — `exit` only ever fires
      // once, so attaching a listener after the fact would hang forever.
      if (live.transcode.child.exitCode === null && live.transcode.child.signalCode === null) {
        await new Promise<void>((resolve) => {
          live.transcode.child.once("exit", () => resolve());
          live.transcode.child.kill("SIGKILL");
        });
      }
      await db.transcodeJob.update({
        where: { id: live.currentTranscodeJobId },
        data: { state: "CANCELLED", endedAt: new Date() },
      });

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
          sessionId: req.params.sessionId,
          mediaFileId: (await db.playbackSession.findUniqueOrThrow({ where: { id: req.params.sessionId } }))
            .mediaFileId,
          method: live.method,
          deviceProfile: live.deviceProfile as object,
          state: "RUNNING",
          segmentFrom: targetSegment,
          startedAt: new Date(),
        },
      });

      const transcode = spawnFfmpeg(args, (code) => {
        void db.transcodeJob.update({
          where: { id: job.id },
          data: { state: code === 0 ? "DONE" : "FAILED", endedAt: new Date() },
        });
      });
      await db.transcodeJob.update({ where: { id: job.id }, data: { pid: transcode.pid } });

      liveSessions.set(req.params.sessionId, {
        ...live,
        transcode,
        currentSegmentFrom: targetSegment,
        currentTranscodeJobId: job.id,
      });

      return { restarted: true, segmentFrom: targetSegment, pid: transcode.pid, killedPid: oldPid };
    },
  );

  // Audio-track switch (§11.4/Step 8) — always restarts ffmpeg, unlike /seek,
  // because the target segment may already exist on disk with the *previous*
  // audio track muxed in and reusing it would silently serve the wrong audio.
  // A fresh per-track outDir (audioOutDir) sidesteps that instead of trying to
  // invalidate/overwrite segments a player might still rewind into.
  app.post<{ Params: { sessionId: string }; Body: { audioStreamIndex: number; positionMs: number } }>(
    "/playback/:sessionId/audio-track",
    async (req, reply) => {
      const live = liveSessions.get(req.params.sessionId);
      if (!live) return reply.code(404).send({ error: "no active transcode session" });

      const playbackSession = await db.playbackSession.findUniqueOrThrow({ where: { id: req.params.sessionId } });
      const mediaFile = await db.mediaFile.findUniqueOrThrow({
        where: { id: playbackSession.mediaFileId },
        include: { streams: true },
      });
      const audioIndex = relativeAudioIndex(mediaFile.streams, req.body.audioStreamIndex);

      const targetSegment = Math.floor(req.body.positionMs / 1000 / HLS_SEGMENT_SECONDS);
      const newOutDir = audioOutDir(req.params.sessionId, audioIndex);
      await mkdir(newOutDir, { recursive: true });

      const oldPid = live.transcode.pid;
      if (live.transcode.child.exitCode === null && live.transcode.child.signalCode === null) {
        await new Promise<void>((resolve) => {
          live.transcode.child.once("exit", () => resolve());
          live.transcode.child.kill("SIGKILL");
        });
      }
      await db.transcodeJob.update({
        where: { id: live.currentTranscodeJobId },
        data: { state: "CANCELLED", endedAt: new Date() },
      });

      const playlist = buildM3u8(live.mediaFile.durationMs, HLS_SEGMENT_SECONDS);
      await writeFile(path.join(newOutDir, "playlist.m3u8"), playlist);

      const args = buildFfmpegArgs({
        inputPath: live.mediaFile.path,
        outputDir: newOutDir,
        method: live.method,
        startSegment: targetSegment,
        segmentSeconds: HLS_SEGMENT_SECONDS,
        videoCodec: pickVideoEncoder(live.deviceProfile.supportedVideoCodecs),
        audioCodec: pickAudioEncoder(live.deviceProfile.supportedAudioCodecs),
        audioStreamIndex: audioIndex,
        maxWidth: live.deviceProfile.maxWidth,
        maxHeight: live.deviceProfile.maxHeight,
        maxVideoBitrateKbps: live.deviceProfile.maxVideoBitrateKbps,
        toneMap: live.toneMap,
        subtitleBurnIn: live.subtitleBurnIn,
      });

      const job = await db.transcodeJob.create({
        data: {
          sessionId: req.params.sessionId,
          mediaFileId: playbackSession.mediaFileId,
          method: live.method,
          deviceProfile: live.deviceProfile as object,
          state: "RUNNING",
          segmentFrom: targetSegment,
          startedAt: new Date(),
        },
      });

      const transcode = spawnFfmpeg(args, (code) => {
        void db.transcodeJob.update({
          where: { id: job.id },
          data: { state: code === 0 ? "DONE" : "FAILED", endedAt: new Date() },
        });
      });
      await db.transcodeJob.update({ where: { id: job.id }, data: { pid: transcode.pid } });

      liveSessions.set(req.params.sessionId, {
        ...live,
        transcode,
        outDir: newOutDir,
        currentSegmentFrom: targetSegment,
        currentTranscodeJobId: job.id,
        audioStreamIndex: audioIndex,
      });

      return { restarted: true, segmentFrom: targetSegment, pid: transcode.pid, killedPid: oldPid };
    },
  );
}

export function livePlaybackPids(): number[] {
  return [...liveSessions.values()].map((s) => s.transcode.pid);
}
