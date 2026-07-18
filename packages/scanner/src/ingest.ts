import path from "node:path";

import { Prisma, PrismaClient, type ContentProfile } from "@hokago/db";

import { resolveArtwork } from "./artwork.js";
import { clusterByRuntime } from "./cluster.js";
import { parseSeasonDirName } from "./constants.js";
import { syncEvidenceAndConfidence, type EvidenceInput } from "./evidence.js";
import { extractFonts } from "./fonts.js";
import { partialHash } from "./hash.js";
import { findNfoForFile } from "./nfo.js";
import { parseFilename } from "./parse-filename.js";
import { probeFile, type ProbeResult } from "./probe.js";
import { syncMediaStreams, syncSubtitleTracks } from "./streams.js";
import { type DiscoveredFile, groupByDirectory, walkVideoFiles } from "./walk.js";

export interface IngestSummary {
  directoriesScanned: number;
  filesScanned: number;
  seriesCreated: number;
  moviesCreated: number;
  episodesCreated: number;
  artworkStored: number;
}

/**
 * Directory-hierarchy heuristic (§9.2 "group first, match second"):
 *
 * For each directory of video files, parse every filename through the
 * registry (§9.3, forked by the library's content profile). If a majority
 * carry a season/episode marker, the directory is a season worth of a
 * series (explicit "Season 01"-style dirname, or implicit Season 1 if not).
 * Runtime-cluster outliers within that group become standalone movies —
 * the Mugen Train shape (§7.3, §9.2c). Otherwise every file in the
 * directory is independently a movie (covers both one-movie-per-folder and
 * flat scene-style dumps of unrelated files in one folder).
 */
