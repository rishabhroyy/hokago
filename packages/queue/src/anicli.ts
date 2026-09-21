/**
 * ani-cli acquisition query parsing. The downloaded episodes carry NO season in
 * their filename (ani-cli names them "<Title> Episode N.mp4"), so the ONLY
 * season signal is the folder we land them in. Both the API (dedup: is this a
 * new season?) and the worker (which folder do I write to?) must agree on how
 * a query maps to a series + season — keep it in one place.
 *
 * Result `sub` is one of the folder names the scanner reads natively:
 *   - null        → flat "<root>/<Series>/"            (implicit Season 1)
 *   - "Season N"  → "<root>/<Series>/Season N/"        (season N)
 *   - "Specials"  → "<root>/<Series>/Specials/"        (season 0: OVA/ONA/specials)
 * `year` is a trailing "(2019)"-style year, returned separately so it can be
 * re-attached to the series folder for metadata matching without polluting the
 * season/subfolder parse.
 */

import path from "node:path";

const ORDINAL: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

/**
 * Release junk external acquire-providers glue onto an otherwise clean
 * series title: quality/codec/audio tokens ("BD", "1080p", "BluRay",
 * "x264", "FLAC", ...), bracketed groups ("[SubsPlease]", "[abc123]"),
 * "-GROUP" suffixes, dot/underscore separators, and per-episode suffixes
 * (" - 01", " Episode 12", " E05"). ani-cli queries never carry any of
 * this (they are already "Frieren S2"-clean), so stripping here is a no-op
 * for the built-in path and a fork-preventer for every external one.
 *
 * Without this, two failures compound into exactly the reported bug:
 * a quality suffix after a season token hides the season ("Season 1 BD
 * 1080p" no longer ends with "Season 1"), and the leftover junk poisons
 * findExistingSeries so the import misses the library's canonical show
 * and forks a near-duplicate folder ("... BD 1080p") instead. Kept in
 * step with packages/scanner/src/parsers/scene.ts's own QUALITY_TOKEN
 * (same unambiguous allowlist — never bare "web"/"dvd"/"multi", which are
 * real title words) but extended for acquire titles: a lone "BD" and
 * resolutions with glued suffixes ("1080pH") both occur in the wild.
 */
const ACQUIRE_QUALITY_TOKEN =
  /\b(?:\d{3,4}p[a-z0-9]*|\d{3,4}i|4k|uhd|hdr10\+?|hdr|dv|dolbyvision|blu-?ray|bd(?:rip|remux)?|dvd(?:rip)?|web-?dl|webrip|hdtv|hdrip|remux|bdremux|x264|x265|h\.?264|h\.?265|hevc|avc|av1|xvid|divx|10-?bit|8-?bit|hi10p|aac|e?ac-?3|dts(?:-?hd|-?ma)?|truehd|atmos|flac|opus|mp3|5\.1|7\.1|dual[- ]?audio|proper|repack|rerip)\b/gi;

/** Trailing per-episode suffixes live in the episodeRange/filename, never the series folder. */
function stripTrailingEpisodeMarker(body: string): string {
  // 1-4 digits (not 1-3): long-runners cross 1000 episodes ("One Piece
  // 1071"), and 4-digit 1900-2099 values are years, skipped by the guard
  // below rather than by the digit cap. Bare stays 2+ digits so sequel
  // numbers ("Spice and Wolf 2") survive.
  const patterns = [
    /\s+(?:episode|ep)\s*0*(\d{1,4})\s*$/i,
    /\s*-\s*(?:episode|ep)\s*0*(\d{1,4})\s*$/i,
    /\s*-\s*e\s*0*(\d{1,4})\s*$/i,
    /\s+e\s*0*(\d{1,4})\s*$/i,
    /\s*-\s*0*(\d{1,4})(?:v\d+)?\s*$/i,
    /\s+0*(\d{2,4})(?:v\d+)?\s*$/i,
  ];
  for (const re of patterns) {
    const m = re.exec(body);
    if (!m) continue;
    const num = Number(m[1]);
    // A trailing 4-digit year ("Show - 2019") is not an episode.
    if (num >= 1900 && num <= 2099) continue;
    const candidate = body.slice(0, m.index).trim();
    if (candidate) return candidate;
  }
  return body;
}

export interface ParsedAnicliQuery {
  /** Clean series title — no season token, no trailing year. */
  title: string;
  /** Trailing "(YYYY)" year, if any. */
  year: number | null;
  /** Season folder to write to (or null = flat, implicit Season 1). */
  sub: string | null;
  /** The season number, when `sub` is a numbered season. */
  season: number | null;
}

