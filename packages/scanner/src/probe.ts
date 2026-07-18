import { execFile } from "node:child_process";
import { trackPid, untrackPid } from "./child-registry.js";

/** Like promisify(execFile), but registers the child's PID so a worker's SIGTERM handler can reap it (§9.6.4). */
function execFileAsync(
  file: string,
  args: string[],
  options: { maxBuffer?: number } = {},
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

export interface ProbeResult {
  durationMs: number | null;
  container: string | null;
  bitrate: number | null;
  tags: Record<string, string>;
  attachedPics: AttachedPic[];
}

interface FfprobeStream {
  index: number;
  codec_name?: string;
  disposition?: Record<string, number>;
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

    const attachedPics: AttachedPic[] = (parsed.streams ?? [])
      .filter((s) => s.disposition?.attached_pic === 1)
      .map((s) => ({ streamIndex: s.index, codec: s.codec_name ?? null }));

    return {
      durationMs: durationSec !== null && !Number.isNaN(durationSec) ? Math.round(durationSec * 1000) : null,
      container: parsed.format?.format_name ?? null,
      bitrate,
      tags,
      attachedPics,
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
