import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { processAcquireImport, acquireImportStagingDir, resolveSeriesDirOnDisk } from "./acquire-import.js";
import { seasonTargetDir, type AcquireImportJobData, type Job } from "@hokago/queue";

async function startServer(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("unexpected server address");
  return { baseUrl: `http://127.0.0.1:${addr.port}`, server };
}

function fakeJob(data: AcquireImportJobData): Job<AcquireImportJobData> {
  return { data } as unknown as Job<AcquireImportJobData>;
}

async function existsDir(p: string): Promise<boolean> {
  return readdir(p).then(() => true).catch(() => false);
}

test("processAcquireImport streams to the library-convention path, cleans staging, and triggers a scan on success", async () => {
  const payload = Buffer.from("some video bytes, definitely not a real container");
  const { baseUrl, server } = await startServer((req, res) => {
    res.writeHead(200, { "content-length": String(payload.length), "content-type": "video/mp4" });
    res.end(payload);
  });

  const root = await mkdtemp(path.join(tmpdir(), "acquire-import-test-"));
  let scannedLibraryId: string | null = null;

  try {
    await processAcquireImport(
      fakeJob({ providerId: "ext1", downloadId: "dl-1", baseUrl, libraryId: "lib-1", query: "Frieren", title: "Frieren" }),
      {
        db: { library: { findUnique: async () => ({ rootPath: root }) }, mediaItem: { findMany: async () => [] } },
        enqueueScan: async (libraryId) => {
          scannedLibraryId = libraryId;
        },
        scanSettleMs: 0,
      },
    );

    // Same placement convention as ani-cli: flat "<root>/<Series>/" for a
    // query with no season signal.
    const finalDir = path.join(root, "Frieren");
    const files = await readdir(finalDir);
    assert.deepEqual(files, ["Frieren.mp4"]);
    assert.deepEqual(await readFile(path.join(finalDir, files[0]!)), payload);
    assert.equal(scannedLibraryId, "lib-1");
    assert.equal(await existsDir(acquireImportStagingDir(root, "ext1", "dl-1")), false, "this job's staging dir must be gone after a clean success");
  } finally {
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("processAcquireImport treats a truncated stream as a failure: rejects, no file in the library, no scan, nothing left in staging", async () => {
  const { baseUrl, server } = await startServer((req, res) => {
    // Promise 1000 bytes via Content-Length, then die after a few --
    // exactly the "connection destroyed mid-stream" failure mode the
    // provider contract describes; no trailing error JSON to expect.
    res.writeHead(200, { "content-length": "1000" });
    res.write(Buffer.from("only a few bytes"));
    res.destroy();
  });

  const root = await mkdtemp(path.join(tmpdir(), "acquire-import-test-"));
  let scanCalled = false;

  try {
    await assert.rejects(
      processAcquireImport(
        fakeJob({ providerId: "ext1", downloadId: "dl-2", baseUrl, libraryId: "lib-1", query: "Frieren" }),
        {
          db: { library: { findUnique: async () => ({ rootPath: root }) }, mediaItem: { findMany: async () => [] } },
          enqueueScan: async () => {
            scanCalled = true;
          },
          scanSettleMs: 0,
        },
      ),
    );

    assert.equal(scanCalled, false, "a failed transfer must never trigger the follow-up scan");
    assert.equal(await existsDir(path.join(root, "Frieren")), false, "no file may land in the library on a truncated stream");
    assert.equal(await existsDir(acquireImportStagingDir(root, "ext1", "dl-2")), false, "the partial temp file must be cleaned up, not left behind");
  } finally {
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("processAcquireImport rejects and cleans up when the provider omits Content-Length", async () => {
  const { baseUrl, server } = await startServer((req, res) => {
    res.writeHead(200); // no content-length -- the provider contract violated
    res.end(Buffer.from("bytes with no declared length"));
  });

  const root = await mkdtemp(path.join(tmpdir(), "acquire-import-test-"));
  try {
    await assert.rejects(
      processAcquireImport(
        fakeJob({ providerId: "ext1", downloadId: "dl-3", baseUrl, libraryId: "lib-1", query: "Frieren" }),
        {
          db: { library: { findUnique: async () => ({ rootPath: root }) }, mediaItem: { findMany: async () => [] } },
          enqueueScan: async () => {},
          scanSettleMs: 0,
        },
      ),
    );
    assert.equal(await existsDir(acquireImportStagingDir(root, "ext1", "dl-3")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("processAcquireImport aborts a stalled stream (no bytes at all, connection left open) instead of hanging forever", async () => {
  const { baseUrl, server } = await startServer((req, res) => {
    // Headers only, then silence -- never writes another byte and never
    // ends the response. A real stall, not a destroyed connection: proves
    // the timeout is watching for "no progress", not just "stream broke".
    res.writeHead(200, { "content-length": "1000" });
  });

  const root = await mkdtemp(path.join(tmpdir(), "acquire-import-test-"));
  try {
    await assert.rejects(
      processAcquireImport(
        fakeJob({ providerId: "ext1", downloadId: "dl-5", baseUrl, libraryId: "lib-1", query: "Frieren" }),
        {
          db: { library: { findUnique: async () => ({ rootPath: root }) }, mediaItem: { findMany: async () => [] } },
          enqueueScan: async () => {},
          scanSettleMs: 0,
          stallMs: 200, // real default is 5 minutes -- tiny here so the test doesn't wait for it
        },
      ),
      // Either message is the same protection firing -- whether the abort
      // lands during connect or during the (headers-only, bodyless) stream
      // phase is a timing race this test has no reason to pin down.
      /never responded|stalled/,
    );
    assert.equal(await existsDir(acquireImportStagingDir(root, "ext1", "dl-5")), false, "nothing left behind after an aborted stall");
  } finally {
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("processAcquireImport never clobbers a file that already exists at the destination", async () => {
  const payload = Buffer.from("new bytes");
  const { baseUrl, server } = await startServer((req, res) => {
    res.writeHead(200, { "content-length": String(payload.length) });
    res.end(payload);
  });

  const root = await mkdtemp(path.join(tmpdir(), "acquire-import-test-"));
  const { mkdir, writeFile } = await import("node:fs/promises");
  const finalDir = path.join(root, "Frieren");
  await mkdir(finalDir, { recursive: true });
  await writeFile(path.join(finalDir, "Frieren.mp4"), "already here");

  try {
    await processAcquireImport(
      fakeJob({ providerId: "ext1", downloadId: "dl-4", baseUrl, libraryId: "lib-1", query: "Frieren", title: "Frieren" }),
      {
        db: { library: { findUnique: async () => ({ rootPath: root }) }, mediaItem: { findMany: async () => [] } },
        enqueueScan: async () => {},
        scanSettleMs: 0,
      },
    );
    assert.equal((await readFile(path.join(finalDir, "Frieren.mp4"))).toString(), "already here");
  } finally {
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("processAcquireImport reuses an existing similar-sounding series instead of creating a near-duplicate folder", async () => {
  const payload = Buffer.from("existing-series bytes");
  const { baseUrl, server } = await startServer((req, res) => {
    res.writeHead(200, { "content-length": String(payload.length) });
    res.end(payload);
  });

  const root = await mkdtemp(path.join(tmpdir(), "acquire-import-test-"));
  try {
    await processAcquireImport(
      fakeJob({ providerId: "ext1", downloadId: "dl-6", baseUrl, libraryId: "lib-1", query: "Frieren", title: "Frieren" }),
      {
        db: {
          library: { findUnique: async () => ({ rootPath: root }) },
          // A show this library already has, under its own fuller,
          // canonical title -- the "query embedded in the fuller title"
          // shape acceptMatch's own doc comment gives as its example.
          mediaItem: { findMany: async () => [{ id: "series-1", title: "Frieren: Beyond Journey's End", originalTitle: null, year: null }] },
        },
        enqueueScan: async () => {},
        scanSettleMs: 0,
      },
    );

    const finalDir = seasonTargetDir(root, "Frieren: Beyond Journey's End", null, null);
    const files = await readdir(finalDir);
    assert.equal(files.length, 1, "file should land under the existing series' own folder, not a fresh one derived from this request's raw title");
    assert.deepEqual(await readFile(path.join(finalDir, files[0]!)), payload);
    assert.equal(await existsDir(path.join(root, "Frieren")), false, "must not also create a near-duplicate folder from the raw query/title text");
  } finally {
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("processAcquireImport keeps sibling files distinct even when the title alone consumes sanitizeFolder's whole 80-char budget", async () => {
  // Pure truncation case (no release junk): a genuinely 80-char clean title
  // leaves zero room for " - Episode NN" once appended — every sibling job
  // truncated to the identical filename despite genuinely different
  // episodeRange values without the suffix-first reservation. Kept clean on
  // purpose so release-junk cleaning cannot shorten it and hide the edge.
  const longTitle = "L".repeat(80);
  assert.equal(longTitle.length, 80, "test fixture must reproduce the exact failure length");

  const payload1 = Buffer.from("episode one bytes");
  const payload2 = Buffer.from("episode two bytes");
  let call = 0;
  const { baseUrl, server } = await startServer((req, res) => {
    call += 1;
    const payload = call === 1 ? payload1 : payload2;
    res.writeHead(200, { "content-length": String(payload.length) });
    res.end(payload);
  });

  const root = await mkdtemp(path.join(tmpdir(), "acquire-import-test-"));
  const deps = {
    db: {
      library: { findUnique: async () => ({ rootPath: root }) },
      mediaItem: { findMany: async () => [] },
    },
    enqueueScan: async () => {},
    scanSettleMs: 0,
  };
  try {
    await processAcquireImport(
      fakeJob({ providerId: "ext1", downloadId: "dl-7", baseUrl, libraryId: "lib-1", query: longTitle, title: longTitle, episodeRange: "Episode 01" }),
      deps,
    );
    await processAcquireImport(
      fakeJob({ providerId: "ext1", downloadId: "dl-8", baseUrl, libraryId: "lib-1", query: longTitle, title: longTitle, episodeRange: "Episode 02" }),
      deps,
    );

    const finalDir = seasonTargetDir(root, longTitle, null, null);
    const files = await readdir(finalDir);
    assert.equal(files.length, 2, "both sibling files must land, not just the first one");
    const contents = await Promise.all(files.map((f) => readFile(path.join(finalDir, f))));
    assert.deepEqual(new Set(contents.map(String)), new Set([payload1.toString(), payload2.toString()]));
  } finally {
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("processAcquireImport cleans release junk and honors the season signal hidden behind it", async () => {
  // The real production shape that motivated the junk-tolerant parser: an
  // external provider title carrying both a season token and a quality tail.
  // Pre-fix this parsed flat with the junk in the folder name; now it must
  // land under the clean title in the Season 1 subfolder.
  const noisyTitle = "Judas Sewayaki Kitsune no Senko-san The Helpful Fox Senko-san Season 1 BD 1080pH";
  assert.equal(noisyTitle.length, 80, "fixture keeps the original production length");
  const cleanTitle = "Judas Sewayaki Kitsune no Senko-san The Helpful Fox Senko-san";

  const payload = Buffer.from("cleaned placement bytes");
  const { baseUrl, server } = await startServer((req, res) => {
    res.writeHead(200, { "content-length": String(payload.length) });
    res.end(payload);
  });

  const root = await mkdtemp(path.join(tmpdir(), "acquire-import-test-"));
  try {
    await processAcquireImport(
      fakeJob({ providerId: "ext1", downloadId: "dl-9", baseUrl, libraryId: "lib-1", query: noisyTitle, title: noisyTitle, episodeRange: "Episode 01" }),
      {
        db: {
          library: { findUnique: async () => ({ rootPath: root }) },
          mediaItem: { findMany: async () => [] },
        },
        enqueueScan: async () => {},
        scanSettleMs: 0,
      },
    );

    const finalDir = seasonTargetDir(root, cleanTitle, null, "Season 1");
    const files = await readdir(finalDir);
    assert.equal(files.length, 1, "file must land under the cleaned title + season subfolder");
    assert.deepEqual(await readFile(path.join(finalDir, files[0]!)), payload);
    assert.equal(await existsDir(seasonTargetDir(root, noisyTitle, null, null)), false, "must not create a junk-named folder from the raw provider title");
  } finally {
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("processAcquireImport reuses the existing show when the provider title carries BD/1080p junk (Anohana regression)", async () => {
  // Exact reported bug: /acquire/existing matched the real show ("already
  // have ... no files yet") but the import forked into a "... BD 1080p"
  // duplicate because findExistingSeries missed the noisy provider title.
  const payload = Buffer.from("anohana bytes");
  const { baseUrl, server } = await startServer((req, res) => {
    res.writeHead(200, { "content-length": String(payload.length) });
    res.end(payload);
  });

  const root = await mkdtemp(path.join(tmpdir(), "acquire-import-test-"));
  try {
    await processAcquireImport(
      fakeJob({
        providerId: "ext1",
        downloadId: "dl-10",
        baseUrl,
        libraryId: "lib-1",
        query: "anohana",
        title: "Anohana BD 1080p",
      }),
      {
        db: {
          library: { findUnique: async () => ({ rootPath: root }) },
          mediaItem: {
            findMany: async () => [{ id: "series-1", title: "Anohana The Flower We Saw That Day", originalTitle: null, year: 2011 }],
          },
        },
        enqueueScan: async () => {},
        scanSettleMs: 0,
      },
    );

    const finalDir = seasonTargetDir(root, "Anohana The Flower We Saw That Day", 2011, null);
    const files = await readdir(finalDir);
    assert.equal(files.length, 1, "noisy provider title must still land in the existing show's folder");
    assert.deepEqual(await readFile(path.join(finalDir, files[0]!)), payload);
    assert.equal(await existsDir(path.join(root, "Anohana BD 1080p")), false, "must not fork a junk-named duplicate show");
  } finally {
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("processAcquireImport falls back to the request query season when the provider title has none", async () => {
  const payload = Buffer.from("season fallback bytes");
  const { baseUrl, server } = await startServer((req, res) => {
    res.writeHead(200, { "content-length": String(payload.length) });
    res.end(payload);
  });

  const root = await mkdtemp(path.join(tmpdir(), "acquire-import-test-"));
  try {
    await processAcquireImport(
      fakeJob({
        providerId: "ext1",
        downloadId: "dl-11",
        baseUrl,
        libraryId: "lib-1",
        query: "Frieren Season 2",
        title: "Frieren BD 1080p",
      }),
      {
        db: {
          library: { findUnique: async () => ({ rootPath: root }) },
          mediaItem: { findMany: async () => [{ id: "series-1", title: "Frieren Beyond Journey s End", originalTitle: null, year: 2023 }] },
        },
        enqueueScan: async () => {},
        scanSettleMs: 0,
      },
    );

    const finalDir = seasonTargetDir(root, "Frieren Beyond Journey s End", 2023, "Season 2");
    const files = await readdir(finalDir);
    assert.equal(files.length, 1, "must land in the requested season even when the provider title carries no season signal");
  } finally {
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("processAcquireImport prefers the request title over an episode-number provider title for new shows", async () => {
  // The "01" folder regression: a per-item provider title carrying only
  // episode identity must never name a new series folder when the request
  // itself parsed clean.
  const payload = Buffer.from("request-title bytes");
  const { baseUrl, server } = await startServer((req, res) => {
    res.writeHead(200, { "content-length": String(payload.length) });
    res.end(payload);
  });

  const root = await mkdtemp(path.join(tmpdir(), "acquire-import-test-"));
  try {
    await processAcquireImport(
      fakeJob({
        providerId: "ext1",
        downloadId: "dl-12",
        baseUrl,
        libraryId: "lib-1",
        query: "anohana",
        title: "01",
        requestTitle: "Anohana The Flower We Saw That Day",
      }),
      {
        db: {
          library: { findUnique: async () => ({ rootPath: root }) },
          mediaItem: { findMany: async () => [] },
        },
        enqueueScan: async () => {},
        scanSettleMs: 0,
      },
    );

    const finalDir = seasonTargetDir(root, "Anohana The Flower We Saw That Day", null, null);
    const files = await readdir(finalDir);
    assert.equal(files.length, 1, "new folder must come from the request title, not the episode-number provider title");
    assert.equal(await existsDir(path.join(root, "01")), false, "must not create a numeric junk folder");
  } finally {
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("processAcquireImport prefers the real show over a legacy junk row shadowing it", async () => {
  // A pre-existing "01" SERIES row (from before the fail-closed guard)
  // exact-matches an episode-number provider title — but the request-level
  // query still matches the real show, which must win for both lookup and
  // folder naming.
  const payload = Buffer.from("shadow bytes");
  const { baseUrl, server } = await startServer((req, res) => {
    res.writeHead(200, { "content-length": String(payload.length) });
    res.end(payload);
  });

  const root = await mkdtemp(path.join(tmpdir(), "acquire-import-test-"));
  try {
    await processAcquireImport(
      fakeJob({ providerId: "ext1", downloadId: "dl-15", baseUrl, libraryId: "lib-1", query: "anohana", title: "01" }),
      {
        db: {
          library: { findUnique: async () => ({ rootPath: root }) },
          mediaItem: {
            findMany: async () => [
              { id: "junk-1", title: "01", originalTitle: null, year: null },
              { id: "series-1", title: "Anohana The Flower We Saw That Day", originalTitle: null, year: 2011 },
            ],
          },
        },
        enqueueScan: async () => {},
        scanSettleMs: 0,
      },
    );

    const finalDir = seasonTargetDir(root, "Anohana The Flower We Saw That Day", 2011, null);
    const files = await readdir(finalDir);
    assert.equal(files.length, 1, "must land in the real show folder, not the shadowing junk row");
    assert.equal(await existsDir(path.join(root, "01")), false, "must not reuse the junk folder");
  } finally {
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("processAcquireImport fails closed when no candidate carries series identity", async () => {
  const payload = Buffer.from("junk bytes");
  const { baseUrl, server } = await startServer((req, res) => {
    res.writeHead(200, { "content-length": String(payload.length) });
    res.end(payload);
  });

  const root = await mkdtemp(path.join(tmpdir(), "acquire-import-test-"));
  try {
    await assert.rejects(
      processAcquireImport(
        fakeJob({ providerId: "ext1", downloadId: "dl-13", baseUrl, libraryId: "lib-1", query: "01", title: "Episode 5" }),
        {
          db: {
            library: { findUnique: async () => ({ rootPath: root }) },
            mediaItem: { findMany: async () => [] },
          },
          enqueueScan: async () => {},
          scanSettleMs: 0,
        },
      ),
      /could not determine series title/,
    );
    assert.equal(await existsDir(path.join(root, "01")), false, "a refused import must not leave a junk folder behind");
    assert.equal(await existsDir(path.join(root, "Episode 5")), false, "a refused import must not leave a junk folder behind");
  } finally {
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("processAcquireImport reuses the ExternalId-matched show when strings cannot bridge the alias gap", async () => {
  const payload = Buffer.from("identity bytes");
  const { baseUrl, server } = await startServer((req, res) => {
    res.writeHead(200, { "content-length": String(payload.length) });
    res.end(payload);
  });

  const root = await mkdtemp(path.join(tmpdir(), "acquire-import-test-"));
  try {
    await processAcquireImport(
      fakeJob({ providerId: "ext1", downloadId: "dl-14", baseUrl, libraryId: "lib-1", query: "Sousou no Frieren", title: "Sousou no Frieren" }),
      {
        db: {
          library: { findUnique: async () => ({ rootPath: root }) },
          // An unresolved-style row: no stored AKA for the request to match
          // against, so string matching misses on purpose here.
          mediaItem: {
            findMany: async (args: unknown) => {
              const where = (args as { where: Record<string, unknown> }).where;
              if (where.kind === "SERIES" && !("id" in where)) {
                return [{ id: "series-9", title: "Frieren Beyond Journey s End", originalTitle: null, year: 2023 }];
              }
              if ("id" in (where as Record<string, unknown>)) {
                return [{ id: "series-9", title: "Frieren Beyond Journey s End", originalTitle: null, year: 2023 }];
              }
              return [];
            },
          },
          externalId: {
            findMany: async () => [{ mediaItemId: "series-9" }],
          },
        },
        enqueueScan: async () => {},
        scanSettleMs: 0,
        resolveIdentity: async () => [{ provider: "ANILIST", providerId: "139585" }],
      },
    );

    const finalDir = seasonTargetDir(root, "Frieren Beyond Journey s End", 2023, null);
    const files = await readdir(finalDir);
    assert.equal(files.length, 1, "identity hit must land in the canonical folder despite the string gap");
  } finally {
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("resolveSeriesDirOnDisk: reuses the on-disk spelling despite sanitize loss", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acquire-dirdup-test-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(root, "Frieren Beyond Journey's End"), { recursive: true });
  try {
    assert.equal(
      await resolveSeriesDirOnDisk(root, "Frieren Beyond Journeys End", null),
      path.join(root, "Frieren Beyond Journey's End"),
    );
    assert.equal(await resolveSeriesDirOnDisk(root, "Some New Show", 2024), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("processAcquireImport reuses the existing on-disk folder instead of forking a sanitized duplicate", async () => {
  // Exact reported bug: library holds "Frieren Beyond Journey's End" but the
  // import derived "Frieren Beyond Journeys End" (sanitizeFolder drops the
  // apostrophe) and forked a second show folder.
  const payload = Buffer.from("apostrophe bytes");
  const { baseUrl, server } = await startServer((req, res) => {
    res.writeHead(200, { "content-length": String(payload.length) });
    res.end(payload);
  });

  const root = await mkdtemp(path.join(tmpdir(), "acquire-import-test-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(root, "Frieren Beyond Journey's End"), { recursive: true });
  try {
    await processAcquireImport(
      fakeJob({ providerId: "ext1", downloadId: "dl-16", baseUrl, libraryId: "lib-1", query: "Frieren", title: "Frieren Beyond Journeys End" }),
      {
        db: {
          library: { findUnique: async () => ({ rootPath: root }) },
          mediaItem: {
            findMany: async () => [{ id: "series-1", title: "Frieren Beyond Journey's End", originalTitle: null, year: 2023 }],
          },
        },
        enqueueScan: async () => {},
        scanSettleMs: 0,
      },
    );

    const files = await readdir(path.join(root, "Frieren Beyond Journey's End"));
    assert.equal(files.length, 1, "file must land in the existing on-disk folder");
    assert.deepEqual(await readFile(path.join(root, "Frieren Beyond Journey's End", files[0]!)), payload);
    assert.equal(await existsDir(path.join(root, "Frieren Beyond Journeys End")), false, "must not fork a sanitized duplicate folder");
  } finally {
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("processAcquireImport reuses the on-disk folder with no DB row at all", async () => {
  const payload = Buffer.from("disk-only bytes");
  const { baseUrl, server } = await startServer((req, res) => {
    res.writeHead(200, { "content-length": String(payload.length) });
    res.end(payload);
  });

  const root = await mkdtemp(path.join(tmpdir(), "acquire-import-test-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(root, "Frieren Beyond Journey's End"), { recursive: true });
  try {
    await processAcquireImport(
      fakeJob({ providerId: "ext1", downloadId: "dl-17", baseUrl, libraryId: "lib-1", query: "Frieren", title: "Frieren Beyond Journeys End" }),
      {
        db: {
          library: { findUnique: async () => ({ rootPath: root }) },
          mediaItem: { findMany: async () => [] },
        },
        enqueueScan: async () => {},
        scanSettleMs: 0,
      },
    );

    const files = await readdir(path.join(root, "Frieren Beyond Journey's End"));
    assert.equal(files.length, 1, "on-disk match alone must prevent the fork");
    assert.equal(await existsDir(path.join(root, "Frieren Beyond Journeys End")), false, "must not fork a sanitized duplicate folder");
  } finally {
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
