import path from "node:path";

import { Prisma, PrismaClient, type SignalType } from "@hokago/db";

import { resolveArtwork } from "./artwork.js";
import { clusterByRuntime } from "./cluster.js";
import { SIGNAL_WEIGHT, parseSeasonDirName } from "./constants.js";
import { partialHash } from "./hash.js";
import { findNfoForFile } from "./nfo.js";
import { parseFilename } from "./parse-filename.js";
import { probeFile, type ProbeResult } from "./probe.js";
import { type DiscoveredFile, groupByDirectory, walkVideoFiles } from "./walk.js";

// jsonb round-trips through Postgres don't preserve JS object key insertion
// order, so a plain JSON.stringify comparison against a freshly-fetched row
// spuriously reports "changed" on every scan. Sort keys recursively so the
// comparison is order-independent.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface IngestSummary {
  directoriesScanned: number;
  filesScanned: number;
  seriesCreated: number;
  moviesCreated: number;
  episodesCreated: number;
  artworkStored: number;
}

/**
 * Directory-hierarchy heuristic (§9.2 "group first, match second" —
 * ponytail stand-in for the real parser registry, Step 4):
 *
 * For each directory of video files, parse every filename. If a majority
 * carry a season/episode marker, the directory is a season worth of a
 * series (explicit "Season 01"-style dirname, or implicit Season 1 if not).
 * Runtime-cluster outliers within that group become standalone movies —
 * the Mugen Train shape (§7.3, §9.2c). Otherwise every file in the
 * directory is independently a movie (covers both one-movie-per-folder and
 * flat scene-style dumps of unrelated files in one folder).
 */
function isSeasonLikeDirectory(files: DiscoveredFile[]): boolean {
  const parsed = files.map((f) => parseFilename(path.basename(f.path)));
  const seasoned = parsed.filter((p) => p.episode !== null).length;
  return seasoned / files.length >= 0.5;
}

async function findOrCreateChild(
  db: PrismaClient,
  params: {
    libraryId: string;
    parentId: string | null;
    kind: "SERIES" | "SEASON";
    title: string;
    seasonNumber?: number | null;
  },
): Promise<{ id: string; wasCreated: boolean }> {
  const existing = await db.mediaItem.findFirst({
    where: { libraryId: params.libraryId, parentId: params.parentId, kind: params.kind, title: params.title },
  });
  if (existing) return { id: existing.id, wasCreated: false };
  const created = await db.mediaItem.create({
    data: {
      libraryId: params.libraryId,
      parentId: params.parentId,
      kind: params.kind,
      title: params.title,
      sortTitle: params.title.toLowerCase(),
      seasonNumber: params.seasonNumber ?? null,
    },
  });
  return { id: created.id, wasCreated: true };
}

interface FileContext {
  file: DiscoveredFile;
  dir: string;
  probe: ProbeResult | null;
}

