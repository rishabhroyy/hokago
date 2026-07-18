import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { ARTWORK_SOURCE_PRIORITY, SIDECAR_ART_FILENAMES } from "./constants.js";
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

function configDir(): string {
  return process.env.HOKAGO_CONFIG_DIR ?? "./data/config";
}

function artworkStoreDir(): string {
  return path.join(configDir(), "artwork");
}

/** Content-addressed store under /config/artwork — same bytes, same path, idempotent (§9.6.1). */
async function storeBytes(bytes: Buffer, ext: string): Promise<{ bytesPath: string; hash: string }> {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const dir = artworkStoreDir();
  await mkdir(dir, { recursive: true });
  const bytesPath = path.join(dir, `${hash}${ext}`);
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

/** Discovers Kodi + Radarr/Sonarr sidecar art files in a directory (§10.1). */
export async function findSidecarArt(dir: string): Promise<ArtworkDescriptor[]> {
  const results: ArtworkDescriptor[] = [];
  for (const { file, kind } of SIDECAR_ART_FILENAMES) {
    const candidate = path.join(dir, file);
    try {
      const bytes = await readFile(candidate);
      const ext = path.extname(file);
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
    } catch {
      // not present — try the next filename
    }
  }
  return results;
}

/** Extracts the first attached_pic stream as embedded cover art (§10.2). */
export async function extractEmbeddedArt(
  filePath: string,
  attachedPics: AttachedPic[],
): Promise<ArtworkDescriptor | null> {
  const first = attachedPics[0];
  if (!first) return null;

  const tmpOut = path.join(artworkStoreDir(), `.tmp-${Date.now()}.jpg`);
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
 * Generated fallback (§8.7): a real frame becomes the backdrop directly, and
 * a blur-extend composition of that same frame becomes the poster. Always
 * lowest priority, always source=GENERATED — silently replaced by anything
 * better later (§8.7.4 self-healing). No baked-in title text (skipped for now).
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

/** Full artwork resolution for one media item: sidecar > embedded > generated, in priority order. */
export async function resolveArtwork(
  dir: string,
  filePath: string,
  attachedPics: AttachedPic[],
  durationMs: number | null,
): Promise<ArtworkDescriptor[]> {
  const sidecar = await findSidecarArt(dir);
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
