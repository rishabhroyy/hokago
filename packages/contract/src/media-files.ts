/** subtitle/audio track listing and font linking for a media file. Binary byte-range/font/artwork routes are never JSON and stay outside this contract. */

import { z } from "zod";

export const MediaFileParams = z.object({ id: z.string() });

export const FontDescriptor = z.object({
  hash: z.string(),
  family: z.string(),
  weight: z.number().nullable(),
  style: z.string().nullable(),
  url: z.string(),
});
export type FontDescriptor = z.infer<typeof FontDescriptor>;
export const MediaFileFontsResponse = z.array(FontDescriptor);

export const AudioTrackInfo = z.object({
  streamIndex: z.number(),
  codec: z.string().nullable(),
  lang: z.string().nullable(),
  title: z.string().nullable(),
  isDefault: z.boolean(),
});
export type AudioTrackInfo = z.infer<typeof AudioTrackInfo>;

export const SubtitleTrackInfo = z.object({
  id: z.string(),
  lang: z.string().nullable(),
  title: z.string().nullable(),
  format: z.string(),
  forced: z.boolean(),
  sdh: z.boolean(),
  requiresBurnIn: z.boolean(),
});
export type SubtitleTrackInfo = z.infer<typeof SubtitleTrackInfo>;

export const MediaFileTracksResponse = z.object({
  audio: z.array(AudioTrackInfo),
  subtitles: z.array(SubtitleTrackInfo),
});

/** One sprite sheet of the file's scrubber-preview index; `url` serves the JPG bytes. */
export const TrickplaySheet = z.object({
  index: z.number(),
  url: z.string(),
  /** How many tiles this sheet actually holds — only the last sheet can hold fewer than tilesPerSheet. */
  tiles: z.number(),
});
export type TrickplaySheet = z.infer<typeof TrickplaySheet>;

/** Scrubber-preview (trickplay) index: tile N = sheets[floor(N / tilesPerSheet)] at col (N % tilesPerSheet) % cols, row floor(N % tilesPerSheet / cols). */
export const MediaFileTrickplayResponse = z.object({
  tileWidth: z.number(),
  tileHeight: z.number(),
  intervalMs: z.number(),
  tilesPerSheet: z.number(),
  cols: z.number(),
  sheets: z.array(TrickplaySheet),
});
export type MediaFileTrickplayResponse = z.infer<typeof MediaFileTrickplayResponse>;

export const ErrorResponse = z.object({ error: z.string() });
