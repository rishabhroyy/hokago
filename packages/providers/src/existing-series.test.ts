import assert from "node:assert/strict";
import { test } from "node:test";

import { checkSeasonDedup, findExistingSeries, seasonsForSeries, type SeasonDedupDeps } from "./existing-series.js";

interface Series {
  id: string;
  title: string;
  originalTitle: string | null;
  year: number | null;
}

interface Episode {
  seriesId: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
}

function fakeDeps(series: Series[], episodes: Episode[]): SeasonDedupDeps {
  return {
    db: {
      mediaItem: {
        findMany: async (args: unknown) => {
          const where = (args as { where: Record<string, unknown> }).where;
          if (where.kind === "SERIES") {
            return series.filter((s) => (where as { libraryId: string }).libraryId === "lib-1");
          }
          const seriesId = (where.parent as { parentId: string }).parentId;
          return episodes.filter((e) => e.seriesId === seriesId).map((e) => ({ seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber }));
        },
      },
    },
  } as unknown as SeasonDedupDeps;
}

test("findExistingSeries: no match for a genuinely new show", async () => {
  const deps = fakeDeps([{ id: "s1", title: "Frieren", originalTitle: null, year: 2023 }], []);
  const match = await findExistingSeries(deps, "lib-1", "Some New Show", 2024);
  assert.equal(match, undefined);
});

test("findExistingSeries: fuzzy/AKA title still matches", async () => {
  const deps = fakeDeps([{ id: "s1", title: "Frieren: Beyond Journey's End", originalTitle: "Sousou no Frieren", year: 2023 }], []);
  const match = await findExistingSeries(deps, "lib-1", "Sousou no Frieren", 2023);
  assert.equal(match?.id, "s1");
});

test("findExistingSeries: short stored row matches a fuller request (bidirectional)", async () => {
  // The Anohana fork shape: the library holds the short canonical folder
  // while the acquire request carries the fuller provider title (already
  // cleaned of "BD 1080p" by parseAnicliQuery upstream). One-directional
  // "query in candidate" matching misses this every time.
  const deps = fakeDeps([{ id: "s1", title: "Anohana", originalTitle: null, year: 2011 }], []);
  const match = await findExistingSeries(deps, "lib-1", "Anohana The Flower We Saw That Day", 2011);
  assert.equal(match?.id, "s1");
});

test("findExistingSeries: fuller stored row still matches a short request", async () => {
  const deps = fakeDeps([{ id: "s1", title: "Anohana The Flower We Saw That Day", originalTitle: null, year: 2011 }], []);
  const match = await findExistingSeries(deps, "lib-1", "Anohana", 2011);
  assert.equal(match?.id, "s1");
});

test("findExistingSeries: originalTitle matches in either direction", async () => {
  const deps = fakeDeps([{ id: "s1", title: "Frieren: Beyond Journey's End", originalTitle: "Sousou no Frieren", year: 2023 }], []);
  const viaOriginal = await findExistingSeries(deps, "lib-1", "Sousou no Frieren", 2023);
  assert.equal(viaOriginal?.id, "s1");
  // Stored short AKA against a fuller request is the same bidirectional case.
  const deps2 = fakeDeps([{ id: "s1", title: "Sousou no Frieren", originalTitle: null, year: 2023 }], []);
  const reverse = await findExistingSeries(deps2, "lib-1", "Frieren Beyond Journey s End", 2023);
  assert.equal(reverse, undefined, "unrelated fuller titles must not carpet-match a short row");
});

test("checkSeasonDedup: season 0 always passes, even with existing specials", async () => {
  const deps = fakeDeps(
    [{ id: "s1", title: "Frieren", originalTitle: null, year: 2023 }],
    [{ seriesId: "s1", seasonNumber: 0, episodeNumber: 1 }],
  );
  const result = await checkSeasonDedup(deps, "lib-1", "Frieren", 2023, 0, undefined);
  assert.equal(result.ok, true);
});

test("checkSeasonDedup: a genuinely new season on an existing show passes", async () => {
  const deps = fakeDeps(
    [{ id: "s1", title: "Frieren", originalTitle: null, year: 2023 }],
    [{ seriesId: "s1", seasonNumber: 1, episodeNumber: 1 }],
  );
  const result = await checkSeasonDedup(deps, "lib-1", "Frieren", 2023, 2, undefined);
  assert.equal(result.ok, true);
});

test("checkSeasonDedup: no range against a partially-filled season fails closed", async () => {
  const deps = fakeDeps(
    [{ id: "s1", title: "Frieren", originalTitle: null, year: 2023 }],
    [{ seriesId: "s1", seasonNumber: 1, episodeNumber: 1 }],
  );
  const result = await checkSeasonDedup(deps, "lib-1", "Frieren", 2023, 1, undefined);
  assert.equal(result.ok, false);
});

test("checkSeasonDedup: a fully-covered episode range blocks", async () => {
  const deps = fakeDeps(
    [{ id: "s1", title: "Frieren", originalTitle: null, year: 2023 }],
    [
      { seriesId: "s1", seasonNumber: 1, episodeNumber: 1 },
      { seriesId: "s1", seasonNumber: 1, episodeNumber: 2 },
    ],
  );
  const result = await checkSeasonDedup(deps, "lib-1", "Frieren", 2023, 1, "1-2");
  assert.equal(result.ok, false);
});

test("checkSeasonDedup: a malformed range against a partially-filled season fails closed (unparseable range is treated as no range) — callers must validate range format before this, not rely on it for that", async () => {
  const deps = fakeDeps(
    [{ id: "s1", title: "Frieren", originalTitle: null, year: 2023 }],
    [{ seriesId: "s1", seasonNumber: 1, episodeNumber: 1 }],
  );
  const result = await checkSeasonDedup(deps, "lib-1", "Frieren", 2023, 1, "not-a-range");
  assert.equal(result.ok, false);
});

test("checkSeasonDedup: a partially-covered range (gap fill) passes", async () => {
  const deps = fakeDeps(
    [{ id: "s1", title: "Frieren", originalTitle: null, year: 2023 }],
    [{ seriesId: "s1", seasonNumber: 1, episodeNumber: 1 }],
  );
  const result = await checkSeasonDedup(deps, "lib-1", "Frieren", 2023, 1, "1-3");
  assert.equal(result.ok, true);
});

test("checkSeasonDedup: a show emptied via delete-files-keep-folder re-opens (zero episodes = pass)", async () => {
  const deps = fakeDeps([{ id: "s1", title: "Frieren", originalTitle: null, year: 2023 }], []);
  const result = await checkSeasonDedup(deps, "lib-1", "Frieren", 2023, 1, undefined);
  assert.equal(result.ok, true);
});

test("seasonsForSeries: groups and sorts episode numbers per season", async () => {
  const deps = fakeDeps(
    [],
    [
      { seriesId: "s1", seasonNumber: 1, episodeNumber: 2 },
      { seriesId: "s1", seasonNumber: 1, episodeNumber: 1 },
      { seriesId: "s1", seasonNumber: 2, episodeNumber: 1 },
    ],
  );
  const breakdown = await seasonsForSeries(deps, "s1");
  assert.deepEqual(breakdown, [
    { season: 1, episodeNumbers: [1, 2] },
    { season: 2, episodeNumbers: [1] },
  ]);
});
