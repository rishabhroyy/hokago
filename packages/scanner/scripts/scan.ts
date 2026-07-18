import path from "node:path";

import { PrismaClient } from "@hokago/db";

import { ingestLibrary } from "../src/ingest.js";

async function main() {
  const [rootArg, nameArg] = process.argv.slice(2);
  if (!rootArg) {
    console.error("usage: pnpm scan <path> [library-name]");
    process.exit(1);
  }

  const rootPath = path.resolve(rootArg);
  const name = nameArg ?? path.basename(rootPath);

  const db = new PrismaClient();
  try {
    const library = await db.library.upsert({
      where: { rootPath },
      create: {
        rootPath,
        name,
        contentProfile: "GENERAL",
        mediaKinds: ["MOVIE", "SERIES", "SEASON", "EPISODE"],
        providerOrder: [],
        scanMode: "MANUAL",
      },
      update: {},
    });

    console.log(`Scanning "${library.name}" at ${rootPath}...`);
    const summary = await ingestLibrary(db, library.id, rootPath);

    console.log("");
    console.log("Scan complete:");
    console.log(`  directories scanned : ${summary.directoriesScanned}`);
    console.log(`  files scanned       : ${summary.filesScanned}`);
    console.log(`  series created      : ${summary.seriesCreated}`);
    console.log(`  movies created      : ${summary.moviesCreated}`);
    console.log(`  episodes created    : ${summary.episodesCreated}`);
    console.log(`  artwork stored      : ${summary.artworkStored}`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
