// Duplicated from packages/scanner/src/child-registry.ts rather than imported —
// that package's PID set is scoped to scan/probe children reaped by the worker
// process; this one is scoped to transcode children reaped by apps/api (§9.6.4).
// Same shape, deliberately separate module-level state.
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
