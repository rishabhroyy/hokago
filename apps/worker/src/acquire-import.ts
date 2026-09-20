/**
 * Materializes an external acquire-provider's stream into the library. A
 * registered provider only ever hands hokago JSON (search results, a
 * download's status) — it doesn't write into hokago's storage itself, so
 * this is what actually pulls the bytes and places them. Placement reuses
 * the exact same convention the built-in ani-cli import already
 * established (parseAnicliQuery + seasonTargetDir, from @hokago/queue) —
 * never a second, independently-invented rule for where a file goes.
 * Before that, it also checks whether this library already has a matching
 * show (@hokago/providers' findExistingSeries — the same shared matching
 * apps/api's acquire-routes.ts also uses for season/episode dedup, so "is
 * this the same show" is answered exactly one way everywhere) and places
 * under its existing canonical title/year instead of whatever this one
 * request's text happens to produce, so the same show arriving via a
 * different release/provider doesn't fork into a second near-duplicate
 * folder.
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
import { Readable, Transform } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

/**
 * Passes chunks through unchanged, calling onData for each -- a Transform
 * participates in the pipeline's own consumption (backpressure included),
 * unlike an `.on("data", ...)` listener attached alongside it. Attaching
 * "data" directly to a stream also being consumed by pipeline() switches it
 * to flowing mode and competes with pipeline's own reader for the same
 * bytes, which starves pipeline() of everything and hangs it forever --
 * this exists specifically to avoid that trap.
 */
class StallTracker extends Transform {
  constructor(private onData: () => void) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void): void {
    this.onData();
    cb(null, chunk);
  }
}

import { parseAnicliQuery, seasonTargetDir, sanitizeFolder, type AcquireImportJobData, type Job } from "@hokago/queue";
import { findExistingSeries, type ExistingSeriesDeps } from "@hokago/providers";

export interface AcquireImportDeps extends ExistingSeriesDeps {
  db: ExistingSeriesDeps["db"] & {
    library: { findUnique: (args: { where: { id: string } }) => Promise<{ rootPath: string } | null> };
  };
  enqueueScan: (libraryId: string, mode: "light" | "heavy", delayMs?: number) => Promise<void>;
  scanSettleMs: number;
  /** No bytes at all for this long (initial connect included) -- something's
   * actually stuck, not just slow -- aborts the transfer. Injectable so a
   * test can prove the behavior without a real 5-minute wait. Deliberately
   * NOT an overall-duration cap: a large file over a slow-but-progressing
   * connection can legitimately take much longer than this between its
   * first and last byte. */
  stallMs?: number;
}

