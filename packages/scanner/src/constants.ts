export const VIDEO_EXTENSIONS = new Set([
  ".mkv",
  ".mp4",
  ".m4v",
  ".avi",
  ".ts",
  ".m2ts",
  ".mov",
  ".webm",
  ".wmv",
  ".mpg",
  ".mpeg",
  ".flv",
  ".vob",
  ".divx",
  ".ogm",
]);

// Kodi + Radarr/Sonarr sidecar art conventions . Radarr's bare
// poster.jpg/fanart.jpg form matters most in practice .
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
// list rather than hand-maintained separately .
const FOLDER_ONLY_ART_FILENAMES = new Set(["folder.jpg", "background.jpg"]);
export const SIDECAR_ART_SUFFIXES: { suffix: string; kind: "POSTER" | "BACKDROP" | "BANNER" | "LOGO" }[] =
  SIDECAR_ART_FILENAMES.filter(({ file }) => !FOLDER_ONLY_ART_FILENAMES.has(file)).map(({ file, kind }) => ({
    suffix: `-${file}`,
    kind,
  }));

// Lower wins (Artwork.priority). GENERATED always loses to everything.
export const ARTWORK_SOURCE_PRIORITY: Record<string, number> = {
  LOCAL_SIDECAR: 0,
  NFO_URL: 1,
  EMBEDDED: 2,
  PROVIDER: 3,
  GENERATED: 4,
};

// signal weights, as a 0..1 scale for a simple weighted-sum confidence.
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

// / default provider order, used when Library.providerOrder is empty.
// MOVIE always additionally tries the anime chain regardless of profile (
// non-negotiable #15) — merged in by callers, not baked into this table.
// GENERAL MOVIE leads with the keyless Wikipedia resolver (title/overview/
// poster via the REST summary API — the one keyless movie source; the anime
// carve-out below catches anime movies).
export const DEFAULT_PROVIDER_ORDER: Record<string, { SERIES: string[]; MOVIE: string[] }> = {
  GENERAL: { SERIES: ["TVMAZE"], MOVIE: ["WIKIPEDIA"] },
  ANIME: { SERIES: ["ANILIST", "MAL"], MOVIE: ["ANILIST", "MAL"] },
};
export const ANIME_MOVIE_CARVEOUT = ["ANILIST", "MAL"];

// Every signal type local ingest can produce -- the domain it owns when
// syncing evidence . PROVIDER_MATCH belongs to the metadata resolver
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

// self-healing thresholds. Noisy-OR math on the weights above gives a
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

// Scan-pipeline parallelism: ffprobe spawns and per-file DB/read work are
// CPU/IO-bound and stateless per file, so the directory loop runs them with
// bounded concurrency instead of serially. Generous defaults are fine — the
// bottleneck these protect is process spawn cost, not RAM.
export const PROBE_CONCURRENCY = 8;
export const INGEST_CONCURRENCY = 8;

/**
 * Recognized season-directory names. Beyond "Season 01"/"S01": the UK
 * "Series 1" convention, dot/underscore separators ("Season.01"), trailing
 * year brackets ("Season 1 (2019)"), German "Staffel 1", and the specials
 * family (specials/extras/OVAs/ONAs → season 0). An unrecognized name would
 * otherwise become its own SERIES ("Series 1", "OVA") — splitting one show
 * into several top-level series, or merging every show's "OVA" folder into
 * one shared fake series.
 */
export function parseSeasonDirName(name: string): number | null {
  const cleaned = name
    .replace(/[([][^\])]*[\])]/g, "")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/^(?:specials?|extras?|ovas?|onas?)$/i.test(cleaned)) return 0;
  // A leading season token ("S1", "Season 1") optionally followed by a
  // descriptor ("S1 - First Stage", "Season 1 (2019)") — the "S1 - First
  // Stage" style splits one show into several root-level SERIES rows when
  // unrecognized (Initial D's "stages"). The number must be followed by
  // whitespace or the end of the name, so "s1e5" (an episode-style name)
  // never matches.
  const m = /^(?:season|series|staffel|s)\s*0*(\d{1,3})(?=\s|$)/i.exec(cleaned);
  if (m) return Number(m[1]);
  // Bare numeric folders ("1", "02") — common for anime arranged as Show/1/, Show/2/
  if (/^0*(\d{1,3})$/.test(cleaned)) return Number(RegExp.$1);
  return null;
}

/**
 * Folder-name titles that must never drive provider churn. Two families:
 * the scan's structural noise (a "S1 - First Stage" season dir scanned
 * standalone becomes a SERIES titled "S1 - First Stage"; every episode
 * collection's shared "OVA"/"Specials" folder would too), and download-site
 * garbage ("watch ... online", "123movies", "YIFY"). The self-healing and
 * metadata sweeps skip these outright so provider queues don't churn
 * forever on titles that can never match. A human pin still works — pinned
 * identities revalidate by exact providerId, never by title search.
 */
export function isJunkShowTitle(title: string): boolean {
  const t = title.trim();
  if (!t) return true;
  return (
    /^(?:s|season|series|staffel)\s*\d{1,3}(?=\s|$)/i.test(t) ||
    /^(?:ova|ona|specials?|extras?)$/i.test(t) ||
    /^\d{1,3}\s+-\s+\S/.test(t) ||
    /^watch\s+/i.test(t) ||
    /123movies|soap2day|engsub|yify|rarbg|webrip|web-dl|bluray|1080p|720p/i.test(t)
  );
}
