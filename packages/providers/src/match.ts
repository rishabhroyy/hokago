import type { MetadataMatch, MetadataQuery } from "@hokago/metadata";

/** Case/punctuation-insensitive normalization — no ML, mirrors "No ML" philosophy. */
export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/\p{Mn}/gu, "") // strip combining diacritics after NFKD decomposition
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * True when every char of `needle` appears in `haystack` in order — the
 * cheap deterministic stand-in for "query title is embedded in the
 * provider's fuller title". "frieren" ⊂ "frieren beyond journey s end",
 * "nhk" ⊂ "welcome to the n h k". No ML, no tokenizer — just the sort of
 * containment real folder names (short form) vs provider titles (full form)
 * actually exhibit. Guarded by the min-length + year checks in acceptMatch.
 */
function isOrderedSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
}

/**
 * The chain's acceptance gate : normalized title equality against
 * *any* title AniList/Jikan knows this candidate under (romaji/english/
 * native — not just the primary one) + year within ±1 (or either missing).
 * Folder names commonly use the English title while a provider's primary
 * title is romaji-first, so checking only `candidate.title` would silently
 * never match a large, ordinary class of real libraries.
 *
 * Falls back to ordered-subsequence containment (see isOrderedSubsequence)
 * for the equally common "folder is the short form, provider title carries
 * the subtitle" shape ("Frieren" vs "Frieren: Beyond Journey's End"),
 * gated on a minimum query length so a 1-2 char folder can't carpet-match.
 */
export function acceptMatch(query: MetadataQuery, candidate: MetadataMatch): boolean {
  const queryNorm = normalizeTitle(query.title);
  // An all-CJK (or punctuation-only) query normalizes to "" — and so does
  // every candidate's native title, making "" === "" a vacuous "exact match"
  // that accepts the first search hit unconditionally.
  if (queryNorm.length === 0) return false;
  const candidateTitles = [candidate.title, ...(candidate.titles?.map((t) => t.value) ?? [])];

  const exact = candidateTitles.some((t) => normalizeTitle(t) === queryNorm);
  const contained = !exact && queryNorm.length >= 4 && candidateTitles.some((t) => isOrderedSubsequence(queryNorm, normalizeTitle(t)));
  if (!exact && !contained) return false;

  if (query.year !== undefined && candidate.year !== undefined) {
    return Math.abs(query.year - candidate.year) <= 1;
  }
  return true;
}

/** First candidate clearing the acceptance gate, or undefined if none do — stops the provider chain there. */
export function findAcceptedMatch(query: MetadataQuery, candidates: MetadataMatch[]): MetadataMatch | undefined {
  return candidates.find((candidate) => acceptMatch(query, candidate));
}
