import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { hwDecodeArgs, type HwaccelState } from "@hokago/ffmpeg/hwaccel";
import { configDir } from "./artwork.js";
import { runFfmpeg } from "./generate-art.js";

// Sprite-sheet scrubber previews: one JPG sheet per 25 tiles (5x5), one tile
// per 10s of video at 320x180 — ~6MB/90min per the schema comment. Sheets are
// disposable cache under /config/cache/trickplay/{mediaFileId}/, regenerated
// whenever the file's content hash changes (sourceHash on the Trickplay row).
//
// Tiles are captured with one keyframe-seek per tile (-ss input seek + one
// output frame) instead of decoding the whole window continuously — a 250s
// window decode of a 1080p episode is minutes of GPU/CPU time, a seek+GOP
// decode is a few hundred ms, so a whole show's sheets land in well under a
// minute instead of hours. The seek lands on the keyframe at-or-before the
// 10s grid, so tiles drift by at most one GOP — invisible in a scrubber.
export const TRICKPLAY_TILE_WIDTH = 320;
export const TRICKPLAY_TILE_HEIGHT = 180;
export const TRICKPLAY_INTERVAL_MS = 10_000;
export const TRICKPLAY_COLS = 5;
export const TRICKPLAY_ROWS = 5;
export const TRICKPLAY_TILES_PER_SHEET = TRICKPLAY_COLS * TRICKPLAY_ROWS;

// A tile is one keyframe seek + a handful of decoded frames — generous
// ceiling for a pathological seek, nothing near the old whole-window cost.
const TILE_TIMEOUT_MS = 60_000;

const TILE_FILTER =
  `scale=${TRICKPLAY_TILE_WIDTH}:${TRICKPLAY_TILE_HEIGHT}:force_original_aspect_ratio=decrease,` +
  `pad=${TRICKPLAY_TILE_WIDTH}:${TRICKPLAY_TILE_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black`;

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
 *  rewrites the same directory. Throws on a failed tile — a partial sheet set
 *  would desync the client's tile math, so a permanently broken sheet is a
 *  job failure (poison-pill), not a silently short index. `hwaccel` enables
 *  hardware decode for the per-tile keyframe seeks. */
export async function generateTrickplaySheets(
  filePath: string,
  durationMs: number,
  mediaFileId: string,
  hwaccel?: HwaccelState,
): Promise<TrickplayResult> {
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
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  // Pass 1 — one keyframe-seek per tile. Tile N of sheet M is exactly
  // (M*25 + N) * 10s of media time, matching the old window-decode grid.
  const tilePaths: string[] = [];
  for (let tile = 0; tile < totalTiles; tile++) {
    const startSec = (tile * TRICKPLAY_INTERVAL_MS) / 1000;
    const tilePath = path.join(dir, `tile-${String(tile + 1).padStart(6, "0")}.jpg`);
    await runFfmpeg(
      [
        "-y",
        ...(hwaccel ? hwDecodeArgs(hwaccel) : []),
        "-ss",
        String(startSec),
        "-i",
        filePath,
        "-frames:v",
        "1",
        "-an",
        "-sn",
        "-vf",
        TILE_FILTER,
        "-q:v",
        "5",
        tilePath,
      ],
      { timeoutMs: TILE_TIMEOUT_MS },
    );
    tilePaths.push(tilePath);
  }

  // Pass 2 — lay each sheet's tiles into a 5x5 grid in one image2 pass; the
  // tail sheet simply has fewer frames (the grid leaves empty cells, same as
  // the old window decode).
  const sheetPaths: string[] = [];
  for (let sheet = 0; sheet < sheetCount; sheet++) {
    const outPath = path.join(dir, `sheet-${String(sheet + 1).padStart(4, "0")}.jpg`);
    await runFfmpeg(
      [
        "-y",
        "-start_number",
        String(sheet * TRICKPLAY_TILES_PER_SHEET + 1),
        "-i",
        path.join(dir, "tile-%06d.jpg"),
        "-frames:v",
        "1",
        "-vf",
        `tile=${TRICKPLAY_COLS}x${TRICKPLAY_ROWS}`,
        "-q:v",
        "5",
        outPath,
      ],
      { timeoutMs: TILE_TIMEOUT_MS },
    );
    sheetPaths.push(path.relative(configDir(), outPath));
  }

  // Tiles are intermediate — the sheets are the deliverable.
  await Promise.all(tilePaths.map((p) => rm(p, { force: true })));

  return {
    sheetPaths,
    tileWidth: TRICKPLAY_TILE_WIDTH,
    tileHeight: TRICKPLAY_TILE_HEIGHT,
    intervalMs: TRICKPLAY_INTERVAL_MS,
    tilesPerSheet: TRICKPLAY_TILES_PER_SHEET,
    totalTiles,
  };
}
