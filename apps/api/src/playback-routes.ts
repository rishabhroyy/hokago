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
}

// PGS/VOBSUB/DVBSUB are bitmap subtitle formats — burned in via ffmpeg's
// `overlay` filter (decodes the bitmap and composites it). Everything else is
// text, burned in via libass's `subtitles` filter (§13.4).
const BITMAP_SUBTITLE_FORMATS = new Set(["PGS", "VOBSUB", "DVBSUB"]);

const db = new PrismaClient();
const liveSessions = new Map<string, LiveSession>();

interface StartBody {
  profileId: string;
  mediaItemId: string;
  mediaFileId: string;
  deviceProfile: DeviceProfile;
  subtitleTrackId?: string;
}

async function buildCandidateInput(
  mediaFileId: string,
  subtitleTrackId?: string,
): Promise<{
  input: PlaybackCandidateInput;
  path: string;
  durationMs: number;
  subtitleBurnIn?: { streamIndex: number; bitmap: boolean };
} | null> {
  const mediaFile = await db.mediaFile.findUnique({
    where: { id: mediaFileId },
    include: { streams: true, subtitleTracks: true },
  });
  if (!mediaFile) return null;

  const videoStream = mediaFile.streams.find((s) => s.type === "VIDEO");
  const audioStream = mediaFile.streams.find((s) => s.type === "AUDIO");
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
  };
}

/** §11.1/§11.2 — three-tier playback decision, on-demand HLS, seek-restart. apps/api owns the live ffmpeg process directly (separate container/PID namespace from apps/worker). */
export async function registerPlaybackRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: StartBody }>("/playback/start", async (req, reply) => {
    const { profileId, mediaItemId, mediaFileId, deviceProfile, subtitleTrackId } = req.body;
    const candidate = await buildCandidateInput(mediaFileId, subtitleTrackId);
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

    const outDir = transcodeDir(session.id);
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
}

export function livePlaybackPids(): number[] {
  return [...liveSessions.values()].map((s) => s.transcode.pid);
}
