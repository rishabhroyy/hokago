import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import { trackPid, untrackPid } from "./child-registry.js";

export interface RunningTranscode {
  child: ChildProcessByStdio<null, Readable, Readable>;
  pid: number;
}

/** Spawns ffmpeg with the given args and tracks its PID so a SIGTERM handler (or a seek) can reap it (§9.6.4, §11.2). */
export function spawnFfmpeg(args: string[], onExit?: (code: number | null) => void): RunningTranscode {
  const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  if (!child.pid) throw new Error("ffmpeg failed to spawn");
  const pid = child.pid;
  trackPid(pid);
  child.on("exit", (code) => {
    untrackPid(pid);
    onExit?.(code);
  });
  return { child, pid };
}
