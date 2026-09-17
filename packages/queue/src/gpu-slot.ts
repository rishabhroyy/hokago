import { randomUUID } from "node:crypto";
import { getConnection } from "./connection.js";

const KEY = "hokago:gpu-sessions";
// Generous ceiling above any real hw session's lifetime -- a crashed holder
// (SIGKILL, OOM) never calls releaseGpuSlot(), so members past this age are
// pruned by the next acquirer instead of leaking the slot forever.
const MAX_AGE_MS = 10 * 60 * 1000;

function limit(): number {
  return Math.max(1, Number(process.env.HOKAGO_GPU_SESSION_LIMIT ?? 2));
}

/**
 * Cross-process GPU concurrent-hw-session budget, shared via valkey between
 * apps/api's live playback transcodes and apps/worker's background
 * trickplay/artwork sweeps -- both spawn ffmpeg against the same physical
 * GPU with no other coordination between the two processes, so a background
 * sweep can exhaust the GPU's real concurrent-session capacity right as a
 * live TRANSCODE starts, silently degrading playback.
 *
 * Backed by a valkey sorted set (member = a random id per held slot, score =
 * acquire time) instead of a plain counter so a crashed holder self-heals
 * away via MAX_AGE_MS instead of leaking the slot forever.
 *
 * Not perfectly atomic (zcard + zadd is two round-trips, so two concurrent
 * acquirers can occasionally both slip past the count check) -- this is a
 * soft budget, not a hard resource lock, and the cost of occasionally
 * running one session over it for a moment is far cheaper than a Lua script
 * would be worth here.
 *
 * Returns the slot id on success (pass to releaseGpuSlot when the hw-using
 * process exits), or null if `waitMs` elapsed with no slot free -- callers
 * fall back to a CPU-only pass rather than blocking indefinitely.
 */
export async function acquireGpuSlot(waitMs: number): Promise<string | null> {
  const redis = getConnection();
  const deadline = Date.now() + waitMs;
  const id = randomUUID();
  for (;;) {
    await redis.zremrangebyscore(KEY, 0, Date.now() - MAX_AGE_MS);
    const count = await redis.zcard(KEY);
    if (count < limit()) {
      await redis.zadd(KEY, Date.now(), id);
      return id;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function releaseGpuSlot(id: string | null): Promise<void> {
  if (id === null) return;
  await getConnection().zrem(KEY, id).catch(() => {});
}
