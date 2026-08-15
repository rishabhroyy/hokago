import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { PrismaClient, type ContentProfile } from "@hokago/db";

import { resolveArtwork, upsertArtworkDescriptor } from "./artwork.js";
import { clusterByRuntime } from "./cluster.js";
import { INGEST_CONCURRENCY, LOCAL_SIGNAL_TYPES, PROBE_CONCURRENCY, parseSeasonDirName } from "./constants.js";
import { syncEvidenceAndConfidence, type EvidenceInput } from "./evidence.js";
import { extractFonts } from "./fonts.js";
import { partialHash } from "./hash.js";
import { mapLimit } from "./limit.js";
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
 * Directory-hierarchy heuristic ("group first, match second"):
 *
 * For each directory of video files, parse every filename through the
 * registry (forked by the library's content profile). If a majority
 * carry a season/episode marker, the directory is a season worth of a
 * series (explicit "Season 01"-style dirname, or implicit Season 1 if not).
 * Runtime-cluster outliers within that group become standalone movies —
 * the Mugen Train shape (c). Otherwise every file in the
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
 * Collections : find-then-create, mirroring findOrCreateChild — no
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

/** Walk a child's parent chain to the root — finds the series an item (re)parents under. */
async function rootSeriesOf(
  db: PrismaClient,
  itemId: string,
): Promise<{ id: string; title: string } | null> {
  let cursor = itemId;
  for (let hops = 0; hops < 8; hops++) {
    const row = await db.mediaItem.findUnique({
      where: { id: cursor },
      select: { parentId: true, kind: true, title: true },
    });
    if (!row) return null;
    if (row.kind === "SERIES") return { id: cursor, title: row.title };
    if (!row.parentId) return null;
    cursor = row.parentId;
  }
  return null;
}

/**
 * Series identity follows a rename: when a file re-parents out of one series
 * into another (a show folder renamed, a season restructured), the resolved
 * ExternalIds move to the new series and the scanner-derived franchise link
 * is repointed. The old series row is left empty for the prune roll-up.
 * Concurrent leaves of the same season all fire this — every query/upsert
 * below is idempotent, so the first one wins and the rest no-op.
 */
async function transferSeriesIdentity(db: PrismaClient, oldParentId: string, newParentId: string): Promise<void> {
  const oldRoot = await rootSeriesOf(db, oldParentId);
  if (!oldRoot) return;
  const newRoot = await rootSeriesOf(db, newParentId);
  if (!newRoot || newRoot.id === oldRoot.id) return;

  const transferred = await db.externalId.findMany({ where: { mediaItemId: oldRoot.id } });
  if (transferred.length === 0) return;
  if ((await db.externalId.count({ where: { mediaItemId: newRoot.id } })) > 0) return;

  await db.externalId.createMany({
    data: transferred.map((e) => ({
      mediaItemId: newRoot.id,
      provider: e.provider,
      providerId: e.providerId,
      confidence: e.confidence,
    })),
    skipDuplicates: true,
  });

  const oldEntry = await db.collectionEntry.findFirst({
    where: { mediaItemId: oldRoot.id, relationType: "MAIN", collection: { derived: true } },
  });
  if (oldEntry) {
    const collection = await findOrCreateCollection(db, { name: newRoot.title, kind: "FRANCHISE" });
    await db.collectionEntry.upsert({
      where: { collectionId_mediaItemId: { collectionId: collection.id, mediaItemId: newRoot.id } },
      create: { collectionId: collection.id, mediaItemId: newRoot.id, relationType: "MAIN" },
      update: {},
    });
    await db.collectionEntry.delete({ where: { id: oldEntry.id } });
  }
}

/**
 * Identity is only ever set at creation — a row that re-parses as a
 * different shape (e.g. an episode that runtime clustering previously flung
 * out as a root- level movie) must be reset in place, or corrected scans
 * leave stale root items behind forever. Shared by the inode-match and
 * content-steal reattach paths below; MOVIE titles also follow the current
 * parse so a renamed file/folder actually re-updates the library.
 */
async function reparentItem(
  db: PrismaClient,
  params: {
    mediaItemId: string;
    oldParentId: string | null;
    kind: "MOVIE" | "EPISODE";
    parentId: string | null;
    title: string;
    year: number | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
  },
): Promise<void> {
  await db.mediaItem.update({
    where: { id: params.mediaItemId },
    data: {
      kind: params.kind,
      parentId: params.parentId,
      title: params.title,
      sortTitle: params.title.toLowerCase(),
      year: params.year,
      seasonNumber: params.seasonNumber,
      episodeNumber: params.episodeNumber,
    },
  });
  // Scanner-made franchise links (relationType MOVIE) only mean anything
  // while the item is an outlier movie — drop them when it reverts to a
  // plain leaf. Hand-built/derived-as-collection links are untouched.
  if (params.kind === "EPISODE") {
    await db.collectionEntry.deleteMany({
      where: { mediaItemId: params.mediaItemId, relationType: "MOVIE", collection: { derived: true } },
    });
  }
  if (params.oldParentId !== null && params.parentId !== null && params.oldParentId !== params.parentId) {
    await transferSeriesIdentity(db, params.oldParentId, params.parentId);
  }
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

/** Per-file scrubber-preview sheets (trickplay) — queued, not inline. */
export interface TrickplayNeeded {
  mediaItemId: string;
  mediaFileId: string;
  filePath: string;
  durationMs: number | null;
}

/** A MOVIE or SERIES item whose network-provider metadata (Step 6) hasn't been resolved yet. */
export interface MetadataNeeded {
  mediaItemId: string;
  libraryId: string;
  kind: "MOVIE" | "SERIES";
  title: string;
  year: number | null;
}

interface LeafResult {
  mediaItemId: string;
  artworkStored: number;
  needsArtwork: ArtworkNeeded | null;
  trickplayNeeded: TrickplayNeeded | null;
  title: string;
  year: number | null;
}

async function ingestLeafItem(
  db: PrismaClient,
  libraryId: string,
  ctx: FileContext,
  kind: "MOVIE" | "EPISODE",
  parentId: string | null,
  seasonNumber: number | null,
  deferArtwork: boolean,
  deferTrickplay: boolean,
  profile: ContentProfile,
): Promise<LeafResult> {
  const { file, dir, probe } = ctx;
  const parsed = parseFilename(path.basename(file.path), profile);
  // Season folders keep anime's absolute numbering ("Season 2" holding files
  // 13..24) — normalize to season-relative (1..12) so ordering, titles, and
  // provider episode lists agree. The base is the prior seasons' episode
  // count; files already relative (episode <= base) are left untouched.
  let episodeNumber: number | null = kind === "EPISODE" ? (parsed.episode ?? null) : null;
  if (kind === "EPISODE" && episodeNumber !== null && seasonNumber !== null && seasonNumber > 1) {
    const seasonRow = await db.mediaItem.findUnique({ where: { id: parentId as string }, select: { parentId: true } });
    if (seasonRow?.parentId) {
      const prior = await db.mediaItem.count({
        where: { kind: "EPISODE", parent: { parentId: seasonRow.parentId }, seasonNumber: { lt: seasonNumber } },
      });
      if (prior > 0 && episodeNumber > prior) episodeNumber -= prior;
    }
  }
  // Episodes never take the filename as their name — parsers only ever return
  // the series title, which every row of a season would share. "Episode N" is
  // the honest placeholder until provider enrichment fills `extra.episodeTitle`.
  const title =
    kind === "EPISODE" ? `Episode ${episodeNumber ?? "?"}` : (parsed.title ?? path.basename(file.path));

// Path first (common case, cheap unique lookup). If the path moved, fall
  // back to inode within this library — a rename/move must reuse the same
  // MediaItem/MediaFile, not re-import .
  let existingFile = await db.mediaFile.findUnique({
    where: { path: file.path },
    include: { mediaItem: { select: { kind: true, parentId: true, title: true } } },
  });
  if (!existingFile) {
    existingFile = await db.mediaFile.findFirst({
      where: { inode: file.inode, mediaItem: { libraryId } },
      include: { mediaItem: { select: { kind: true, parentId: true, title: true } } },
    });
  }
  let mediaItemId: string;
  let oldParentId: string | null = null;
  let huskItemId: string | null = null;

  if (existingFile) {
    mediaItemId = existingFile.mediaItemId;
    oldParentId = existingFile.mediaItem.parentId;
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
        episodeNumber,
        runtimeMs: probe?.durationMs ?? null,
      },
    });
    mediaItemId = item.id;
    huskItemId = item.id;
  }

  const hash = await partialHash(file.path, file.sizeBytes);

  // Content-identity steal: no path/inode match, but a row with the identical
  // content hash (size + first/last MiB — partialHash) whose own file has
  // vanished proves this is a copy-style move (cp+rm, cross-device mv) — the
  // inode fallback above only survives same-filesystem renames. Reuse the old
  // row + item (streams, artwork, ExternalIds, watch state survive) instead
  // of importing the file as a brand-new item; the husk item just created has
  // enqueued nothing yet and is removed. A twin whose file is still on disk is
  // a legitimate duplicate — copies stay separate items.
  if (!existingFile) {
    const twin = await db.mediaFile.findFirst({
      where: { hash, mediaItem: { libraryId }, path: { not: file.path } },
      include: { mediaItem: { select: { kind: true, parentId: true, title: true } } },
    });
    if (twin && !existsSync(twin.path)) {
      existingFile = twin;
      mediaItemId = twin.mediaItemId;
      oldParentId = twin.mediaItem.parentId;
      if (huskItemId) await db.mediaItem.delete({ where: { id: huskItemId } });
    }
  }

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
    // Shape changed (kind/parent/reparse) or a MOVIE retitled — reset in
    // place, or corrected scans leave stale root items behind forever.
    if (
      existingFile.mediaItem.kind !== kind ||
      existingFile.mediaItem.parentId !== parentId ||
      (kind === "MOVIE" && existingFile.mediaItem.title !== title)
    ) {
      await reparentItem(db, {
        mediaItemId: existingFile.mediaItemId,
        oldParentId,
        kind,
        parentId,
        title,
        year: parsed.year,
        seasonNumber,
        episodeNumber,
      });
    }
  } else {
    const created = await db.mediaFile.create({ data: { mediaItemId, ...fileFields } });
    mediaFileId = created.id;
  }

  if (probe?.durationMs) {
    await db.mediaItem.update({ where: { id: mediaItemId }, data: { runtimeMs: probe.durationMs } });
  }

 // Local NFO always outranks network providers (resolution chain) — only
  // fill overview when still unset, so a later provider fetch never clobbers it.
  if (nfo?.plot) {
    await db.mediaItem.updateMany({ where: { id: mediaItemId, overview: null }, data: { overview: nfo.plot } });
  }

 // Probe + fonts + subtitles (Step 5): streams carry HDR gate data
 // , subtitle tracks carry the burn-in flag , fonts land in
  // the shared hash-deduped store regardless of which of the three sources
 // they came from .
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

 // Contradiction : runtime clustering resolved this file as MOVIE, but
  // its own filename evidence unambiguously parses as a numbered episode —
  // the two signals disagree about what this item even is. Noisy-OR alone
  // can't express that; it only ever combines weights upward.
  const contradictsKind = kind === "MOVIE" && (parsed.season !== null || parsed.episode !== null);
  await syncEvidenceAndConfidence(db, mediaItemId, evidence, LOCAL_SIGNAL_TYPES, contradictsKind);

  for (const uid of nfo?.uniqueIds ?? []) {
    await db.externalId
      .upsert({
        where: { mediaItemId_provider: { mediaItemId, provider: uid.provider } },
        create: { mediaItemId, provider: uid.provider, providerId: uid.id, confidence: 0.99 },
        update: { providerId: uid.id },
      })
      .catch(() => {});
  }

 // Job infra : artwork resolution shells out to ffmpeg and is the
  // crash/CPU-heavy risk, so it's split into its own queue with its own
  // concurrency limit and poison-pill handling. Direct/offline invocation
  // (scripts/scan.ts, no deferArtwork) keeps resolving it inline, unchanged.
  if (deferArtwork) {
    return {
      mediaItemId,
      artworkStored: 0,
      needsArtwork: { mediaItemId, filePath: file.path, dir, durationMs: probe?.durationMs ?? null },
      trickplayNeeded: deferTrickplay
        ? { mediaItemId, mediaFileId, filePath: file.path, durationMs: probe?.durationMs ?? null }
        : null,
      title,
      year: parsed.year,
    };
  }

  const artworkStored = await storeArtwork(db, mediaItemId, dir, file.path, probe?.attachedPics ?? [], probe?.durationMs ?? null);
  return { mediaItemId, artworkStored, needsArtwork: null, trickplayNeeded: null, title, year: parsed.year };
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
    await upsertArtworkDescriptor(db, mediaItemId, art);
    artworkStored += 1;
  }
  return artworkStored;
}

