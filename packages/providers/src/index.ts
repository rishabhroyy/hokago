export { AniListProvider } from "./anilist.js";
export { JikanProvider } from "./jikan.js";
export { TvMazeProvider } from "./tvmaze.js";
export { WikipediaProvider } from "./wikipedia.js";
export { WikidataBridge } from "./wikidata.js";
export { acceptMatch, findAcceptedMatch, normalizeTitle } from "./match.js";
export {
  findExistingSeries,
  seasonsForSeries,
  checkSeasonDedup,
  type ExistingSeriesDeps,
  type SeasonsForSeriesDeps,
  type SeasonDedupDeps,
  type SeasonBreakdown,
} from "./existing-series.js";
