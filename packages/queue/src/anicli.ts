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

const ORDINAL: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

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

  let year: number | null = null;
  let body = s;
  const yearM = /\(\s*(?:19|20)\d{2}\s*\)\s*$/.exec(s);
  if (yearM) {
    year = Number(yearM[0].replace(/\D/g, ""));
    body = s.slice(0, yearM.index).trim();
  }
  body = body.replace(/\([^)]*\)\s*$/g, "").trim();

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

  // No season signal — flat show. Return the cleaned body (trailing year and
  // parens already peeled) so the series folder doesn't end up doubled
  // ("Demon Slayer (2019) (2019)") when the year is re-attached below.
  const flatTitle = body.trim();
  return { title: flatTitle || s.trim(), year, sub: null, season: null };
}

/**
 * The season number a query denotes, for the API's "is this a new season?"
 * dedup gate. Returns null when the query has no season signal (a flat show —
 * "already exists" check applies by title alone).
 */
export function anicliQuerySeason(query: string): number | null {
  return parseAnicliQuery(query).season;
}
