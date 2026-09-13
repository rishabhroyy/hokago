/**
 * Materializes an external acquire-provider's stream into the library. A
 * registered provider only ever hands hokago JSON (search results, a
 * download's status) — it doesn't write into hokago's storage itself, so
 * this is what actually pulls the bytes and places them. Placement reuses
 * the exact same convention the built-in ani-cli import already
 * established (parseAnicliQuery + seasonTargetDir, from @hokago/queue) —
 * never a second, independently-invented rule for where a file goes.
 *
 * No DB row backs this job — its own BullMQ job state is the only record,
 * deliberately, matching how lightweight the rest of the acquire-provider
 * work has stayed. attempts:1 (configured on the queue, in
 * apps/api/src/acquire-routes.ts): a failed transfer is terminal, never
 * silently re-driven.
 *
 * db/enqueueScan/scanSettleMs are injected rather than imported from
 * apps/worker/src/index.ts, which has heavy module-scope side effects
 * (a live DB connection, Redis, ffmpeg hardware probing, every other
 * queue/worker in the process) that make it unsuitable to import into a
 * test — this file has none of that, so it can be unit tested directly.
 */

import path from "node:path";
import { existsSync, createWriteStream } from "node:fs";
import { mkdir, rm, stat, rename } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import { parseAnicliQuery, seasonTargetDir, sanitizeFolder, type AcquireImportJobData, type Job } from "@hokago/queue";

export interface AcquireImportDeps {
  db: { library: { findUnique: (args: { where: { id: string } }) => Promise<{ rootPath: string } | null> } };
  enqueueScan: (libraryId: string, mode: "light" | "heavy", delayMs?: number) => Promise<void>;
  scanSettleMs: number;
}

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "video/x-matroska": "mkv",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/x-msvideo": "avi",
  "video/quicktime": "mov",
};

/** Strips any path component and anything but the safe characters sanitizeFolder allows, plus a dot so an extension survives. */
export function sanitizeAcquireFilename(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9 ._-]/g, "").trim().slice(0, 120) || "download";
}

/** RFC 6266 filename/filename* — provider-supplied, so always run through sanitizeAcquireFilename (path-traversal defense, not just cosmetic). */
export function acquireFilenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8''|utf-8'')?([^;]+)/i.exec(header);
  if (star) {
    try {
      return sanitizeAcquireFilename(decodeURIComponent(star[1]!.trim().replace(/^"|"$/, "").replace(/"$/, "")));
    } catch {
      // malformed percent-encoding -- fall through to the plain form below
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain ? sanitizeAcquireFilename(plain[1]!.trim()) : null;
}

export const acquireImportStagingDir = (libraryRoot: string, providerId: string, downloadId: string): string =>
  path.join(libraryRoot, ".acquire-staging", `${providerId}-${downloadId}`);

/**
 * The provider's side of the contract: an ordinary streamed HTTP response,
 * Content-Length set to the final size, connection stays open until
 * complete, ends normally on success or is destroyed/truncated on failure
 * — there is no trailing error JSON, a short read against Content-Length
 * *is* the failure signal. Both a request-level failure (bad status, no
 * body, no Content-Length) and a short/aborted stream are treated
 * identically: delete whatever was written so far, never leave a
 * truncated file sitting in the library, and never auto-retry.
 */
export async function processAcquireImport(job: Job<AcquireImportJobData>, deps: AcquireImportDeps): Promise<void> {
  const { providerId, downloadId, baseUrl, token, libraryId, query, title, episodeRange } = job.data;
  const library = await deps.db.library.findUnique({ where: { id: libraryId } });
  if (!library) return; // deleted between enqueue and run -- nothing to place this into

  const parsed = parseAnicliQuery(query);
  const finalDir = seasonTargetDir(library.rootPath, parsed.title, parsed.year, parsed.sub);
  const stagingDir = acquireImportStagingDir(library.rootPath, providerId, downloadId);
  const tmpPath = path.join(stagingDir, "download.tmp");
  const cleanup = () => rm(stagingDir, { recursive: true, force: true }).catch(() => {});

  try {
    if (!existsSync(library.rootPath)) throw new Error(`library root missing: ${library.rootPath}`);
    await cleanup();
    await mkdir(stagingDir, { recursive: true });

    const res = await fetch(`${baseUrl}/downloads/${downloadId}/stream`, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok || !res.body) throw new Error(`stream fetch failed: HTTP ${res.status}`);

    const contentLength = Number(res.headers.get("content-length"));
    if (!Number.isFinite(contentLength) || contentLength <= 0) {
      throw new Error("provider did not report a Content-Length for the stream");
    }

    await pipeline(Readable.fromWeb(res.body as WebReadableStream), createWriteStream(tmpPath));

    const written = (await stat(tmpPath)).size;
    if (written !== contentLength) {
      throw new Error(`short read: got ${written} of ${contentLength} bytes — treating as a failed transfer`);
    }

    const ext = EXT_BY_CONTENT_TYPE[res.headers.get("content-type") ?? ""] ?? "mkv";
    const base = (title?.trim() || parsed.title) + (episodeRange ? ` - ${episodeRange}` : "");
    const filename = acquireFilenameFromContentDisposition(res.headers.get("content-disposition")) ?? `${sanitizeFolder(base)}.${ext}`;

    await mkdir(finalDir, { recursive: true });
    const dest = path.join(finalDir, filename);
    if (existsSync(dest)) {
      // Never clobber existing library content -- the file that matters is
      // already there (most likely a duplicate enqueue for the same id).
      await cleanup();
    } else {
      await rename(tmpPath, dest); // same filesystem as staging -- atomic
      await cleanup();
      await deps.enqueueScan(libraryId, "light", deps.scanSettleMs).catch(() => {});
    }
  } catch (err) {
    await cleanup();
    console.error(`acquire import (${providerId}/${downloadId}) failed:`, err);
    throw err; // attempts:1 (queue-side) -- BullMQ marks this terminal, nothing re-drives it
  }
}
