// Human-friendly audio-track labels. Media files carry language tags (ffprobe
// ISO 639-2/B codes like "eng"/"jpn") but mux titles are often codec artifacts
// ("Opus 2.0") — the language name is the useful label. Meaningful titles
// (commentary, "English 5.1") are kept, prefixed by the language when distinct.

import type { AudioTrackInfo } from "@hokago/contract/media-files";

let displayNames: Intl.DisplayNames | null = null;
function getDisplayNames(): Intl.DisplayNames | null {
  if (displayNames === null) {
    try {
      displayNames = new Intl.DisplayNames(["en"], { type: "language" });
    } catch {
      displayNames = null;
    }
  }
  return displayNames;
}

/** Human-readable language name for a tag, or null when it can't be resolved. */
export function languageName(code: string | null | undefined): string | null {
  if (!code) return null;
  const trimmed = code.trim();
  if (!trimmed) return null;
  const names = getDisplayNames();
  if (!names) return null;
  try {
    const name = names.of(trimmed);
    // Unresolvable codes come back as themselves (e.g. "zxx", "enm") — absent.
    if (!name || name.toLowerCase() === trimmed.toLowerCase()) return null;
    return name;
  } catch {
    return null;
  }
}

/** True when a track title is just the codec echoing itself (e.g. "Opus 2.0"). */
export function isCodecArtifactTitle(title: string | null | undefined, codec: string | null | undefined): boolean {
  if (!title || !codec) return false;
  return title.trim().toLowerCase().startsWith(codec.trim().toLowerCase());
}

/** Menu label for an audio track — the language name when the title is a codec
 *  artifact, otherwise the meaningful title (with the language prefix). */
export function audioTrackLabel(t: AudioTrackInfo): string {
  const name = languageName(t.lang);
  const title = t.title?.trim();
  if (!title) return name ?? t.lang ?? `Track ${t.streamIndex}`;
  if (isCodecArtifactTitle(title, t.codec)) return name ?? title;
  if (name && !title.toLowerCase().startsWith(name.toLowerCase())) return `${name} · ${title}`;
  return title;
}
