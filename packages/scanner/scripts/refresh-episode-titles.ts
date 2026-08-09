/**
 * One-shot repair for episode titles and per-season numbering, run via
 * `pnpm --filter @hokago/scanner episode-titles`.
 *
 * Three things this fixes (all from before multi-source enrichment, the
 * "Episode N" placeholder, and season-relative renumbering):
 *  1. EPISODE rows whose DB `title` is the filename-derived *series* title
 *     (e.g. every K-ON! row titled "K-ON!") — normalized to "Episode N".
 *  2. Missing `extra.episodeTitle` — re-runs the (now merged) enrichment so
 *     season 2+ episodes pick up titles from a provider that covers them.
 *  3. Season 2+ episodes stored with absolute anime numbering ("Season 2"
 *     folder holding files 13..24) — renumbered season-relative (1..12).
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

async function renumberSeasonEpisodes(): Promise<number> {
  const seasons = await db.mediaItem.findMany({
    where: { kind: "SEASON", seasonNumber: { gt: 1 } },
    select: { id: true, parentId: true, seasonNumber: true },
  });
  let renumbered = 0;
  for (const season of seasons) {
    if (!season.parentId) continue;
    const prior = await db.mediaItem.count({
      where: { kind: "EPISODE", parent: { parentId: season.parentId }, seasonNumber: { lt: season.seasonNumber } },
    });
    if (prior <= 0) continue;
    const episodes = await db.mediaItem.findMany({
      where: { kind: "EPISODE", parentId: season.id },
      select: { id: true, episodeNumber: true, title: true },
    });
    for (const ep of episodes) {
      if (ep.episodeNumber == null || ep.episodeNumber <= prior) continue;
      const n = ep.episodeNumber - prior;
      await db.mediaItem.update({
        where: { id: ep.id },
        data: { episodeNumber: n, title: `Episode ${n}`, sortTitle: `episode ${n}` },
      });
      renumbered += 1;
    }
  }
  return renumbered;
}

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
  const renumbered = await renumberSeasonEpisodes();
  console.log(`Season episodes renumbered: ${renumbered}`);
}

main()
  .then(() => db.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect();
    process.exit(1);
  });
