import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";

import { trackPid, untrackPid } from "./child-registry.js";

export interface RunningTranscode {
  child: ChildProcessWithoutNullStreams;
  pid: number;
  /** Tail of ffmpeg's stderr (last ~8KB) — the useful part for lastError. */
  stderr: string;
}

export interface TranscodeExit {
  code: number | null;
  stderr: string;
}

/** Maximum stderr retained per process — enough for the fatal error ffmpeg prints on failure. */
const STDERR_TAIL_BYTES = 8192;

/**
 * Spawns ffmpeg with the given args and tracks its PID so a SIGTERM handler
 * (or a seek) can reap it. Both stdout and stderr are consumed immediately —
 * an unread pipe fills up (64KB kernel buffer) and BLOCKS ffmpeg mid-encode,
 * which looks exactly like a hung transcode. stderr is also tail-captured so
 * failures can be surfaced via TranscodeJob.lastError.
 *
 * `input` (resume-stub streams for REMUX) is piped into the child's stdin;
 * ffmpeg exits early on a kill, so the source stream must be torn down with
 * it or the underlying file read would keep feeding a dead pipe.
 */
export function spawnFfmpeg(args: string[], onExit?: (result: TranscodeExit) => void, input?: Readable): RunningTranscode {
  const child = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
  // A failed exec emits 'error' instead of 'exit' — without a listener that
  // becomes an uncaught exception (taking the whole API down), and the slot/
  // job accounting that onExit performs would never run. Pre-pid errors
  // (ENOENT/EMFILE at spawn) are handled by the throw below; this catches
  // anything async that slips past it.
  child.on("error", (err) => {
    if (child.pid !== undefined && child.pid !== null) {
      untrackPid(child.pid);
      onExit?.({ code: -1, stderr: `spawn error: ${err.message}` });
    }
  });
  if (!child.pid) throw new Error("ffmpeg failed to spawn");
  const pid = child.pid;
  trackPid(pid);

  if (input) {
    input.pipe(child.stdin);
    // The stdin pipe can die before the child event fires (early exit, broken
    // demuxer) — stop reading the source then, or the file read stalls forever.
    child.stdin.on("error", () => input.destroy());
  }

  const transcode: RunningTranscode = { child, pid, stderr: "" };
  child.stdout.on("data", () => {
    // drain — ffmpeg writes progress to stderr, stdout is normally silent
  });
  child.stderr.on("data", (chunk: Buffer) => {
    transcode.stderr = (transcode.stderr + chunk.toString()).slice(-STDERR_TAIL_BYTES);
  });

  child.on("exit", (code) => {
    untrackPid(pid);
    if (input) input.destroy();
    onExit?.({ code, stderr: transcode.stderr });
  });
  return transcode;
}
