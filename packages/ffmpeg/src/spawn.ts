import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import { trackPid, untrackPid } from "./child-registry.js";

export interface RunningTranscode {
  child: ChildProcessByStdio<null, Readable, Readable>;
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
 */
export function spawnFfmpeg(args: string[], onExit?: (result: TranscodeExit) => void): RunningTranscode {
  const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  if (!child.pid) throw new Error("ffmpeg failed to spawn");
  const pid = child.pid;
  trackPid(pid);

  const transcode: RunningTranscode = { child, pid, stderr: "" };
  child.stdout.on("data", () => {
    // drain — ffmpeg writes progress to stderr, stdout is normally silent
  });
  child.stderr.on("data", (chunk: Buffer) => {
    transcode.stderr = (transcode.stderr + chunk.toString()).slice(-STDERR_TAIL_BYTES);
  });

  child.on("exit", (code) => {
    untrackPid(pid);
    onExit?.({ code, stderr: transcode.stderr });
  });
  return transcode;
}
