import { createReadStream, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { PrismaClient } from "@hokago/db";
import { MediaFileParams, MediaFileFontsResponse, MediaFileTracksResponse, MediaFileTrickplayResponse, ErrorResponse } from "@hokago/contract/media-files";
import { resolveConfigFilePath, configDir } from "./config.js";
import type { ZodFastifyInstance } from "./fastify-zod.js";

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
// the browser this way (they force server-side burn-in instead).
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

// Trickplay sheets are generated with a fixed 5-wide grid (tile filter
// `tile=5x5` in packages/scanner/src/trickplay.ts); the client needs the
// column count to crop a single tile out of a sheet.
const TRICKPLAY_COLS = 5;

// Sheet paths are stored relative to the config dir ("cache/trickplay/{id}/…")
// but host-run tools may have recorded host-absolute paths — accept both.
function resolveTrickplaySheetPath(stored: string): string | null {
  if (existsSync(stored)) return stored;
  const fallback = path.join(configDir(), stored);
  return existsSync(fallback) ? fallback : null;
}

/**
 * Static-byte serving for the four things a browser now needs from our own
 * origin : the direct-play media file, fonts, artwork,
 * and extracted subtitle text. `Cross-Origin-Resource-Policy: cross-origin`
 * on all of them is defense-in-depth for any topology where these aren't
 * proxied to the same origin as the app shell.
 */
export async function registerStaticRoutes(app: ZodFastifyInstance): Promise<void> {
 // DIRECT_PLAY — raw bytes, range-enabled like any static video server.
  // @fastify/static's sendFile does the Range/If-Range/206/416 handling; we
  // only supply the explicit container MIME type (extension-based sniffing
  // would get this wrong for e.g. `.mkv`) and skip its cache headers, which
  // this route never set.
  app.get<{ Params: { id: string } }>(
    "/media-files/:id/direct",
    { preHandler: app.authenticate },
    async (req, reply) => {
      const mediaFile = await db.mediaFile.findUnique({ where: { id: req.params.id } });
    if (!mediaFile || !existsSync(mediaFile.path)) {
      return reply.code(404).send({ error: "media file not found" });
    }

    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    reply.type(CONTAINER_MIME[mediaFile.container ?? ""] ?? "application/octet-stream");
    return reply.sendFile(path.basename(mediaFile.path), path.dirname(mediaFile.path), {
      contentType: false,
      cacheControl: false,
    });
  });

  // Chrome fonts — one font stack, so this is just every vendored font,
  // unconditionally, no per-theme lookup.
  app.get("/fonts", { preHandler: app.authenticate }, async () => {
    const fonts = await db.font.findMany({ where: { source: "VENDORED" } });
    return fonts.map((f) => ({ hash: f.hash, family: f.family, weight: f.weight, style: f.style, url: `/fonts/${f.hash}` }));
  });

 // Font store — hash-keyed, so the response is safe to cache
  // forever regardless of which of the four sources produced it.
  app.get<{ Params: { hash: string } }>(
    "/fonts/:hash",
    { preHandler: app.authenticate },
    async (req, reply) => {
    const font = await db.font.findUnique({ where: { hash: req.params.hash } });
    const fontPath = font && resolveConfigFilePath(font.path, "fonts");
    if (!fontPath) return reply.code(404).send({ error: "font not found" });

    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    reply.type(FONT_MIME[font.format] ?? "application/octet-stream");
    return reply.send(createReadStream(fontPath));
  });

 // Artwork store — bytes fetched once server-side, never a URL.
  app.get<{ Params: { id: string } }>(
    "/artwork/:id",
    { preHandler: app.authenticate },
    async (req, reply) => {
    const artwork = await db.artwork.findUnique({ where: { id: req.params.id } });
    // resolveConfigFilePath handles every legacy path shape: host-absolute
    // (/Users/.../data/config/...), cwd-relative, or container-relative.
    const bytesPath = artwork && resolveConfigFilePath(artwork.bytesPath, "artwork");
    if (!bytesPath) return reply.code(404).send({ error: "artwork not found" });

    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    reply.type(ARTWORK_MIME[path.extname(bytesPath).toLowerCase()] ?? "application/octet-stream");
    return reply.send(createReadStream(bytesPath));
  });

 // Which fonts a media file's ASS track(s) need (MediaFileFont join) —
  // JASSUB's `availableFonts` map is built from this on the client.
  app.get(
    "/media-files/:id/fonts",
    {
      preHandler: app.authenticate,
      schema: { params: MediaFileParams, response: { 200: MediaFileFontsResponse } },
    },
    async (req) => {
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
    },
  );

  // Audio + subtitle tracks for the switcher UI (Step 8).
  app.get(
    "/media-files/:id/tracks",
    {
      preHandler: app.authenticate,
      schema: { params: MediaFileParams, response: { 200: MediaFileTracksResponse, 404: ErrorResponse } },
    },
    async (req, reply) => {
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
    },
  );

  // Scrubber-preview (trickplay) sheet index — the JSON side of the cache
  // under /config/cache/trickplay. 404 (not "empty") when a file has no
  // sheets yet: the player treats that as "no previews", the same way it
  // treats a missing file.
  app.get(
    "/media-files/:id/trickplay",
    {
      preHandler: app.authenticate,
      schema: { params: MediaFileParams, response: { 200: MediaFileTrickplayResponse, 404: ErrorResponse } },
    },
    async (req, reply) => {
      const mediaFile = await db.mediaFile.findUnique({ where: { id: req.params.id } });
      const row = await db.trickplay.findUnique({ where: { mediaFileId: req.params.id } });
      if (!mediaFile || !row || row.sheetPaths.length === 0) {
        return reply.code(404).send({ error: "trickplay not generated" });
      }
      // Tiles are exactly floor(duration / interval) + 1: one per 10s
      // boundary (0, 10, 20…). The last sheet holds the remainder.
      const totalTiles = Math.max(1, Math.ceil((mediaFile.durationMs ?? 0) / row.intervalMs));
      return {
        tileWidth: row.tileWidth,
        tileHeight: row.tileHeight,
        intervalMs: row.intervalMs,
        tilesPerSheet: row.tilesPerSheet,
        cols: TRICKPLAY_COLS,
        sheets: row.sheetPaths.map((_, index) => ({
          index,
          url: `/media-files/${req.params.id}/trickplay/sheets/${index}`,
          tiles: Math.min(row.tilesPerSheet, totalTiles - index * row.tilesPerSheet),
        })),
      };
    },
  );

  // Trickplay sheet bytes — content-addressed by (mediaFile, index), so the
  // response is safe to cache forever. Same COOP/COEP dance as artwork.
  app.get<{ Params: { id: string; index: string } }>(
    "/media-files/:id/trickplay/sheets/:index",
    { preHandler: app.authenticate },
    async (req, reply) => {
      const row = await db.trickplay.findUnique({ where: { mediaFileId: req.params.id } });
      const index = Number.parseInt(req.params.index, 10);
      const sheetPath = row && Number.isInteger(index) && index >= 0 && index < row.sheetPaths.length ? resolveTrickplaySheetPath(row.sheetPaths[index]!) : null;
      if (!sheetPath) return reply.code(404).send({ error: "trickplay sheet not found" });

      reply.header("Cross-Origin-Resource-Policy", "cross-origin");
      reply.header("Cache-Control", "public, max-age=31536000, immutable");
      reply.type("image/jpeg");
      return reply.send(createReadStream(sheetPath));
    },
  );

  // Subtitle text for client-side rendering — external sidecars are
  // read straight off disk; embedded tracks are extracted on demand (no eager
  // extraction step exists for subtitle *text* itself, only for the fonts an
 // ASS track references — — so this has to happen at request time).
  app.get<{ Params: { id: string; trackId: string } }>(
    "/media-files/:id/subtitle-tracks/:trackId",
    { preHandler: app.authenticate },
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
