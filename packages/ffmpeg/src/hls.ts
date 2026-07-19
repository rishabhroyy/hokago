import path from "node:path";

/**
 * Full VOD playlist generated upfront (§11.2) — the client sees the whole
 * video as ready-to-seek immediately, even though most segment files don't
 * exist on disk yet. Segments are produced on request by whatever route
 * serves segment-N.ts; this function only ever describes the shape.
 */
export function buildM3u8(durationMs: number, segmentSeconds: number): string {
  const totalSeconds = durationMs / 1000;
  const segmentCount = Math.max(1, Math.ceil(totalSeconds / segmentSeconds));
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${segmentSeconds}`,
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-MEDIA-SEQUENCE:0",
  ];
  for (let i = 0; i < segmentCount; i++) {
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
  /** DIRECT_PLAY never reaches here — no ffmpeg process is spawned for it. */
  method: "DIRECT_STREAM" | "TRANSCODE";
  /** Which segment index to start producing from — seek-restart target (§11.2). */
  startSegment: number;
  segmentSeconds: number;
  videoCodec?: string;
  audioCodec?: string;
  maxWidth?: number;
  maxHeight?: number;
  maxVideoBitrateKbps?: number;
  /** §11.3 — gate with needsToneMap() before setting; only meaningful for TRANSCODE (real re-encode, same honest limitation as force_key_frames below). */
  toneMap?: boolean;
  /**
   * §13.4 — a selected subtitle track that requires burn-in. `bitmap: true`
   * for PGS/VOBSUB/DVBSUB: decoded and composited via `overlay`. `false` for
   * text formats (ASS/SSA/SRT/VTT): rendered via libass's `subtitles` filter.
   */
  subtitleBurnIn?: { streamIndex: number; bitmap: boolean };
}

// §11.3 — naive PQ/Rec.2020 -> SDR reads grey and foggy. Convert to
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
 * built by buildM3u8), ffmpeg only ever produces the .ts bytes (§11.2).
 * `-ss` before `-i` seeks the input for a fast keyframe-aligned-ish start;
 * `-segment_start_number` keeps output filenames matching the segment index
 * the playlist already promised.
 */
export function buildFfmpegArgs(input: SegmentJobInput): string[] {
  const startSeconds = input.startSegment * input.segmentSeconds;
  const args: string[] = ["-y"];
  if (startSeconds > 0) args.push("-ss", String(startSeconds));
  args.push("-i", input.inputPath);

  if (input.method === "DIRECT_STREAM") {
    // Remux only: streams are copied verbatim, so segment boundaries land
    // wherever the source's existing keyframes are — -force_key_frames only
    // works when we control encoding, which a copy remux by definition does
    // not (honest limitation, §11.2). Same reason tone-map/burn-in can't
    // apply here either — decision.ts never selects DIRECT_STREAM when either
    // is required, so this branch never needs to carry them.
    args.push("-map", "0:v:0", "-map", "0:a:0?", "-c", "copy");
  } else {
    const videoFilters: string[] = [];
    if (input.toneMap) videoFilters.push(...TONE_MAP_FILTERS);
    if (input.maxWidth !== undefined || input.maxHeight !== undefined) {
      videoFilters.push(`scale='min(${input.maxWidth ?? -2},iw)':'min(${input.maxHeight ?? -2},ih)'`);
    }

    if (input.subtitleBurnIn) {
      const { streamIndex, bitmap } = input.subtitleBurnIn;
      const preChain = videoFilters.length > 0 ? videoFilters.join(",") : "null";
      const graph = bitmap
        ? `[0:v]${preChain}[vpre];[vpre][0:s:${streamIndex}]overlay[vout]`
        : `[0:v]${preChain},subtitles=${escapeFilterPath(input.inputPath)}:si=${streamIndex}[vout]`;
      args.push("-filter_complex", graph, "-map", "[vout]", "-map", "0:a:0?");
    } else {
      args.push("-map", "0:v:0", "-map", "0:a:0?");
      if (videoFilters.length > 0) args.push("-vf", videoFilters.join(","));
    }

    args.push("-c:v", input.videoCodec ?? "libx264");
    if (input.maxVideoBitrateKbps !== undefined) {
      args.push("-b:v", `${input.maxVideoBitrateKbps}k`);
    }
    args.push("-c:a", input.audioCodec ?? "aac");
    // Deterministic segment boundaries — only meaningful when re-encoding,
    // which is exactly the branch this is in (§11.2).
    args.push("-force_key_frames", `expr:gte(t,n_forced*${input.segmentSeconds})`);
  }

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
