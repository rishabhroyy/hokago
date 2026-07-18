import { execFile } from "node:child_process";
import { trackPid, untrackPid } from "./child-registry.js";

/** Like promisify(execFile), but registers the child's PID so a worker's SIGTERM handler can reap it (§9.6.4). */
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

/** Gate for the §11.3 tone-map chain: present only for PQ/HLG streams, null (and skipped) for SDR. */
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
// chain entirely (§11.3) — this set is the gate.
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
 * just the first frame of each video stream (§11.3, §21 HDR appendix).
 * Degrades to an empty map on failure, never throws (§3 "degrade, never error").
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

/** Pure gate for the §11.3 tone-map chain — SDR (hdrMeta null) skips it entirely. */
export function needsToneMap(hdrMeta: HdrMeta | null): boolean {
  return hdrMeta !== null;
}

/** Returns null on probe failure — caller sets MediaFile.probeFailed, never throws the pipeline off course (§3 "degrade, never error"). */
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
          title: s.tags?.title ?? null,
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
