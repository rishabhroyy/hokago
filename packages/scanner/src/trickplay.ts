import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { configDir } from "./artwork.js";
import { runFfmpeg } from "./generate-art.js";
import { mapLimit } from "./limit.js";

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

// How many tile-seek ffmpeg spawns run at once inside one job. Each spawn is
// a short seek+GOP decode, so a job can safely run several concurrently; the
// worker's HOKAGO_TRICKPLAY_CONCURRENCY still bounds whole-file jobs. Tuning
// up helps single-file turnaround (540 tiles for a 90-min movie) at the cost
// of parallel ffmpeg load on the box.
const TILE_CONCURRENCY = 4;

const TILE_FILTER =
  `scale=${TRICKPLAY_TILE_WIDTH}:${TRICKPLAY_TILE_HEIGHT}:force_original_aspect_ratio=decrease,` +
  `pad=${TRICKPLAY_TILE_WIDTH}:${TRICKPLAY_TILE_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black,` +
  // JPEG is full-range-only; hw-decoded nv12 frames are limited-range, and
  // mjpeg rejects them ("Non full-range YUV is non-standard") — the tile job
  // then hangs and reportHwFailure flips the worker to CPU. Force full range.
  `format=yuvj420p`;

/** True when ffmpeg failed because a keyframe-seek landed past the last
 *  decodable frame ("nothing was written") — the file is fine, its reported
 *  container duration just outlives the video (audio tails, padding). This is
 *  "content ends here", not corruption, so it must not poison the item. */
export function isNothingWrittenError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.message} ${String(err.cause ?? "")}` : String(err);
  return /nothing was written|received no packets|output file is empty|no packets/i.test(msg);
}

/** One solid-black tile, reused for every past-the-end grid cell. Generated
 *  once per run (this is the same encode the failed tile would have made). */
async function makeBlackTile(dir: string): Promise<string> {
  const outPath = path.join(dir, "black.jpg");
  await runFfmpeg(
    ["-y", "-f", "lavfi", "-i", "color=black:s=320x180:r=1", "-frames:v", "1", "-q:v", "5", outPath],
    { timeoutMs: TILE_TIMEOUT_MS },
  );
  return outPath;
}

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
 *  rewrites the same directory.
 *
 *  Robustness: the container duration routinely outlives the decodable video
 *  (audio tails, padding, rounding) — a keyframe-seek near the reported end
 *  can land past the last real frame and yield nothing. That's "content ends
 *  here", not a broken file: a black cell is left in place so the sheet grid
 *  stays dense and the API's duration-derived tile math never desyncs. Only a
 *  genuinely undecodable tile (corrupt region, decode error) throws — that is
 *  the poison-pill case. Hardware decode is applied by runFfmpeg itself (the
 *  worker sets its hw state at boot), so no hw args are passed here. */
export async function generateTrickplaySheets(
  filePath: string,
  durationMs: number,
  mediaFileId: string,
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

  // Pass 1 — one keyframe-seek per tile, bounded-fan-out so the seek spawns
  // for a whole show overlap instead of running serially. Tile N of sheet M is
  // exactly (M*25 + N) * 10s of media time, matching the old window-decode grid.
  const tilePaths: string[] = [];
  let blackTile: string | null = null;
  await mapLimit(Array.from({ length: totalTiles }), TILE_CONCURRENCY, async (_, tile) => {
    const startSec = (tile * TRICKPLAY_INTERVAL_MS) / 1000;
    const tilePath = path.join(dir, `tile-${String(tile + 1).padStart(6, "0")}.jpg`);
    try {
      await runFfmpeg(
        [
          "-y",
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
    } catch (err) {
      // A keyframe-seek that lands past the last real frame (container
      // duration over-reports the video — audio tails, padding, rounding)
      // fails with "nothing was written". That's the end of the content, not
      // a broken file: drop a black cell so the sheet grid stays dense and
      // the client's duration-derived tile math never points at a hole.
      // Anything else (corrupt region, decode failure, timeout) is a genuine
      // job failure and propagates to the worker's retry/poison gate. A
      // "nothing written" at the very first tile means the file has no
      // decodable video at all — that is genuinely broken and does poison.
      if (!isNothingWrittenError(err) || tile === 0) throw err;
      blackTile ??= await makeBlackTile(dir);
      await copyFile(blackTile, tilePath);
    }
    tilePaths.push(tilePath);
  });

  // Pass 2 — lay each sheet's tiles into a 5x5 grid in one image2 pass; the
  // tail sheet simply has fewer frames (the grid leaves empty cells, same as
  // the old window decode). Sheets are independent once pass 1 is done, so
  // they can fan out too.
  const sheetPaths: string[] = [];
  await mapLimit(Array.from({ length: sheetCount }), TILE_CONCURRENCY, async (_, sheet) => {
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
  });

  // Tiles are intermediate — the sheets are the deliverable.
  await Promise.all(tilePaths.map((p) => rm(p, { force: true })));
  if (blackTile) await rm(blackTile, { force: true });

  return {
    sheetPaths,
    tileWidth: TRICKPLAY_TILE_WIDTH,
    tileHeight: TRICKPLAY_TILE_HEIGHT,
    intervalMs: TRICKPLAY_INTERVAL_MS,
    tilesPerSheet: TRICKPLAY_TILES_PER_SHEET,
    totalTiles,
  };
}