export function parseAnicliQuery(query: string): ParsedAnicliQuery {
  const s = query.trim();

  // Pre-clean release junk before any season/year parse so a quality tail
  // can neither hide a season token nor poison the title used for
  // findExistingSeries. Clean titles pass through unchanged.
  let pre = s.replace(/[._]/g, " ");
  ACQUIRE_QUALITY_TOKEN.lastIndex = 0;
  const hadQuality = ACQUIRE_QUALITY_TOKEN.test(pre);
  ACQUIRE_QUALITY_TOKEN.lastIndex = 0;
  pre = pre.replace(ACQUIRE_QUALITY_TOKEN, " ");
  pre = pre.replace(/\[[^\]]*\]/g, " ");
  // "-GROUP rides the quality tail" (same guard as the scanner's own
  // stripSceneJunk): only strip when quality was present, otherwise a
  // legitimate " - Alicization"-style title tail would be eaten.
  if (hadQuality) pre = pre.replace(/-[A-Za-z][A-Za-z0-9]*\s*$/, " ");
  pre = pre.replace(/\s+/g, " ").trim();

  let year: number | null = null;
  let body = pre;
  const trailingParenYear = /\(\s*((?:19|20)\d{2})\s*\)\s*$/.exec(pre);
  if (trailingParenYear) {
    year = Number(trailingParenYear[1]);
    body = pre.slice(0, trailingParenYear.index).trim();
  } else {
    // Bare trailing year ("Anohana 2011 BD 1080p" → pre already lost the
    // quality tail, leaving "Anohana 2011"). Four digits 1900-2099 at the
    // end are never an episode number (episodes are ≤100, long-runners
    // stay <1900), so this cannot misfire on "Show 12" or "One Piece 1071".
    const trailingBareYear = /(?:^|\s)((?:19|20)\d{2})\s*$/.exec(pre);
    if (trailingBareYear) {
      year = Number(trailingBareYear[1]);
      body = pre.slice(0, trailingBareYear.index).trim();
    } else {
      // Year mid-string with a season after it ("Anohana (2011) Season 1"
      // → quality tail already gone). Trailing-only extraction would drop
      // the year entirely here; the folder would lose its "(2011)" suffix
      // and a bare-year request would poison matching with "Anohana 2011".
      const anywhereParenYear = /\(\s*((?:19|20)\d{2})\s*\)/.exec(pre);
      if (anywhereParenYear) {
        year = Number(anywhereParenYear[1]);
        body = (pre.slice(0, anywhereParenYear.index) + " " + pre.slice(anywhereParenYear.index + anywhereParenYear[0].length)).replace(/\s+/g, " ").trim();
      }
    }
  }
  body = body.replace(/\([^)]*\)\s*$/g, "").trim();
  // Year is already extracted, so any remaining parens are junk ("(TV)").
  body = body.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  // Per-episode suffixes must go before season detection: "S2 - 05" only
  // reads as Season 2 once " - 05" is gone.
  body = stripTrailingEpisodeMarker(body);
  // A bare year revealed by episode removal ("Anohana 2011 - 01" → "Anohana
  // 2011"): the first pass saw only the episode suffix, so try once more.
  if (year === null) {
    const revealedBareYear = /(?:^|\s)((?:19|20)\d{2})\s*$/.exec(body);
    if (revealedBareYear) {
      year = Number(revealedBareYear[1]);
      body = body.slice(0, revealedBareYear.index).trim();
    }
  }

  // Specials family → "Specials" (scanner reads it as season 0).
  let m = /^(.*?)\s*(?:specials?|ovas?|onas?|extras?)\s*$/i.exec(body);
  if (m && m[1]!.trim()) return { title: m[1]!.trim(), year, sub: "Specials", season: 0 };

  // "Season 2" / "Series 2" / "Staffel 2" / "S2" / "2nd Season" / "Second Season"
  m = /^(.*?)\s*(?:-\s*)?(?:(?:season|series|staffel)\s*0*(\d{1,3})|(\d{1,3})(?:st|nd|rd|th)\s+season|s\s*0*(\d{1,3}))$/i.exec(body);
  if (m) {
    const n = Number(m[2] ?? m[3] ?? m[4]);
    if (m[1]!.trim() && Number.isInteger(n) && n >= 1 && n <= 100) {
      return { title: m[1]!.trim(), year, sub: `Season ${n}`, season: n };
    }
  }
  m = /^(.*?)\s*(?:-\s*)?([a-z]+)\s+season$/i.exec(body);
  if (m && m[1]!.trim() && m[2]!.toLowerCase() in ORDINAL) {
    const n = ORDINAL[m[2]!.toLowerCase()];
    return { title: m[1]!.trim(), year, sub: `Season ${n}`, season: n };
  }
  // "Part 2" / "Cour 2" — a season continuation signal.
  m = /^(.*?)\s*(?:-\s*)?(?:part|cour)\s*0*(\d{1,3})$/i.exec(body);
  if (m && m[1]!.trim() && Number(m[2]) >= 1 && Number(m[2]) <= 100) {
    const n = Number(m[2]);
    return { title: m[1]!.trim(), year, sub: `Season ${n}`, season: n };
  }
  // Scene-style "S02E05" trailing in a provider title (episode belongs in
  // episodeRange, season belongs in the folder). ani-cli queries never look
  // like this, so this is external-only and cannot regress the built-in path.
  m = /^(.*?)\s*s0*(\d{1,3})\s*e0*(\d{1,3})\s*$/i.exec(body);
  if (m && m[1]!.trim()) {
    const n = Number(m[2]);
    if (Number.isInteger(n) && n >= 1 && n <= 100) {
      return { title: m[1]!.trim(), year, sub: `Season ${n}`, season: n };
    }
  }

  // No season signal — flat show. Return the cleaned body (trailing year and
  // parens already peeled) so the series folder doesn't end up doubled
  // ("Demon Slayer (2019) (2019)") when the year is re-attached below.
  // Fall back to the cleaned pre-parse text, never the raw junk: an input
  // that was only release groups/quality ("[X] BD 1080p") must not become a
  // folder literally named after that junk.
  const flatTitle = body.trim();
  return { title: flatTitle || pre.trim() || "anicli", year, sub: null, season: null };
}

