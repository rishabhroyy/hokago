// ffmpeg args for OFFLINE DOWNLOADS (the TRANSCODE variant). One-off encode,
// not a realtime-serving path like live transcoding: quality over the speed
// settings buildFfmpegArgs in hls.ts uses.

import { hwDecodeArgs, hwEncodeFilterTail, hwEncodeInitArgs, hwEncodeQualityArgs, type HwaccelState } from "./hwaccel.js";

export interface DownloadEncodeInput {
  inputPath: string;
  outputPath: string;
  /** Cap height (width auto) — clamped like playback's normalizeDeviceProfile. */
  maxHeight?: number;
  maxVideoBitrateKbps?: number;
  /** A selected bitmap/text subtitle track to burn in (bitmap tracks are the
   *  only way they're available offline — original-variant downloads reject
   *  them at creation instead). */
  subtitleBurnIn?: { streamIndex: number; bitmap: boolean };
  /** Resolved hardware acceleration state — same contract as hls.ts's. */
  hwaccel?: HwaccelState;
  /** Output video encoder — defaults to libx264; pickVideoEncoder selects the hw encoder when hwaccel is active. */
  videoCodec?: string;
}

// ffmpeg filter option values split on ':' and quote on "'" — escape both so
// a real filesystem path survives being embedded inside a filtergraph string.
function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/**
 * Self-contained MP4 at the requested caps: h264 (8-bit 4:2:0, B-frames off
 * for dts==pts cleanliness), AAC, faststart so the moov box leads and the file
 * is playable while still being downloaded. No segment muxing — this is a
 * single progressive file the client stores as one blob.
 */
export function buildDownloadArgs(input: DownloadEncodeInput): string[] {
  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
  if (input.hwaccel) args.push(...hwEncodeInitArgs(input.hwaccel), ...hwDecodeArgs(input.hwaccel));
  args.push("-i", input.inputPath);

  const videoFilters: string[] = [];
  if (input.maxHeight) {
    videoFilters.push(`scale='min(-2,iw)':'min(${input.maxHeight},ih)'`);
  }
  // Force 8-bit 4:2:0 — a 10-bit HEVC source would otherwise come out as
  // 10-bit h264 that many decoders reject.
  videoFilters.push("format=yuv420p");
  const hwTail = input.hwaccel ? hwEncodeFilterTail(input.hwaccel) : [];
  if (hwTail.length > 0) videoFilters.push(...hwTail);

  const audioMap = "0:a:0?";
  if (input.subtitleBurnIn) {
    const { streamIndex, bitmap } = input.subtitleBurnIn;
    const preChain = videoFilters.length > 0 ? videoFilters.join(",") : "null";
    const graph = bitmap
      ? `[0:v]${preChain}[vpre];[vpre][0:s:${streamIndex}]overlay${hwTail.length > 0 ? "," + hwTail.join(",") : ""}[vout]`
      : `[0:v]${preChain},subtitles=${escapeFilterPath(input.inputPath)}:si=${streamIndex}${hwTail.length > 0 ? "," + hwTail.join(",") : ""}[vout]`;
    args.push("-filter_complex", graph, "-map", "[vout]", "-map", audioMap);
  } else {
    args.push("-map", "0:v:0", "-map", audioMap);
    if (videoFilters.length > 0) args.push("-vf", videoFilters.join(","));
  }

  // Downloads are quality-first: hw encoders get their equivalent options
  // (hwEncodeQualityArgs defaults) — a one-off encode can afford the slower
  // software path too, so this is the same selection as live transcoding.
  const hwQuality = input.hwaccel ? hwEncodeQualityArgs(input.hwaccel, input.maxVideoBitrateKbps) : null;
  args.push("-c:v", input.videoCodec ?? "libx264");
  if (hwQuality) args.push(...hwQuality, "-bf", "0");
  else args.push("-preset", "fast", "-crf", "20", "-bf", "0");
  if (input.maxVideoBitrateKbps !== undefined) {
    args.push("-maxrate", `${input.maxVideoBitrateKbps}k`, "-bufsize", `${input.maxVideoBitrateKbps * 2}k`);
  }
  args.push("-c:a", "aac");
  // Matroska sources can carry dozens of streams; a small muxer queue aborts
  // the whole job mid-encode ("Too many packets buffered").
  args.push("-max_muxing_queue_size", "4096");
  // faststart relocates moov to the front — the file plays progressively
  // while it's still being written by the client's downloader.
  args.push("-movflags", "+faststart", "-f", "mp4", input.outputPath);
  return args;
}
