import type { ParsedFilename } from "./types.js";

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

function yearOf(base: string): number | null {
  const m = YEAR.exec(base);
  return m ? Number(m[1]) : null;
}

/**
 * Scene-release + Kodi folder-convention parser (§9.3, GENERAL content profile).
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

  const trailing = TRAILING_EP.exec(base);
  if (trailing) {
    return {
      title: cleanTitle(base.slice(0, trailing.index)),
      year: yearOf(base),
      season: null,
      episode: Number(trailing[1]),
      absoluteNumber: null,
      releaseGroup: null,
    };
  }

  return {
    title: cleanTitle(base),
    year: yearOf(base),
    season: null,
    episode: null,
    absoluteNumber: null,
    releaseGroup: null,
  };
}
