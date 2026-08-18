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

  // Best-effort: the scrubber-preview sheets are disposable cache under
  // /config/cache/trickplay/{fileId}/ — drop them with the row.
  for (const f of missingFiles) {
    rmSync(path.join(configDir(), "cache", "trickplay", f.id), { recursive: true, force: true });
  }

  await db.mediaFile.deleteMany({ where: { id: { in: missingFiles.map((f) => f.id) } } });

  // Roll-up: leaves first, then seasons, then series — strictly sequential,
  // each round querying only AFTER the previous round's deletes. A series
  // still holding empty seasons (or a season still holding vanished leaves)
  // must not be invisible to its own round; running the queries in parallel
  // lets exactly that shape escape (a reparenting parser change leaves bogus
  // shows whose episodes all moved away). The roll-up runs unconditionally —
  // the caller gates on the walk finding files, which is what protects a
  // temporarily unmounted library; a settled library with nothing missing
  // still needs empty-container cleanup to happen.
  const emptyLeaves = await db.mediaItem.findMany({
    where: { libraryId, kind: { in: ["MOVIE", "EPISODE"] }, files: { none: {} } },
    select: { id: true },
  });
  await db.mediaItem.deleteMany({ where: { id: { in: emptyLeaves.map((i) => i.id) } } });

  const emptySeasons = await db.mediaItem.findMany({
    where: { libraryId, kind: "SEASON", children: { none: {} } },
    select: { id: true },
  });
  await db.mediaItem.deleteMany({ where: { id: { in: emptySeasons.map((i) => i.id) } } });

  const emptySeries = await db.mediaItem.findMany({
    where: { libraryId, kind: "SERIES", children: { none: {} }, files: { none: {} } },
    select: { id: true, title: true },
  });

  // Bare SERIES rows are keyed on their folder — an existing (even empty)
  // folder keeps the placeholder, a deleted folder releases the identity.
  const deadSeries = emptySeries.filter((s) => !existsSync(path.join(rootPath, s.title)));
  await db.mediaItem.deleteMany({ where: { id: { in: deadSeries.map((i) => i.id) } } });
  await db.collection.deleteMany({ where: { id: { in: orphanCollections.map((c) => c.id) } } });

  return {
    filesRemoved: missingFiles.length,
    itemsRemoved: emptyLeaves.length + emptySeasons.length + deadSeries.length,
    collectionsRemoved: orphanCollections.length,
  };
}