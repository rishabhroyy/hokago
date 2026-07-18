import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { VIDEO_EXTENSIONS } from "./constants.js";

export interface DiscoveredFile {
  path: string;
  dir: string;
  sizeBytes: bigint;
  mtime: Date;
  inode: bigint;
}

export async function walkVideoFiles(root: string): Promise<DiscoveredFile[]> {
  const out: DiscoveredFile[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const s = await stat(full);
        out.push({
          path: full,
          dir,
          sizeBytes: BigInt(s.size),
          mtime: s.mtime,
          inode: BigInt(s.ino),
        });
      }
    }
  }

  await walk(root);
  return out;
}

export function groupByDirectory(files: DiscoveredFile[]): Map<string, DiscoveredFile[]> {
  const map = new Map<string, DiscoveredFile[]>();
  for (const file of files) {
    const bucket = map.get(file.dir);
    if (bucket) bucket.push(file);
    else map.set(file.dir, [file]);
  }
  return map;
}
