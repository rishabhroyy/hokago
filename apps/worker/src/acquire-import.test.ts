import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { processAcquireImport, acquireImportStagingDir } from "./acquire-import.js";
import type { AcquireImportJobData, Job } from "@hokago/queue";

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
        db: { library: { findUnique: async () => ({ rootPath: root }) } },
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
          db: { library: { findUnique: async () => ({ rootPath: root }) } },
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
          db: { library: { findUnique: async () => ({ rootPath: root }) } },
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
        db: { library: { findUnique: async () => ({ rootPath: root }) } },
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
