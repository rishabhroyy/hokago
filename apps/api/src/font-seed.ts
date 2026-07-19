import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@hokago/db";
import type { ThemeManifest } from "@hokago/theme";

const VENDOR_DIR = process.env.HOKAGO_FONTS_VENDOR_DIR ?? path.resolve(import.meta.dirname, "../../../packages/fonts/vendor");

function fontStoreDir(): string {
  return path.join(process.env.HOKAGO_CONFIG_DIR ?? "./data/config", "fonts");
}

// Filename → (family, weight) for the chrome fonts packages/fonts vendors at
// build time (§1.1 source 1, VENDORED — the offline-boot floor). Only the
// "latin" subset is registered: the per-file fontsource CSS carries no
// unicode-range, so also serving "latin-ext" would just be a second
// @font-face with an identical selector and no way for the browser to choose
// between them.
const VENDORED_FONTS: { file: string; family: string; weight: number }[] = [
  ...[400, 500, 600, 700].map((weight) => ({ file: `inter/inter-latin-${weight}-normal.woff2`, family: "Inter", weight })),
  ...[400, 500, 600, 700].map((weight) => ({
    file: `jetbrains-mono/jetbrains-mono-latin-${weight}-normal.woff2`,
    family: "JetBrains Mono",
    weight,
  })),
  { file: "wordmark/zen-maru-gothic-500-hokago-subset.woff2", family: "Zen Maru Gothic", weight: 500 },
];

/**
 * Registers the build-time-vendored chrome fonts into the same hash-deduped
 * Font store subtitle-extracted fonts already use (packages/scanner/src/
 * fonts.ts), then links each to every reference theme whose font stacks name
 * that family — the missing piece that made §15 font tokens silently
 * degrade to their stack's fallback member in every real browser.
 */
export async function seedVendoredFonts(db: PrismaClient, themes: ThemeManifest[]): Promise<void> {
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

    for (const theme of themes) {
      if (!Object.values(theme.tokens.font).some((stack) => stack[0] === family)) continue;
      const row = await db.theme.findUnique({ where: { slug: theme.slug } });
      if (!row) continue;
      await db.themeFont.upsert({
        where: { themeId_fontHash: { themeId: row.id, fontHash: hash } },
        create: { themeId: row.id, fontHash: hash },
        update: {},
      });
    }
  }
}
