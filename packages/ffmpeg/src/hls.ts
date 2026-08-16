import path from "node:path";

import { hwDecodeArgs, hwEncodeFilterTail, hwEncodeInitArgs, hwEncodeQualityArgs, type HwaccelState } from "./hwaccel.js";

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

/**
 * Rewrites a playlist to only the segments that actually exist on disk after
 * a transcode dies (crash, kill on quality switch, session end). The full
 * VOD playlist advertises the whole future up front; if the encoder stops,
 * the unwritten tail would have clients retry segment-N forever and stall at
 * the last surviving segment's boundary. Truncating to `lastSegment` (the
 * highest written segment file) plus ENDLIST makes players surface the real
 * end instead of hanging. When nothing was written yet, emit an empty
 * playlist so the player errors out loudly rather than wedging.
 */
export function buildTruncatedM3u8(
  durationMs: number,
  segmentSeconds: number,
  startSegment: number,
  lastSegment: number,
): string {
  const totalSeconds = durationMs / 1000;
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${segmentSeconds}`,
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXT-X-MEDIA-SEQUENCE:${startSegment}`,
  ];
  if (lastSegment >= startSegment) {
    for (let i = startSegment; i <= lastSegment; i++) {
      const remaining = totalSeconds - i * segmentSeconds;
      const dur = Math.min(segmentSeconds, Math.max(0.5, remaining));
      lines.push(`#EXTINF:${dur.toFixed(3)},`);
      lines.push(`segment-${i}.ts`);
    }
  }
  lines.push("#EXT-X-ENDLIST", "");
  return lines.join("\n");
}

export interface SegmentJobInput {
  inputPath: string;
  outputDir: string;
  /** DIRECT_PLAY never reaches here — no ffmpeg process is spawned for it. */
  startSegment: number;
  segmentSeconds: number;
  /**
   * The exact input timestamp the output must begin at (media-absolute ms).
   * Applied as an ACCURATE seek (`-ss` after `-i`): ffmpeg demuxes up to the
   * target and discards everything before it, so the first output frame is
   * exactly the frame at (or just after) this timestamp — no keyframe
   * requirement, no reliance on the container's seek table. The client's
   * reported timeline offset (actualStartMs) therefore equals the browser's
   * timeline origin with zero drift, whatever the source container.
   * Without it (one-off tooling) the -ss point is derived from the segment
   * grid as before.
   */
  seekMs?: number;
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
  /**
   * Resolved hardware acceleration state — when active, the decode runs on
   * the GPU, frames are downloaded to system memory (the CPU filter chain
   * below is untouched), and vaapi/qsv upload back to the encoder. Omit for
   * a pure software encode. Callers must NOT hand over a state that was
   * already disabled by reportHwFailure — pickVideoEncoder handles the
   * encoder, this only affects flags.
   */
  hwaccel?: HwaccelState;
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
 * `-ss` AFTER `-i` is an ACCURATE seek: ffmpeg demuxes to the target and
 * discards everything before it, so the output begins at the exact requested
 * input timestamp — frame-exact by construction, independent of the
 * container's seek table (which can land at a different keyframe than the
 * bitstream probe reports, drifting the client's timeline offset by the whole
 * keyframe gap) and of source B-frames/audio priming. The muxer normalizes
 * the output timeline to ~0, so the client's offset (actualStartMs) matches
 * the browser timeline origin with zero drift.
 * `-segment_start_number` keeps output filenames matching the segment index
 * the playlist already promised. `-loglevel error` keeps stderr to
 * failures only (the tail that TranscodeJob.lastError captures).
 */
/**
 * Full-GPU (residual-frame) path for nvenc — the pipeline that makes a GPU
 * transcode actually fast. Default nvenc mode decodes on the GPU but
 * downloads every frame to system memory (`-hwaccel_output_format nv12`),
 * runs scale/format on the CPU, then uploads again for the encoder: a 4K→1080p
 * transcode pays a CPU resize plus two PCIe round-trips per frame, which is
 * exactly the "GPU should be fast but transcoding is slow" report. NVIDIA's
 * documented fast path keeps the frames on-GPU end-to-end: decode with
 * `-hwaccel_output_format cuda`, scale + 10→8-bit conversion via NPP's
 * scale_npp, straight into h264_nvenc (which consumes CUDA frames directly).
 *
 * Gated to the cases where nothing forces a CPU stage: no tone map (the
 * zscale chain needs system frames) and no subtitle burn-in (libass /
 * overlay also run on CPU). Anything else keeps the existing nv12-download
 * pipeline, same as vaapi/qsv — and a runtime failure on this path falls
 * back to CPU via the usual reportHwFailure retry, so the worst case is the
 * behavior we have today.
 */
