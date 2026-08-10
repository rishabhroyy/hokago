// Browser-side "usual" track preference for audio + subtitles, persisted to
// localStorage. The player applies it as the default for every file and falls
// back to the file's own default when the remembered track doesn't exist there.

import type { AudioTrackInfo, SubtitleTrackInfo } from "@hokago/contract/media-files";

const STORAGE_KEY = "hokago:trackPrefs";

/** Audio choice. streamIndex = server track (TRANSCODE/REMUX menu); id = vidstack
 *  native track id (DIRECT_PLAY native menu); title/lang cover both. */
export interface AudioPref {
  streamIndex: number | null;
  id: string | null;
  lang: string | null;
  title: string | null;
}

/** Subtitle choice. A null *pref* means "subs off"; undefined means the user
 *  never picked (file's own default — first renderable — applies). */
export interface SubtitlePref {
  id: string;
  lang: string | null;
  title: string | null;
}

export interface TrackPrefs {
  audio: AudioPref | null;
  /** undefined = unset (default), null = off, otherwise a remembered track. */
  subtitle: SubtitlePref | null | undefined;
  /** undefined = unset (the device profile's default caps apply). */
  quality: QualityPref | null | undefined;
}

/** Encode caps for a quality selection — merged into the device profile on /start and sent to /quality on change. Null caps = "Original" (no forced caps, the decider picks the easiest tier). */
export interface QualityPref {
  label: string;
  maxWidth: number | null;
  maxHeight: number | null;
  maxVideoBitrateKbps: number | null;
}

export function loadTrackPrefs(): TrackPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { audio: null, subtitle: undefined, quality: undefined };
    const parsed = JSON.parse(raw) as Partial<TrackPrefs>;
    return {
      audio: parsed.audio ?? null,
      // Distinguish "never set" (missing key → undefined) from "turned off"
      // (stored null) so a fresh user still gets the file's default subtitle.
      subtitle: parsed.subtitle === undefined ? undefined : parsed.subtitle,
      quality: parsed.quality === undefined ? undefined : parsed.quality,
    };
  } catch {
    return { audio: null, subtitle: undefined, quality: undefined };
  }
}

function persist(prefs: TrackPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Quota / private mode — best effort.
  }
}

export function saveAudioPref(pref: AudioPref | null): void {
  const prefs = loadTrackPrefs();
  prefs.audio = pref;
  persist(prefs);
}

export function saveSubtitlePref(pref: SubtitlePref | null): void {
  const prefs = loadTrackPrefs();
  prefs.subtitle = pref;
  persist(prefs);
}

export function saveQualityPref(pref: QualityPref): void {
  const prefs = loadTrackPrefs();
  prefs.quality = pref;
  persist(prefs);
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** Best matching audio track for the remembered preference. */
export function matchAudioPref(
  tracks: AudioTrackInfo[],
  pref: AudioPref | null | undefined,
): AudioTrackInfo | undefined {
  if (!pref || tracks.length === 0) return undefined;
  if (pref.streamIndex != null) {
    const byIndex = tracks.find((t) => t.streamIndex === pref.streamIndex);
    if (byIndex) return byIndex;
  }
  const byTitle = pref.title ? tracks.find((t) => norm(t.title) === norm(pref.title)) : undefined;
  if (byTitle) return byTitle;
  const byLang = pref.lang ? tracks.find((t) => norm(t.lang) === norm(pref.lang)) : undefined;
  return byLang;
}

/** Best matching subtitle track for the remembered preference. */
export function matchSubtitlePref(
  tracks: SubtitleTrackInfo[],
  pref: SubtitlePref | null | undefined,
): SubtitleTrackInfo | undefined {
  if (!pref || tracks.length === 0) return undefined;
  const byId = tracks.find((t) => t.id === pref.id);
  if (byId) return byId;
  const byTitle = pref.title ? tracks.find((t) => norm(t.title) === norm(pref.title)) : undefined;
  if (byTitle) return byTitle;
  const byLang = pref.lang ? tracks.find((t) => norm(t.lang) === norm(pref.lang)) : undefined;
  return byLang;
}
