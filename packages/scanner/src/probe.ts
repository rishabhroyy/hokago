import { execFile } from "node:child_process";
import { open, type FileHandle } from "node:fs/promises";
import { trackPid, untrackPid } from "./child-registry.js";

/** Like promisify(execFile), but registers the child's PID so a worker's SIGTERM handler can reap it . */
export function execFileAsync(
  file: string,
  args: string[],
  options: { maxBuffer?: number; cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (err, stdout, stderr) => {
      untrackPid(child.pid);
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
    trackPid(child.pid);
  });
}

export interface AttachedPic {
  streamIndex: number;
  codec: string | null;
}

export type StreamKind = "VIDEO" | "AUDIO" | "SUBTITLE" | "ATTACHMENT" | "DATA";

export interface HdrMasteringDisplay {
  redX: number | null;
  redY: number | null;
  greenX: number | null;
  greenY: number | null;
  blueX: number | null;
  blueY: number | null;
  whitePointX: number | null;
  whitePointY: number | null;
  minLuminance: number | null;
  maxLuminance: number | null;
}

export interface HdrContentLightLevel {
  maxContent: number | null;
  maxAverage: number | null;
}

/** Gate for the tone-map chain: present only for PQ/HLG streams, null (and skipped) for SDR. */
export interface HdrMeta {
  colorPrimaries: string | null;
  transfer: string | null;
  matrix: string | null;
  masteringDisplay: HdrMasteringDisplay | null;
  contentLightLevel: HdrContentLightLevel | null;
  dv?: boolean;
}

export interface ProbedStream {
  index: number;
  type: StreamKind;
  codec: string | null;
  profile: string | null;
  lang: string | null;
  title: string | null;
  channels: number | null;
  sampleRate: number | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  bitDepth: number | null;
  isDefault: boolean;
  isForced: boolean;
  isHearingImpaired: boolean;
  hdrMeta: HdrMeta | null;
  attachmentFilename: string | null;
  attachmentMimetype: string | null;
}

export interface ProbeResult {
  durationMs: number | null;
  container: string | null;
  bitrate: number | null;
  tags: Record<string, string>;
  attachedPics: AttachedPic[];
  streams: ProbedStream[];
}

interface FfprobeStream {
  index: number;
  codec_name?: string;
  codec_type?: string;
  profile?: string;
  disposition?: Record<string, number>;
  tags?: Record<string, string>;
  channels?: number;
  sample_rate?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  pix_fmt?: string;
  color_primaries?: string;
  color_transfer?: string;
  color_space?: string;
  codec_tag_string?: string;
}

interface FfprobeOutput {
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
    tags?: Record<string, string>;
  };
  streams?: FfprobeStream[];
}

interface FfprobeSideData {
  side_data_type?: string;
  red_x?: string;
  red_y?: string;
  green_x?: string;
  green_y?: string;
  blue_x?: string;
  blue_y?: string;
  white_point_x?: string;
  white_point_y?: string;
  min_luminance?: string;
  max_luminance?: string;
  max_content?: number;
  max_average?: number;
}

interface FfprobeFramesOutput {
  frames?: { stream_index: number; side_data_list?: FfprobeSideData[] }[];
}

// PQ (HDR10/HDR10+/Dolby Vision base layer) and HLG transfer characteristics.
// Anything else (bt709, smpte170m, ...) is SDR and must skip the tone-map
// chain entirely — this set is the gate.
const HDR_TRANSFER_CHARACTERISTICS = new Set(["smpte2084", "arib-std-b67"]);

function parseFraction(s: string | undefined): number | null {
  if (!s) return null;
  const [n, d] = s.split("/").map(Number);
  if (!d || Number.isNaN(n) || Number.isNaN(d)) return null;
  return n / d;
}

function bitDepthFromPixFmt(pixFmt: string | undefined): number | null {
  if (!pixFmt) return null;
  const m = /(\d+)(?:le|be)$/.exec(pixFmt);
  return m ? Number(m[1]) : 8;
}

function mapStreamType(codecType: string | undefined): StreamKind | null {
  switch (codecType) {
    case "video":
      return "VIDEO";
    case "audio":
      return "AUDIO";
    case "subtitle":
      return "SUBTITLE";
    case "attachment":
      return "ATTACHMENT";
    case "data":
      return "DATA";
    default:
      return null;
  }
}

/**
 * Mastering display metadata and content light level only surface via a
 * frame-level decode, not -show_streams — a narrow second ffprobe call reads
 * just the first frame of each video stream (HDR appendix).
 * Degrades to an empty map on failure, never throws ("degrade, never error").
 */
async function probeHdrSideData(filePath: string, hasVideo: boolean): Promise<Map<number, FfprobeSideData[]>> {
  const result = new Map<number, FfprobeSideData[]>();
  if (!hasVideo) return result;
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_frames", "-read_intervals", "%+#1", "-select_streams", "v", filePath],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    const parsed: FfprobeFramesOutput = JSON.parse(stdout);
    for (const frame of parsed.frames ?? []) {
      if (frame.side_data_list) result.set(frame.stream_index, frame.side_data_list);
    }
  } catch {
    // no HDR side data — SDR gate below correctly sees hdrMeta stay null
  }
  return result;
}

