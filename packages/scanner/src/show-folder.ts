import path from "node:path";

/**
 * Resolves a SERIES row's on-disk folder from its title. Safe because
 * MediaItem.title is set once from the folder basename at ingest and never
 * rewritten by metadata resolution (packages/scanner/src/metadata.ts only
 * ever writes overview/rating/studio/etc via `updateMany({ where: { ...,
 * <field>: null } })` — never title) — the same invariant prune.ts's own
 * bare-SERIES survival check already depends on
 * (`existsSync(path.join(rootPath, s.title))`).
 *
 * Returns null when the result would escape rootPath, be empty, or resolve
 * to rootPath itself — any of which would turn a caller's recursive delete
 * into "wipe the whole library" instead of one show's folder.
 */
export function resolveShowFolderPath(rootPath: string, showTitle: string): string | null {
  const title = showTitle.trim();
  if (!title) return null;
  const root = path.resolve(rootPath);
  const candidate = path.resolve(root, title);
  const rel = path.relative(root, candidate);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return candidate;
}
