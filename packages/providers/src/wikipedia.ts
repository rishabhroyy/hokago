import type {
  MetadataMatch,
  MetadataProvider,
  MetadataQuery,
  MetadataSearchOptions,
  MetadataSearchResult,
} from "@hokago/metadata";

/**
 * Keyless movie metadata via Wikipedia — the one keyless source that still
 * serves movies (Apple's iTunes Search API dropped movie results while music
 * and TV still work). MOVIE chain: title search (opensearch) → REST summary
 * per candidate for the intro extract + lead image (fair-use posters
 * included). No infobox scraping: modern en.wiki film articles dropped the
 * genre/studio/released fields, so the year comes from the intro text.
 * Best-effort throughout: a broken field never fails the match.
 *
 * Wikimedia requires a descriptive User-Agent — bare fetch() calls 403.
 */

const ACTION_BASE = process.env.HOKAGO_WIKIPEDIA_API_BASE_URL ?? "https://en.wikipedia.org/w/api.php";
const REST_BASE = process.env.HOKAGO_WIKIPEDIA_REST_BASE_URL ?? "https://en.wikipedia.org/api/rest_v1";

const USER_AGENT = "hokago/0.1 (self-hosted media server; keyless metadata resolver)";

const MAX_CANDIDATES = 6;
const SEARCH_LIMIT = 10;
const EXTRACT_LIMIT = 1200;

interface WikipediaSummary {
  type: string;
  title: string;
  description?: string;
  extract?: string;
  thumbnail?: { source: string };
}

/** A film-ish description ("1999 film directed by...") vs a landform/novel/franchise blurb. */
const FILMISH = /film|movie|animation|anime|television|series|episode|drama|documentary/i;

function isFilmish(s: WikipediaSummary): boolean {
  if (!s.description) return true; // no description → don't over-prune
  return FILMISH.test(s.description);
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" } });
  if (!res.ok) throw new Error(`Wikipedia request failed: ${res.status} ${res.statusText}`);
  return res.json();
}

async function summary(title: string): Promise<WikipediaSummary | undefined> {
  const body = (await getJson(
    `${REST_BASE}/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`,
  )) as WikipediaSummary;
  if (body.type === "missing" || body.type === "disambiguation" || body.type === "mainpage") return undefined;
  if (!isFilmish(body)) return undefined; // a landform/novel page must never become a movie identity
  return body;
}

/** First 1900-2099 year in the intro — the release year for the gate's ±1 check. */
function extractYear(text?: string): number | undefined {
  const m = text?.match(/\b(?:18|19|20)\d{2}\b/);
  return m ? Number(m[0]) : undefined;
}

async function toMatch(s: WikipediaSummary): Promise<MetadataMatch> {
  // "The Matrix (film)" → "The Matrix" — drop ONLY the pure disambiguator
  // suffix; parenthetical year stays out of titles anyway.
  const title = s.title.replace(/\s*\((?:film|movie|animation)\)$/i, "");
  return {
    providerId: s.title,
    title,
    year: extractYear(s.extract),
    overview: s.extract ? s.extract.slice(0, EXTRACT_LIMIT) : undefined,
    artwork: s.thumbnail?.source
      ? [{ kind: "POSTER" as const, url: s.thumbnail.source.replace(/\?utm[^#]*$/, "") }]
      : undefined,
  };
}

export class WikipediaProvider implements MetadataProvider {
  readonly provider = "WIKIPEDIA" as const;

  async search(query: MetadataQuery, options?: MetadataSearchOptions): Promise<MetadataSearchResult> {
    // providerId is the page title — revalidate exactly, no search ambiguity.
    if (options?.existingProviderId) {
      const body = await summary(options.existingProviderId);
      if (!body) return { matches: [] };
      return { matches: [await toMatch(body)] };
    }

    const params = new URLSearchParams({
      action: "opensearch",
      search: query.title,
      limit: String(SEARCH_LIMIT),
      namespace: "0",
      format: "json",
    });
    const body = (await getJson(`${ACTION_BASE}?${params.toString()}`)) as [string, string[], string[], string[]];
    const matches: MetadataMatch[] = [];
    // opensearch ranks by near-match relevance, so a polysemous title can
    // bury the film pages behind the franchise/merch swath — skim the top N
    // and let the resolver's title+year gate pick the real film.
    for (const url of (body[3] ?? []).slice(0, MAX_CANDIDATES)) {
      const pageTitle = decodeURIComponent(url.split("/wiki/")[1] ?? "").replace(/_/g, " ");
      if (!pageTitle) continue;
      const s = await summary(pageTitle);
      if (!s) continue;
      matches.push(await toMatch(s));
    }
    return { matches };
  }
}