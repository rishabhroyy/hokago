export interface ParsedFilename {
  title: string | null;
  year: number | null;
  season: number | null;
  episode: number | null;
}

const SXXEYY = /s(\d{1,2})e(\d{1,3})/i;
const XSEP = /(\d{1,2})x(\d{1,3})(?!\d)/;
const TRAILING_EP = /-\s*(\d{1,3})\s*(?:\[|\(|$)/;
const YEAR = /[([]?((?:19|20)\d{2})[)\]]?/;

function cleanTitle(raw: string): string | null {
  const cleaned = raw
    .replace(/[._]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[-\s]+$/, "");
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * ponytail: one generic regex parser, not the real parser registry (§9.3).
 * The doc calls for anitomy (anime) + a separate scene-release/Kodi-folder
 * parser behind a swappable parseFilename(), forked by library contentProfile
 * — that's explicitly Step 4 work. This is a single best-effort stand-in
 * so Step 2 can produce a real title/season/episode without it, and it's
 * exactly the function to delete when the registry lands.
 */
export function parseFilename(filename: string): ParsedFilename {
  const base = filename.replace(/\.[^.]+$/, "");

  const sxxeyy = SXXEYY.exec(base);
  if (sxxeyy) {
    return {
      title: cleanTitle(base.slice(0, sxxeyy.index)),
      year: yearOf(base),
      season: Number(sxxeyy[1]),
      episode: Number(sxxeyy[2]),
    };
  }

  const xsep = XSEP.exec(base);
  if (xsep) {
    return {
      title: cleanTitle(base.slice(0, xsep.index)),
      year: yearOf(base),
      season: Number(xsep[1]),
      episode: Number(xsep[2]),
    };
  }

  const trailing = TRAILING_EP.exec(base);
  if (trailing) {
    return {
      title: cleanTitle(base.slice(0, trailing.index)),
      year: yearOf(base),
      season: null,
      episode: Number(trailing[1]),
    };
  }

  return { title: cleanTitle(base), year: yearOf(base), season: null, episode: null };
}

function yearOf(base: string): number | null {
  const m = YEAR.exec(base);
  return m ? Number(m[1]) : null;
}
