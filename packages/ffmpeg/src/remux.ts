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
import fs from "node:fs";

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
  /** Source video codec (ffprobe name). `-tag:v` must match the copied stream's codec — hvc1 only exists for HEVC. */
  videoCodec?: string | null;
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
  // Only for HEVC — forcing it on an H.264 copy makes ffmpeg abort at header
  // write (`Tag hvc1 incompatible with output codec id '27' (avc1)`).
  if (input.videoCodec === "hevc" || input.videoCodec === "h265") {
    args.push("-tag:v", "hvc1");
  }
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

/**
 * Inserts a `mehd` (movie-extends header) box as the first child of `mvex` in
 * the moov of a fragmented MP4, so players know the full duration up-front
 * instead of inferring it from the fragments downloaded so far. Without it a
 * REMUX stream's duration tracks the written frontier — on a slow connection
 * Chrome shows e.g. 8 minutes of a 24-minute episode and the seek bar lies.
 *
 * ffmpeg's mp4 muxer has no mehd output flag (upstream `write_moov_mehd`
 * exists only in forks), so this is a binary patch: moov grows by 20 bytes,
 * the file tail is shifted in place by a backward chunked copy. Idempotent —
 * no-op when mehd is already present. Must be re-run after a seek-restart
 * rewrites the file. Never throws on a corrupt/unexpected structure; returns
 * false so callers can serve the unpatched file rather than fail playback.
 */
export function patchRemuxMehd(filePath: string, durationMs: number, startMs: number): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r+");
    const fileSize = fs.fstatSync(fd).size;
    // 1MB head: moov is written up front (empty_moov) right after ftyp, and
    // with large cover-art attachments or many tracks it can grow well past
    // a 256KB read.
    const head = Buffer.alloc(Math.min(fileSize, 1024 * 1024));
    const read = fs.readSync(fd, head, 0, head.length, 0);
    const buf = head.subarray(0, read);

    let moovStart = -1;
    let o = 0;
    while (o + 8 <= buf.length) {
      const size = buf.readUInt32BE(o);
      if (buf.toString("latin1", o + 4, o + 8) === "moov") {
        moovStart = o;
        break;
      }
      if (size < 8 || o + size > buf.length) break;
      o += size;
    }
    if (moovStart < 0) return false;
    const moovSize = buf.readUInt32BE(moovStart);
    if (moovStart + moovSize > buf.length) return false;

    let mvexStart = -1;
    let mvhdPayloadStart = -1;
    let p = moovStart + 8;
    while (p + 8 <= moovStart + moovSize) {
      const size = buf.readUInt32BE(p);
      const type = buf.toString("latin1", p + 4, p + 8);
      if (type === "mvex") mvexStart = p;
      if (type === "mvhd") mvhdPayloadStart = p + 8;
      if (size < 8 || p + size > moovStart + moovSize) break;
      p += size;
    }
    if (mvexStart < 0 || mvhdPayloadStart < 0) return false;

    const mvexChildStart = mvexStart + 8;
    if (mvexChildStart + 8 <= moovStart + moovSize) {
      const firstSize = buf.readUInt32BE(mvexChildStart);
      if (firstSize >= 8 && buf.toString("latin1", mvexChildStart + 4, mvexChildStart + 8) === "mehd") {
        return true;
      }
    }

    const version = buf.readUInt8(mvhdPayloadStart);
    // mvhd payload: version+flags(4), then (v0: creation+mod u32 each; v1:
    // u64 each), then timescale(4). Duration is in movie timescale units.
    const timescale =
      version === 1
        ? buf.readUInt32BE(mvhdPayloadStart + 4 + 8 + 8)
        : buf.readUInt32BE(mvhdPayloadStart + 4 + 4 + 4);
    const duration = Math.round(((durationMs - startMs) / 1000) * timescale);

    const mehd = Buffer.alloc(20);
    mehd.writeUInt32BE(20, 0);
    mehd.write("mehd", 4, "latin1");
    mehd.writeUInt32BE(0x01000000, 8); // version 1 (u64 duration), flags 0
    mehd.writeBigUInt64BE(BigInt(duration), 12);

    // Shift [mvexChildStart, EOF) forward by 20 — backward so chunks being
    // read are never overwritten before they're read.
    const delta = mehd.length;
    const chunk = Buffer.alloc(1024 * 1024);
    let pos = fileSize;
    while (pos > mvexChildStart) {
      const len = Math.min(chunk.length, pos - mvexChildStart);
      const from = pos - len;
      fs.readSync(fd, chunk, 0, len, from);
      fs.writeSync(fd, chunk, 0, len, from + delta);
      pos = from;
    }
    fs.writeSync(fd, mehd, 0, delta, mvexChildStart);

    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeUInt32BE(moovSize + delta, 0);
    fs.writeSync(fd, sizeBuf, 0, 4, moovStart);
    sizeBuf.writeUInt32BE(buf.readUInt32BE(mvexStart) + delta, 0);
    fs.writeSync(fd, sizeBuf, 0, 4, mvexStart);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