export function buildFfmpegArgs(input: SegmentJobInput): string[] {
  // True only for the nvenc residual path: hardware decode, GPU-resident
  // scale, no CPU-only stage — frames never leave video memory.
  const gpuResidentNvenc =
    input.hwaccel?.method === "nvenc" &&
    !input.toneMap &&
    !input.subtitleBurnIn &&
    input.maxWidth !== undefined &&
    input.maxHeight !== undefined;
  const startSeconds = input.seekMs !== undefined ? input.seekMs / 1000 : input.startSegment * input.segmentSeconds;
  const audioMap = `0:a:${input.audioStreamIndex ?? 0}?`;
  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
  // hw init devices first (the named device the upload filters reference),
  // then the hw decode flags that also carry the -i argument. nvenc needs no
  // init device; the residual path keeps decoded frames in GPU memory.
  if (input.hwaccel) {
    if (gpuResidentNvenc) {
      args.push("-hwaccel", "cuda", "-hwaccel_output_format", "cuda");
    } else {
      args.push(...hwEncodeInitArgs(input.hwaccel), ...hwDecodeArgs(input.hwaccel));
    }
  }
  args.push("-i", input.inputPath);
  // Accurate seek. A 100ms trim on a fresh start (seekMs absent → segment
  // grid ~0) drops the source pre-roll (leading keyframe lands ~1.4s in
  // while audio starts at 0) without the garbage frames reaching the player;
  // every seeked start lands on the exact target instead.
  if (startSeconds <= 0.1) args.push("-ss", "0.1");
  else args.push("-ss", String(startSeconds));

  const videoFilters: string[] = [];
  if (input.toneMap) videoFilters.push(...TONE_MAP_FILTERS);
  if (gpuResidentNvenc) {
    // Same min() semantics as the CPU scale below, evaluated in the GPU
    // device context instead. format=nv12 makes NPP convert 10-bit sources
    // (HEVC Main 10) to 8-bit 4:2:0 on-GPU — the 10→8-bit step the CPU path
    // does via format=yuv420p. Odd-dimension sources fail here and ride the
    // hw→CPU fallback; every real-world resolution is even. The w/h
    // expressions resolve once at init (eval=init default).
    videoFilters.push(
      `scale_npp=w='min(${input.maxWidth},iw)':h='min(${input.maxHeight},ih)':format=nv12`,
    );
  } else if (input.maxWidth !== undefined || input.maxHeight !== undefined) {
    videoFilters.push(`scale='min(${input.maxWidth ?? -2},iw)':'min(${input.maxHeight ?? -2},ih)'`);
  }
  // Browsers can't decode high-bit-depth h264 — scale preserves the input
  // pix_fmt, so a 10-bit source (HEVC Main 10) would come out as h264 High
  // 10 and every MSE append would be rejected. Force 8-bit 4:2:0. Skipped on
  // the residual nvenc path: scale_npp's format=nv12 already did the 10→8-bit
  // conversion on-GPU, and `format` can't touch CUDA frames anyway.
  if (!gpuResidentNvenc) videoFilters.push("format=yuv420p");
  // hw encoders take hw-frames (vaapi/qsv): upload the filtered CPU frames
  // at the end of the chain. nvenc accepts system frames — no tail.
  const hwTail = input.hwaccel ? hwEncodeFilterTail(input.hwaccel) : [];
  if (hwTail.length > 0) videoFilters.push(...hwTail);

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

  args.push("-c:v", input.videoCodec ?? "libx264");
  // Live transcoding is a realtime-serving path, not a one-off rip —
  // veryfast + CRF 23 keeps the first segment on screen in seconds. The
  // cap below (when provided) bounds the bitrate; without a cap CRF 23 is
  // the speed/quality tradeoff instead. Hardware encoders get their own
  // equivalent options (hwEncodeQualityArgs) — libx264's preset/crf set is
  // rejected by vaapi/qsv/nvenc outright.
  const hwQuality = input.hwaccel ? hwEncodeQualityArgs(input.hwaccel, input.maxVideoBitrateKbps) : null;
  if (hwQuality) args.push(...hwQuality);
  else args.push("-preset", "veryfast", "-crf", "23");
  // No B-frames: the B-frame reorder puts a pts/dts skew on every keyframe,
  // which the mpegts muxer propagates as a small lead on every segment. With
  // dts == pts the segments stay exactly flush (6.006s spacing, no lead).
  args.push("-bf", "0");
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
    // The mpegts muxer adds a ~1.5s lead on the first packet (PAT/PMT/PCR
    // interleaving at the default muxdelay) — every segment would carry that
    // offset, hls.js's remuxer flags fragments as overlapping the previous
    // timeline, appends land in gapped ranges, and the playhead stalls at
    // each gap. Zero muxdelay writes packets as they encode.
    //
    // Deliberately NO -reset_timestamps: resetting makes every segment start
    // at 0, and hls.js normalizes a sub-1s first sample against the playlist
    // offset by adding 2^33 (33-bit PTS rollover guard) — the whole timeline
    // then sits ~95443.7s off, the per-fragment overlap compensation
    // compresses it (a 24-min episode ends up ~7 min long) and playback ends
    // at the compressed end. Continuous absolute PTS across segments keeps
    // every fragment flush with the running timeline instead.
    "-muxdelay",
    "0",
    path.join(input.outputDir, "segment-%d.ts"),
  );

  return args;
}