function isSeasonLikeDirectory(files: DiscoveredFile[], profile: ContentProfile): boolean {
  const parsed = files.map((f) => parseFilename(path.basename(f.path), profile));
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

/**
 * Collections (§7.3): find-then-create, mirroring findOrCreateChild — no
 * unique DB constraint on name, so this is a lookup, not a true upsert.
 */
async function findOrCreateCollection(
  db: PrismaClient,
  params: { name: string; kind: "FRANCHISE" | "MOVIE_SET" },
): Promise<{ id: string }> {
  const existing = await db.collection.findFirst({ where: { name: params.name, kind: params.kind } });
  if (existing) return { id: existing.id };
  const created = await db.collection.create({
    data: { name: params.name, sortTitle: params.name.toLowerCase(), kind: params.kind, derived: true },
  });
  return { id: created.id };
}

interface FileContext {
  file: DiscoveredFile;
  dir: string;
  probe: ProbeResult | null;
}

export interface ArtworkNeeded {
  mediaItemId: string;
  filePath: string;
  dir: string;
  durationMs: number | null;
}

interface LeafResult {
  mediaItemId: string;
  artworkStored: number;
  needsArtwork: ArtworkNeeded | null;
}

async function ingestLeafItem(
  db: PrismaClient,
  libraryId: string,
  ctx: FileContext,
  kind: "MOVIE" | "EPISODE",
  parentId: string | null,
  seasonNumber: number | null,
  deferArtwork: boolean,
  profile: ContentProfile,
): Promise<LeafResult> {
  const { file, dir, probe } = ctx;
  const parsed = parseFilename(path.basename(file.path), profile);
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

  let mediaFileId: string;
  if (existingFile) {
    // Update by id, not by path — the path itself may be what changed (rename/move).
    mediaFileId = existingFile.id;
    await db.mediaFile.update({ where: { id: mediaFileId }, data: fileFields });
  } else {
    const created = await db.mediaFile.create({ data: { mediaItemId, ...fileFields } });
    mediaFileId = created.id;
  }

  if (probe?.durationMs) {
    await db.mediaItem.update({ where: { id: mediaItemId }, data: { runtimeMs: probe.durationMs } });
  }

  // Probe + fonts + subtitles (§19 Step 5): streams carry HDR gate data
  // (§11.3), subtitle tracks carry the burn-in flag (§13.4), fonts land in
  // the shared hash-deduped store regardless of which of the three sources
  // they came from (§1.1, §13.2).
  await syncMediaStreams(db, mediaFileId, probe?.streams ?? []);
  await syncSubtitleTracks(db, mediaFileId, probe?.streams ?? []);
  await extractFonts(db, mediaFileId, file.path, dir);

  const evidence: EvidenceInput[] = [{ signalType: "FOLDER_NAME", source: dir, value: { title } }];
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

  // Contradiction (§7.5): runtime clustering resolved this file as MOVIE, but
  // its own filename evidence unambiguously parses as a numbered episode —
  // the two signals disagree about what this item even is. Noisy-OR alone
  // can't express that; it only ever combines weights upward.
  const contradictsKind = kind === "MOVIE" && (parsed.season !== null || parsed.episode !== null);
  await syncEvidenceAndConfidence(db, mediaItemId, evidence, contradictsKind);

  for (const uid of nfo?.uniqueIds ?? []) {
    await db.externalId
      .upsert({
        where: { mediaItemId_provider: { mediaItemId, provider: uid.provider } },
        create: { mediaItemId, provider: uid.provider, providerId: uid.id, confidence: 0.99 },
        update: { providerId: uid.id },
      })
      .catch(() => {});
  }

  // Job infra (§9.6): artwork resolution shells out to ffmpeg and is the
  // crash/CPU-heavy risk, so it's split into its own queue with its own
  // concurrency limit and poison-pill handling. Direct/offline invocation
  // (scripts/scan.ts, no deferArtwork) keeps resolving it inline, unchanged.
  if (deferArtwork) {
    return {
      mediaItemId,
      artworkStored: 0,
      needsArtwork: { mediaItemId, filePath: file.path, dir, durationMs: probe?.durationMs ?? null },
    };
  }

  const artworkStored = await storeArtwork(db, mediaItemId, dir, file.path, probe?.attachedPics ?? [], probe?.durationMs ?? null);
  return { mediaItemId, artworkStored, needsArtwork: null };
}

/** Resolves and upserts artwork for one media item — shared by inline (CLI) and queued (worker) paths. */
export async function storeArtwork(
  db: PrismaClient,
  mediaItemId: string,
  dir: string,
  filePath: string,
  attachedPics: Parameters<typeof resolveArtwork>[2],
  durationMs: number | null,
): Promise<number> {
  const artworkList = await resolveArtwork(dir, filePath, attachedPics, durationMs);
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

    // Self-healing (§8.7.4, §3.4): a higher-priority source resolved this
    // scan (e.g. a real poster.jpg dropped in beside a GENERATED fallback)
    // permanently supersedes whatever this kind previously resolved to.
    // Without this, the old row survives forever under its own [kind,
    // source] key since the upsert above only ever touches this scan's
    // winning source.
    await db.artwork.deleteMany({ where: { mediaItemId, kind: art.kind, source: { not: art.source } } });
    artworkStored += 1;
  }
  return artworkStored;
}

export interface IngestOptions {
  /** Skip directories at/before this sorted path — resume after a checkpointed interruption (§9.6.3). */
  resumeFromCursor?: string | null;
  /** Called after a directory's MediaItem/Evidence work is fully committed — persist as the new scanCursor. */
  onDirectoryComplete?: (dir: string) => Promise<void>;
  /** When set, artwork is not resolved inline — each file needing it is handed to this callback instead (queued). */
  onArtworkNeeded?: (job: ArtworkNeeded) => Promise<void>;
  /** Forks the parser registry (§9.3). Defaults to the library's own profile when omitted. */
  contentProfile?: ContentProfile;
}