// findExistingSeries itself now lives in @hokago/providers (the one shared
// implementation apps/api's acquire-routes.ts also calls for season/episode
// dedup) -- this file only ever consumed it for file placement, never
// defined the matching rule.

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

  // Provider-resolved `title` first (human result), caller `query` second.
  // parseAnicliQuery now strips release junk ("BD 1080p", groups, episode
  // suffixes) internally, so both sides parse clean — but they can still
  // disagree: /acquire/existing + dedup gate on the API side only ever see
  // the clean user query, while this step prefers the provider's noisier
  // title. Trying both against findExistingSeries (provider first, query as
  // fallback) is what keeps "already have X with no files" and "where the
  // bytes actually land" from diverging into a duplicate folder.
  const parsed = parseAnicliQuery(title?.trim() || query);
  const queryParsed = parseAnicliQuery(query);
  // Best-effort only: a lookup hiccup here degrades to "no match found",
  // not a failed import -- this only ever improves on parsed.title/year,
  // never gates whether the transfer itself can proceed.
  let existing = await findExistingSeries(deps, libraryId, parsed.title, parsed.year).catch(() => undefined);
  if (!existing && (queryParsed.title !== parsed.title || queryParsed.year !== parsed.year)) {
    existing = await findExistingSeries(deps, libraryId, queryParsed.title, queryParsed.year).catch(() => undefined);
  }
  // A junk-only provider title parses to the "anicli" sentinel — never let
  // that become a real folder when the caller's own query parsed clean.
  const useQueryParse = parsed.title === "anicli" && queryParsed.title !== "anicli";
  const baseParsed = useQueryParse ? queryParsed : parsed;
  const effectiveTitle = existing?.title ?? baseParsed.title;
  const effectiveYear = existing?.year ?? baseParsed.year ?? queryParsed.year;
  // Season lives only in the folder: prefer the provider's own signal, fall
  // back to the request's ("Season 1 BD 1080p" hid it pre-clean; a provider
  // title with no season at all still lands in the requested season).
  const effectiveSub = parsed.sub ?? queryParsed.sub;
  const finalDir = seasonTargetDir(library.rootPath, effectiveTitle, effectiveYear, effectiveSub);
  const stagingDir = acquireImportStagingDir(library.rootPath, providerId, downloadId);
  const tmpPath = path.join(stagingDir, "download.tmp");
  const cleanup = () => rm(stagingDir, { recursive: true, force: true }).catch(() => {});

  try {
    if (!existsSync(library.rootPath)) throw new Error(`library root missing: ${library.rootPath}`);
    await cleanup();
    await mkdir(stagingDir, { recursive: true });

    // This deliberately does not bound the transfer's overall duration --
    // a provider fetching from a slow upstream of its own can legitimately
    // take a long time between bytes without being stuck. What's needed
    // instead is exactly this: reset the clock on every chunk (including
    // the initial connect), only fire if nothing arrives at all for a
    // while. The single outer `finally` is load-bearing -- an exception
    // from fetch() itself (a destroyed connection, not just a bad status)
    // skips right past any clearTimeout that isn't in it, leaving the
    // timer armed and the process alive for no reason.
    const stallMs = deps.stallMs ?? 5 * 60_000;
    const stallMinutes = Math.round(stallMs / 60_000);
    const controller = new AbortController();
    let stallTimer: NodeJS.Timeout;
    const armStall = (msg: string) => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => controller.abort(new Error(msg)), stallMs);
    };

    let res: Response;
    let contentLength: number;
    try {
      armStall(`provider never responded within ${stallMinutes} minutes`);
      res = await fetch(`${baseUrl}/downloads/${downloadId}/stream`, {
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`stream fetch failed: HTTP ${res.status}`);

      contentLength = Number(res.headers.get("content-length"));
      if (!Number.isFinite(contentLength) || contentLength <= 0) {
        throw new Error("provider did not report a Content-Length for the stream");
      }

      armStall(`stream stalled -- no bytes in ${stallMinutes} minutes`);
      await pipeline(
        Readable.fromWeb(res.body as WebReadableStream),
        new StallTracker(() => armStall(`stream stalled -- no bytes in ${stallMinutes} minutes`)),
        createWriteStream(tmpPath),
      );
    } finally {
      clearTimeout(stallTimer!);
    }

    const written = (await stat(tmpPath)).size;
    if (written !== contentLength) {
      throw new Error(`short read: got ${written} of ${contentLength} bytes — treating as a failed transfer`);
    }

    const ext = EXT_BY_CONTENT_TYPE[res.headers.get("content-type") ?? ""] ?? "mkv";
    // Same effective title the folder above was placed under -- keeps a
    // file consistent with its own folder instead of the folder reflecting
    // an existing show's canonical name while the filename still carries
    // this request's raw one.
    //
    // sanitizeFolder truncates its whole input to 80 characters -- reserve
    // room for the episodeRange suffix FIRST (the only thing that actually
    // distinguishes sibling files from one another) instead of truncating
    // the combined string blindly. Confirmed, not theoretical: a title
    // alone at or past 80 characters consumes the entire budget, silently
    // dropping the suffix and leaving every sibling file computing the
    // identical destination path despite genuinely different episodeRange
    // values -- exactly the "only one file landed" failure traced back to
    // a real production run.
    const suffix = episodeRange ? ` - ${episodeRange}` : "";
    const base = effectiveTitle.slice(0, Math.max(1, 80 - suffix.length)) + suffix;
    const filename = acquireFilenameFromContentDisposition(res.headers.get("content-disposition")) ?? `${sanitizeFolder(base)}.${ext}`;

    await mkdir(finalDir, { recursive: true });
    const dest = path.join(finalDir, filename);
    if (existsSync(dest)) {
      // Never clobber existing library content -- the file that matters is
      // already there (most likely a duplicate enqueue for the same id).
      // A real, fully-downloaded transfer ends here every time this
      // fires, so it stays visible rather than a silent no-op -- a
      // provider whose sibling items ever collide on this same path
      // (this is the only thing standing between that and quietly
      // losing a real download) shows up in logs instead of disappearing
      // without a trace.
      console.error(`acquire import (${providerId}/${downloadId}): ${dest} already exists, discarding this transfer as a likely duplicate`);
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
