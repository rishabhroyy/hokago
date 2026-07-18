import { parse as anitomyParse } from "anitomy";

import type { ParsedFilename } from "./types.js";

/**
 * Anime parser (§9.3, ANIME content profile). Wraps `anitomy` — a real
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
  const episode = result.episode.number ?? null;
  // No season token means "Series - 38" style absolute numbering — the same
  // number is the absolute number too, until episode_offset resolution (§7.4)
  // can tell us otherwise against a real season structure.
  const absoluteNumber = result.episode.numberAlt ?? (season === null ? episode : null);

  return {
    title: result.title ?? null,
    year: result.year ?? null,
    season,
    episode,
    absoluteNumber,
    releaseGroup: result.release.group ?? null,
  };
}
