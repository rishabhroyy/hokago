import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { processAcquireImport, acquireImportStagingDir } from "./acquire-import.js";
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
  // The exact title length from a real production failure: exactly 80
  // characters, leaving zero room for " - Episode NN" once appended --
  // every sibling job truncated to the identical filename despite
  // genuinely different episodeRange values, and only the first ever
  // landed. This is that title, verbatim.
  const longTitle = "Judas Sewayaki Kitsune no Senko-san The Helpful Fox Senko-san Season 1 BD 1080pH";
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
