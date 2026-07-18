/**
 * hokago — metadata provider interfaces (license firewall)
 * Design doc: docs/design.md §8.5, §19 Step 0.
 *
 * INTERFACES ONLY. No implementation, no data, ever — not even temporarily.
 * AGPL-encumbered (anime-offline-database, Fribb/anime-lists) and non-commercial
 * (IMDb) datasets implement these in packages-optional/, fetched at runtime by
 * the operator's own instance. Never vendored, never imported, from this package.
 *
 * Mirrors the `Provider` / `SignalType` / `IdMapping` / `Evidence` shapes in
 * packages/db/prisma/schema.prisma — kept as literal unions here, not imported
 * from @hokago/db, so this package has zero dependencies.
 */

export type ProviderName =
  | "LOCAL"
  | "EMBEDDED"
  | "GENERATED"
  | "TVMAZE"
  | "ANILIST"
  | "MAL"
  | "ANIDB"
  | "IMDB"
  | "WIKIDATA"
  | "TMDB";

export type SignalType =
  | "NFO_UNIQUEID"
  | "EMBEDDED_TAG"
  | "SIBLING_CONSISTENCY"
  | "FOLDER_NAME"
  | "PROBE_RUNTIME"
  | "FILENAME_PARSE"
  | "TRACK_LANGUAGE"
  | "RESOLUTION_CODEC"
  | "PROVIDER_MATCH";

export interface MetadataQuery {
  title: string;
  originalTitle?: string;
  year?: number;
  kind: "MOVIE" | "SERIES" | "SEASON" | "EPISODE";
}

/**
 * A raw observation, not a verdict. Confidence is derived from these by the
 * resolver — a provider never hands back a confidence number (§7.5).
 */
export interface MetadataSignal {
  signalType: SignalType;
  value: unknown;
  weight: number;
}

export type MetadataTitleType = "PRIMARY" | "ROMAJI" | "ENGLISH" | "NATIVE" | "SYNONYM";

export interface MetadataTitle {
  type: MetadataTitleType;
  value: string;
}

export type MetadataLifecycleState = "ENDED" | "ONGOING" | "UNKNOWN" | "UNRELEASED";

export interface MetadataArtworkCandidate {
  kind: "POSTER" | "BACKDROP" | "STILL" | "BANNER" | "LOGO" | "THUMB";
  /** Remote URL — the provider client fetches these bytes once; never stored as a URL (§1.1). */
  url: string;
}

/**
 * One candidate identity match from a provider's search — not yet accepted.
 * The resolver runs its own title+year sanity check (§8.7.2) before treating
 * this as a real match; the provider does no matching-confidence math itself.
 */
export interface MetadataMatch {
  providerId: string;
  title: string;
  year?: number;
  overview?: string;
  premieredAt?: string;
  lifecycleState?: MetadataLifecycleState;
  titles?: MetadataTitle[];
  artwork?: MetadataArtworkCandidate[];
}

export interface MetadataSearchOptions {
  /** Last-Modified value from a prior fetch (§8.3), sent back as If-Modified-Since — only Jikan currently honors this. */
  lastModified?: string;
  /** This mediaItem's existing providerId from a prior match — lets a provider revalidate directly instead of re-searching by title (§8.3; TVmaze's /updates/shows). */
  existingProviderId?: string;
}

export interface MetadataSearchResult {
  matches: MetadataMatch[];
  /** New Last-Modified value to persist for next time, if the provider's transport exposes one. */
  lastModified?: string;
  /** True when the server confirmed no change via 304 — matches is empty and should be ignored. */
  notModified?: boolean;
}

export interface MetadataProvider {
  readonly provider: ProviderName;
  search(query: MetadataQuery, options?: MetadataSearchOptions): Promise<MetadataSearchResult>;
}

/**
 * Unidirectional: A→B does not imply B→A (§7.4). A mapping source returns
 * only the direction it was asked for.
 */
export interface IdMapping {
  sourceProvider: string;
  sourceId: string;
  targetProvider: string;
  targetId: string;
  seasonOffset?: number;
  episodeOffset?: number;
}

export interface MappingSource {
  /** Which packages-optional dataset this is — stored on IdMapping.datasetSource (§8.5). */
  readonly datasetSource: string;
  mappingsFor(provider: string, id: string): Promise<IdMapping[]>;
}
