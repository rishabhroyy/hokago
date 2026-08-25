import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { Prisma, PrismaClient, type ContentProfile } from "@hokago/db";

import { resolveArtwork, upsertArtworkDescriptor } from "./artwork.js";
import { clusterByRuntime } from "./cluster.js";
import { INGEST_CONCURRENCY, LOCAL_SIGNAL_TYPES, PROBE_CONCURRENCY, parseSeasonDirName } from "./constants.js";
import { syncEvidenceAndConfidence, type EvidenceInput } from "./evidence.js";
import { extractFonts } from "./fonts.js";
import { partialHash } from "./hash.js";
import { mapLimit } from "./limit.js";
import { findNfoForFile } from "./nfo.js";
import { parseFilename } from "./parse-filename.js";
import { cleanFolderTitle } from "./parsers/scene.js";
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

/** ffprobe's `format_name` for .mp4/.m4v/.mov — the only containers that carry mov_text subtitle tracks. */
const MP4_MOV_CONTAINER = "mov,mp4,m4a,3gp,3g2,mj2";

// Structural folder names that are never seasons, regardless of what their
// files parse as — the Kodi/arr convention for show-scoped movie containers
// ("Show/Movies/"). Movies inside routinely carry leading episode-style
// numbers ("01. Legend of Crimson.mp4"), which the anime parser's leading-
// number episode fallback cannot distinguish from "01. Episode Name" — a
// majority of such files would otherwise flip the folder season-like and
// ingest the movies as fake episodes of a fake "Season 1". Declining here
// routes the folder through findSeriesAnchor, whose "Show/Movies/" anchor
// branch parents every file as a MOVIE child of the series — the Mugen Train
// shape this folder exists for. (Extras/Specials/OVAs are a real season 0 via
// parseSeasonDirName, not movie containers — intentionally untouched.)
// Evangelion's "Rebuild" folder is the same shape: 4 movies with leading
// catalogue numbers ("1. Evangelion - 1.0 ... (2007).mkv") that the fallback
// would otherwise treat as S01E01-03.
const NON_SEASON_MOVIE_DIRS = new Set([
  "movies",
  "movie",
  "films",
  "film",
  "rebuild",
  "rebuilds",
  "movieset",
  "theatrical",
  "theater",
  "theatre",
]);

/**
 * Directory-hierarchy heuristic ("group first, match second"):
 *
 * For each directory of video files, parse every filename through the
 * registry (forked by the library's content profile). If a majority
 * carry a season/episode marker, the directory is a season worth of a
 * series (explicit "Season 01"-style dirname, or implicit Season 1 if not).
 * Runtime-cluster outliers within that group are movies that live inside
 * the show — parented to the series and shown under its Movies section
 * (the Mugen Train shape). A non-season directory still belongs to a show
 * when an ancestor anchors it (a season dir, a season-named folder, or a
 * season-named child — "Show/Movies/", loose files in "Show/"); its files
 * are series-parented movies too. Otherwise every file in the directory is
 * independently a root-level movie (covers both one-movie-per-folder and
 * flat scene-style dumps of unrelated files in one folder).
 */