/**
 * The season number a query denotes, for the API's "is this a new season?"
 * dedup gate. Returns null when the query has no season signal (a flat show —
 * "already exists" check applies by title alone).
 */
export function anicliQuerySeason(query: string): number | null {
  return parseAnicliQuery(query).season;
}

/** Filesystem-safe folder name — same allowlist for any caller placing a file under a library root. */
export const sanitizeFolder = (q: string): string => (q.replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 80) || "anicli").trim();

/**
 * False for strings that are episode identity, not series identity:
 * numeric-only/range-only ("01", "01-28"), episode-word-only ("Episode 5",
 * "EP12", "E01"), bare scene codes ("S02E05"), the junk-only sentinel.
 * A series folder must never be derived from one of these — a provider
 * per-item title like "01" names an episode, and "01" as a SERIES folder
 * is exactly the fork this guards against. Callers fall back to the
 * request-level title (user intent) and fail closed when nothing is left.
 */
export function isSeriesLikeTitle(title: string): boolean {
  const t = title.trim();
  if (!t || t === "anicli") return false;
  if (/^(?:episode|ep|e)\s*\d{1,4}(?:\s*-\s*\d{1,4})?\s*(?:v\d+)?$/i.test(t)) return false;
  if (/^\d{1,4}(?:\s*-\s*\d{1,4})?\s*(?:v\d+)?$/.test(t)) return false;
  if (/^s0*\d{1,3}\s*e0*\d{1,3}$/i.test(t)) return false;
  return true;
}

/**
 * Target folder for a download. The season signal lives only here (ani-cli
 * filenames carry none, and an external provider's stream carries none
 * either), so this MUST match the scanner's own season-dir names: flat
 * "<root>/<Series>/" (implicit Season 1), "<root>/<Series>/Season N/", or
 * "<root>/<Series>/Specials/" (season 0). A trailing year is re-attached to
 * the series folder so cleanFolderTitle can feed it to the provider. Both
 * the ani-cli worker path and any external-provider import must call this
 * exact function — never a second, independently-written placement rule.
 */
export function seasonTargetDir(root: string, title: string, year: number | null, sub: string | null): string {
  // sanitizeFolder truncates its whole input to 80 characters -- reserve
  // room for the year suffix first rather than truncating the combined
  // string blindly, which could otherwise let two different long-titled
  // shows with different years collapse to the identical truncated
  // folder name (the same class of bug fixed in acquire-import.ts's own
  // filename computation, on the folder side this time).
  const yearSuffix = year !== null ? ` (${year})` : "";
  const base = path.join(root, sanitizeFolder(title.slice(0, Math.max(1, 80 - yearSuffix.length)) + yearSuffix));
  return sub !== null ? path.join(base, sub) : base;
}
