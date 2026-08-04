import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { PrismaClient } from "@hokago/db";
import type { MetadataProvider } from "@hokago/metadata";
import { AniListProvider, JikanProvider, WikidataBridge } from "@hokago/providers";

import { buildProviderChain, resolveMetadataStep } from "../src/metadata.js";
import { ingestLibrary } from "../src/ingest.js";
import { walkVideoFiles } from "../src/walk.js";
import { syncEvidenceAndConfidence } from "../src/evidence.js";
import { LOCAL_SIGNAL_TYPES } from "../src/constants.js";

// storeBytes writes artwork under HOKAGO_CONFIG_DIR (default ./data/config)
// relative to cwd — scripts run from the package dir via pnpm, so pin it to
// the repo root config dir the API/worker serve from, unless already set.
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
process.env.HOKAGO_CONFIG_DIR ??= path.join(REPO_ROOT, "data", "config");

const PROVIDERS: Record<string, MetadataProvider> = {
  ANILIST: new AniListProvider(),
  MAL: new JikanProvider(),
};

const db = new PrismaClient();
const wikidataBridge = new WikidataBridge();

async function resolveInline(mediaItemId: string, libraryId: string, kind: "MOVIE" | "SERIES", title: string, year: number | null, profile: string, providerOrder: string[]) {
  const chain = buildProviderChain(kind, profile as "GENERAL" | "ANIME", providerOrder);
  for (const name of chain) {
    const provider = PROVIDERS[name];
    if (!provider) continue;
    try {
      const matched = await Promise.race([
        resolveMetadataStep(db, { mediaItemId, libraryId, kind, title, year }, name, provider, wikidataBridge),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out after 30s")), 30_000)),
      ]);
      if (matched) return;
    } catch (err) {
      console.warn(`  [${name}] failed for "${title}": ${err instanceof Error ? err.message : err}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const retryMissing = args.includes("--retry-missing");
  const positional = args.filter((a) => !a.startsWith("--"));
  const rootPath = positional[0] ?? path.join(os.homedir(), "Downloads", "Anime");
  const name = positional[1] ?? "Anime";
  const resolved = path.resolve(rootPath);

  const library = await db.library.upsert({
    where: { rootPath: resolved },
    create: {
      rootPath: resolved,
      name,
      contentProfile: "ANIME",
      mediaKinds: ["MOVIE", "SERIES", "SEASON", "EPISODE"],
      providerOrder: [],
      scanMode: "MANUAL",
    },
    update: {},
  });

  if (retryMissing) {
    const missing = await db.mediaItem.findMany({
      where: { libraryId: library.id, kind: "SERIES", externalIds: { none: {} } },
      select: { id: true, title: true },
    });
    console.log(`Retrying ${missing.length} unmatched series...`);
    for (const item of missing) {
      console.log(`Retrying "${item.title}"...`);
      await resolveInline(item.id, library.id, "SERIES", item.title, null, library.contentProfile, library.providerOrder);
    }
    return;
  }

  console.log(`Library "${library.name}" (${library.contentProfile}) at ${resolved}`);
  console.log("Scanning with inline metadata resolution...");

  const summary = await ingestLibrary(db, library.id, resolved, {
    contentProfile: library.contentProfile,
    onMetadataNeeded: async (job) => {
      await resolveInline(job.mediaItemId, job.libraryId, job.kind, job.title, job.year, library.contentProfile, library.providerOrder);
    },
  });

  console.log("Scan complete:", JSON.stringify(summary));

  const existingFiles = new Set((await walkVideoFiles(resolved)).map((f) => f.dir));
  const entries = (await readdir(resolved, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));

  let bareCreated = 0;
  for (const entry of entries) {
    const dir = path.join(resolved, entry.name);
    if (existingFiles.has(dir)) continue;

    const series = await db.mediaItem.findFirst({
      where: { libraryId: library.id, kind: "SERIES", title: entry.name },
    });
    if (series) {
      console.log(`Skipping "${entry.name}" (already exists)`);
      continue;
    }

    const created = await db.mediaItem.create({
      data: {
        libraryId: library.id,
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
    bareCreated += 1;
    console.log(`Seeded empty folder "${entry.name}" — resolving via providers...`);
    await resolveInline(created.id, library.id, "SERIES", entry.name, null, library.contentProfile, library.providerOrder);
  }

  console.log(`Bare series created: ${bareCreated}`);
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await db.$disconnect();
    process.exit(1);
  });
