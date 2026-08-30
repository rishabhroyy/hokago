import { needsToneMap, type DeviceProfile, type PlaybackCandidateInput } from "./device-profile.js";

/** Mirrors the Prisma PlaybackMethod enum without a dependency on @hokago/db (pure function, no I/O). */
export type PlaybackMethod = "DIRECT_PLAY" | "DIRECT_STREAM" | "REMUX" | "TRANSCODE";

export interface PlaybackDecision {
  method: PlaybackMethod;
  reasons: string[];
}

/**
 * Three-tier decision, evaluated in the doc's stated order (Jellyfin
 * StreamBuilder order): force flags → direct play eval → remux eval →
 * transcoding profile eval.
 *
 * REMUX is copy-remux: the video stream is copied verbatim into a fragmented
 * MP4 (container swap, `hvc1` tagging, audio copied or re-encoded to AAC when
 * the source codec isn't MP4-safe). It can fix a container or audio-codec
 * mismatch — not a video codec, HDR, or subtitle-burn mismatch. Anything
 * else falls through to a real re-encode.
 */
export function decidePlaybackMethod(input: PlaybackCandidateInput, profile: DeviceProfile): PlaybackDecision {
  const reasons: string[] = [];

  // Stage 1: force flags.
  const directPlayForced = profile.enableDirectPlay !== false;
  const directStreamForced = profile.enableDirectStream !== false;
  if (!directPlayForced) reasons.push("direct play disabled by device profile force flag");
  if (!directStreamForced) reasons.push("direct stream disabled by device profile force flag");

  // Shared compatibility checks — a container/audio mismatch alone is
  // remux-fixable, everything else here is not.
  const containerOk = profile.supportedContainers.includes(input.container);
  const videoCodecOk = input.videoCodec !== null && profile.supportedVideoCodecs.includes(input.videoCodec);
  const audioCodecOk =
    !input.audioKnownBroken &&
    (input.audioCodec === null || profile.supportedAudioCodecs.includes(input.audioCodec));
  const widthOk = profile.maxWidth === undefined || input.width === null || input.width <= profile.maxWidth;
  const heightOk = profile.maxHeight === undefined || input.height === null || input.height <= profile.maxHeight;
  const bitrateOk =
    profile.maxVideoBitrateKbps === undefined ||
    input.bitrateKbps === null ||
    input.bitrateKbps <= profile.maxVideoBitrateKbps;
  const hdrOk = !needsToneMap(input.isHdr, profile.supportsHdr);
  // PGS/VOBSUB forcing burn-in always wins; a profile that itself
  // wants everything burned (e.g. airplay) forces it independent of the track.
  const burnRequired = input.subtitleRequiresBurnIn || profile.subtitleMode === "burn";

  if (!videoCodecOk) reasons.push(`video codec ${input.videoCodec ?? "unknown"} unsupported by profile`);
  if (!audioCodecOk) {
    reasons.push(
      input.audioKnownBroken
        ? `audio codec ${input.audioCodec ?? "unknown"} previously reported undecodable — forcing re-encode`
        : `audio codec ${input.audioCodec ?? "unknown"} unsupported by profile`,
    );
  }
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

  // Stage 3: remux eval — the video is decodable by the client as-is, so a
  // container swap (and/or audio re-encode to an MP4-safe codec) is enough.
  // Resolution caps DO apply: remux is a verbatim copy, so it can never
  // deliver a quality below the source — a profile/user requesting 720p of a
  // 1080p source must fall through to a real re-encode. Bitrate caps don't:
  // a copy can't be re-bitrated, and the client decodes natively anyway.
  if (directStreamForced && videoCodecOk && widthOk && heightOk && hdrOk && !burnRequired) {
    return { method: "REMUX", reasons: [...reasons, "video decodable — container swap (copy), audio as needed"] };
  }

  return { method: "TRANSCODE", reasons };
}
