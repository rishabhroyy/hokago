import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import subsetFont from "subset-font";

const root = path.resolve(import.meta.dirname, "..");
const vendorDir = path.join(root, "vendor");

const WEIGHTS = [400, 500, 600, 700] as const;
const SUBSETS = ["latin", "latin-ext"] as const;

async function copyFontsourceFiles(pkg: string, outDir: string, weights: readonly number[] = WEIGHTS) {
  await mkdir(outDir, { recursive: true });
  const filesDir = path.join(root, "node_modules/@fontsource", pkg, "files");
  for (const weight of weights) {
    for (const subset of SUBSETS) {
      const name = `${pkg}-${subset}-${weight}-normal.woff2`;
      const buf = await readFile(path.join(filesDir, name));
      await writeFile(path.join(outDir, name), buf);
    }
  }
}

async function buildWordmark() {
  const outDir = path.join(vendorDir, "wordmark");
  await mkdir(outDir, { recursive: true });
  const src = await readFile(
    path.join(
      root,
      "node_modules/@fontsource/zen-maru-gothic/files/zen-maru-gothic-latin-500-normal.woff2",
    ),
  );
  const subset = await subsetFont(src, "hokago", { targetFormat: "woff2" });
  await writeFile(path.join(outDir, "zen-maru-gothic-500-hokago-subset.woff2"), subset);
}

async function main() {
  await rm(vendorDir, { recursive: true, force: true });
  await buildWordmark();
  await copyFontsourceFiles("inter", path.join(vendorDir, "inter"));
  await copyFontsourceFiles("jetbrains-mono", path.join(vendorDir, "jetbrains-mono"));
  // Default UI tier (§1.1, §15.2): Regular + Medium, full latin/latin-ext
  // charset (not the 5-glyph wordmark subset) — this is what renders
  // font.display for arbitrary heading text, not just "hokago".
  await copyFontsourceFiles("zen-maru-gothic", path.join(vendorDir, "zen-maru-gothic"), [400, 500]);
  console.log("fonts vendored to", vendorDir);
}

main();
