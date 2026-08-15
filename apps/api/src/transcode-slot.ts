/**
 * Bounded ffmpeg concurrency for live transcodes (apps/api).
 *
 * One slot per active transcode session. Without a cap, N open player tabs =
 * N ffmpeg processes saturating the box — the machine-freeze bug report.
 * Default 2 (a home server is one viewer at a time, usually); tune via
 * HOKAGO_MAX_TRANSCODES. DIRECT_PLAY sessions take no slot (no ffmpeg).
 */

const MAX_TRANSCODES = Math.max(1, Number(process.env.HOKAGO_MAX_TRANSCODES ?? 4));

let active = 0;
const waiters: Array<() => void> = [];

export function transcodeSlotCount(): number {
  return active + waiters.length;
}

/** Acquires a slot, waiting up to `timeoutMs` for one to free. False on timeout. */
export function acquireTranscodeSlot(timeoutMs = 60_000): Promise<boolean> {
  if (active < MAX_TRANSCODES) {
    active++;
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const release = () => {
      clearTimeout(timer);
      // The slot handoff happens here — the waiter takes over the freed slot.
      active++;
      resolve(true);
    };
    const timer = setTimeout(() => {
      const idx = waiters.indexOf(release);
      if (idx >= 0) waiters.splice(idx, 1);
      resolve(false);
    }, timeoutMs);
    waiters.push(release);
  });
}

export function releaseTranscodeSlot(): void {
  const next = waiters.shift();
  if (next) {
    next(); // hands the freed slot to the oldest waiter
  } else if (active > 0) {
    active--;
  }
}
