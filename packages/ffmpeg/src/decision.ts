import { needsToneMap, type DeviceProfile, type PlaybackCandidateInput } from "./device-profile.js";

/** Mirrors the Prisma PlaybackMethod enum without a dependency on @hokago/db (pure function, no I/O). */
export type PlaybackMethod = "DIRECT_PLAY" | "DIRECT_STREAM" | "TRANSCODE";

export interface PlaybackDecision {
  method: PlaybackMethod;
  reasons: string[];
}

/**
 * Three-tier decision, evaluated in the doc's stated order (§11.1, Jellyfin
 * StreamBuilder order): force flags → direct play eval → transcoding profile
 * eval. Direct Stream is remux-only (container swap, streams copied) — it
 * can't fix a codec, resolution, bitrate, HDR, or subtitle-burn mismatch, only
 * a container one. Anything else falls through to a real re-encode.
 */
export function decidePlaybackMethod(input: PlaybackCandidateInput, profile: DeviceProfile): PlaybackDecision {
  const reasons: string[] = [];

  // Stage 1: force flags.
  const directPlayForced = profile.enableDirectPlay !== false;
  const directStreamForced = profile.enableDirectStream !== false;
  if (!directPlayForced) reasons.push("direct play disabled by device profile force flag");
  if (!directStreamForced) reasons.push("direct stream disabled by device profile force flag");

  // Shared compatibility checks — a container mismatch alone is remux-fixable,
  // everything else here is not.
  const containerOk = profile.supportedContainers.includes(input.container);
  const videoCodecOk = input.videoCodec !== null && profile.supportedVideoCodecs.includes(input.videoCodec);
  const audioCodecOk = input.audioCodec === null || profile.supportedAudioCodecs.includes(input.audioCodec);
  const widthOk = profile.maxWidth === undefined || input.width === null || input.width <= profile.maxWidth;
  const heightOk = profile.maxHeight === undefined || input.height === null || input.height <= profile.maxHeight;
  const bitrateOk =
    profile.maxVideoBitrateKbps === undefined ||
    input.bitrateKbps === null ||
    input.bitrateKbps <= profile.maxVideoBitrateKbps;
  const hdrOk = !needsToneMap(input.isHdr, profile.supportsHdr);
  // PGS/VOBSUB forcing burn-in (§13.4) always wins; a profile that itself
  // wants everything burned (e.g. airplay) forces it independent of the track.
  const burnRequired = input.subtitleRequiresBurnIn || profile.subtitleMode === "burn";

  if (!videoCodecOk) reasons.push(`video codec ${input.videoCodec ?? "unknown"} unsupported by profile`);
  if (!audioCodecOk) reasons.push(`audio codec ${input.audioCodec ?? "unknown"} unsupported by profile`);
  if (!widthOk || !heightOk) reasons.push(`resolution ${input.width}x${input.height} exceeds profile max`);
  if (!bitrateOk) reasons.push(`bitrate ${input.bitrateKbps}kbps exceeds profile max`);
  if (!hdrOk) reasons.push("HDR source not supported by profile — needs tone map");
  if (burnRequired) reasons.push("subtitle burn-in required — forces re-encode");
  if (!containerOk) reasons.push(`container ${input.container} unsupported by profile`);

  const codecsAndLimitsOk = videoCodecOk && audioCodecOk && widthOk && heightOk && bitrateOk && hdrOk && !burnRequired;

  // Stage 2: direct play eval.
  if (directPlayForced && containerOk && codecsAndLimitsOk) {
    return { method: "DIRECT_PLAY", reasons: ["container, codecs, and limits all within profile support"] };
  }

  // Stage 3: transcoding profile eval — remux (Direct Stream) still counts as
  // a "transcode" tier per §11.1's naming, but only ever touches the container.
  if (directStreamForced && !containerOk && codecsAndLimitsOk) {
    return { method: "DIRECT_STREAM", reasons: [...reasons, "remux only: codecs and limits already compatible"] };
  }

  return { method: "TRANSCODE", reasons };
}