function isSeasonLikeDirectory(dir: string, files: DiscoveredFile[], profile: ContentProfile): boolean {
  if (NON_SEASON_MOVIE_DIRS.has(path.basename(dir).toLowerCase())) return false;
  const parsed = files.map((f) => parseFilename(path.basename(f.path), profile));
  // Year-bearing files are almost always movies, not episodes — a folder of
  // "1. Movie (2007).mkv" entries would otherwise be majority episode-like
  // via the leading-number fallback and become a fake season. Require that a
  // season-like folder not be dominated by year-carrying files.
  const yearBearing = parsed.filter((p) => p.year !== null).length;
  if (yearBearing / files.length >= 0.5) return false;
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

/**
 * The top-level folder under the library root that contains `dir` — the show
 * container. "No matter how many subfolders": an episode nested at any depth
 * ("Initial D/S1 - First Stage/01.mkv" or "Initial D/Stages/S7/x.mp4") still
 * belongs to the show whose folder sits directly under the library root, so
 * season/series resolution always climbs back to it.
 */
function topLevelFolder(rootPath: string, dir: string): string {
  let d = dir;
  while (d !== rootPath && path.dirname(d) !== rootPath) d = path.dirname(d);
  return d;
}

/**
 * Show anchor for a directory: a folder belongs to a show when it (or an
 * ancestor) is a season directory, parses as a season ("Season 1", "Specials")
 * or contains a season-named/season-like child. The anchor names the series:
 * always the top-level folder under the library root (basename(anchor)), so a
 * season dir nested at any depth resolves to the same show ("Initial D/Stages/
 * S7 - Fifth Stage" → "Initial D"). Walk-up stops at the library root — a flat
 * folder with no anchoring show anywhere above it is a standalone movie
 * folder, not a show.
 *
 * `seasonChildParents` is the precomputed set of dirs that contain a
 * season-named/season-like child — the "Show/Movies/" anchor case. It's
 * built once per scan (O(#season-dirs)); checking it here is O(1) instead of
 * scanning every season dir at each walk-up level.
 */
function findSeriesAnchor(
  rootPath: string,
  dir: string,
  seasonLikeDirs: ReadonlySet<string>,
  seasonChildParents: ReadonlySet<string>,
): { seriesDir: string; title: string } | null {
  let d = dir;
  for (;;) {
    if (d === rootPath) return null;
    const seasonNumber = parseSeasonDirName(path.basename(d));
    if (seasonNumber !== null) {
      // A season-named dir directly under the library root has no show above
      // it — its files are root-level movies, not a fake series named after
      // the library ("anime").
      if (path.dirname(d) === rootPath) return null;
      const anchor = topLevelFolder(rootPath, d);
      return { seriesDir: anchor, title: path.basename(anchor) };
    }
    if (seasonLikeDirs.has(d) || seasonChildParents.has(d)) {
      const anchor = topLevelFolder(rootPath, d);
      return { seriesDir: anchor, title: path.basename(anchor) };
    }
    d = path.dirname(d);
  }
}

/** Links show-scoped movies and their series into one franchise collection (Mugen Train shape). */
async function linkFranchise(
  db: PrismaClient,
  seriesId: string,
  seriesTitle: string,
  movieIds: string[],
): Promise<void> {
  const collection = await findOrCreateCollection(db, { name: seriesTitle, kind: "FRANCHISE" });
  await db.collectionEntry.upsert({
    where: { collectionId_mediaItemId: { collectionId: collection.id, mediaItemId: seriesId } },
    create: { collectionId: collection.id, mediaItemId: seriesId, relationType: "MAIN" },
    update: {},
  });
  for (const mediaItemId of movieIds) {
    await db.collectionEntry.upsert({
      where: { collectionId_mediaItemId: { collectionId: collection.id, mediaItemId } },
      create: { collectionId: collection.id, mediaItemId, relationType: "MOVIE" },
      update: {},
    });
  }
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
  // Merge, don't gate: the new series may already hold provider rows of its
  // own (its resolve job can land before this transfer runs) — skipDuplicates
  // keeps those and fills in whatever the old series had that it lacks.
  // All-or-nothing here used to lose the pinned identity entirely.
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
  /** The library's stored row for this file (bulk-fetched once per scan) — null for brand-new files. */
  stored: StoredFile | null;
  /** EMBEDDED_TAG evidence from a previous scan — re-added verbatim when the file is unchanged so the full-snapshot sync doesn't drop it. */
  preservedEmbeddedTag: EvidenceInput | null;
}

type StoredFile = Prisma.MediaFileGetPayload<{
  include: {
    mediaItem: { select: { kind: true; parentId: true; title: true } };
    // Streams/subtitle-track counts let the rescan gate detect a stored probe
    // that never produced rows (failed probe, or a pre-mapping scan that
    // silently dropped mov_text tracks) so it re-probes and heals the gap.
    _count: { select: { streams: true; subtitleTracks: true } };
  };
}>;

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
  const { file, dir, probe, stored, preservedEmbeddedTag } = ctx;
  const parsed = parseFilename(path.basename(file.path), profile);
  // Season folders keep anime's absolute numbering ("Season 2" holding files
  // 13..24) — normalize to season-relative (1..12) so ordering, titles, and
  // provider episode lists agree. The base is the prior seasons' episode
  // count; files already relative (episode <= base) are left untouched.
  // Gated on the filename carrying NO explicit season token: an S02E09 parse
  // is already season-relative, and subtracting the prior-season count from
  // it would renumber it to "Episode 1" and collide with the real S02E01.
  let episodeNumber: number | null = kind === "EPISODE" ? (parsed.episode ?? null) : null;
  if (
    kind === "EPISODE" &&
    episodeNumber !== null &&
    seasonNumber !== null &&
    seasonNumber > 1 &&
    parsed.season === null
  ) {
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

  // The stored row comes from the scan's one bulk fetch (path first, inode
  // fallback within the library) — no per-file query here. A row matched by
  // inode means the file moved: the row's probe data stays valid, only the
  // path is rewritten below.
  let existingFile = stored ?? null;
  let mediaItemId: string;
  let oldParentId: string | null = null;
  let huskItemId: string | null = null;

  if (existingFile) {
    mediaItemId = existingFile.mediaItemId;
    oldParentId = existingFile.mediaItem.parentId;
  } else {
    // Deduplicate episode numbers within the same season (Evangelion's
    // TV Series has Director's Cut duplicates: E21 Director's Cut and E21
    // regular share S01E21). Without this, the scan creates two
    // "Episode 21" rows. Reuse the existing episode row and attach this
    // file as an additional version under the same item (MediaItem can
    // hold multiple MediaFiles).
    let dupId: string | null = null;
    let dupParentId: string | null = null;
    if (kind === "EPISODE" && episodeNumber !== null && parentId) {
      const dup = await db.mediaItem.findFirst({
        where: { parentId, kind: "EPISODE", seasonNumber, episodeNumber },
        select: { id: true, parentId: true },
      });
      if (dup) {
        dupId = dup.id;
        dupParentId = dup.parentId;
      }
    }
    if (dupId) {
      mediaItemId = dupId;
      oldParentId = dupParentId;
      huskItemId = null;
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
  }

  // Immutable snapshot — existingFile may be replaced by the twin steal
  // below, and TS won't narrow a reassigned `let` through the unchanged gate.
  const existing = existingFile;

  // Rescan gate: size + mtime match means the file never changed since its
  // stored probe — skip the 2MiB partial hash. Classification (kind/parent/
  // title), NFO, and evidence are still re-derived from the (unchanged)
  // on-disk signals below — that's what makes a plain rescan heal
  // re-classifications. Probing may still happen for unchanged files the
  // gate flagged as incomplete (failed/empty stored probe, TX3G backfill);
  // those flows treat this as "content unchanged" but take the fresh probe.
  const unchanged =
    existing !== null &&
    existing.sizeBytes === file.sizeBytes &&
    existing.mtime.getTime() === file.mtime.getTime();

  const hash = unchanged ? existing.hash : await partialHash(file.path, file.sizeBytes);

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
      include: {
        mediaItem: { select: { kind: true, parentId: true, title: true } },
        _count: { select: { streams: true, subtitleTracks: true } },
      },
    });
    if (twin && !existsSync(twin.path)) {
      existingFile = twin;
      mediaItemId = twin.mediaItemId;
      oldParentId = twin.mediaItem.parentId;
      if (huskItemId) await db.mediaItem.delete({ where: { id: huskItemId } });
    }
  }

  const nfo = await findNfoForFile(file.path, kind === "EPISODE" ? "episode" : "movie");

  // Fresh probe data wins when this run produced one (the file was re-probed
  // — including unchanged-but-incomplete files the gate sent back for a heal,
  // e.g. a previously-failed probe now succeeding). A skipped file (unchanged,
  // complete stored probe) keeps its stored fields verbatim; a changed/new
  // file whose probe just failed gets nulls + probeFailed so the next scan
  // retries it.
  const fileFields =
    probe !== null
      ? {
          path: file.path,
          sizeBytes: file.sizeBytes,
          mtime: file.mtime,
          inode: file.inode,
          hash,
          container: probe.container,
          durationMs: probe.durationMs,
          bitrate: probe.bitrate,
          probedAt: new Date(),
          probeFailed: false,
        }
      : unchanged
        ? {
            path: file.path,
            sizeBytes: file.sizeBytes,
            mtime: file.mtime,
            inode: file.inode,
            hash,
            container: existing.container,
            durationMs: existing.durationMs,
            bitrate: existing.bitrate,
            probedAt: existing.probedAt,
            probeFailed: existing.probeFailed,
          }
        : {
            path: file.path,
            sizeBytes: file.sizeBytes,
            mtime: file.mtime,
            inode: file.inode,
            hash,
            container: null,
            durationMs: null,
            bitrate: null,
            probedAt: null,
            probeFailed: true,
          };

  let mediaFileId: string;
  if (existingFile) {
    // Update by id, not by path — the path itself may be what changed (rename/move).
    mediaFileId = existingFile.id;
    await db.mediaFile.update({ where: { id: mediaFileId }, data: fileFields });
    // Shape changed (kind/parent/reparse) or the item retitled — reset in
    // place, or corrected scans leave stale rows behind forever. The title
    // compare doubles as the episode-renumber check ("Episode N" encodes the
    // episode number): a parse/normalization fix that changes the computed
    // number must rewrite the row, not keep the stale one.
    if (
      existingFile.mediaItem.kind !== kind ||
      existingFile.mediaItem.parentId !== parentId ||
      existingFile.mediaItem.title !== title
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

  // Effective duration: fresh probe, or the stored row's when the file is
  // unchanged — feeds clustering, runtime evidence, and the item's runtime.
  const durationMs = probe?.durationMs ?? (unchanged ? existing.durationMs : null);
  if (durationMs) {
    await db.mediaItem.update({ where: { id: mediaItemId }, data: { runtimeMs: durationMs } });
  }

 // Local NFO always outranks network providers (resolution chain) — only
  // fill overview when still unset, so a later provider fetch never clobbers it.
  if (nfo?.plot) {
    await db.mediaItem.updateMany({ where: { id: mediaItemId, overview: null }, data: { overview: nfo.plot } });
  }

  // Probe + fonts + subtitles (Step 5): streams carry HDR gate data
  // , subtitle tracks carry the burn-in flag , fonts land in
  // the shared hash-deduped store regardless of which of the three sources
  // they came from . Sync runs only on a *successful* probe this run — a
  // skipped (unchanged) file keeps its stored rows, and a failed re-probe
  // leaves them untouched instead of wiping them with an empty list. Files
  // the gate re-probes for a heal (failed probe, zero streams, the TX3G
  // backfill) land here too: the syncs are idempotent upserts, so re-running
  // them on an unchanged file is safe and closes the missing-row gaps.
  if (probe !== null) {
    await syncMediaStreams(db, mediaFileId, probe.streams);
    await syncSubtitleTracks(db, mediaFileId, probe.streams);
    await extractFonts(db, mediaFileId, file.path, dir);
  }

  // FOLDER_NAME carries the folder's identity, not the item's synthetic
  // display title — for episodes `title` is "Episode N", which would record
  // nonsense as the folder signal.
  const evidence: EvidenceInput[] = [
    { signalType: "FOLDER_NAME", source: dir, value: { title: kind === "EPISODE" ? path.basename(dir) : title } },
  ];
  if (parsed.episode !== null || parsed.title) {
    evidence.push({ signalType: "FILENAME_PARSE", source: file.path, value: { ...parsed } });
  }
  if (durationMs) {
    evidence.push({ signalType: "PROBE_RUNTIME", source: "probe", value: { runtimeMs: durationMs } });
  }
  if (probe?.tags && Object.keys(probe.tags).length > 0) {
    evidence.push({ signalType: "EMBEDDED_TAG", source: "container-tags", value: probe.tags });
  } else if (unchanged && preservedEmbeddedTag) {
    // No fresh probe means no fresh container tags — carry the stored
    // EMBEDDED_TAG evidence forward instead of dropping it in the full-
    // snapshot sync. The source file is unchanged, so the tag didn't vanish.
    evidence.push(preservedEmbeddedTag);
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
  resumeFromCursor?: string | null;
  onDirectoryComplete?: (dir: string) => Promise<void>;
  onScanProgress?: (doneDirs: number, totalDirs: number) => Promise<void>;
  onArtworkNeeded?: (job: ArtworkNeeded) => Promise<void>;
  onTrickplayNeeded?: (job: TrickplayNeeded) => Promise<void>;
  onMetadataNeeded?: (job: MetadataNeeded) => Promise<void>;
  contentProfile?: ContentProfile;
  /** Lightweight scan: skip ffprobe, artwork, trickplay, and hash reads — only structural changes and metadata retries. */
  lightweight?: boolean;
}

export async function ingestLibrary(
  db: PrismaClient,
  libraryId: string,
  rootPath: string,
  opts: IngestOptions = {},
): Promise<IngestSummary> {
  const profile = opts.contentProfile ?? "GENERAL";
  const lightweight = !!opts.lightweight;
  const files = await walkVideoFiles(rootPath);
  const byDir = groupByDirectory(files);
  const deferArtwork = !lightweight && opts.onArtworkNeeded !== undefined;
  const deferTrickplay = !lightweight && opts.onTrickplayNeeded !== undefined;

  // One bulk fetch of every stored file in the library — the per-file lookup
  // ingest used to do (path first, inode fallback) and the rescan gate. The
  // map is authoritative for this run: nothing else mutates rows mid-scan.
  const storedRows = await db.mediaFile.findMany({
    where: { mediaItem: { libraryId } },
    include: {
      mediaItem: { select: { kind: true, parentId: true, title: true } },
      _count: { select: { streams: true, subtitleTracks: true } },
    },
  });
  const storedByPath = new Map(storedRows.map((r) => [r.path, r]));
  // inode 0 means the filesystem doesn't report real inodes (SMB/some network
  // mounts) — every file shares it, so matching on it would attach this file
  // to an arbitrary wrong item.
  const storedByInode = new Map(
    storedRows
      .filter((r): r is StoredFile & { inode: bigint } => r.inode !== null && r.inode !== 0n)
      .map((r) => [r.inode.toString(), r]),
  );
  const storedFor = (f: DiscoveredFile): StoredFile | null =>
    storedByPath.get(f.path) ?? (f.inode !== 0n ? (storedByInode.get(f.inode.toString()) ?? null) : null);

  // Probe only files whose stored probe is missing or untrustworthy: no
  // stored row (brand new), size/mtime changed (content changed), the stored
  // probe failed or never stored streams (nothing complete to reuse), or an
  // mp4/mov with zero stored subtitle tracks — files probed before the
  // mov_text→TX3G mapping silently lost their subtitle streams, so re-probe
  // just those containers and let the leaf's idempotent sync heal the rows.
  // Everything else skips ffprobe — a rescan of a settled library still
  // spawns zero probes.
  const needsProbe = lightweight
    ? []
    : files.filter((f) => {
        const row = storedFor(f);
        if (!row) return true;
        if (row.sizeBytes !== f.sizeBytes || row.mtime.getTime() !== f.mtime.getTime()) return true;
        if (row.probeFailed) return true;
        if (row._count.streams === 0) return true;
        if (MP4_MOV_CONTAINER === row.container && row._count.subtitleTracks === 0) return true;
        return false;
      });
  const probeResults = lightweight ? [] : await mapLimit(needsProbe, PROBE_CONCURRENCY, (f) => probeFile(f.path));
  const probeByPath = new Map(needsProbe.map((f, i) => [f.path, probeResults[i] as ProbeResult | null]));
  // Cluster/evidence reads the effective duration — fresh probe, else stored.
  const durationByPath = new Map<string, number | null>(
    files.map((f) => [f.path, probeByPath.get(f.path)?.durationMs ?? storedFor(f)?.durationMs ?? null]),
  );

  // Unchanged files have no fresh container tags; the full-snapshot evidence
  // sync would drop their EMBEDDED_TAG rows. Bulk-load them once so the leaf
  // can re-add the stored value verbatim.
  const unchangedItemIds = new Set<string>();
  for (const f of files) {
    const row = storedFor(f);
    if (row && row.sizeBytes === f.sizeBytes && row.mtime.getTime() === f.mtime.getTime()) {
      unchangedItemIds.add(row.mediaItemId);
    }
  }
  const preservedEmbeddedTags = new Map<string, EvidenceInput>();
  if (unchangedItemIds.size > 0) {
    const rows = await db.evidence.findMany({
      where: { mediaItemId: { in: [...unchangedItemIds] }, signalType: "EMBEDDED_TAG" },
      select: { mediaItemId: true, value: true },
    });
    for (const r of rows) {
      preservedEmbeddedTags.set(r.mediaItemId, {
        signalType: "EMBEDDED_TAG",
        source: "container-tags",
        value: r.value as Record<string, unknown>,
      });
    }
  }

  // Per-file ingest context — probes and stored rows resolved once, shared
  // by every branch below.
  const ctxFor = (file: DiscoveredFile, dir: string): FileContext => {
    const stored = storedFor(file);
    return {
      file,
      dir,
      probe: probeByPath.get(file.path) ?? null,
      stored,
      preservedEmbeddedTag: stored ? (preservedEmbeddedTags.get(stored.mediaItemId) ?? null) : null,
    };
  };

  // Precompute the anchor sets once: dirs that parse as a season and dirs
  // whose own files are majority episode-named — findSeriesAnchor consults
  // them for every directory. seasonChildParents flattens "contains a season
  // child" into a plain set so the walk-up check is O(1), not O(season dirs).
  const seasonNamedDirs = new Set<string>();
  const seasonLikeDirs = new Set<string>();
  for (const d of byDir.keys()) {
    const dirFiles = byDir.get(d)!;
    if (isSeasonLikeDirectory(d, dirFiles, profile)) seasonLikeDirs.add(d);
    if (parseSeasonDirName(path.basename(d)) !== null) seasonNamedDirs.add(d);
  }
  const seasonChildParents = new Set<string>();
  for (const child of seasonNamedDirs) seasonChildParents.add(path.dirname(child));
  for (const child of seasonLikeDirs) seasonChildParents.add(path.dirname(child));

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
    // The folder basename is the on-disk identity; the provider query gets
    // the cleaned view ("Attack on Titan (2013)" → title + year), or the
    // year/tags poison the title and the match gate rejects everything.
    const folderQuery = cleanFolderTitle(entry.name);
    await opts.onMetadataNeeded?.({ mediaItemId: created.id, libraryId, kind: "SERIES", title: folderQuery.title, year: folderQuery.year });
  }

  // Global, deterministic order independent of filesystem readdir order —
  // required for scanCursor resume to mean anything. Numeric-aware, so
  // "Season 2" sorts before "Season 10" (plain string sort inverts them,
  // which also skews the prior-season episode counts used for absolute-
  // number normalization).
  const comparePaths = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });
  const sortedDirs = Array.from(byDir.keys()).sort(comparePaths);
  const totalDirs = sortedDirs.length;

  // Progress is reported per committed directory (matching the resumeCursor
  // checkpoint granularity). Directories skipped by a resume cursor still
  // count toward "done" — they're already processed from a previous run.
  let doneDirs = 0;
  const reportProgress = async (): Promise<void> => {
    doneDirs += 1;
    await opts.onScanProgress?.(doneDirs, totalDirs);
  };

  for (const dir of sortedDirs) {
    if (opts.resumeFromCursor && comparePaths(dir, opts.resumeFromCursor) <= 0) {
      await reportProgress();
      continue;
    }
    const dirFiles = [...(byDir.get(dir) ?? [])].sort((a, b) => a.path.localeCompare(b.path));

    if (!seasonLikeDirs.has(dir)) {
      // A non-season folder that still belongs to a show (Show/Movies/,
      // Show/Extras/, or loose files sitting directly in the show folder):
      // every file is a movie parented to the series, so they surface under
      // the show's Movies section instead of leaking out as root-level
      // standalone movies.
      const anchor = findSeriesAnchor(rootPath, dir, seasonLikeDirs, seasonChildParents);
      if (anchor) {
        const series = await findOrCreateChild(db, { libraryId, parentId: null, kind: "SERIES", title: anchor.title });
        if (series.wasCreated) summary.seriesCreated += 1;
        await syncEvidenceAndConfidence(
          db,
          series.id,
          [{ signalType: "FOLDER_NAME", source: anchor.seriesDir, value: { title: anchor.title } }],
          LOCAL_SIGNAL_TYPES,
        );
        const seriesQuery = cleanFolderTitle(anchor.title);
        await opts.onMetadataNeeded?.({ mediaItemId: series.id, libraryId, kind: "SERIES", title: seriesQuery.title, year: seriesQuery.year });

        const results = await mapLimit(dirFiles, INGEST_CONCURRENCY, async (file) => {
          const result = await ingestLeafItem(
            db,
            libraryId,
            ctxFor(file, dir),
            "MOVIE",
            series.id,
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
        const movieIds: string[] = [];
        for (const result of results) {
          summary.artworkStored += result.artworkStored;
          summary.moviesCreated += 1;
          movieIds.push(result.mediaItemId);
        }
        if (movieIds.length > 0) await linkFranchise(db, series.id, anchor.title, movieIds);
        await opts.onDirectoryComplete?.(dir);
        await reportProgress();
        continue;
      }

      // Every file in a non-season directory is independently a movie — no
      // shared parent rows, so the leaf ingestion can run concurrently.
      const results = await mapLimit(dirFiles, INGEST_CONCURRENCY, async (file) => {
        const result = await ingestLeafItem(
          db,
          libraryId,
          ctxFor(file, dir),
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
      await reportProgress();
      continue;
    }

    const seasonDirNumber = parseSeasonDirName(path.basename(dir));
    // The show is the top-level folder under the library root, no matter how
    // many subfolders separate it from the season ("Initial D/Stages/S1 - First
    // Stage" → "Initial D"). A season dir directly under the root keeps the
    // loose-at-root fallback below; a flat (non-season) show folder is its own
    // top-level folder.
    const seriesDir =
      seasonDirNumber !== null ? topLevelFolder(rootPath, path.dirname(dir)) : topLevelFolder(rootPath, dir);
    let seriesTitle = path.basename(seriesDir);

    const parsedByPath = new Map(dirFiles.map((f) => [f.path, parseFilename(path.basename(f.path), profile)] as const));

    if (seriesDir === rootPath) {
      // Files sitting loose at the library root: the root's own name ("tv",
      // "anime") is not a show — parenting under it merges unrelated series
      // into one fake SERIES. Fall back to the files' own parsed title.
      const counts = new Map<string, number>();
      for (const p of parsedByPath.values()) {
        if (!p.title) continue;
        counts.set(p.title, (counts.get(p.title) ?? 0) + 1);
      }
      const mode = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (mode) seriesTitle = mode;
    }

    const series = await findOrCreateChild(db, { libraryId, parentId: null, kind: "SERIES", title: seriesTitle });
    if (series.wasCreated) summary.seriesCreated += 1;

    // The directory name wins the season number when it carries one; in a
    // flat (non-season) show folder an explicit per-file season token
    // ("Show.S02E05.mkv" next to S01 files) wins instead — dumping it into
    // Season 1 would collide episode numbers and silently renumber the file.
    // Season rows are created serially up front: the concurrent leaf loop
    // below must never race findOrCreateChild.
    const dirSeasonNumber = seasonDirNumber ?? 1;
    const seasonNumbers = new Set<number>([dirSeasonNumber]);
    if (seasonDirNumber === null) {
      for (const p of parsedByPath.values()) {
        if (p.season !== null) seasonNumbers.add(p.season);
      }
    }
    const seasonRows = new Map<number, { id: string }>();
    for (const n of seasonNumbers) {
      seasonRows.set(
        n,
        await findOrCreateChild(db, { libraryId, parentId: series.id, kind: "SEASON", title: `Season ${n}`, seasonNumber: n }),
      );
    }
    const season = seasonRows.get(dirSeasonNumber)!;
    const seasonForFile = (filePath: string): { seasonId: string; seasonNumber: number } => {
      const parsedSeason = seasonDirNumber === null ? (parsedByPath.get(filePath)?.season ?? null) : null;
      const n = parsedSeason ?? dirSeasonNumber;
      return { seasonId: seasonRows.get(n)!.id, seasonNumber: n };
    };

    const { main, outliers } = clusterByRuntime(
      dirFiles.map((f) => ({ path: f.path, durationMs: durationByPath.get(f.path) ?? null })),
    );

    // Episodes share the season row but each leaf's own MediaItem/MediaFile/
    // Evidence rows are disjoint — the leaf loop can run concurrently. The
    // SERIES/SEASON evidence sync below stays serial because it needs the
    // aggregated title agreement count from every file first.
    const outcomes = await mapLimit(dirFiles, INGEST_CONCURRENCY, async (file) => {
      const ctx = ctxFor(file, dir);
      const parsed = parsedByPath.get(file.path)!;
      const { seasonId, seasonNumber } = seasonForFile(file.path);
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
        // The Mugen Train shape: a movie living inside a show folder. It
        // stays *inside* the show — parented to the SERIES (not the season),
        // so it surfaces under the show's Movies section, not as a root-level
        // standalone movie. Only files in a *flat* (non-season) directory
        // with no anchoring show are ever root-level movies; a movie inside a
        // show folder is part of that show, full stop.
        result = await ingestLeafItem(db, libraryId, ctx, "MOVIE", series.id, null, deferArtwork, deferTrickplay, profile);
      } else if (isMain) {
        result = await ingestLeafItem(db, libraryId, ctx, "EPISODE", seasonId, seasonNumber, deferArtwork, deferTrickplay, profile);
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
    // The folder basename is the on-disk identity; the provider query gets
    // the cleaned view ("Attack on Titan (2013)" → title + year), or the
    // year/tags poison the title and the match gate rejects everything.
    const seriesQuery = cleanFolderTitle(seriesTitle);
    await opts.onMetadataNeeded?.({ mediaItemId: series.id, libraryId, kind: "SERIES", title: seriesQuery.title, year: seriesQuery.year });
    await syncEvidenceAndConfidence(
      db,
      season.id,
      [
        { signalType: "FOLDER_NAME", source: dir, value: { title: `Season ${dirSeasonNumber}` } },
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
      await linkFranchise(db, series.id, seriesTitle, outlierMediaItemIds);
    }

    await opts.onDirectoryComplete?.(dir);
    await reportProgress();
  }

  return summary;
}
