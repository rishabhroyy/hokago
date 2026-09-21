import assert from "node:assert/strict";
import { test } from "node:test";

import { __resetIdentityBudgetForTests, findSeriesByExternalIds, resolveQueryExternalIds } from "./identity.js";

function fakeIdentityDb(
  externalRows: { mediaItemId: string | null; provider: string; providerId: string }[],
  seriesRows: { id: string; title: string; year: number | null; libraryId: string }[],
  libraryId: string,
) {
  return {
    db: {
      externalId: {
        findMany: async (args: unknown) => {
          const or = (args as { where: { OR: { provider: string; providerId: string }[] } }).where.OR;
          return externalRows.filter((r) => or.some((q) => q.provider === r.provider && q.providerId === r.providerId));
        },
      },
      mediaItem: {
        findMany: async (args: unknown) => {
          const where = (args as { where: { id: { in: string[] }; libraryId: string; kind: string } }).where;
          return seriesRows.filter((s) => where.id.in.includes(s.id) && s.libraryId === libraryId && where.kind === "SERIES");
        },
      },
    },
  } as unknown as Parameters<typeof findSeriesByExternalIds>[0];
}

test("findSeriesByExternalIds: resolves a row in the same library", async () => {
  const deps = fakeIdentityDb(
    [{ mediaItemId: "s1", provider: "ANILIST", providerId: "139585" }],
    [{ id: "s1", title: "Frieren: Beyond Journey's End", year: 2023, libraryId: "lib-1" }],
    "lib-1",
  );
  const hit = await findSeriesByExternalIds(deps, "lib-1", [{ provider: "ANILIST", providerId: "139585" }]);
  assert.equal(hit?.id, "s1");
});

test("findSeriesByExternalIds: ignores rows from other libraries and null links", async () => {
  const deps = fakeIdentityDb(
    [
      { mediaItemId: "other", provider: "ANILIST", providerId: "139585" },
      { mediaItemId: null, provider: "MAL", providerId: "22297" },
    ],
    [{ id: "other", title: "Frieren", year: 2023, libraryId: "lib-2" }],
    "lib-1",
  );
  const hit = await findSeriesByExternalIds(deps, "lib-1", [
    { provider: "ANILIST", providerId: "139585" },
    { provider: "MAL", providerId: "22297" },
  ]);
  assert.equal(hit, undefined);
});

test("findSeriesByExternalIds: empty ids short-circuit without touching the database", async () => {
  let calls = 0;
  const deps = {
    db: {
      externalId: {
        findMany: async () => {
          calls += 1;
          return [];
        },
      },
      mediaItem: { findMany: async () => [] },
    },
  } as unknown as Parameters<typeof findSeriesByExternalIds>[0];
  assert.equal(await findSeriesByExternalIds(deps, "lib-1", []), undefined);
  assert.equal(calls, 0);
});

test("resolveQueryExternalIds: accepted match yields ANILIST plus alternate ids", async () => {
  const ids = await resolveQueryExternalIds("Frieren", 2023, {
    search: async () => ({
      matches: [
        {
          providerId: "139585",
          title: "Frieren: Beyond Journey's End",
          year: 2023,
          titles: [{ type: "ROMAJI", value: "Sousou no Frieren" }],
          alternateIds: [{ provider: "MAL", id: "22297" }],
        },
      ],
    }),
  });
  assert.deepEqual(ids, [
    { provider: "ANILIST", providerId: "139585" },
    { provider: "MAL", providerId: "22297" },
  ]);
});

test("resolveQueryExternalIds: no accepted match, empty title, and search faults all yield undefined", async () => {
  assert.equal(
    await resolveQueryExternalIds("Frieren", 2023, { search: async () => ({ matches: [] }) }),
    undefined,
  );
  assert.equal(await resolveQueryExternalIds("   ", null), undefined);
  assert.equal(
    await resolveQueryExternalIds("Frieren", null, {
      search: async () => {
        throw new Error("network down");
      },
    }),
    undefined,
  );
});

test("resolveQueryExternalIds: exhausted budget degrades to undefined without searching", async () => {
  __resetIdentityBudgetForTests();
  try {
    let calls = 0;
    const search = async () => {
      calls += 1;
      return {
        matches: [
          {
            providerId: "139585",
            title: "Frieren: Beyond Journey's End",
            year: 2023,
            titles: [],
          },
        ],
      };
    };
    for (let i = 0; i < 20; i++) {
      assert.ok(await resolveQueryExternalIds("Frieren", 2023, { search }));
    }
    assert.equal(calls, 20);
    assert.equal(await resolveQueryExternalIds("Frieren", 2023, { search }), undefined);
    assert.equal(calls, 20, "exhausted budget must not reach the network");
  } finally {
    __resetIdentityBudgetForTests();
  }
});
