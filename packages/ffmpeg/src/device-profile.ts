// §11.1/§11.2. Fixed segment length so the upfront .m3u8 can enumerate every
// segment before any of them exist on disk (§11.2 "generate the full .m3u8
// immediately"). 6s balances seek granularity against segment-boundary overhead;
// not derived from anything, just a reasonable default.
export const HLS_SEGMENT_SECONDS = 6;

/**
 * General enough that "airplay" is just another profile with subtitleMode:
 * "burn" (§11.1) — nothing about this type is device-specific. Chromecast is
 * permanently out of scope (non-negotiable #12) and must never be used as an
 * example here or anywhere else this type is documented.
 */
export interface DeviceProfile {
  supportedContainers: string[];
  supportedVideoCodecs: string[];
  supportedAudioCodecs: string[];
  maxVideoBitrateKbps?: number;
  maxWidth?: number;
  maxHeight?: number;
  supportsHdr?: boolean;
  /** none: no subtitle rendering. external: client renders soft subs (JASSUB). burn: server must burn in regardless of track type. */
  subtitleMode: "none" | "external" | "burn";
  /** Force flags (§11.1 evaluation order, stage 1) — default true when omitted. */
  enableDirectPlay?: boolean;
  enableDirectStream?: boolean;
}

// ffprobe's format_name is a comma-separated demuxer alias list (e.g.
// "matroska,webm" or "mov,mp4,m4a,3gp,3g2,mj2") — not what a device profile
// author would write. Map to the short tag people actually mean.
const CONTAINER_ALIASES: Record<string, string> = {
  matroska: "mkv",
  webm: "webm",
  mov: "mp4",
  mp4: "mp4",
  m4a: "mp4",
  "3gp": "mp4",
  "3g2": "mp4",
  mj2: "mp4",
};

/** Normalizes an ffprobe format_name to the short container tag a DeviceProfile.supportedContainers list should use. */
export function normalizeContainer(ffprobeFormatName: string): string {
  const parts = ffprobeFormatName.split(",").map((p) => p.trim());
  for (const part of parts) {
    const alias = CONTAINER_ALIASES[part];
    if (alias) return alias;
  }
  return parts[0] ?? ffprobeFormatName;
}

// Maps the codec names a DeviceProfile lists (ffprobe-style: "h264", "hevc",
// "vp9", "aac"...) to the ffmpeg encoder that actually produces them — a
// TRANSCODE exists to satisfy the profile, so the output must be an encoder
// the profile's own supported-codec list accepts, not a fixed default.
const VIDEO_ENCODERS: Record<string, string> = {
  h264: "libx264",
  hevc: "libx265",
  vp9: "libvpx-vp9",
  av1: "libaom-av1",
};
const AUDIO_ENCODERS: Record<string, string> = {
  aac: "aac",
  mp3: "libmp3lame",
  opus: "libopus",
  ac3: "ac3",
  flac: "flac",
};

/** First profile-supported video codec we have an encoder for; falls back to libx264 if the profile lists none we recognize. */
export function pickVideoEncoder(supportedVideoCodecs: string[]): string {
  for (const codec of supportedVideoCodecs) {
    const encoder = VIDEO_ENCODERS[codec];
    if (encoder) return encoder;
  }
  return "libx264";
}

/** First profile-supported audio codec we have an encoder for; falls back to aac if the profile lists none we recognize. */
export function pickAudioEncoder(supportedAudioCodecs: string[]): string {
  for (const codec of supportedAudioCodecs) {
    const encoder = AUDIO_ENCODERS[codec];
    if (encoder) return encoder;
  }
  return "aac";
}

/**
 * Gate for the §11.3 tone-map chain. Mirrors packages/scanner/src/probe.ts's
 * needsToneMap(hdrMeta) — that one gates on raw ffprobe HDR transfer
 * characteristics at scan time; this one operates on the already-flattened
 * `isHdr` boolean a PlaybackCandidateInput carries plus the profile's own
 * support flag, since decision.ts and buildFfmpegArgs never see raw HdrMeta.
 */
export function needsToneMap(isHdr: boolean, profileSupportsHdr?: boolean): boolean {
  return isHdr && profileSupportsHdr !== true;
}

/** What the decision engine needs to know about the actual media being played. */
export interface PlaybackCandidateInput {
  /** ffprobe format name, e.g. "matroska,webm" or "mov,mp4,m4a,3gp,3g2,mj2". */
  container: string;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  /** Overall bitrate in kbps. */
  bitrateKbps: number | null;
  isHdr: boolean;
  /** Whether the active subtitle track needs burn-in — PGS/VOBSUB always do (§13.4). */
  subtitleRequiresBurnIn: boolean;
}