async function ingestLeafItem(
  db: PrismaClient,
  libraryId: string,
  ctx: FileContext,
  kind: "MOVIE" | "EPISODE",
  parentId: string | null,
  seasonNumber: number | null,
): Promise<number> {
  const { file, dir, probe } = ctx;
  const parsed = parseFilename(path.basename(file.path));
  const title = parsed.title ?? path.basename(file.path);

  // Path first (common case, cheap unique lookup). If the path moved, fall
  // back to inode within this library — a rename/move must reuse the same
  // MediaItem/MediaFile, not re-import (§9.5).
  let existingFile = await db.mediaFile.findUnique({ where: { path: file.path } });
  if (!existingFile) {
    existingFile = await db.mediaFile.findFirst({
      where: { inode: file.inode, mediaItem: { libraryId } },
    });
  }
  let mediaItemId: string;

  if (existingFile) {
    mediaItemId = existingFile.mediaItemId;
  } else {
    const item = await db.mediaItem.create({
      data: {
        libraryId,
        parentId,
        kind,
        title,
        sortTitle: title.toLowerCase(),
        year: parsed.year,
        seasonNumber,
        episodeNumber: kind === "EPISODE" ? parsed.episode : null,
        runtimeMs: probe?.durationMs ?? null,
      },
    });
    mediaItemId = item.id;
  }

  const hash = await partialHash(file.path, file.sizeBytes);
  const nfo = await findNfoForFile(file.path);

  const fileFields = {
    path: file.path,
    sizeBytes: BigInt(file.sizeBytes),
    mtime: file.mtime,
    inode: file.inode,
    hash,
    container: probe?.container ?? null,
    durationMs: probe?.durationMs ?? null,
    bitrate: probe?.bitrate ?? null,
    probedAt: probe ? new Date() : null,
    probeFailed: probe === null,
  };

  if (existingFile) {
    // Update by id, not by path — the path itself may be what changed (rename/move).
    await db.mediaFile.update({ where: { id: existingFile.id }, data: fileFields });
  } else {
    await db.mediaFile.create({ data: { mediaItemId, ...fileFields } });
  }

  if (probe?.durationMs) {
    await db.mediaItem.update({ where: { id: mediaItemId }, data: { runtimeMs: probe.durationMs } });
  }

  const evidence: { signalType: SignalType; source: string; value: Record<string, unknown> }[] = [
    { signalType: "FOLDER_NAME", source: dir, value: { title } },
  ];
  if (parsed.episode !== null || parsed.title) {
    evidence.push({ signalType: "FILENAME_PARSE", source: file.path, value: { ...parsed } });
  }
  if (probe?.durationMs) {
    evidence.push({ signalType: "PROBE_RUNTIME", source: "probe", value: { runtimeMs: probe.durationMs } });
  }
  if (probe?.tags && Object.keys(probe.tags).length > 0) {
    evidence.push({ signalType: "EMBEDDED_TAG", source: "container-tags", value: probe.tags });
  }
  if (nfo) {
    evidence.push({ signalType: "NFO_UNIQUEID", source: "nfo", value: { ...nfo } });
  }

  // Sync rather than blind delete+recreate (§9.6.1 idempotency, §9.6.2
  // self-healing, §3.6/§9.6.7 crash-only): unchanged signals keep their
  // original observedAt instead of resetting on every rescan, changed/new
  // signals get a fresh one, and vanished sources are removed. All in one
  // transaction so a crash mid-sync can never leave a MediaItem with zero
  // evidence rows.
  await db.$transaction(async (tx) => {
    const existing = await tx.evidence.findMany({ where: { mediaItemId } });
    const existingByKey = new Map(existing.map((row) => [`${row.signalType}::${row.source}`, row]));
    const seenIds = new Set<string>();

    for (const e of evidence) {
      const key = `${e.signalType}::${e.source}`;
      const weight = SIGNAL_WEIGHT[e.signalType] ?? 0.5;
      const prior = existingByKey.get(key);

      if (prior) {
        seenIds.add(prior.id);
        const unchanged = stableStringify(prior.value) === stableStringify(e.value) && prior.weight === weight;
        if (unchanged) continue;
        await tx.evidence.update({
          where: { id: prior.id },
          data: { value: e.value as Prisma.InputJsonValue, weight, observedAt: new Date() },
        });
        continue;
      }

      const created = await tx.evidence.create({
        data: {
          mediaItemId,
          signalType: e.signalType,
          source: e.source,
          value: e.value as Prisma.InputJsonValue,
          weight,
        },
      });
      seenIds.add(created.id);
    }

    const stale = existing.filter((row) => !seenIds.has(row.id));
    if (stale.length > 0) {
      await tx.evidence.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
    }
  });

  // ponytail: simplified weighted-sum confidence, not the real recompute-on-
  // new-evidence engine (§7.5) — good enough for a zero-network scan to
  // produce a meaningful, derived number instead of an authored one.
  const confidence = Math.min(1, evidence.reduce((sum, e) => sum + (SIGNAL_WEIGHT[e.signalType] ?? 0.5), 0) / 2);
  await db.mediaItem.update({ where: { id: mediaItemId }, data: { confidence } });

  for (const uid of nfo?.uniqueIds ?? []) {
    await db.externalId
      .upsert({
        where: { mediaItemId_provider: { mediaItemId, provider: uid.provider } },
        create: { mediaItemId, provider: uid.provider, providerId: uid.id, confidence: 0.99 },
        update: { providerId: uid.id },
      })
      .catch(() => {});
  }

  const artworkList = await resolveArtwork(dir, file.path, probe?.attachedPics ?? [], probe?.durationMs ?? null);
  let artworkStored = 0;
  for (const art of artworkList) {
    await db.artwork
      .upsert({
        where: { mediaItemId_kind_source: { mediaItemId, kind: art.kind, source: art.source } },
        create: {
          mediaItemId,
          kind: art.kind,
          source: art.source,
          priority: art.priority,
          bytesPath: art.bytesPath,
          hash: art.hash,
          sizeBytes: art.sizeBytes,
          meta: (art.meta as Prisma.InputJsonValue) ?? undefined,
        },
        update: {
          bytesPath: art.bytesPath,
          hash: art.hash,
          sizeBytes: art.sizeBytes,
          meta: (art.meta as Prisma.InputJsonValue) ?? undefined,
        },
      })
      .catch(() => {});
    artworkStored += 1;
  }

  return artworkStored;
}

