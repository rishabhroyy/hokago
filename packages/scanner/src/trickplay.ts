import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { configDir } from "./artwork.js";
import { runFfmpeg } from "./generate-art.js";

// Sprite-sheet scrubber previews: one JPG sheet per 25 tiles (5x5), one tile
// per 10s of video at 320x180 — ~6MB/90min per the schema comment. Sheets are
// disposable cache under /config/cache/trickplay/{mediaFileId}/, regenerated
// whenever the file's content hash changes (sourceHash on the Trickplay row).
export const TRICKPLAY_TILE_WIDTH = 320;
export const TRICKPLAY_TILE_HEIGHT = 180;
export const TRICKPLAY_INTERVAL_MS = 10_000;
export const TRICKPLAY_COLS = 5;
export const TRICKPLAY_ROWS = 5;
export const TRICKPLAY_TILES_PER_SHEET = TRICKPLAY_COLS * TRICKPLAY_ROWS;
const SHEET_WINDOW_SEC = (TRICKPLAY_TILES_PER_SHEET * TRICKPLAY_INTERVAL_MS) / 1000;

/** One ffmpeg decode of a 250s window per sheet: fps=1/10 samples every 10s
 *  boundary and the tile filter packs 25 of them into one grid. `-ss` seeks to
 *  the keyframe at-or-before the window start and fps emits on the absolute
 *  PTS grid, so tile N of sheet M is exactly (M*25 + N) * 10s of media time. */
const SHEET_FILTER =
  `scale=${TRICKPLAY_TILE_WIDTH}:${TRICKPLAY_TILE_HEIGHT}:force_original_aspect_ratio=decrease,` +
  `pad=${TRICKPLAY_TILE_WIDTH}:${TRICKPLAY_TILE_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black,` +
  `fps=1/${TRICKPLAY_INTERVAL_MS / 1000},tile=${TRICKPLAY_COLS}x${TRICKPLAY_ROWS}`;

// A sheet decodes ~250s of video; software decode of a 90-min movie is the
// slowest legitimately common case, so give each sheet a generous ceiling and
// let the worker's concurrency cap (HOKAGO_TRICKPLAY_CONCURRENCY) bound load.
const SHEET_TIMEOUT_MS = 10 * 60_000;

export interface TrickplayResult {
  /** Relative to the config dir (e.g. cache/trickplay/{fileId}/sheet-0001.jpg) — the API resolves against configDir(). */
  sheetPaths: string[];
  tileWidth: number;
  tileHeight: number;
  intervalMs: number;
  tilesPerSheet: number;
  totalTiles: number;
}

/** Generates (or regenerates — the old dir is wiped first) the sheet set for
 *  one media file. Idempotent per file: crash-anywhere is safe, a re-run just
 *  rewrites the same directory. Throws on a failed sheet — a partial sheet set
 *  would desync the client's tile math, so a permanently broken sheet is a
 *  job failure (poison-pill), not a silently short index. */
export async function generateTrickplaySheets(filePath: string, durationMs: number, mediaFileId: string): Promise<TrickplayResult> {
  const totalTiles = Math.ceil(durationMs / TRICKPLAY_INTERVAL_MS);
  const dir = path.join(configDir(), "cache", "trickplay", mediaFileId);

  if (totalTiles < 2) {
    // Nothing worth previewing — ensure no stale sheets linger.
    await rm(dir, { recursive: true, force: true });
    return {
      sheetPaths: [],
      tileWidth: TRICKPLAY_TILE_WIDTH,
      tileHeight: TRICKPLAY_TILE_HEIGHT,
      intervalMs: TRICKPLAY_INTERVAL_MS,
      tilesPerSheet: TRICKPLAY_TILES_PER_SHEET,
      totalTiles,
    };
  }

  const sheetCount = Math.ceil(totalTiles / TRICKPLAY_TILES_PER_SHEET);
  const durationSec = durationMs / 1000;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const sheetPaths: string[] = [];
  for (let sheet = 0; sheet < sheetCount; sheet++) {
    const startSec = sheet * SHEET_WINDOW_SEC;
    const windowSec = Math.min(SHEET_WINDOW_SEC, durationSec - startSec);
    const outPath = path.join(dir, `sheet-${String(sheet + 1).padStart(4, "0")}.jpg`);
    await runFfmpeg(
      [
        "-y",
        "-ss",
        String(startSec),
        "-i",
        filePath,
        "-t",
        String(windowSec),
        "-an",
        "-sn",
        "-vf",
        SHEET_FILTER,
        "-frames:v",
        "1",
        "-q:v",
        "5",
        outPath,
      ],
      { timeoutMs: SHEET_TIMEOUT_MS },
    );
    sheetPaths.push(path.relative(configDir(), outPath));
  }

  return {
    sheetPaths,
    tileWidth: TRICKPLAY_TILE_WIDTH,
    tileHeight: TRICKPLAY_TILE_HEIGHT,
    intervalMs: TRICKPLAY_INTERVAL_MS,
    tilesPerSheet: TRICKPLAY_TILES_PER_SHEET,
    totalTiles,
  };
}
