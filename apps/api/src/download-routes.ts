import { existsSync } from "node:fs";
import { createReadStream, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

import { PrismaClient } from "@hokago/db";
import {
  Queue,
  getConnection,
  QUEUE_NAMES,
  downloadJobId,
  type DownloadJobData,
} from "@hokago/queue";
import {
  DownloadCreateBody,
  DownloadInfo,
  DownloadListQuery,
  DownloadParams,
  DownloadSubtitleParams,
  DownloadFontParams,
  DownloadArtifactManifest,
  ErrorResponse,
} from "@hokago/contract/downloads";
import { RevokedResponse } from "@hokago/contract/auth";
import { z } from "zod";
import { configDir } from "./config.js";
import type { ZodFastifyInstance } from "./fastify-zod.js";

const db = new PrismaClient();

// The worker consumes this queue; the API only ever enqueues. BullMQ Queue in
// the API process is fine — valkey is part of the stack and this is the only
// queue the API touches.
const downloadQueue = new Queue<DownloadJobData>(QUEUE_NAMES.DOWNLOAD, {
  connection: getConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: true,
    removeOnFail: true,
  },
});

export async function closeDownloadQueue(): Promise<void> {
  await downloadQueue.close().catch(() => {});
}

function downloadDir(id: string): string {
  return path.join(configDir(), "downloads", id);
}

// The worker builds the artifact in a sibling tmp dir and renames it in at the
// end — the API only ever sees complete artifacts, so a partial encode can't
// be served mid-write.
function tmpDownloadDir(id: string): string {
  return path.join(configDir(), "downloads", `.${id}.tmp`);
}

const SUBTITLE_MIME: Record<string, string> = {
  ASS: "text/x-ssa",
  SSA: "text/x-ssa",
  SRT: "application/x-subrip",
  VTT: "text/vtt",
};
const MEDIA_MIME: Record<string, string> = {
  mkv: "video/x-matroska",
  mp4: "video/mp4",
  webm: "video/webm",
};
const FONT_MIME: Record<string, string> = {
  WOFF2: "font/woff2",
  WOFF: "font/woff",
  TTF: "font/ttf",
  OTF: "font/otf",
  TTC: "font/collection",
};

interface ArtifactManifest {
  media: { filename: string; sizeBytes: number | null } | null;
  subtitles: { trackId: string; filename: string; format: string; lang: string | null }[];
  fonts: { hash: string; filename: string }[];
}

function readManifest(id: string): ArtifactManifest | null {
  const p = path.join(downloadDir(id), "manifest.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as ArtifactManifest;
  } catch {
    return null;
  }
}