export async function ingestLibrary(db: PrismaClient, libraryId: string, rootPath: string): Promise<IngestSummary> {
  const files = await walkVideoFiles(rootPath);
  const byDir = groupByDirectory(files);

  const summary: IngestSummary = {
    directoriesScanned: byDir.size,
    filesScanned: files.length,
    seriesCreated: 0,
    moviesCreated: 0,
    episodesCreated: 0,
    artworkStored: 0,
  };

  for (const [dir, dirFiles] of byDir) {
    const probes = new Map<string, ProbeResult | null>();
    for (const f of dirFiles) probes.set(f.path, await probeFile(f.path));

    if (!isSeasonLikeDirectory(dirFiles)) {
      for (const file of dirFiles) {
        summary.artworkStored += await ingestLeafItem(
          db,
          libraryId,
          { file, dir, probe: probes.get(file.path) ?? null },
          "MOVIE",
          null,
          null,
        );
        summary.moviesCreated += 1;
      }
      continue;
    }

    const seasonDirNumber = parseSeasonDirName(path.basename(dir));
    const seriesDir = seasonDirNumber !== null ? path.dirname(dir) : dir;
    const seriesTitle = path.basename(seriesDir);
    const seasonNumber = seasonDirNumber ?? 1;

    const series = await findOrCreateChild(db, { libraryId, parentId: null, kind: "SERIES", title: seriesTitle });
    if (series.wasCreated) summary.seriesCreated += 1;

    const season = await findOrCreateChild(db, {
      libraryId,
      parentId: series.id,
      kind: "SEASON",
      title: `Season ${seasonNumber}`,
      seasonNumber,
    });

    const { main, outliers } = clusterByRuntime(
      dirFiles.map((f) => ({ path: f.path, durationMs: probes.get(f.path)?.durationMs ?? null })),
    );

    for (const file of dirFiles) {
      const ctx: FileContext = { file, dir, probe: probes.get(file.path) ?? null };
      if (outliers.includes(file.path)) {
        summary.artworkStored += await ingestLeafItem(db, libraryId, ctx, "MOVIE", null, null);
        summary.moviesCreated += 1;
      } else if (main.includes(file.path)) {
        summary.artworkStored += await ingestLeafItem(db, libraryId, ctx, "EPISODE", season.id, seasonNumber);
        summary.episodesCreated += 1;
      }
    }
  }

  return summary;
}
