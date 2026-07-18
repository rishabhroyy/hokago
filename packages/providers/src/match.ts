import type { MetadataMatch, MetadataQuery } from "@hokago/metadata";

/** Case/punctuation-insensitive normalization — no ML, mirrors §8.7.2 "No ML" philosophy. */
export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/\p{Mn}/gu, "") // strip combining diacritics after NFKD decomposition
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The chain's acceptance gate (§8.7.2): normalized title equality against
 * *any* title AniList/Jikan knows this candidate under (romaji/english/
 * native — not just the primary one) + year within ±1 (or either missing).
 * Folder names commonly use the English title while a provider's primary
 * title is romaji-first, so checking only `candidate.title` would silently
 * never match a large, ordinary class of real libraries.
 */
export function acceptMatch(query: MetadataQuery, candidate: MetadataMatch): boolean {
  const queryNorm = normalizeTitle(query.title);
  const candidateTitles = [candidate.title, ...(candidate.titles?.map((t) => t.value) ?? [])];
  if (!candidateTitles.some((t) => normalizeTitle(t) === queryNorm)) return false;
  if (query.year !== undefined && candidate.year !== undefined) {
    return Math.abs(query.year - candidate.year) <= 1;
  }
  return true;
}

/** First candidate clearing the acceptance gate, or undefined if none do — stops the provider chain there. */
export function findAcceptedMatch(query: MetadataQuery, candidates: MetadataMatch[]): MetadataMatch | undefined {
  return candidates.find((candidate) => acceptMatch(query, candidate));
}
