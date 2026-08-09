/**
 * REMUX ffmpeg args — the "direct stream" tier: video copied verbatim into a
 * fragmented MP4, audio copied when the codec is MP4-safe or re-encoded to
 * AAC otherwise. The browser plays the file with native <video> (hardware
 * decode, e.g. HEVC Main 10 on macOS) and does its own seeking via range
 * requests; there is no HLS/MSE involved, which is precisely why 10-bit HEVC
 * works here when MSE rejects it.
 *
 * Fragmented output (`empty_moov` + `frag_keyframe`): the moov box is written
 * up front and fragments append as the file grows, so <video> can open and
 * play a file that ffmpeg is still writing — the progressive-playback trick
 * media servers use to start streaming a remux within a second.
 */

import path from "node:path";

/** Codecs MP4-safe for Chrome/Safari/Firefox — copied verbatim, no re-encode. */
const MP4_SAFE_AUDIO = new Set(["aac", "mp3", "opus", "flac", "pcm_s16le"]);

export interface RemuxJobInput {
  inputPath: string;
  outputPath: string;
  /** Wall-clock seek target (ms) — input-side `-ss` lands on the keyframe at-or-before it, so the file starts there. */
  startMs: number;
  /** Which audio stream to map (track switching) — index among audio-type streams, not absolute container index. */
  audioStreamIndex?: number;
  /** Remux only carries the video — the muxer must know where the file ends or it runs past the media end. */
  durationMs: number;
  audioCodec?: string | null;
}

export function buildRemuxArgs(input: RemuxJobInput): string[] {
  const startSeconds = input.startMs / 1000;
  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
  if (startSeconds > 0) args.push("-ss", String(startSeconds));
  args.push("-i", input.inputPath);

  args.push("-map", "0:v:0", "-map", `0:a:${input.audioStreamIndex ?? 0}?`);
  args.push("-c:v", "copy");
  // hvc1 (not hev1) is the tag Chrome/Safari's native demuxer recognizes for
  // HEVC-in-MP4; Matroska carries hev1-style NALs, so the remuxer must retag.
  args.push("-tag:v", "hvc1");
  args.push("-c:a", input.audioCodec && MP4_SAFE_AUDIO.has(input.audioCodec) ? "copy" : "aac");
  args.push("-movflags", "+empty_moov+frag_keyframe+default_base_moof", "-f", "mp4");
  // Remux only carries the video — without an end cap the muxer runs past the
  // media end into a dead stream. Omit when the duration is unknown rather
  // than capping at a bogus 1s (durationMs 0 = unknown, not "one second").
  if (input.durationMs > 0) {
    args.push("-t", String(Math.max(1, input.durationMs / 1000 - startSeconds)));
  }
  args.push(path.join(input.outputPath));

  return args;
}
