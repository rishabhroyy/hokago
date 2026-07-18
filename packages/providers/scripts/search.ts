import type { MetadataProvider, MetadataQuery } from "@hokago/metadata";

import { AniListProvider } from "../src/anilist.js";
import { JikanProvider } from "../src/jikan.js";
import { TvMazeProvider } from "../src/tvmaze.js";

const PROVIDERS: Record<string, MetadataProvider> = {
  tvmaze: new TvMazeProvider(),
  anilist: new AniListProvider(),
  jikan: new JikanProvider(),
};

async function main() {
  const [providerArg, kindArg, titleArg, yearArg] = process.argv.slice(2);
  if (!providerArg || !kindArg || !titleArg) {
    console.error("usage: pnpm search <tvmaze|anilist|jikan> <MOVIE|SERIES> <title> [year] [lastModified]");
    process.exit(1);
  }
  const provider = PROVIDERS[providerArg];
  if (!provider) {
    console.error(`unknown provider: ${providerArg}`);
    process.exit(1);
  }

  const query: MetadataQuery = {
    title: titleArg,
    kind: kindArg as MetadataQuery["kind"],
    year: yearArg ? Number(yearArg) : undefined,
  };
  const lastModified = process.argv[6];

  const result = await provider.search(query, lastModified ? { lastModified } : undefined);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
