/**
 * Tracks live ffmpeg/ffprobe child PIDs so a worker's SIGTERM handler can reap
 * them (§9.6.4) — Node itself won't kill in-flight children on exit.
 */
const tracked = new Set<number>();

export function trackPid(pid: number | undefined): void {
  if (pid) tracked.add(pid);
}

export function untrackPid(pid: number | undefined): void {
  if (pid) tracked.delete(pid);
}

export function trackedPidCount(): number {
  return tracked.size;
}

export function killTrackedChildren(signal: NodeJS.Signals = "SIGKILL"): void {
  for (const pid of tracked) {
    try {
      process.kill(pid, signal);
    } catch {
      // already exited
    }
  }
}
