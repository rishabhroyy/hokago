import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@hokago/db";

const VENDOR_DIR = process.env.HOKAGO_FONTS_VENDOR_DIR ?? path.resolve(import.meta.dirname, "../../../packages/fonts/vendor");

function fontStoreDir(): string {
  return path.join(process.env.HOKAGO_CONFIG_DIR ?? "./data/config", "fonts");
}

// Filename → (family, weight) for the chrome fonts packages/fonts vendors at
// build time (source 1, VENDORED — the offline-boot floor). Only the
// "latin" subset is registered: the per-file fontsource CSS carries no
// unicode-range, so also serving "latin-ext" would just be a second
// @font-face with an identical selector and no way for the browser to choose
// between them.
const VENDORED_FONTS: { file: string; family: string; weight: number }[] = [
  ...[400, 500, 600, 700, 800].map((weight) => ({
    file: `plus-jakarta-sans/plus-jakarta-sans-latin-${weight}-normal.woff2`,
    family: "Plus Jakarta Sans",
    weight,
  })),
  ...[400, 500].map((weight) => ({
    file: `jetbrains-mono/jetbrains-mono-latin-${weight}-normal.woff2`,
    family: "JetBrains Mono",
    weight,
  })),
  { file: "wordmark/zen-maru-gothic-500-hokago-subset.woff2", family: "Zen Maru Gothic", weight: 500 },
 // Display tier : full latin charset — renders font.display for
  // arbitrary heading text, not just the "hokago" wordmark glyphs. Shares
  // family/weight 500 with the subset above; browsers resolve same-
  // family/weight @font-face duplicates by picking whichever declaration
  // actually has the requested glyph, so this coexists fine.
  ...[500, 700, 900].map((weight) => ({
    file: `zen-maru-gothic/zen-maru-gothic-latin-${weight}-normal.woff2`,
    family: "Zen Maru Gothic",
    weight,
  })),
];

/**
 * Registers the build-time-vendored chrome fonts into the same hash-deduped
 * Font store subtitle-extracted fonts already use (packages/scanner/src/
 * fonts.ts). There's one font stack, so no per-theme linking — every vendored
 * font is just always served.
 */
export async function seedVendoredFonts(db: PrismaClient): Promise<void> {
  const dir = fontStoreDir();
  await mkdir(dir, { recursive: true });

  for (const { file, family, weight } of VENDORED_FONTS) {
    const bytes = await readFile(path.join(VENDOR_DIR, file));
    const hash = createHash("sha256").update(bytes).digest("hex");
    const storedPath = path.join(dir, `${hash}.woff2`);
    try {
      await stat(storedPath);
    } catch {
      await writeFile(storedPath, bytes);
    }

    await db.font.upsert({
      where: { hash },
      create: { hash, family, weight, style: "normal", format: "WOFF2", source: "VENDORED", path: storedPath, sizeBytes: bytes.length },
      update: {},
    });
  }
}
