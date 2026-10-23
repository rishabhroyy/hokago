import type { ParsedFilename } from "./types.js";

const SXXEYY = /s(\d{1,2})e(\d{1,3})/i;
// (?<!\d) guards resolution strings: "640x480"/"720x404" must not read as
// S40E480/S20E404 — the season group can't be preceded by another digit.
const XSEP = /(?<!\d)(\d{1,2})x(\d{1,3})(?!\d)/;
// "Title - 05", "Title - 05v2 [hash]", "Title - 05 - Episode Name". The
// 1-3 digit cap keeps "Title - 2019" (a year) from reading as an episode.
const TRAILING_EP = /-\s*(\d{1,3})(?:v\d+)?\s*(?:[[(]|-\s|$)/;
// "Title (05)" / "Title [05]" — fansub bracket numbering.
const BRACKET_EP = /[\[(](\d{1,3})[\])]\s*$/;
// Bare "Title 05" — 2-3 digits only: a trailing single digit is a sequel
// number ("Spice and Wolf 2"), not an episode.
const BARE_EP = /\s(\d{2,3})$/;
// A bracketed year wins over a bare one: "2012 (2009)" is the movie "2012"
// from 2009 — the bare-first read both mistitled it and failed the ±1-year
// provider gate.
const YEAR_BRACKETED = /[([]\s*((?:19|20)\d{2})\s*[\])]/;
const YEAR_BARE = /\b((?:19|20)\d{2})\b/;

// Scene-release tail junk. Kept deliberately unambiguous — no bare "web",
// "dvd", "multi" etc., which are real words in real titles. Matched before
// dots become spaces so dotted tokens ("H.264", "DDP2.0") can match.
const QUALITY_TOKEN =
  /\b(2160p|1080p|720p|576p|480p|4k|uhd|hdr10\+?|hdr|dv|blu-?ray|bdrip|bdremux|remux|web-?dl|webrip|hdtv|hdrip|dvdrip|x264|x265|h[. ]?264|h[. ]?265|hevc|avc|av1|xvid|divx|10-?bit|8-?bit|(?:dd[p+]?|aac)\s?[1-7][. ][01]|aac|e?ac-?3|dts(-?hd|-?ma)?|truehd|atmos|flac|opus|mp3|5\.1|7\.1|proper|repack|rerip)\b/gi;

// Streaming WEB-DL release tags short enough to be real title words —
// case-sensitive, and only stripped once QUALITY_TOKEN proved the name is a
// release. Kept in step with packages/queue/src/anicli.ts's ACQUIRE_RELEASE_TAG.
const RELEASE_TAG = /(?<![A-Za-z0-9])(?:NF|AMZN|DSNP|HMAX|ATVP|HULU|PCOK|PMTP|CR|iT|WEB|COMPLETE|DDP|DD\+?)(?![A-Za-z0-9])/g;

function cleanTitle(raw: string): string | null {
  const cleaned = raw
    .replace(/^[\[(][^\])]*[\])]\s*/, "") // leading [ReleaseGroup]
    .replace(/[._]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[-\s]+$/, "");
  return cleaned.length > 0 ? cleaned : null;
}

function yearOf(base: string): number | null {
  const m = YEAR_BRACKETED.exec(base) ?? YEAR_BARE.exec(base);
  return m ? Number(m[1]) : null;
}

/**
 * Strips the scene tail (year, quality/codec/audio tokens, [bracketed]
 * groups, -GROUP suffix) from a name that has no episode marker — i.e. a
 * movie filename or a series folder. Without this the provider query is a
 * superset of every real title ("Your Name 2016 1080p BluRay x264-GROUP")
 * and the match gate can never accept anything.
 */
function stripSceneJunk(raw: string, year: number | null): string {
  let s = ` ${raw} `.replace(/_/g, " "); // padded so \b tokens match at the edges; dots kept for "H.264"
  const hadQuality = QUALITY_TOKEN.test(s);
  QUALITY_TOKEN.lastIndex = 0;
  s = s.replace(QUALITY_TOKEN, " ");
  if (hadQuality) s = s.replace(RELEASE_TAG, " ");
  s = s.replace(/\./g, " ");
  if (year !== null) s = s.replace(new RegExp(`[([]?\\s*${year}\\s*[)\\]]?`), " ");
  s = s.replace(/[\[(][^\])]*[\])]/g, " ");
  if (hadQuality) s = s.replace(/-[A-Za-z0-9]+(?=\s*$)/, " "); // -GROUP rides the quality tail
  if (hadQuality) s = s.replace(/\ss\d{1,2}\s*$/i, " "); // season-pack "S01" belongs to the season, not the title
  return s.replace(/\s+/g, " ").trim().replace(/[-\s]+$/, "").replace(/^[-\s]+/, "");
}

/**
 * Folder-derived series identity for provider queries: "Attack on Titan
 * (2013)" → { title: "Attack on Titan", year: 2013 }. The raw basename stays
 * the on-disk identity (the SERIES row title); this is only the search view.
 */
export function cleanFolderTitle(raw: string): { title: string; year: number | null } {
  const year = yearOf(raw);
  const title = stripSceneJunk(raw, year) || raw;
  return { title, year };
}

/**
 * Scene-release + Kodi folder-convention parser (GENERAL content profile).
 * One generic regex, not a tokenizer — good enough for `SxxEyy` / `NxNN` /
 * `Title - NN` scene conventions. Known-unresolvable cases (ambiguous group vs.
 * title, "Spice and Wolf 2" episode-vs-batch) are left as-is rather than guessed.
 */
export function parseScene(filename: string): ParsedFilename {
  const base = filename.replace(/\.[^.]+$/, "");

  const sxxeyy = SXXEYY.exec(base);
  if (sxxeyy) {
    return {
      title: cleanTitle(base.slice(0, sxxeyy.index)),
      year: yearOf(base),
      season: Number(sxxeyy[1]),
      episode: Number(sxxeyy[2]),
      absoluteNumber: null,
      releaseGroup: null,
    };
  }

  const xsep = XSEP.exec(base);
  if (xsep) {
    return {
      title: cleanTitle(base.slice(0, xsep.index)),
      year: yearOf(base),
      season: Number(xsep[1]),
      episode: Number(xsep[2]),
      absoluteNumber: null,
      releaseGroup: null,
    };
  }

  const marker = TRAILING_EP.exec(base) ?? BRACKET_EP.exec(base) ?? BARE_EP.exec(base);
  if (marker) {
    return {
      title: cleanTitle(base.slice(0, marker.index)),
      year: yearOf(base),
      season: null,
      episode: Number(marker[1]),
      absoluteNumber: null,
      releaseGroup: null,
    };
  }

  const year = yearOf(base);
  return {
    title: stripSceneJunk(base, year) || cleanTitle(base),
    year,
    season: null,
    episode: null,
    absoluteNumber: null,
    releaseGroup: null,
  };
}