/** Same clamp playback's normalizeDeviceProfile applies to transcode caps. */
function clampCap(v: number | undefined, min: number, max: number, fallback: number | null): number | null {
  if (v === undefined) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

function toDownloadInfo(d: {
  id: string;
  mediaItemId: string;
  mediaFileId: string;
  deviceId: string;
  variant: string;
  targetHeight: number | null;
  targetBitrateKbps: number | null;
  subtitleTrackIds: string[];
  status: "QUEUED" | "PROCESSING" | "READY" | "FAILED";
  sizeBytes: bigint | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: d.id,
    mediaItemId: d.mediaItemId,
    mediaFileId: d.mediaFileId,
    deviceId: d.deviceId,
    variant: d.variant as "original" | "transcode",
    targetHeight: d.targetHeight,
    targetBitrateKbps: d.targetBitrateKbps,
    subtitleTrackIds: d.subtitleTrackIds,
    status: d.status,
    sizeBytes: d.sizeBytes === null ? null : Number(d.sizeBytes),
    error: d.error,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

/** Offline downloads: create/track/serve a packaged artifact (media + subtitles + fonts). */
export async function registerDownloadRoutes(app: ZodFastifyInstance): Promise<void> {
  app.post(
    "/downloads",
    {
      preHandler: app.authenticate,
      schema: {
        body: DownloadCreateBody,
        response: { 201: DownloadInfo, 404: ErrorResponse, 422: ErrorResponse, 503: ErrorResponse },
      },
    },
    async (req, reply) => {
      const { mediaItemId, mediaFileId, deviceId, variant, subtitleTrackIds } = req.body;

      const device = await db.device.findUnique({ where: { id: deviceId } });
      if (!device || device.accountId !== req.accountId) {
        return reply.code(404).send({ error: "device not found" });
      }
      const mediaFile = await db.mediaFile.findUnique({ where: { id: mediaFileId } });
      if (!mediaFile || mediaFile.mediaItemId !== mediaItemId) {
        return reply.code(404).send({ error: "media file not found" });
      }

      // Validate requested subtitle tracks up front so a job never fails late.
      const selected: string[] = subtitleTrackIds ?? [];
      const selectedBitmap: string[] = [];
      if (selected.length > 0) {
        const tracks = await db.subtitleTrack.findMany({
          where: { id: { in: selected }, mediaFileId },
          select: { id: true, requiresBurnIn: true },
        });
        if (tracks.length !== selected.length) {
          return reply.code(404).send({ error: "one or more subtitle tracks not found on this file" });
        }
        for (const t of tracks) if (t.requiresBurnIn) selectedBitmap.push(t.id);
      }
      if (variant.kind === "original" && selectedBitmap.length > 0) {
        return reply.code(422).send({
          error: "bitmap subtitle tracks (PGS/VOBSUB/DVBSUB) can't be packaged on an original download — use a transcode variant to burn them in",
        });
      }
      // Transcode variant burns at most one bitmap track (the filtergraph is
      // single-overlay); more than one is an invalid request.
      if (variant.kind === "transcode" && selectedBitmap.length > 1) {
        return reply.code(422).send({ error: "at most one bitmap subtitle track can be burned in per download" });
      }

      const targetHeight = variant.kind === "transcode" ? clampCap(variant.maxHeight, 64, 4320, null) : null;
      const targetBitrateKbps =
        variant.kind === "transcode" ? clampCap(variant.maxBitrateKbps, 200, 100_000, null) : null;

      const download = await db.download.create({
        data: {
          accountId: req.accountId!,
          deviceId,
          mediaItemId,
          mediaFileId,
          variant: variant.kind,
          targetHeight,
          targetBitrateKbps,
          subtitleTrackIds: selected,
          status: "QUEUED",
        },
      });
      // Enqueue can fail transiently (valkey restarting) — the row exists, so
      // fail it visibly rather than leave a QUEUED zombie the client waits on.
      try {
        await downloadQueue.add(QUEUE_NAMES.DOWNLOAD, { downloadId: download.id }, { jobId: downloadJobId(download.id) });
      } catch (err) {
        await db.download.update({ where: { id: download.id }, data: { status: "FAILED", error: String(err) } });
        return reply.code(503).send({ error: "could not enqueue download — try again" });
      }

      return reply.code(201).send(toDownloadInfo(download));
    },
  );

  app.get(
    "/downloads",
    {
      preHandler: app.authenticate,
      schema: { querystring: DownloadListQuery, response: { 200: z.array(DownloadInfo) } },
    },
    async (req) => {
      const rows = await db.download.findMany({
        where: { accountId: req.accountId, ...(req.query.deviceId ? { deviceId: req.query.deviceId } : {}) },
        orderBy: { createdAt: "desc" },
      });
      return rows.map(toDownloadInfo);
    },
  );

  app.get(
    "/downloads/:id",
    {
      preHandler: app.authenticate,
      schema: { params: DownloadParams, response: { 200: DownloadInfo, 404: ErrorResponse } },
    },
    async (req, reply) => {
      const download = await db.download.findUnique({ where: { id: req.params.id } });
      if (!download || download.accountId !== req.accountId) {
        return reply.code(404).send({ error: "download not found" });
      }
      return toDownloadInfo(download);
    },
  );

  app.delete(
    "/downloads/:id",
    {
      preHandler: app.authenticate,
      schema: { params: DownloadParams, response: { 200: RevokedResponse, 404: ErrorResponse } },
    },
    async (req, reply) => {
      const download = await db.download.findUnique({ where: { id: req.params.id } });
      if (!download || download.accountId !== req.accountId) {
        return reply.code(404).send({ error: "download not found" });
      }
      // Drop a still-queued job so the worker never picks it up.
      await downloadQueue.remove(downloadJobId(download.id)).catch(() => {});
      await db.download.delete({ where: { id: download.id } });
      await Promise.all([rm(downloadDir(download.id), { recursive: true, force: true }), rm(tmpDownloadDir(download.id), { recursive: true, force: true })]);
      return { revoked: true };
    },
  );

  app.get(
    "/downloads/:id/artifact",
    {
      preHandler: app.authenticate,
      schema: { params: DownloadParams, response: { 200: DownloadArtifactManifest, 404: ErrorResponse } },
    },
    async (req, reply) => {
      const download = await db.download.findUnique({ where: { id: req.params.id } });
      if (!download || download.accountId !== req.accountId || download.status !== "READY") {
        return reply.code(404).send({ error: "download not ready" });
      }
      const manifest = readManifest(req.params.id);
      if (!manifest) return reply.code(404).send({ error: "artifact missing" });
      return {
        media: manifest.media
          ? { ...manifest.media, url: `/downloads/${req.params.id}/artifact/media` }
          : null,
        subtitles: manifest.subtitles.map((s) => ({
          ...s,
          url: `/downloads/${req.params.id}/artifact/subtitles/${s.trackId}`,
        })),
        fonts: manifest.fonts.map((f) => ({
          ...f,
          url: `/downloads/${req.params.id}/artifact/fonts/${f.hash}`,
        })),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/downloads/:id/artifact/media",
    { preHandler: app.authenticate },
    async (req, reply) => {
      const download = await db.download.findUnique({ where: { id: req.params.id } });
      if (!download || download.accountId !== req.accountId || download.status !== "READY") {
        return reply.code(404).send({ error: "download not ready" });
      }
      const manifest = readManifest(req.params.id);
      if (!manifest?.media) return reply.code(404).send({ error: "artifact missing" });
      const filePath = path.join(downloadDir(req.params.id), manifest.media.filename);
      if (!existsSync(filePath)) return reply.code(404).send({ error: "artifact missing" });

      reply.header("Cross-Origin-Resource-Policy", "cross-origin");
      const ext = path.extname(manifest.media.filename).slice(1).toLowerCase();
      reply.type(MEDIA_MIME[ext] ?? "application/octet-stream");
      return reply.sendFile(path.basename(filePath), path.dirname(filePath), {
        contentType: false,
        cacheControl: false,
        acceptRanges: true,
      });
    },
  );

  app.get<{ Params: z.infer<typeof DownloadSubtitleParams> }>(
    "/downloads/:id/artifact/subtitles/:trackId",
    { preHandler: app.authenticate },
    async (req, reply) => {
      const download = await db.download.findUnique({ where: { id: req.params.id } });
      if (!download || download.accountId !== req.accountId || download.status !== "READY") {
        return reply.code(404).send({ error: "download not ready" });
      }
      const manifest = readManifest(req.params.id);
      const entry = manifest?.subtitles.find((s) => s.trackId === req.params.trackId);
      if (!entry) return reply.code(404).send({ error: "subtitle not in this download" });
      const filePath = path.join(downloadDir(req.params.id), entry.filename);
      if (!existsSync(filePath)) return reply.code(404).send({ error: "artifact missing" });

      reply.header("Cross-Origin-Resource-Policy", "cross-origin");
      reply.type(SUBTITLE_MIME[entry.format] ?? "text/plain");
      return reply.send(createReadStream(filePath));
    },
  );

  app.get<{ Params: z.infer<typeof DownloadFontParams> }>(
    "/downloads/:id/artifact/fonts/:hash",
    { preHandler: app.authenticate },
    async (req, reply) => {
      const download = await db.download.findUnique({ where: { id: req.params.id } });
      if (!download || download.accountId !== req.accountId || download.status !== "READY") {
        return reply.code(404).send({ error: "download not ready" });
      }
      const manifest = readManifest(req.params.id);
      const entry = manifest?.fonts.find((f) => f.hash === req.params.hash);
      if (!entry) return reply.code(404).send({ error: "font not in this download" });
      const filePath = path.join(downloadDir(req.params.id), entry.filename);
      if (!existsSync(filePath)) return reply.code(404).send({ error: "artifact missing" });

      const ext = path.extname(entry.filename).slice(1).toUpperCase();
      reply.header("Cross-Origin-Resource-Policy", "cross-origin");
      reply.header("Cache-Control", "public, max-age=31536000, immutable");
      reply.type(FONT_MIME[ext] ?? "application/octet-stream");
      return reply.send(createReadStream(filePath));
    },
  );
}
