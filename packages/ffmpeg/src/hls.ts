import path from "node:path";

/**
 * Full VOD playlist generated upfront — the client sees the whole
 * video as ready-to-seek immediately, even though most segment files don't
 * exist on disk yet. Segments are produced on request by whatever route
 * serves segment-N.ts; this function only ever describes the shape.
 *
 * `startSegment` (a resume position) sets EXT-X-MEDIA-SEQUENCE so players
 * begin at the segment ffmpeg was asked to produce from — otherwise the
 * player preloads segment-0, which a resumed session never writes.
 */
export function buildM3u8(durationMs: number, segmentSeconds: number, startSegment = 0): string {
  const totalSeconds = durationMs / 1000;
  let segmentCount = Math.max(1, Math.ceil(totalSeconds / segmentSeconds));
  // ffmpeg's segment muxer merges sub-`-segment_time_delta` (default 0.2s)
  // remainders into the previous segment instead of writing a stub file —
  // a phantom trailing EXTINF would make players fetch a segment that never
  // exists and wedge the loader queue. Drop ghosts under half a second.
  if (segmentCount > 1 && totalSeconds - (segmentCount - 1) * segmentSeconds < 0.5) {
    segmentCount--;
  }
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${segmentSeconds}`,
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXT-X-MEDIA-SEQUENCE:${startSegment}`,
  ];
  for (let i = startSegment; i < segmentCount; i++) {
    const remaining = totalSeconds - i * segmentSeconds;
    const dur = Math.min(segmentSeconds, remaining);
    lines.push(`#EXTINF:${dur.toFixed(3)},`);
    lines.push(`segment-${i}.ts`);
  }
  lines.push("#EXT-X-ENDLIST", "");
  return lines.join("\n");
}

export interface SegmentJobInput {
  inputPath: string;
  outputDir: string;
  /** DIRECT_PLAY/REMUX never reach here — no ffmpeg process is spawned for them. */
  startSegment: number;
  segmentSeconds: number;
  videoCodec?: string;
  audioCodec?: string;
 /** Which audio stream to map (track switching) — index among audio-type streams, not absolute container index. Defaults to 0. */
  audioStreamIndex?: number;
  maxWidth?: number;
  maxHeight?: number;
  maxVideoBitrateKbps?: number;
 /** gate with needsToneMap before setting; only meaningful for TRANSCODE (real re-encode, same honest limitation as force_key_frames below). */
  toneMap?: boolean;
  /**
 * — a selected subtitle track that requires burn-in. `bitmap: true`
   * for PGS/VOBSUB/DVBSUB: decoded and composited via `overlay`. `false` for
   * text formats (ASS/SSA/SRT/VTT): rendered via libass's `subtitles` filter.
   */
  subtitleBurnIn?: { streamIndex: number; bitmap: boolean };
}

// — naive PQ/Rec.2020 -> SDR reads grey and foggy. Convert to
// scene-linear light, regrade into bt709 primaries, apply the actual tone
// curve, convert back to a display-referred bt709 signal.
const TONE_MAP_FILTERS = [
  "zscale=t=linear:npl=100",
  "format=gbrpf32le",
  "zscale=p=bt709",
  "tonemap=hable:desat=0",
  "zscale=t=bt709:m=bt709:r=tv",
  "format=yuv420p",
];

// ffmpeg filter option values split on ':' and quote on "'" — escape both so
// a real filesystem path survives being embedded inside a filtergraph string.
function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/**
 * `-f segment` muxer, not `-f hls` — the app owns playlist content (already
 * built by buildM3u8), ffmpeg only ever produces the .ts bytes.
 * `-ss` before `-i` seeks the input for a fast keyframe-aligned-ish start;
 * `-segment_start_number` keeps output filenames matching the segment index
 * the playlist already promised. `-loglevel error` keeps stderr to
 * failures only (the tail that TranscodeJob.lastError captures).
 */
export function buildFfmpegArgs(input: SegmentJobInput): string[] {
  const startSeconds = input.startSegment * input.segmentSeconds;
  const audioMap = `0:a:${input.audioStreamIndex ?? 0}?`;
  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
  if (startSeconds > 0) args.push("-ss", String(startSeconds));
  args.push("-i", input.inputPath);

  const videoFilters: string[] = [];
  if (input.toneMap) videoFilters.push(...TONE_MAP_FILTERS);
  if (input.maxWidth !== undefined || input.maxHeight !== undefined) {
    videoFilters.push(`scale='min(${input.maxWidth ?? -2},iw)':'min(${input.maxHeight ?? -2},ih)'`);
  }
  // Browsers can't decode high-bit-depth h264 — scale preserves the input
  // pix_fmt, so a 10-bit source (HEVC Main 10) would come out as h264 High
  // 10 and every MSE append would be rejected. Force 8-bit 4:2:0.
  videoFilters.push("format=yuv420p");

  if (input.subtitleBurnIn) {
    const { streamIndex, bitmap } = input.subtitleBurnIn;
    const preChain = videoFilters.length > 0 ? videoFilters.join(",") : "null";
    const graph = bitmap
      ? `[0:v]${preChain}[vpre];[vpre][0:s:${streamIndex}]overlay[vout]`
      : `[0:v]${preChain},subtitles=${escapeFilterPath(input.inputPath)}:si=${streamIndex}[vout]`;
    args.push("-filter_complex", graph, "-map", "[vout]", "-map", audioMap);
  } else {
    args.push("-map", "0:v:0", "-map", audioMap);
    if (videoFilters.length > 0) args.push("-vf", videoFilters.join(","));
  }

  args.push("-c:v", input.videoCodec ?? "libx264");
  // Live transcoding is a realtime-serving path, not a one-off rip —
  // veryfast + CRF 23 keeps the first segment on screen in seconds. The
  // cap below (when provided) bounds the bitrate; without a cap CRF 23 is
  // the speed/quality tradeoff instead.
  args.push("-preset", "veryfast", "-crf", "23");
  if (input.maxVideoBitrateKbps !== undefined) {
    args.push("-maxrate", `${input.maxVideoBitrateKbps}k`, "-bufsize", `${input.maxVideoBitrateKbps * 2}k`);
  }
  args.push("-c:a", input.audioCodec ?? "aac");
  // Deterministic segment boundaries — only meaningful when re-encoding,
  // which is exactly the branch this is in.
  args.push("-force_key_frames", `expr:gte(t,n_forced*${input.segmentSeconds})`);
  // Matroska sources (fansubs) can carry dozens of streams; without a big
  // muxer queue a temporarily-full packet buffer aborts the whole job
  // mid-episode ("Too many packets buffered") — classic mid-playback stall.
  args.push("-max_muxing_queue_size", "4096");

  args.push(
    "-f",
    "segment",
    "-segment_time",
    String(input.segmentSeconds),
    "-segment_start_number",
    String(input.startSegment),
    "-reset_timestamps",
    "1",
    path.join(input.outputDir, "segment-%d.ts"),
  );

  return args;
}
