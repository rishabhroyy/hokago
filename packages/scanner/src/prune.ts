import { existsSync, rmSync } from "node:fs";
import path from "node:path";

import { PrismaClient } from "@hokago/db";

import { configDir } from "./artwork.js";

export interface PruneSummary {
  filesRemoved: number;
  itemsRemoved: number;
  collectionsRemoved: number;
}

/**
 * Post-scan staleness sweep: rows whose files vanished from disk are removed
 * so a deleted show disappears from the library (browse, continue-watching,
 * artwork rows, watch state — everything cascades with the item).
 *
 * Deliberately NOT a filesystem watchdog, and deliberately only ever run by
 * the worker right after a scan walked the whole tree — the caller gates on
 * the walk having found at least one file, so a temporarily unmounted drive
 * (empty walk) can never nuke a library. Roll-up: MOVIE/EPISODE items with
 * no files → SEASONs with no children → SERIES with nothing left beneath
 * them. Bare SERIES placeholders (empty folders) survive while their folder
 * still exists, so a genuinely empty dir keeps its "not downloaded" row and
 * only a deleted folder releases its identity.
 */
export async function pruneMissingMedia(db: PrismaClient, libraryId: string, rootPath: string): Promise<PruneSummary> {
  const [files, orphanCollections] = await Promise.all([
    db.mediaFile.findMany({
      where: { mediaItem: { libraryId } },
      select: { id: true, mediaItemId: true, path: true },
    }),
    db.collection.findMany({ where: { derived: true, entries: { none: {} } }, select: { id: true } }),
  ]);

  const missingFiles = files.filter((f) => !existsSync(f.path));
  if (missingFiles.length === 0 && orphanCollections.length === 0) return { filesRemoved: 0, itemsRemoved: 0, collectionsRemoved: 0 };

  // Best-effort: the scrubber-preview sheets are disposable cache under
  // /config/cache/trickplay/{fileId}/ — drop them with the row.
  for (const f of missingFiles) {
    rmSync(path.join(configDir(), "cache", "trickplay", f.id), { recursive: true, force: true });
  }

  await db.mediaFile.deleteMany({ where: { id: { in: missingFiles.map((f) => f.id) } } });

  // Computed AFTER the file deletes — zero surviving files is the death
  // condition. Leaves first, then seasons, then series (roll-up).
  const [leaves, seasons, series] = await Promise.all([
    db.mediaItem.findMany({
      where: { libraryId, kind: { in: ["MOVIE", "EPISODE"] }, files: { none: {} } },
      select: { id: true },
    }),
    db.mediaItem.findMany({
      where: { libraryId, kind: "SEASON", children: { none: {} } },
      select: { id: true },
    }),
    db.mediaItem.findMany({
      where: { libraryId, kind: "SERIES", children: { none: {} }, files: { none: {} } },
      select: { id: true, title: true },
    }),
  ]);

  // Bare SERIES rows are keyed on their folder — an existing (even empty)
  // folder keeps the placeholder, a deleted folder releases the identity.
  const deadSeries = series.filter((s) => !existsSync(path.join(rootPath, s.title)));

  if (leaves.length + seasons.length + deadSeries.length === 0 && orphanCollections.length === 0) {
    return { filesRemoved: missingFiles.length, itemsRemoved: 0, collectionsRemoved: 0 };
  }

  await db.mediaItem.deleteMany({
    where: { id: { in: [...leaves, ...seasons, ...deadSeries].map((i) => i.id) } },
  });
  await db.collection.deleteMany({ where: { id: { in: orphanCollections.map((c) => c.id) } } });

  return {
    filesRemoved: missingFiles.length,
    itemsRemoved: leaves.length + seasons.length + deadSeries.length,
    collectionsRemoved: orphanCollections.length,
  };
}