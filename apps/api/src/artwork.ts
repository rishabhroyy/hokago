export interface ArtworkRef {
  id: string;
  kind: string;
  priority: number;
}

/** Lowest `priority` wins per kind — sidecar/embedded beat generated. */
export function primaryArtworkUrl(artwork: ArtworkRef[], kind: "POSTER" | "BACKDROP"): string | null {
  const best = artwork.filter((a) => a.kind === kind).sort((a, b) => a.priority - b.priority)[0];
  return best ? `/artwork/${best.id}` : null;
}
