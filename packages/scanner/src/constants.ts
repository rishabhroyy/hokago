export const VIDEO_EXTENSIONS = new Set([
  ".mkv",
  ".mp4",
  ".m4v",
  ".avi",
  ".ts",
  ".m2ts",
  ".mov",
  ".webm",
]);

// Kodi + Radarr/Sonarr sidecar art conventions (§10.1). Radarr's bare
// poster.jpg/fanart.jpg form matters most in practice (§8.6).
export const SIDECAR_ART_FILENAMES: { file: string; kind: "POSTER" | "BACKDROP" | "BANNER" | "LOGO" }[] = [
  { file: "poster.jpg", kind: "POSTER" },
  { file: "poster.png", kind: "POSTER" },
  { file: "folder.jpg", kind: "POSTER" },
  { file: "fanart.jpg", kind: "BACKDROP" },
  { file: "fanart.png", kind: "BACKDROP" },
  { file: "background.jpg", kind: "BACKDROP" },
  { file: "banner.jpg", kind: "BANNER" },
  { file: "logo.png", kind: "LOGO" },
];

// folder.jpg/background.jpg are folder-wide only — no per-file equivalent, so
// Kodi's <video-basename>-poster.jpg convention is derived from the same
// list rather than hand-maintained separately (§10.1).
const FOLDER_ONLY_ART_FILENAMES = new Set(["folder.jpg", "background.jpg"]);
export const SIDECAR_ART_SUFFIXES: { suffix: string; kind: "POSTER" | "BACKDROP" | "BANNER" | "LOGO" }[] =
  SIDECAR_ART_FILENAMES.filter(({ file }) => !FOLDER_ONLY_ART_FILENAMES.has(file)).map(({ file, kind }) => ({
    suffix: `-${file}`,
    kind,
  }));

// Lower wins (Artwork.priority, §7.6). GENERATED always loses to everything.
export const ARTWORK_SOURCE_PRIORITY: Record<string, number> = {
  LOCAL_SIDECAR: 0,
  NFO_URL: 1,
  EMBEDDED: 2,
  PROVIDER: 3,
  GENERATED: 4,
};

// §7.5 signal weights, as a 0..1 scale for a simple weighted-sum confidence.
// Stand-in for the full Step 4 evidence engine — good enough to get a
// meaningful confidence number out of a zero-network scan.
export const SIGNAL_WEIGHT: Record<string, number> = {
  NFO_UNIQUEID: 0.99,
  EMBEDDED_TAG: 0.85,
  SIBLING_CONSISTENCY: 0.7,
  FOLDER_NAME: 0.7,
  PROBE_RUNTIME: 0.7,
  FILENAME_PARSE: 0.45,
  TRACK_LANGUAGE: 0.2,
  RESOLUTION_CODEC: 0.2,
  PROVIDER_MATCH: 0.9,
};

// §8.2/§8.7.6 default provider order, used when Library.providerOrder is empty.
// MOVIE always additionally tries the anime chain regardless of profile (§8.7.6,
// non-negotiable #15) — merged in by callers, not baked into this table.
export const DEFAULT_PROVIDER_ORDER: Record<string, { SERIES: string[]; MOVIE: string[] }> = {
  GENERAL: { SERIES: ["TVMAZE"], MOVIE: [] },
  ANIME: { SERIES: ["ANILIST", "MAL"], MOVIE: ["ANILIST", "MAL"] },
};
export const ANIME_MOVIE_CARVEOUT = ["ANILIST", "MAL"];

// Every signal type local ingest can produce -- the domain it owns when
// syncing evidence (§7.5). PROVIDER_MATCH belongs to the metadata resolver
// instead (see addProviderMatchEvidence in metadata.ts) -- syncEvidenceAndConfidence
// only prunes a stale row within the calling subsystem's own declared domain,
// so neither side ever deletes evidence it doesn't own.
export const LOCAL_SIGNAL_TYPES = [
  "NFO_UNIQUEID",
  "EMBEDDED_TAG",
  "SIBLING_CONSISTENCY",
  "FOLDER_NAME",
  "PROBE_RUNTIME",
  "FILENAME_PARSE",
  "TRACK_LANGUAGE",
  "RESOLUTION_CODEC",
] as const;

// §3.4 self-healing thresholds. Noisy-OR math on the weights above gives a
// real, non-arbitrary gap to sit in: a bare PROVIDER_MATCH with zero local
// corroboration computes to exactly 0.9; adding any real signal (even weak
// FILENAME_PARSE at 0.45) pushes it to ~0.94+, and a normal FOLDER_NAME-
// corroborated match lands at 0.97; a contradicted match (×0.5 penalty)
// collapses to ~0.485-0.50. 0.9 sits right at the top of that gap: it flags
// "provider says so and nothing else backs it up" as still worth another
// look, while never flagging anything with real corroboration.
export const SELF_HEALING_CONFIDENCE_THRESHOLD = 0.9;
// Reuses the same retry-with-backoff cadence already used for UNKNOWN/
// UNRELEASED MetadataCache TTLs (ttlPolicyAndExpiry) — a low-confidence item
// with no new local evidence gets rechecked periodically, not every scan.
export const SELF_HEALING_RETRY_BACKOFF_MS = 24 * 60 * 60 * 1000;

const SEASON_DIR = /^season\s*0*(\d{1,3})$/i;
const SEASON_DIR_SHORT = /^s0*(\d{1,3})$/i;
const SPECIALS_DIR = /^specials?$/i;

export function parseSeasonDirName(name: string): number | null {
  if (SPECIALS_DIR.test(name)) return 0;
  const m = SEASON_DIR.exec(name) ?? SEASON_DIR_SHORT.exec(name);
  return m ? Number(m[1]) : null;
}
