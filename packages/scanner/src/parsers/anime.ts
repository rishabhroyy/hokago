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
  let year = result.year ?? null;
  // anitomy reads a trailing bare 4-digit number as an episode number
  // ("Movie Name 2019.mkv" → episode 2019) — that's a year, not an episode.
  // Left alone it turns a folder of movies into a fake SERIES whose episodes
  // are all "Episode 2019" (the folder flips season-like on the episode
  // marker), so demote it here.
  if (episode !== null && episode >= 1900 && episode <= 2099) {
    year = year ?? episode;
    episode = null;
  }
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
  // "10.mp4" (a bare-numbered file — no title part at all, the whole
  // filename is just the episode number + extension). A digit-led show title
  // always carries a title part after the number ("86 - 01.mkv"), so a bare
  // number + extension can only be an episode number.
  if (episode === null) {
    const bare = /^(\d{1,3})\.[a-z0-9]{2,5}$/i.exec(filename);
    if (bare) {
      leadingFallback = true;
      episode = Number(bare[1]);
    }
  }
  // No season token means "Series - 38" style absolute numbering — the same
  // number is the absolute number too, until episode_offset resolution
  // can tell us otherwise against a real season structure. (numberAlt is the
  // second number of a multi-episode "01-02" shape, not an absolute number —
  // never consult it here.)
  const absoluteNumber = season === null ? episode : null;

  return {
    // The fallback case has no series name in the file — the folder is the
    // show — so anitomy's "01  Departure" title is garbage as a series
    // identity; null it. (A bare-number filename like "10.mp4" is only ever
    // the number, so it stays null too.) The exception: a movie file —
    // "01. Movie Title.mp4" — where the remainder after the recovered number
    // is a real name; keeping it gives the MOVIE item a clean title instead
    // of the raw basename-with-extension fallback.
    title:
      leadingFallback && result.title && !/^\d{1,3}\s*$/.test(result.title)
        ? result.title.replace(/^\d{1,3}\s+/, "")
        : null,
    year,
    season,
    episode,
    absoluteNumber,
    releaseGroup: result.release.group ?? null,
  };
}
