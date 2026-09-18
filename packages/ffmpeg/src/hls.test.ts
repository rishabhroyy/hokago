import assert from "node:assert/strict";
import { test } from "node:test";

import { buildFfmpegArgs, buildM3u8, type SegmentJobInput } from "./hls.js";
import type { HwaccelState } from "./hwaccel.js";

const nvencHwaccel: HwaccelState = {
  requested: "auto",
  method: "nvenc",
  device: "0",
  available: [{ method: "nvenc", device: "0" }],
  encoders: new Set(["h264_nvenc", "hevc_nvenc", "av1_nvenc"]),
  filters: new Set(["scale_npp"]),
  decoders: new Set(["hevc_cuvid"]),
  disabledAfterFailure: false,
  note: null,
};

const baseInput: SegmentJobInput = {
  inputPath: "/media/anime/example.mkv",
  outputDir: "/tmp/out",
  startSegment: 0,
  segmentSeconds: 4,
  seekMs: 0,
  hwaccel: nvencHwaccel,
  videoCodec: "h264_nvenc",
  sourceVideoCodec: "hevc",
  bitDepth: 10,
  audioCodec: "aac",
  maxWidth: 1920,
  maxHeight: 1080,
  toneMap: false,
};

// The actual reported-bug scenario: a 10-bit HEVC source on nvenc, verified
// against real hardware (see hls.ts's nvencCuvidWorkaround comment) -- decode
// must go through the explicit hevc_cuvid decoder, not the generic hwaccel
// framework (confirmed broken for this exact combination on real hardware).
test("10-bit HEVC + nvenc + no tone-map/burn-in uses the hevc_cuvid decode workaround, still fully GPU-resident", () => {
  const args = buildFfmpegArgs(baseInput);
  assert.deepEqual(args.slice(4, 6), ["-c:v", "hevc_cuvid"]);
  assert.equal(args.includes("-hwaccel"), false);
  const vf = args[args.indexOf("-vf") + 1];
  assert.match(vf!, /^format=nv12,hwupload_cuda,scale_npp=/);
  const cIndex = args.lastIndexOf("-c:v");
  assert.equal(args[cIndex + 1], "h264_nvenc");
});

// Tone-map needs the CPU filter chain -- no verified-safe hardware
// combination exists for this, so it must fall through to full CPU rather
// than risk an untested combination corrupting output the same way.
test("10-bit HEVC + nvenc + tone-map falls back to full CPU decode and encode", () => {
  const args = buildFfmpegArgs({ ...baseInput, toneMap: true });
  assert.equal(args.includes("-hwaccel"), false);
  assert.equal(args.includes("hevc_cuvid"), false);
  const cIndex = args.lastIndexOf("-c:v");
  assert.equal(args[cIndex + 1], "libx264");
  const vf = args[args.indexOf("-vf") + 1];
  assert.match(vf!, /^zscale=/);
});

// gpuResidentNvenc's gate is symmetric across !toneMap and !subtitleBurnIn --
// this exercises the other half, since a PGS/bitmap subtitle needing burn-in
// on a 10-bit HEVC nvenc source is the other named case the CPU fallback
// exists for.
test("10-bit HEVC + nvenc + subtitle burn-in falls back to full CPU decode and encode", () => {
  const args = buildFfmpegArgs({ ...baseInput, subtitleBurnIn: { streamIndex: 0, bitmap: true } });
  assert.equal(args.includes("-hwaccel"), false);
  assert.equal(args.includes("hevc_cuvid"), false);
  assert.equal(args.includes("-vf"), false);
  assert.equal(args.includes("-filter_complex"), true);
  const cIndex = args.lastIndexOf("-c:v");
  assert.equal(args[cIndex + 1], "libx264");
});

// Same tone-map case, but the nvenc encoder itself wasn't compiled in, so
// pickVideoEncoder already resolved a software HEVC encoder -- the CPU
// fallback must not blindly remap that already-correct choice.
test("10-bit HEVC + tone-map with a non-nvenc videoCodec leaves the encoder choice untouched", () => {
  const args = buildFfmpegArgs({ ...baseInput, toneMap: true, videoCodec: "libx265" });
  const cIndex = args.lastIndexOf("-c:v");
  assert.equal(args[cIndex + 1], "libx265");
});

// hevc_cuvid missing from this ffmpeg build (--enable-cuvid and
// --enable-nvenc are independent configure flags) must not attempt the
// workaround -- that would hard-fail ffmpeg and, via attemptHwFallback,
// disable hardware acceleration process-wide for every other session.
test("10-bit HEVC + nvenc without hevc_cuvid compiled in falls back to full CPU instead of a hard failure", () => {
  const args = buildFfmpegArgs({ ...baseInput, hwaccel: { ...nvencHwaccel, decoders: new Set() } });
  assert.equal(args.includes("hevc_cuvid"), false);
  assert.equal(args.includes("-hwaccel"), false);
  const cIndex = args.lastIndexOf("-c:v");
  assert.equal(args[cIndex + 1], "libx264");
});

// 8-bit HEVC is unaffected -- the pre-existing gpuResidentNvenc scale_npp
// path (not the new hevc_cuvid workaround) still applies unchanged.
test("8-bit HEVC + nvenc still uses the original gpuResidentNvenc scale_npp path", () => {
  const args = buildFfmpegArgs({ ...baseInput, bitDepth: 8 });
  assert.deepEqual(args.slice(4, 8), ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]);
  assert.equal(args.includes("hevc_cuvid"), false);
  const vf = args[args.indexOf("-vf") + 1];
  assert.match(vf!, /^scale_npp=/);
});

// A plain h264 source (not HEVC) at any bit depth is unaffected -- the
// workaround is scoped to the specific codec it was verified against.
test("10-bit-flagged h264 source (not HEVC) is unaffected by the hevc_cuvid workaround", () => {
  const args = buildFfmpegArgs({ ...baseInput, sourceVideoCodec: "h264" });
  assert.equal(args.includes("hevc_cuvid"), false);
  assert.deepEqual(args.slice(4, 8), ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]);
});

test("buildM3u8 still produces a sane playlist (sanity check, unrelated to this fix)", () => {
  const playlist = buildM3u8(12_000, 4);
  assert.match(playlist, /#EXTM3U/);
});
