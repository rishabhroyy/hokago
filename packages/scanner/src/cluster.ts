export interface RuntimeClusterInput {
  path: string;
  durationMs: number | null;
}

export interface RuntimeClusterResult {
  main: string[];
  outliers: string[];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Detects the Mugen Train shape (§7.3, §9.2c): a season folder of ~24min
 * episodes plus one 108min movie. Outliers become standalone movies.
 *
 * ponytail: a single "> 1.8x median" ratio heuristic, not a real clustering
 * algorithm. Good enough to catch the common one-movie-among-many-episodes
 * case; will misfire on libraries with genuinely wide episode-length spread
 * (double-length finales, documentaries). Files with no known duration
 * (probe failed) are never treated as outliers — can't judge what we can't
 * measure.
 */
export function clusterByRuntime(files: RuntimeClusterInput[]): RuntimeClusterResult {
  const known = files.filter((f): f is RuntimeClusterInput & { durationMs: number } => f.durationMs !== null);
  const unknown = files.filter((f) => f.durationMs === null);

  if (known.length < 2) {
    return { main: files.map((f) => f.path), outliers: [] };
  }

  const med = median(known.map((f) => f.durationMs));
  const main: string[] = [];
  const outliers: string[] = [];

  for (const f of known) {
    if (f.durationMs > med * 1.8) outliers.push(f.path);
    else main.push(f.path);
  }
  for (const f of unknown) main.push(f.path);

  // If everything is an "outlier" (e.g. only 2 files, wildly different),
  // there's no real cluster to be an outlier from — treat as all-main.
  if (main.length === 0) return { main: outliers, outliers: [] };

  return { main, outliers };
}