function buildHdrMeta(stream: FfprobeStream, sideData: FfprobeSideData[]): HdrMeta | null {
  const transfer = stream.color_transfer ?? null;
  if (!transfer || !HDR_TRANSFER_CHARACTERISTICS.has(transfer)) return null;

  const mastering = sideData.find((sd) => sd.side_data_type === "Mastering display metadata");
  const cll = sideData.find((sd) => sd.side_data_type === "Content light level metadata");
  const dv =
    sideData.some((sd) => sd.side_data_type?.includes("DOVI")) ||
    /^dv(h|a)[e1]/.test(stream.codec_tag_string ?? "");

  const masteringDisplay: HdrMasteringDisplay | null = mastering
    ? {
        redX: parseFraction(mastering.red_x),
        redY: parseFraction(mastering.red_y),
        greenX: parseFraction(mastering.green_x),
        greenY: parseFraction(mastering.green_y),
        blueX: parseFraction(mastering.blue_x),
        blueY: parseFraction(mastering.blue_y),
        whitePointX: parseFraction(mastering.white_point_x),
        whitePointY: parseFraction(mastering.white_point_y),
        minLuminance: parseFraction(mastering.min_luminance),
        maxLuminance: parseFraction(mastering.max_luminance),
      }
    : null;

  const contentLightLevel: HdrContentLightLevel | null = cll
    ? { maxContent: cll.max_content ?? null, maxAverage: cll.max_average ?? null }
    : null;

  return {
    colorPrimaries: stream.color_primaries ?? null,
    transfer,
    matrix: stream.color_space ?? null,
    masteringDisplay,
    contentLightLevel,
    ...(dv ? { dv: true } : {}),
  };
}

/** Pure gate for the tone-map chain — SDR (hdrMeta null) skips it entirely. */
export function needsToneMap(hdrMeta: HdrMeta | null): boolean {
  return hdrMeta !== null;
}

// ── MP4 track-name fallback ──────────────────────────────────────────────
// ffprobe's mov demuxer reads `©nam` into stream tags but ignores the 3GPP
// `udta/name` box that HandBrake-style muxers write for track titles
// (video "Default", audio "Japanese", subs "English (US)") — and a 0x7fff
// mdhd language means no `language` tag either, so those tracks would
// surface to the UI with no label at all. Walk the moov atom tree ourselves
// as a fallback: pure buffer walk, bounded (moov is small metadata, mdat is
// seek-skipped), and any failure degrades to "no names" — never an error.
const MP4_MAX_MOOV_BYTES = 64 * 1024 * 1024;

function decodeMp4Name(payload: Buffer): string | null {
  if (payload.length === 0) return null;
  // 3GPP `name` is a NUL-terminated UTF-8 string; tolerate padding.
  let end = payload.length;
  while (end > 0 && (payload[end - 1] === 0 || payload[end - 1] === 32 || payload[end - 1] === 9)) end--;
  const text = payload.subarray(0, end).toString("utf8").trim();
  return text.length > 0 ? text : null;
}

/** Visit every box in `buf[start..end)`; boxes with a 64-bit extended size are skipped via their header. */
function walkMp4Atoms(buf: Buffer, start: number, end: number, visit: (type: string, payload: Buffer) => void): void {
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    let payloadStart = off + 8;
    if (size === 1) {
      if (off + 16 > end) return;
      const ext = buf.readBigUInt64BE(off + 8);
      if (ext > BigInt(end) - BigInt(off)) return;
      size = Number(ext);
      payloadStart = off + 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < 8 || off + size > end) return;
    visit(type, buf.subarray(payloadStart, off + size));
    off += size;
  }
}

/**
 * Read the per-track `moov/trak/udta/name` titles of an MP4/MOV file. The
 * k-th `trak` box corresponds to the demuxer's k-th stream index (the mov
 * demuxer assigns stream indexes in trak order), so the map is keyed by the
 * ffprobe stream index. Returns an empty map on any failure — never throws.
 */
