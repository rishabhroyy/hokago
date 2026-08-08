/**
 * One-shot repair for episode titles, run via
 * `pnpm --filter @hokago/scanner episode-titles`.
 *
 * Two things this fixes (both from before multi-source enrichment and the
 * "Episode N" placeholder):
 *  1. EPISODE rows whose DB `title` is the filename-derived *series* title
 *     (e.g. every K-ON! row titled "K-ON!") — normalized to "Episode N".
 *  2. Missing `extra.episodeTitle` — re-runs the (now merged) enrichment so
 *     season 2+ episodes pick up titles from a provider that covers them.
 *
 * Idempotent: normalized titles and already-set episodeTitles are skipped.
 */
import { PrismaClient } from "@hokago/db";
import type { MetadataProvider } from "@hokago/metadata";
import { enrichSeriesEpisodeTitles } from "../src/metadata.js";
import { AniListProvider, JikanProvider, TvMazeProvider } from "@hokago/providers";

const db = new PrismaClient();

const PROVIDERS: Record<string, MetadataProvider> = {
  TVMAZE: new TvMazeProvider(),
  ANILIST: new AniListProvider(),
  JIKAN: new JikanProvider(),
};

async function main(): Promise<void> {
  const series = await db.mediaItem.findMany({
    where: { kind: "SERIES", externalIds: { some: {} } },
    select: { id: true, title: true },
  });
  console.log(`Found ${series.length} matched series`);

  let episodesFixed = 0;
  let enriched = 0;

  for (const s of series) {
    const episodes = await db.mediaItem.findMany({
      where: { kind: "EPISODE", OR: [{ parentId: s.id }, { parent: { parentId: s.id } }] },
      select: { id: true, title: true, episodeNumber: true, extra: true },
    });
    for (const ep of episodes) {
      if (ep.episodeNumber == null) continue;
      const wanted = `Episode ${ep.episodeNumber}`;
      if (ep.title !== wanted) {
        await db.mediaItem.update({ where: { id: ep.id }, data: { title: wanted, sortTitle: wanted.toLowerCase() } });
        episodesFixed += 1;
      }
    }
    const before = await db.mediaItem.count({
      where: { kind: "EPISODE", extra: { path: ["episodeTitle"], not: null }, OR: [{ parentId: s.id }, { parent: { parentId: s.id } }] },
    });
    await enrichSeriesEpisodeTitles(db, s.id, PROVIDERS);
    const after = await db.mediaItem.count({
      where: { kind: "EPISODE", extra: { path: ["episodeTitle"], not: null }, OR: [{ parentId: s.id }, { parent: { parentId: s.id } }] },
    });
    enriched += after - before;
  }

  console.log(`Episode titles normalized: ${episodesFixed}`);
  console.log(`Episode titles enriched: ${enriched}`);
}

main()
  .then(() => db.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect();
    process.exit(1);
  });
