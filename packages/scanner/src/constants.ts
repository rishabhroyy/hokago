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
};

const SEASON_DIR = /^season\s*0*(\d{1,3})$/i;
const SEASON_DIR_SHORT = /^s0*(\d{1,3})$/i;
const SPECIALS_DIR = /^specials?$/i;

export function parseSeasonDirName(name: string): number | null {
  if (SPECIALS_DIR.test(name)) return 0;
  const m = SEASON_DIR.exec(name) ?? SEASON_DIR_SHORT.exec(name);
  return m ? Number(m[1]) : null;
}