export async function ingestLibrary(
  db: PrismaClient,
  libraryId: string,
  rootPath: string,
  opts: IngestOptions = {},
): Promise<IngestSummary> {
  const profile = opts.contentProfile ?? "GENERAL";
  const files = await walkVideoFiles(rootPath);
  const byDir = groupByDirectory(files);
  const deferArtwork = opts.onArtworkNeeded !== undefined;

  // Global, deterministic order independent of filesystem readdir order —
  // required for scanCursor resume to mean anything (§9.6.3).
  const sortedDirs = Array.from(byDir.keys()).sort();

  const summary: IngestSummary = {
    directoriesScanned: byDir.size,
    filesScanned: files.length,
    seriesCreated: 0,
    moviesCreated: 0,
    episodesCreated: 0,
    artworkStored: 0,
  };

  for (const dir of sortedDirs) {
    if (opts.resumeFromCursor && dir <= opts.resumeFromCursor) continue;
    const dirFiles = [...(byDir.get(dir) ?? [])].sort((a, b) => a.path.localeCompare(b.path));
    const probes = new Map<string, ProbeResult | null>();
    for (const f of dirFiles) probes.set(f.path, await probeFile(f.path));

    if (!isSeasonLikeDirectory(dirFiles, profile)) {
      for (const file of dirFiles) {
        const result = await ingestLeafItem(
          db,
          libraryId,
          { file, dir, probe: probes.get(file.path) ?? null },
          "MOVIE",
          null,
          null,
          deferArtwork,
          profile,
        );
        summary.artworkStored += result.artworkStored;
        if (result.needsArtwork) await opts.onArtworkNeeded?.(result.needsArtwork);
        summary.moviesCreated += 1;
      }
      await opts.onDirectoryComplete?.(dir);
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

    const outlierMediaItemIds: string[] = [];
    let agreeingTitles = 0;

    for (const file of dirFiles) {
      const ctx: FileContext = { file, dir, probe: probes.get(file.path) ?? null };
      let result: LeafResult | null = null;
      if (outliers.includes(file.path)) {
        result = await ingestLeafItem(db, libraryId, ctx, "MOVIE", null, null, deferArtwork, profile);
        summary.moviesCreated += 1;
        outlierMediaItemIds.push(result.mediaItemId);
      } else if (main.includes(file.path)) {
        result = await ingestLeafItem(db, libraryId, ctx, "EPISODE", season.id, seasonNumber, deferArtwork, profile);
        summary.episodesCreated += 1;
      }
      if (result) {
        summary.artworkStored += result.artworkStored;
        if (result.needsArtwork) await opts.onArtworkNeeded?.(result.needsArtwork);
      }
      const parsedTitle = parseFilename(path.basename(file.path), profile).title;
      if (parsedTitle && parsedTitle.toLowerCase() === seriesTitle.toLowerCase()) agreeingTitles += 1;
    }

    // Container-level confidence (§7.5, the Step 2 gap this closes): SERIES
    // identity is stable across all its season directories, so it only ever
    // carries FOLDER_NAME — a per-season SIBLING_CONSISTENCY signal on the
    // series would get wiped by the next season directory's sync pass (each
    // sync call is a full snapshot for that MediaItem, not a delta). SEASON
    // is 1:1 with this directory, so it can safely carry both.
    await syncEvidenceAndConfidence(db, series.id, [
      { signalType: "FOLDER_NAME", source: seriesDir, value: { title: seriesTitle } },
    ]);
    await syncEvidenceAndConfidence(db, season.id, [
      { signalType: "FOLDER_NAME", source: dir, value: { title: `Season ${seasonNumber}` } },
      {
        signalType: "SIBLING_CONSISTENCY",
        source: dir,
        value: { agreement: dirFiles.length > 0 ? agreeingTitles / dirFiles.length : 0, childCount: dirFiles.length },
      },
    ]);

    // Collections (§7.3): the Mugen Train shape. clusterByRuntime's outliers
    // are movies that live inside a series folder — link them and the series
    // into one franchise collection instead of leaving them unconnected.
    if (outlierMediaItemIds.length > 0) {
      const collection = await findOrCreateCollection(db, { name: seriesTitle, kind: "FRANCHISE" });
      await db.collectionEntry.upsert({
        where: { collectionId_mediaItemId: { collectionId: collection.id, mediaItemId: series.id } },
        create: { collectionId: collection.id, mediaItemId: series.id, relationType: "MAIN" },
        update: {},
      });
      for (const mediaItemId of outlierMediaItemIds) {
        await db.collectionEntry.upsert({
          where: { collectionId_mediaItemId: { collectionId: collection.id, mediaItemId } },
          create: { collectionId: collection.id, mediaItemId, relationType: "MOVIE" },
          update: {},
        });
      }
    }

    await opts.onDirectoryComplete?.(dir);
  }

  return summary;
}
