import { parse as anitomyParse } from "anitomy";

import type { ParsedFilename } from "./types.js";

/**
 * Anime parser (ANIME content profile). Wraps `anitomy` — a real
 * tokenizer, not a regex — which natively disambiguates release group from
 * title (`[Group] Title - 08`) and knows the absolute-numbering convention
 * anime uses instead of `SxxEyy`.
 */
export function parseAnime(filename: string): ParsedFilename {
  const result = anitomyParse(filename);
  if (!result) {
    return { title: null, year: null, season: null, episode: null, absoluteNumber: null, releaseGroup: null };
  }

  const season = result.season ? Number(result.season) : null;
  let episode = result.episode.number ?? null;
  let leadingFallback = false;
  if (episode === null) {
    // "01. Departure.mp4" (episode-name style, no series part in the file —
    // the folder carries the show name): anitomy swallows the leading number
    // into the title. A strict leading-number pattern recovers the episode;
    // dot-separated only, so "86 - 01.mkv" (a digit-led show title) can't
    // mis-fire.
    const leading = /^(\d{1,3})\.\s+/.exec(filename);
    if (leading) {
      leadingFallback = true;
      episode = Number(leading[1]);
    }
  }
  // No season token means "Series - 38" style absolute numbering — the same
  // number is the absolute number too, until episode_offset resolution
  // can tell us otherwise against a real season structure.
  const absoluteNumber = result.episode.numberAlt ?? (season === null ? episode : null);

  return {
    // The fallback case has no series name in the file — the folder is the
    // show — so anitomy's "01  Departure" title is garbage; null it.
    title: leadingFallback ? null : (result.title ?? null),
    year: result.year ?? null,
    season,
    episode,
    absoluteNumber,
    releaseGroup: result.release.group ?? null,
  };
}
