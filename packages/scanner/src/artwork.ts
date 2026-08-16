import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { Prisma, type PrismaClient } from "@hokago/db";

import { ARTWORK_SOURCE_PRIORITY, SIDECAR_ART_FILENAMES, SIDECAR_ART_SUFFIXES } from "./constants.js";
import { composePoster, selectBestFrame } from "./generate-art.js";
import { extractAttachedPic, type AttachedPic } from "./probe.js";

export type ArtworkKind = "POSTER" | "BACKDROP" | "STILL" | "BANNER" | "LOGO" | "THUMB";
export type ArtworkSource = "LOCAL_SIDECAR" | "NFO_URL" | "EMBEDDED" | "PROVIDER" | "GENERATED";

export interface ArtworkDescriptor {
  kind: ArtworkKind;
  source: ArtworkSource;
  priority: number;
  bytesPath: string;
  hash: string;
  sizeBytes: number;
  meta: Record<string, unknown> | null;
}

/**
 * Config root, always absolute. Never cwd-relative: scripts and workers can
 * run from any package dir and must share one store — a cwd-relative default
 * made `storeBytes` write artwork into e.g. `packages/scanner/data/config`,
 * and the stored relative `bytesPath` then 404'd from the API's own cwd.
 */
/** Config root for derived stores (artwork, trickplay cache) — always absolute. */
export function configDir(): string {
  return process.env.HOKAGO_CONFIG_DIR ? path.resolve(process.env.HOKAGO_CONFIG_DIR) : defaultConfigDir();
}

export interface ConfigDirStatus {
  dir: string;
  explicit: boolean;
  ok: boolean;
  reason: string;
}

/**
 * Boot probe: is the config dir usable? Composes run with HOKAGO_CONFIG_DIR=/config
 * (bind mount) — when that env var is dropped or the mount is missing, the API
 * silently falls back to an overlay dir and every artwork/font/avatar/download
 * 404s while playback still works. Callers must log loudly on !ok.
 */