export async function readMp4TrackNames(filePath: string): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  let handle: FileHandle | null = null;
  try {
    handle = await open(filePath, "r");
    const fileSize = (await handle.stat()).size;

    // Walk top-level atoms; mdat and friends are skipped by seeking, so the
    // cost is one 8-byte header read per atom plus one bounded moov read.
    for (let off = 0; off + 8 <= fileSize; ) {
      const header = Buffer.alloc(8);
      const { bytesRead } = await handle.read(header, 0, 8, off);
      if (bytesRead < 8) break;
      let atomSize = header.readUInt32BE(0);
      const atomType = header.toString("latin1", 4, 8);
      let payloadOffset = off + 8;
      if (atomSize === 1) {
        const ext = Buffer.alloc(8);
        const { bytesRead: extRead } = await handle.read(ext, 0, 8, off + 8);
        if (extRead < 8) break;
        const extSize = ext.readBigUInt64BE(0);
        if (extSize > BigInt(fileSize - off)) break;
        atomSize = Number(extSize);
        payloadOffset = off + 16;
      } else if (atomSize === 0) {
        atomSize = fileSize - off;
      }
      if (atomSize < 8 || off + atomSize > fileSize) break;

      if (atomType === "moov") {
        const moovSize = atomSize - (payloadOffset - off);
        if (moovSize > 0 && moovSize <= MP4_MAX_MOOV_BYTES) {
          const moov = Buffer.alloc(moovSize);
          const { bytesRead: moovRead } = await handle.read(moov, 0, moovSize, payloadOffset);
          if (moovRead === moovSize) {
            let trakIndex = 0;
            walkMp4Atoms(moov, 0, moovSize, (type, payload) => {
              if (type !== "trak") return;
              let name: string | null = null;
              walkMp4Atoms(payload, 0, payload.length, (t2, p2) => {
                if (t2 !== "udta") return;
                walkMp4Atoms(p2, 0, p2.length, (t3, p3) => {
                  if (t3 === "name") name ??= decodeMp4Name(p3);
                });
              });
              if (name) names.set(trakIndex, name);
              trakIndex++;
            });
          }
        }
        break;
      }

      off += atomSize;
    }
  } catch {
    // degrade, never error
  } finally {
    await handle?.close().catch(() => {});
  }
  return names;
}

/** Returns null on probe failure — caller sets MediaFile.probeFailed, never throws the pipeline off course ("degrade, never error"). */
export async function probeFile(filePath: string): Promise<ProbeResult | null> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    const parsed: FfprobeOutput = JSON.parse(stdout);

    const durationSec = parsed.format?.duration ? Number.parseFloat(parsed.format.duration) : null;
    const bitrate = parsed.format?.bit_rate ? Number.parseInt(parsed.format.bit_rate, 10) : null;

    const tags: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.format?.tags ?? {})) {
      tags[key.toLowerCase()] = value;
    }

    const rawStreams = parsed.streams ?? [];

    const attachedPics: AttachedPic[] = rawStreams
      .filter((s) => s.disposition?.attached_pic === 1)
      .map((s) => ({ streamIndex: s.index, codec: s.codec_name ?? null }));

    const hasVideo = rawStreams.some((s) => s.codec_type === "video");
    const sideDataByIndex = await probeHdrSideData(filePath, hasVideo);

    // ffprobe's mov demuxer ignores 3GPP `udta/name` track titles (HandBrake
    // writes "Japanese"/"English (US)" there, mdhd language stays 0x7fff) —
    // backfill stream titles from the atom tree for mp4-family containers.
    const mp4TrackNames = (parsed.format?.format_name ?? "").includes("mov")
      ? await readMp4TrackNames(filePath)
      : new Map<number, string>();

    const streams: ProbedStream[] = rawStreams
      .map((s): ProbedStream | null => {
        const type = mapStreamType(s.codec_type);
        if (!type) return null;
        return {
          index: s.index,
          type,
          codec: s.codec_name ?? null,
          profile: s.profile ?? null,
          lang: s.tags?.language ?? null,
          title: s.tags?.title ?? mp4TrackNames.get(s.index) ?? null,
          channels: s.channels ?? null,
          sampleRate: s.sample_rate ? Number.parseInt(s.sample_rate, 10) : null,
          width: s.width ?? null,
          height: s.height ?? null,
          frameRate: type === "VIDEO" ? parseFraction(s.r_frame_rate) : null,
          bitDepth: type === "VIDEO" ? bitDepthFromPixFmt(s.pix_fmt) : null,
          isDefault: s.disposition?.default === 1,
          isForced: s.disposition?.forced === 1,
          isHearingImpaired: s.disposition?.hearing_impaired === 1,
          hdrMeta: type === "VIDEO" ? buildHdrMeta(s, sideDataByIndex.get(s.index) ?? []) : null,
          attachmentFilename: type === "ATTACHMENT" ? (s.tags?.filename ?? null) : null,
          attachmentMimetype: type === "ATTACHMENT" ? (s.tags?.mimetype ?? null) : null,
        };
      })
      .filter((s): s is ProbedStream => s !== null);

    return {
      durationMs: durationSec !== null && !Number.isNaN(durationSec) ? Math.round(durationSec * 1000) : null,
      container: parsed.format?.format_name ?? null,
      bitrate,
      tags,
      attachedPics,
      streams,
    };
  } catch {
    return null;
  }
}

/** Extracts one attached-picture stream to a JPEG file on disk. */
export async function extractAttachedPic(filePath: string, streamIndex: number, outPath: string): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-i",
    filePath,
    "-map",
    `0:${streamIndex}`,
    "-frames:v",
    "1",
    outPath,
  ]);
}
