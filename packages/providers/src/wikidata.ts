import type { IdMapping, MappingSource } from "@hokago/metadata";

const BASE_URL = process.env.HOKAGO_WIKIDATA_BASE_URL ?? "https://query.wikidata.org/sparql";
// WDQS's usage policy asks for a descriptive User-Agent identifying the client (§21, "polite").
const USER_AGENT = "hokago-metadata-bridge/1.0 (self-hosted media server; runs on the operator's own instance)";

/** Wikidata property (P-number) holding each provider's own item ID — verified live against query.wikidata.org (§21). */
const SOURCE_PROPERTY: Record<string, string> = {
  TVMAZE: "P8600", // "TV Maze series ID"
  ANILIST: "P8729", // "AniList anime ID"
  MAL: "P4086", // "MyAnimeList anime ID"
};

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

interface SparqlResponse {
  results: { bindings: { imdb?: { value: string } }[] };
}

/**
 * CC0 ID-bridge only (§8.2: Wikidata is "✅ (ID bridge)", not a descriptive or
 * artwork source) — resolves a provider's own item ID to its IMDb ID (P345)
 * via a live SPARQL query. Never a dependency: callers must treat any failure
 * as "no bridge available," not an error.
 */
export class WikidataBridge implements MappingSource {
  readonly datasetSource = "wikidata";

  async mappingsFor(sourceProvider: string, sourceId: string): Promise<IdMapping[]> {
    const prop = SOURCE_PROPERTY[sourceProvider];
    if (!prop || !SAFE_ID.test(sourceId)) return [];

    const query = `SELECT ?imdb WHERE { ?item wdt:${prop} "${sourceId}" . ?item wdt:P345 ?imdb. }`;
    const url = `${BASE_URL}?query=${encodeURIComponent(query)}&format=json`;
    const res = await fetch(url, { headers: { accept: "application/sparql-results+json", "user-agent": USER_AGENT } });
    if (!res.ok) throw new Error(`Wikidata query failed: ${res.status} ${res.statusText}`);

    const body = (await res.json()) as SparqlResponse;
    return body.results.bindings
      .filter((b): b is { imdb: { value: string } } => Boolean(b.imdb?.value))
      .map((b) => ({ sourceProvider, sourceId, targetProvider: "IMDB", targetId: b.imdb.value }));
  }
}
