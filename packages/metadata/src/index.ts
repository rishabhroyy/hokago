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
  | "RESOLUTION_CODEC";

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

export interface MetadataProvider {
  readonly provider: ProviderName;
  search(query: MetadataQuery): Promise<MetadataSignal[]>;
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
