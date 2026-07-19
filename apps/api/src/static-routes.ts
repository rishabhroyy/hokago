import { createReadStream, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@hokago/db";

const db = new PrismaClient();

const CONTAINER_MIME: Record<string, string> = {
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

const ARTWORK_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

// Text subtitle formats only — PGS/VOBSUB/DVBSUB are bitmap and never reach
// the browser this way (§13.4: they force server-side burn-in instead).
const SUBTITLE_MUX: Record<string, string> = {
  ASS: "ass",
  SSA: "ass",
  SRT: "srt",
  VTT: "webvtt",
};
const SUBTITLE_MIME: Record<string, string> = {
  ASS: "text/x-ssa",
  SSA: "text/x-ssa",
  SRT: "application/x-subrip",
  VTT: "text/vtt",
};

/**
 * Same convention `buildCandidateInput` in playback-routes.ts already fixed
 * for filtergraph addressing: ffmpeg's `-map 0:s:N` is relative to subtitle-
 * type streams only, not the absolute container stream index this DB stores.
 */
async function subtitleRelativeIndex(mediaFileId: string, absoluteStreamIndex: number): Promise<number> {
  const preceding = await db.mediaStream.count({
    where: { mediaFileId, type: "SUBTITLE", streamIndex: { lt: absoluteStreamIndex } },
  });
  return preceding;
}

/**
 * Static-byte serving for the four things a browser now needs from our own
 * origin (§1.1, §13.2, §13.3): the direct-play media file, fonts, artwork,
 * and extracted subtitle text. `Cross-Origin-Resource-Policy: cross-origin`
 * on all of them is defense-in-depth for any topology where these aren't
 * proxied to the same origin as the app shell.
 */
export async function registerStaticRoutes(app: FastifyInstance): Promise<void> {
  // DIRECT_PLAY (§11.1) — raw bytes, range-enabled like any static video server.
  app.get<{ Params: { id: string } }>("/media-files/:id/direct", async (req, reply) => {
    const mediaFile = await db.mediaFile.findUnique({ where: { id: req.params.id } });
    if (!mediaFile || !existsSync(mediaFile.path)) {
      return reply.code(404).send({ error: "media file not found" });
    }

    const stat = statSync(mediaFile.path);
    const mime = CONTAINER_MIME[mediaFile.container ?? ""] ?? "application/octet-stream";
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    reply.header("Accept-Ranges", "bytes");

    const range = req.headers.range;
    if (!range) {
      reply.header("Content-Length", stat.size);
      reply.type(mime);
      return reply.send(createReadStream(mediaFile.path));
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return reply.code(416).send({ error: "invalid range" });
    const start = match[1] ? parseInt(match[1], 10) : 0;
    const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
    if (start >= stat.size || end >= stat.size || start > end) {
      reply.header("Content-Range", `bytes */${stat.size}`);
      return reply.code(416).send({ error: "range not satisfiable" });
    }

    reply.code(206);
    reply.header("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    reply.header("Content-Length", end - start + 1);
    reply.type(mime);
    return reply.send(createReadStream(mediaFile.path, { start, end }));
  });

  // Font store (§1.1, §13.2) — hash-keyed, so the response is safe to cache
  // forever regardless of which of the four sources produced it.
  app.get<{ Params: { hash: string } }>("/fonts/:hash", async (req, reply) => {
    const font = await db.font.findUnique({ where: { hash: req.params.hash } });
    if (!font || !existsSync(font.path)) return reply.code(404).send({ error: "font not found" });

    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    reply.type(FONT_MIME[font.format] ?? "application/octet-stream");
    return reply.send(createReadStream(font.path));
  });

  // Artwork store (§3.5, §7.6) — bytes fetched once server-side, never a URL.
  app.get<{ Params: { id: string } }>("/artwork/:id", async (req, reply) => {
    const artwork = await db.artwork.findUnique({ where: { id: req.params.id } });
    if (!artwork || !existsSync(artwork.bytesPath)) return reply.code(404).send({ error: "artwork not found" });

    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    reply.type(ARTWORK_MIME[path.extname(artwork.bytesPath).toLowerCase()] ?? "application/octet-stream");
    return reply.send(createReadStream(artwork.bytesPath));
  });

  // Which fonts a media file's ASS track(s) need (§13.2 MediaFileFont join) —
  // JASSUB's `availableFonts` map is built from this on the client.
  app.get<{ Params: { id: string } }>("/media-files/:id/fonts", async (req, reply) => {
    const links = await db.mediaFileFont.findMany({
      where: { mediaFileId: req.params.id },
      include: { font: true },
    });
    return links.map((l) => ({
      hash: l.font.hash,
      family: l.font.family,
      weight: l.font.weight,
      style: l.font.style,
      url: `/fonts/${l.font.hash}`,
    }));
  });

  // Audio + subtitle tracks for the switcher UI (Step 8).
  app.get<{ Params: { id: string } }>("/media-files/:id/tracks", async (req, reply) => {
    const mediaFile = await db.mediaFile.findUnique({
      where: { id: req.params.id },
      include: { streams: true, subtitleTracks: true },
    });
    if (!mediaFile) return reply.code(404).send({ error: "media file not found" });

    return {
      audio: mediaFile.streams
        .filter((s) => s.type === "AUDIO")
        .map((s) => ({ streamIndex: s.streamIndex, codec: s.codec, lang: s.lang, title: s.title, isDefault: s.isDefault })),
      subtitles: mediaFile.subtitleTracks.map((t) => ({
        id: t.id,
        lang: t.lang,
        title: t.title,
        format: t.format,
        forced: t.forced,
        sdh: t.sdh,
        requiresBurnIn: t.requiresBurnIn,
      })),
    };
  });

  // Subtitle text for client-side rendering (§13.1) — external sidecars are
  // read straight off disk; embedded tracks are extracted on demand (no eager
  // extraction step exists for subtitle *text* itself, only for the fonts an
  // ASS track references — §13.2 — so this has to happen at request time).
  app.get<{ Params: { id: string; trackId: string } }>(
    "/media-files/:id/subtitle-tracks/:trackId",
    async (req, reply) => {
      const track = await db.subtitleTrack.findUnique({ where: { id: req.params.trackId } });
      if (!track || track.mediaFileId !== req.params.id) {
        return reply.code(404).send({ error: "subtitle track not found" });
      }
      const muxer = SUBTITLE_MUX[track.format];
      if (!muxer) return reply.code(422).send({ error: `${track.format} is bitmap — not client-renderable, requires burn-in` });

      reply.header("Cross-Origin-Resource-Policy", "cross-origin");
      reply.type(SUBTITLE_MIME[track.format]);

      if (track.path) {
        if (!existsSync(track.path)) return reply.code(404).send({ error: "sidecar file missing" });
        return reply.send(createReadStream(track.path));
      }

      if (track.streamIndex === null) return reply.code(404).send({ error: "no stream index for embedded track" });
      const mediaFile = await db.mediaFile.findUniqueOrThrow({ where: { id: req.params.id } });
      const relIndex = await subtitleRelativeIndex(req.params.id, track.streamIndex);
      const bytes = execFileSync("ffmpeg", [
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
      return reply.send(bytes);
    },
  );
}
