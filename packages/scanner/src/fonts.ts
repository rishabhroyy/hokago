import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { type FontFormat, type PrismaClient } from "@hokago/db";

import { execFileAsync } from "./probe.js";

const FONT_EXT_FORMAT: Record<string, FontFormat> = {
  ".ttf": "TTF",
  ".otf": "OTF",
  ".woff": "WOFF",
  ".woff2": "WOFF2",
  ".ttc": "TTC",
};

function isFontFilename(filename: string): boolean {
  return path.extname(filename).toLowerCase() in FONT_EXT_FORMAT;
}

function fontStoreDir(): string {
  return path.join(process.env.HOKAGO_CONFIG_DIR ?? "./data/config", "fonts");
}

/** Hash-dedup a font's bytes into the shared Font store and link it to this file (§1.1, §13.2). */
async function storeFontFile(db: PrismaClient, mediaFileId: string, bytes: Buffer, filename: string): Promise<void> {
  const ext = path.extname(filename).toLowerCase();
  const format = FONT_EXT_FORMAT[ext];
  if (!format) return;

  const hash = createHash("sha256").update(bytes).digest("hex");
  const existing = await db.font.findUnique({ where: { hash } });

  if (!existing) {
    const dir = fontStoreDir();
    await mkdir(dir, { recursive: true });
    const storedPath = path.join(dir, `${hash}${ext}`);
    try {
      await stat(storedPath);
    } catch {
      await writeFile(storedPath, bytes);
    }
    const family = path.basename(filename, ext).replace(/[-_]+/g, " ").trim() || filename;
    await db.font.create({
      data: { hash, family, format, source: "SUBTITLE", path: storedPath, sizeBytes: bytes.length },
    });
  }

  await db.mediaFileFont.upsert({
    where: { mediaFileId_fontHash: { mediaFileId, fontHash: hash } },
    create: { mediaFileId, fontHash: hash },
    update: {},
  });
}

/** ffmpeg dumps every attachment stream to cwd under its embedded filename — works for MKV and .mks alike. */
async function extractFromContainer(db: PrismaClient, mediaFileId: string, containerPath: string): Promise<number> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "hokago-fonts-"));
  let stored = 0;
  try {
    try {
      await execFileAsync("ffmpeg", ["-y", "-dump_attachment:t", "", "-i", containerPath, "-f", "null", "-"], {
        cwd: tmpDir,
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch {
      // ffmpeg can exit non-zero mapping a container with no A/V stream to
      // null output (e.g. an attachment-only .mks) — attachments are dumped
      // before that failure, so the files are already on disk regardless.
    }
    const files = await readdir(tmpDir);
    for (const filename of files) {
      if (!isFontFilename(filename)) continue;
      const bytes = await readFile(path.join(tmpDir, filename));
      await storeFontFile(db, mediaFileId, bytes, filename);
      stored += 1;
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
  return stored;
}

async function extractFromFontsDir(db: PrismaClient, mediaFileId: string, fontsDir: string): Promise<number> {
  let stored = 0;
  try {
    const files = await readdir(fontsDir);
    for (const filename of files) {
      if (!isFontFilename(filename)) continue;
      const bytes = await readFile(path.join(fontsDir, filename));
      await storeFontFile(db, mediaFileId, bytes, filename);
      stored += 1;
    }
  } catch {
    // no sibling fonts/ dir
  }
  return stored;
}

/**
 * Eager font extraction at scan time (§13.2) — Jellyfin's lazy, play-time
 * extraction shipped repeated silent-fallback bugs. All three sources
 * converge on the same hash-deduped Font store via storeFontFile, so a font
 * shared across files (or across the MKV/.mks/fonts-dir sources for one
 * file) is stored once and only linked multiple times.
 */
export async function extractFonts(db: PrismaClient, mediaFileId: string, filePath: string, dir: string): Promise<number> {
  let stored = 0;

  stored += await extractFromContainer(db, mediaFileId, filePath);

  const mksPath = filePath.replace(/\.[^./]+$/, ".mks");
  try {
    await stat(mksPath);
    stored += await extractFromContainer(db, mediaFileId, mksPath);
  } catch {
    // no .mks sidecar
  }

  stored += await extractFromFontsDir(db, mediaFileId, path.join(dir, "fonts"));

  return stored;
}