export function probeConfigDir(): ConfigDirStatus {
  const explicit = !!process.env.HOKAGO_CONFIG_DIR;
  const dir = configDir();
  try {
    mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".hokago-write-probe");
    writeFileSync(probe, "");
    rmSync(probe);
    return { dir, explicit, ok: true, reason: "" };
  } catch (err) {
    return { dir, explicit, ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Walk up to the monorepo root (pnpm-workspace.yaml) — works from src/, dist/, and scripts/. */
function repoRoot(): string {
  let dir = import.meta.dirname;
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("hokago repo root not found");
    dir = parent;
  }
}

function defaultConfigDir(): string {
  return path.join(repoRoot(), "data", "config");
}

function artworkStoreDir(): string {
  return path.join(configDir(), "artwork");
}

/** Content-addressed store under /config/artwork — same bytes, same path, idempotent . */
export async function storeBytes(bytes: Buffer, ext: string): Promise<{ bytesPath: string; hash: string }> {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const dir = artworkStoreDir();
  await mkdir(dir, { recursive: true });
  // Absolute at write time — consumers resolve `bytesPath` directly and
  // must never depend on the writer's cwd.
  const bytesPath = path.resolve(dir, `${hash}${ext}`);
  await writeIfMissing(bytesPath, bytes);
  return { bytesPath, hash };
}

async function writeIfMissing(filePath: string, bytes: Buffer): Promise<void> {
  try {
    await stat(filePath);
  } catch {
    await writeFile(filePath, bytes);
  }
}

/** Discovers Kodi + Radarr/Sonarr sidecar art files in a directory . */
export async function findSidecarArt(dir: string, filePath?: string): Promise<ArtworkDescriptor[]> {
  const results: ArtworkDescriptor[] = [];
  const foundKinds = new Set<ArtworkKind>();

  // Kodi's per-file <basename>-poster.jpg is checked first (more specific —
  // matters when several movies share one folder), then Radarr/Sonarr's
 // plain, folder-wide poster.jpg as fallback . At most one
  // sidecar file wins per kind.
  const candidates: { path: string; kind: ArtworkKind }[] = [];
  if (filePath) {
    const base = path.basename(filePath, path.extname(filePath));
    for (const { suffix, kind } of SIDECAR_ART_SUFFIXES) {
      candidates.push({ path: path.join(dir, `${base}${suffix}`), kind });
    }
  }
  for (const { file, kind } of SIDECAR_ART_FILENAMES) {
    candidates.push({ path: path.join(dir, file), kind });
  }

  for (const { path: candidate, kind } of candidates) {
    if (foundKinds.has(kind)) continue;
    try {
      const bytes = await readFile(candidate);
      const ext = path.extname(candidate);
      const { bytesPath, hash } = await storeBytes(bytes, ext);
      results.push({
        kind,
        source: "LOCAL_SIDECAR",
        priority: ARTWORK_SOURCE_PRIORITY.LOCAL_SIDECAR!,
        bytesPath,
        hash,
        sizeBytes: bytes.length,
        meta: null,
      });
      foundKinds.add(kind);
    } catch {
      // not present — try the next candidate
    }
  }
  return results;
}

/** Extracts the first attached_pic stream as embedded cover art . */
export async function extractEmbeddedArt(
  filePath: string,
  attachedPics: AttachedPic[],
): Promise<ArtworkDescriptor | null> {
  const first = attachedPics[0];
  if (!first) return null;

  const tmpOut = path.join(artworkStoreDir(), `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.jpg`);
  await mkdir(artworkStoreDir(), { recursive: true });
  try {
    await extractAttachedPic(filePath, first.streamIndex, tmpOut);
    const bytes = await readFile(tmpOut);
    const { bytesPath, hash } = await storeBytes(bytes, ".jpg");
    return {
      kind: "POSTER",
      source: "EMBEDDED",
      priority: ARTWORK_SOURCE_PRIORITY.EMBEDDED!,
      bytesPath,
      hash,
      sizeBytes: bytes.length,
      meta: null,
    };
  } catch {
    return null;
  } finally {
    await rm(tmpOut, { force: true }).catch(() => {});
  }
}

/**
 * Generated fallback : a real frame becomes the backdrop directly, and
 * a blur-extend composition of that same frame becomes the poster. Always
 * lowest priority, always source=GENERATED — silently replaced by anything
 * better later (self-healing). No baked-in title text (skipped for now).
 */
export async function generateArt(filePath: string, durationMs: number): Promise<ArtworkDescriptor[]> {
  const frame = await selectBestFrame(filePath, durationMs);
  if (!frame) return [];

  const results: ArtworkDescriptor[] = [];
  try {
    const backdropBytes = await readFile(frame.path);
    const backdrop = await storeBytes(backdropBytes, ".jpg");
    results.push({
      kind: "BACKDROP",
      source: "GENERATED",
      priority: ARTWORK_SOURCE_PRIORITY.GENERATED!,
      bytesPath: backdrop.bytesPath,
      hash: backdrop.hash,
      sizeBytes: backdropBytes.length,
      meta: { strategy: "frame-select", sourceFrameMs: Math.round(frame.atSec * 1000) },
    });

    const posterBytes = await composePoster(frame.path);
    const poster = await storeBytes(posterBytes, ".jpg");
    results.push({
      kind: "POSTER",
      source: "GENERATED",
      priority: ARTWORK_SOURCE_PRIORITY.GENERATED!,
      bytesPath: poster.bytesPath,
      hash: poster.hash,
      sizeBytes: posterBytes.length,
      meta: { strategy: "blur-extend", sourceFrameMs: Math.round(frame.atSec * 1000) },
    });
  } finally {
    await rm(frame.path, { force: true }).catch(() => {});
  }
  return results;
}

/**
 * Upsert one artwork candidate and self-heal the [mediaItemId, kind] slot
 * : a higher-priority source resolved this run permanently
 * supersedes whatever this kind previously resolved to. Shared by the
 * local-file resolution path (`storeArtwork` in ingest.ts) and the network
 * provider path (`resolveMetadata` in metadata.ts) so the self-healing
 * `deleteMany` logic exists in exactly one place.
 *
 * The cleanup is priority-aware (lower number wins): only strictly-lower-
 * priority sources lose the slot. A GENERATED fallback landing after the
 * provider fetch must never evict the PROVIDER rows — priority-blind
 * deletion made every rescan destroy provider posters on movies.
 */
export async function upsertArtworkDescriptor(
  db: PrismaClient,
  mediaItemId: string,
  art: ArtworkDescriptor,
): Promise<void> {
  try {
    await db.artwork.upsert({
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
    });
  } catch {
    // A failed upsert must not be followed by the cleanup delete — that
    // would leave the kind slot completely empty instead of keeping old art.
    return;
  }

  await db.artwork.deleteMany({
    where: { mediaItemId, kind: art.kind, source: { not: art.source }, priority: { gt: art.priority } },
  });
}

/** Full artwork resolution for one media item: sidecar > embedded > generated, in priority order. */
export async function resolveArtwork(
  dir: string,
  filePath: string,
  attachedPics: AttachedPic[],
  durationMs: number | null,
): Promise<ArtworkDescriptor[]> {
  const sidecar = await findSidecarArt(dir, filePath);
  const embedded = sidecar.some((a) => a.kind === "POSTER") ? null : await extractEmbeddedArt(filePath, attachedPics);

  const have = new Set(sidecar.map((a) => a.kind));
  if (embedded) have.add(embedded.kind);

  const needsBackdrop = !have.has("BACKDROP");
  const needsPoster = !have.has("POSTER");
  const generated = needsBackdrop || needsPoster ? (durationMs ? await generateArt(filePath, durationMs) : []) : [];

  return [
    ...sidecar,
    ...(embedded ? [embedded] : []),
    ...generated.filter((a) => needsBackdrop || a.kind !== "BACKDROP").filter((a) => needsPoster || a.kind !== "POSTER"),
  ];
}