export interface IngestOptions {
 /** Skip directories at/before this sorted path — resume after a checkpointed interruption . */
  resumeFromCursor?: string | null;
  /** Called after a directory's MediaItem/Evidence work is fully committed — persist as the new scanCursor. */
  onDirectoryComplete?: (dir: string) => Promise<void>;
  /** When set, artwork is not resolved inline — each file needing it is handed to this callback instead (queued). */
  onArtworkNeeded?: (job: ArtworkNeeded) => Promise<void>;
  /** When set, trickplay sheets are not generated inline — handed to this callback instead (queued). */
  onTrickplayNeeded?: (job: TrickplayNeeded) => Promise<void>;
 /** Called for every MOVIE/SERIES item so network-provider metadata (Step 6) can be queued. */
  onMetadataNeeded?: (job: MetadataNeeded) => Promise<void>;
 /** Forks the parser registry . Defaults to the library's own profile when omitted. */
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
  const deferTrickplay = opts.onTrickplayNeeded !== undefined;

  const summary: IngestSummary = {
    directoriesScanned: byDir.size,
    filesScanned: files.length,
    seriesCreated: 0,
    moviesCreated: 0,
    episodesCreated: 0,
    artworkStored: 0,
  };

  // Top-level directories with no video files anywhere beneath them get a
  // bare SERIES row — visible as "not downloaded" until the folder is filled.
  const dirsWithMedia = new Set<string>();
  for (const f of files) {
    let d = path.dirname(f.path);
    while (d.length >= rootPath.length) {
      dirsWithMedia.add(d);
      if (d === rootPath) break;
      d = path.dirname(d);
    }
  }
  const rootEntries = (await readdir(rootPath, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of rootEntries) {
    const dir = path.join(rootPath, entry.name);
    if (dirsWithMedia.has(dir)) continue;
    const existing = await db.mediaItem.findFirst({
      where: { libraryId, parentId: null, kind: "SERIES", title: entry.name },
    });
    if (existing) continue;
    const created = await db.mediaItem.create({
      data: {
        libraryId,
        kind: "SERIES",
        title: entry.name,
        sortTitle: entry.name.toLowerCase(),
      },
    });
    await syncEvidenceAndConfidence(
      db,
      created.id,
      [{ signalType: "FOLDER_NAME", source: dir, value: { title: entry.name } }],
      LOCAL_SIGNAL_TYPES,
    );
    summary.seriesCreated += 1;
    await opts.onMetadataNeeded?.({ mediaItemId: created.id, libraryId, kind: "SERIES", title: entry.name, year: null });
  }

  // Global, deterministic order independent of filesystem readdir order —
  // required for scanCursor resume to mean anything.
  const sortedDirs = Array.from(byDir.keys()).sort();

  for (const dir of sortedDirs) {
    if (opts.resumeFromCursor && dir <= opts.resumeFromCursor) continue;
    const dirFiles = [...(byDir.get(dir) ?? [])].sort((a, b) => a.path.localeCompare(b.path));

    // Probe the whole directory in parallel — each probe is an ffprobe spawn
    // (~100-400ms), and serial probing dominates scan time on big libraries.
    // Probes are keyed by file path and never mutated, so this is pure fan-out.
    const probeResults = await mapLimit(dirFiles, PROBE_CONCURRENCY, (f) => probeFile(f.path));
    const probes = new Map(dirFiles.map((f, i) => [f.path, probeResults[i]]));

    if (!isSeasonLikeDirectory(dirFiles, profile)) {
      // Every file in a non-season directory is independently a movie — no
      // shared parent rows, so the leaf ingestion can run concurrently.
      const results = await mapLimit(dirFiles, INGEST_CONCURRENCY, async (file) => {
        const result = await ingestLeafItem(
          db,
          libraryId,
          { file, dir, probe: probes.get(file.path) ?? null },
          "MOVIE",
          null,
          null,
          deferArtwork,
          deferTrickplay,
          profile,
        );
        if (result.needsArtwork) await opts.onArtworkNeeded?.(result.needsArtwork);
        if (result.trickplayNeeded) await opts.onTrickplayNeeded?.(result.trickplayNeeded);
        await opts.onMetadataNeeded?.({ mediaItemId: result.mediaItemId, libraryId, kind: "MOVIE", title: result.title, year: result.year });
        return result;
      });
      for (const result of results) {
        summary.artworkStored += result.artworkStored;
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

    // Episodes share the season row but each leaf's own MediaItem/MediaFile/
    // Evidence rows are disjoint — the leaf loop can run concurrently. The
    // SERIES/SEASON evidence sync below stays serial because it needs the
    // aggregated title agreement count from every file first.
    const outcomes = await mapLimit(dirFiles, INGEST_CONCURRENCY, async (file) => {
      const ctx: FileContext = { file, dir, probe: probes.get(file.path) ?? null };
      const parsed = parseFilename(path.basename(file.path), profile);
      // Runtime clustering exists only for the Mugen Train shape — movies
      // whose names don't parse as episodes. A file that PARSES as a numbered
      // episode is an episode, full stop: wide runtime spread (short ONA
      // episodes like Alien Stage, double-length finales) must never fling
      // an episode out of its season as a root-level movie.
      const isEpisodeNamed = parsed.episode !== null;
      const isOutlier = !isEpisodeNamed && outliers.includes(file.path);
      const isMain = isEpisodeNamed || main.includes(file.path);
      let result: LeafResult | null = null;
      if (isOutlier) {
        result = await ingestLeafItem(db, libraryId, ctx, "MOVIE", null, null, deferArtwork, deferTrickplay, profile);
      } else if (isMain) {
        result = await ingestLeafItem(db, libraryId, ctx, "EPISODE", season.id, seasonNumber, deferArtwork, deferTrickplay, profile);
      }
      if (result) {
        if (result.needsArtwork) await opts.onArtworkNeeded?.(result.needsArtwork);
        if (result.trickplayNeeded) await opts.onTrickplayNeeded?.(result.trickplayNeeded);
        // Outliers are movies (the Mugen Train shape) — tries the
        // anime provider chain for these regardless of the library's profile.
        if (isOutlier) {
          await opts.onMetadataNeeded?.({ mediaItemId: result.mediaItemId, libraryId, kind: "MOVIE", title: result.title, year: result.year });
        }
      }
      const agrees = parsed.title !== null && parsed.title.toLowerCase() === seriesTitle.toLowerCase();
      return { result, isOutlier, isMain, agrees };
    });

    const outlierMediaItemIds: string[] = [];
    let agreeingTitles = 0;
    for (const { result, isOutlier, isMain, agrees } of outcomes) {
      if (agrees) agreeingTitles += 1;
      if (isOutlier) {
        summary.moviesCreated += 1;
        if (result) outlierMediaItemIds.push(result.mediaItemId);
      }
      if (isMain) summary.episodesCreated += 1;
      if (result) summary.artworkStored += result.artworkStored;
    }

 // Container-level confidence (the Step 2 gap this closes): SERIES
    // identity is stable across all its season directories, so it only ever
    // carries FOLDER_NAME — a per-season SIBLING_CONSISTENCY signal on the
    // series would get wiped by the next season directory's sync pass (each
    // sync call is a full snapshot for that MediaItem, not a delta). SEASON
    // is 1:1 with this directory, so it can safely carry both.
    await syncEvidenceAndConfidence(
      db,
      series.id,
      [{ signalType: "FOLDER_NAME", source: seriesDir, value: { title: seriesTitle } }],
      LOCAL_SIGNAL_TYPES,
    );
    await opts.onMetadataNeeded?.({ mediaItemId: series.id, libraryId, kind: "SERIES", title: seriesTitle, year: null });
    await syncEvidenceAndConfidence(
      db,
      season.id,
      [
        { signalType: "FOLDER_NAME", source: dir, value: { title: `Season ${seasonNumber}` } },
        {
          signalType: "SIBLING_CONSISTENCY",
          source: dir,
          value: { agreement: dirFiles.length > 0 ? agreeingTitles / dirFiles.length : 0, childCount: dirFiles.length },
        },
      ],
      LOCAL_SIGNAL_TYPES,
    );

 // Collections : the Mugen Train shape. clusterByRuntime's outliers
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
