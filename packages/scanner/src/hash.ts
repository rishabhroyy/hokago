import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

const CHUNK_BYTES = 1024 * 1024;

/**
 * ponytail: partial hash (size + first/last 1MiB), not a full-file hash.
 * Hashing every byte of a real media library on every scan is too slow to be
 * usable. Collision requires two files sharing size and both edge chunks
 * while differing only in the middle — effectively never happens for real
 * video files. Upgrade to a full hash if this ever actually bites.
 */
export async function partialHash(path: string, sizeBytes: bigint): Promise<string> {
  const hash = createHash("sha256");
  hash.update(sizeBytes.toString());

  const fh = await open(path, "r");
  try {
    const size = Number(sizeBytes);
    const headLen = Math.min(CHUNK_BYTES, size);
    const head = Buffer.alloc(headLen);
    await fh.read(head, 0, headLen, 0);
    hash.update(head);

    if (size > CHUNK_BYTES) {
      const tailLen = Math.min(CHUNK_BYTES, size - headLen);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, size - tailLen);
      hash.update(tail);
    }
  } finally {
    await fh.close();
  }

  return hash.digest("hex");
}
