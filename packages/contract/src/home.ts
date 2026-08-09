/** /home — the front-page discovery surface (hero carousel + rails). */

import { z } from "zod";
import { MediaCard } from "./browse.js";
import { ContinueWatchingEntry } from "./playback.js";

export const HomeSlideKind = z.enum(["CONTINUE", "THIS_SEASON", "RECENTLY_ADDED"]);
export type HomeSlideKind = z.infer<typeof HomeSlideKind>;

/**
 * One hero carousel slide — fully resolved for display. Server-owned so the
 * carousel can mix local items with *external* anime (this season's slate)
 * that has no MediaItem at all; those simply carry a null detailId /
 * mediaFileId and their artwork is served from our origin via
 * /external-artwork/:hash.
 */
export const HomeSlide = z.object({
  kind: HomeSlideKind,
  /** Chip label, e.g. "Continue watching" / "This season" / "On the air". */
  label: z.string(),
  /** Primary title — the SHOW name for continue-watching episodes. */
  title: z.string(),
  /** Secondary line — episode name + S/E for a continuing episode, genres/kind otherwise. */
  sub: z.string().nullable().default(null),
  year: z.number().int().nullable().default(null),
  /** Landscape-first: the carousel renders backdrop ?? poster, full-bleed, cropped. */
  posterUrl: z.string().nullable().default(null),
  backdropUrl: z.string().nullable().default(null),
  /** 0–1 resume progress — only set for in-progress continue slides. */
  progress: z.number().nullable().default(null),
  timeLeftLabel: z.string().nullable().default(null),
  /** Local detail page to land on — null for external shows. */
  detailId: z.string().nullable().default(null),
  /** Local media item id for playback/resume — null for external shows. */
  mediaItemId: z.string().nullable().default(null),
  /** Primary playable file — null for external shows / bare folders. */
  mediaFileId: z.string().nullable().default(null),
});
export type HomeSlide = z.infer<typeof HomeSlide>;

/** One horizontal rail under the hero. */
export const HomeRow = z.object({
  id: z.string(),
  title: z.string(),
  subtitle: z.string().nullable().default(null),
  items: z.array(MediaCard),
});
export type HomeRow = z.infer<typeof HomeRow>;

export const HomeQuery = z.object({ profileId: z.string().optional() });
export type HomeQuery = z.infer<typeof HomeQuery>;

export const HomeResponse = z.object({
  /** The full continue-watching rail (rendered with progress / next badges). */
  continueWatching: z.array(ContinueWatchingEntry),
  /** Hero carousel — continue-watching + this anime season + recently added. */
  slides: z.array(HomeSlide),
  /** Rails under the hero: recently added + genre rails. */
  rows: z.array(HomeRow),
});
export type HomeResponse = z.infer<typeof HomeResponse>;
