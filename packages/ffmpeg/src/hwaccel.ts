import { execFile } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Hardware acceleration — Immich-style: zero-config by default.
 *
 * `HOKAGO_HWACCEL` (default "auto") picks the acceleration method:
 *   auto    — detect what this box has and use the best available (nvenc >
 *             qsv > vaapi); nothing found → CPU, playback always works
 *   none    — software encoding only
 *   vaapi   — Intel/AMD iGPU or dGPU via /dev/dri (renderD*)
 *   qsv     — Intel Quick Sync (also via /dev/dri, libvpl dispatch)
 *   nvenc   — NVIDIA GPU (needs the nvidia-container-toolkit at runtime)
 *
 * `HOKAGO_HWACCEL_DEVICE` overrides the detected device: a render-node path
 * for vaapi/qsv (e.g. "/dev/dri/renderD129" when the iGPU isn't renderD128)
 * or a CUDA index like "1" for the second nvidia card.
 *
 * Detection is process-lifetime-cached: one `ffmpeg -encoders` exec plus a
 * filesystem probe of /dev/dri and /dev/nvidia0. Both the API and the worker
 * run their own copy (separate processes, same mount, same verdict).
 *
 * Runtime policy (Immich-style "fail soft"): when a job or live transcode
 * dies with hardware acceleration active, the caller calls `reportHwFailure()`
 * — hardware is disabled for the rest of this process (a broken driver or
 * device can't take every play session down) and the failed work is retried
 * with the software path.
 */
export type HwaccelMethod = "vaapi" | "qsv" | "nvenc";

export type HwaccelRequest = "auto" | "none" | HwaccelMethod;

export interface HwaccelCapability {
  method: HwaccelMethod;
  device: string | null;
}

export interface HwaccelState {
  /** what was asked for ("auto" = detect at boot) */
  requested: HwaccelRequest;
  /** active method — "none" when nothing usable or hw got disabled */
  method: HwaccelMethod | "none";
  /** device the active method uses (null when method is "none") */
  device: string | null;
  /** everything detection found usable on this box */
  available: HwaccelCapability[];
  /** encoder names this ffmpeg build offers (from `ffmpeg -encoders`) */
  encoders: Set<string>;
  /** true when a runtime failure flipped this process to CPU */
  disabledAfterFailure: boolean;
  /** why the resolved method was chosen (surfaced in the admin console) */
  note: string | null;
}

// Method → (profile codec → ffmpeg encoder). Detection gates the whole method
// on its h264 encoder; the others are offered when present in the build.
const HW_ENCODERS: Record<HwaccelMethod, Record<string, string>> = {
  vaapi: { h264: "h264_vaapi", hevc: "hevc_vaapi", vp9: "vp9_vaapi", av1: "av1_vaapi" },
  qsv: { h264: "h264_qsv", hevc: "hevc_qsv", vp9: "vp9_qsv", av1: "av1_qsv" },
  nvenc: { h264: "h264_nvenc", hevc: "hevc_nvenc", av1: "av1_nvenc" },
};

// Priority for "auto": nvenc is the most capable, qsv slightly ahead of vaapi
// on Intel (libvpl dispatch on top of vaapi), vaapi the cross-vendor floor.
// On an AMD-only box vaapi is the only survivor anyway.
const AUTO_PRIORITY: HwaccelMethod[] = ["nvenc", "qsv", "vaapi"];

const GATE_ENCODER: Record<HwaccelMethod, string> = {
  vaapi: "h264_vaapi",
  qsv: "h264_qsv",
  nvenc: "h264_nvenc",
};

let cached: HwaccelState | null = null;

function envRequest(): HwaccelRequest {
  const value = process.env.HOKAGO_HWACCEL ?? "auto";
  if (value === "none" || value === "vaapi" || value === "qsv" || value === "nvenc") return value;
  return "auto";
}

function envDeviceOverride(): string | null {
  return process.env.HOKAGO_HWACCEL_DEVICE?.trim() ? process.env.HOKAGO_HWACCEL_DEVICE : null;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** First usable render node (renderD128 by default — the iGPU/best decoder). */
async function renderNode(): Promise<string | null> {
  const dir = "/dev/dri";
  if (!(await exists(dir))) return null;
  try {
    const nodes = (await readdir(dir)).filter((n) => /^renderD\d+$/.test(n)).sort();
    return nodes.length > 0 ? path.join(dir, nodes[0]!) : null;
  } catch {
    return null;
  }
}

/** Encoder names offered by this ffmpeg build — folded into the cached state. */
function readEncoders(): Promise<Set<string>> {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-hide_banner", "-encoders"], { maxBuffer: 4 * 1024 * 1024, timeout: 15_000 }, (err, stdout) => {
      if (err) return reject(err);
      const encoders = new Set<string>();
      for (const line of stdout.split("\n")) {
        const match = /^.{7}\s+(\S+)/.exec(line);
        if (match && !match[1]!.startsWith("=")) encoders.add(match[1]!);
      }
      resolve(encoders);
    });
  });
}

/**
 * Picks the device for a capability: the env override when set (validated to
 * exist for vaapi/qsv), else the detected node. For nvenc an override is a
 * CUDA index (no node to validate — the driver names the device).
 */
async function deviceFor(cap: HwaccelCapability, override: string | null): Promise<string | null> {
  if (cap.method === "nvenc") return override;
  const device = override ?? cap.device;
  if (device === null) return null;
  return (await exists(device)) ? device : null;
}

async function detect(): Promise<HwaccelState> {
  const [encoders, node, nvidia0] = await Promise.all([readEncoders(), renderNode(), exists("/dev/nvidia0")]);

  const capabilities: HwaccelCapability[] = [];
  if (node && encoders.has(GATE_ENCODER.vaapi)) capabilities.push({ method: "vaapi", device: node });
  if (node && encoders.has(GATE_ENCODER.qsv)) capabilities.push({ method: "qsv", device: node });
  if (nvidia0 && encoders.has(GATE_ENCODER.nvenc)) capabilities.push({ method: "nvenc", device: null });

  const requested = envRequest();
  const override = envDeviceOverride();
  const reasons: string[] = [];

  let method: HwaccelMethod | "none" = "none";
  let device: string | null = null;
  let note: string | null = null;

  const pickFrom = async (candidate: HwaccelMethod, label: string): Promise<boolean> => {
    const cap = capabilities.find((c) => c.method === candidate);
    if (!cap) return false;
    const dev = await deviceFor(cap, override);
    if (dev === null) {
      reasons.push(`${candidate}: device (${override ?? cap.device}) not accessible`);
      return false;
    }
    method = candidate;
    device = dev;
    note = label;
    return true;
  };

  if (requested === "none") {
    note = "hardware acceleration disabled by config";
  } else if (capabilities.length === 0) {
    note = "no hardware acceleration detected — using CPU (mount /dev/dri or the nvidia runtime to enable)";
  } else if (requested === "auto") {
    for (const candidate of AUTO_PRIORITY) {
      if (await pickFrom(candidate, `auto-detected ${candidate}`)) break;
    }
    if (method === "none") note = reasons.join("; ") || "nothing usable found — using CPU";
  } else {
    if (!(await pickFrom(requested, `${requested} (configured)`))) {
      note = reasons.length > 0 ? reasons.join("; ") : `${requested} requested but not usable on this host — using CPU`;
    }
  }

  return { requested, method, device, available: capabilities, encoders, disabledAfterFailure: false, note };
}

/** Resolved, process-lifetime-cached acceleration state (first call runs detection). */
export async function getHwaccel(): Promise<HwaccelState> {
  if (cached === null) cached = await detect();
  return cached;
}

/**
 * Disables hardware acceleration for the rest of this process after a runtime
 * failure — a broken driver/device must not take every play session down.
 * The caller retries the failed work with the software path.
 */
export function reportHwFailure(method: HwaccelMethod, reason: string): void {
  if (cached !== null) {
    cached.method = "none";
    cached.device = null;
    cached.disabledAfterFailure = true;
    cached.note = `${method} failed at runtime (${reason}) — CPU fallback active`;
  }
  console.warn(`hwaccel: ${method} failed at runtime (${reason}) — falling back to CPU for this process`);
}

/** True when the state resolves to active hardware acceleration. */
export function hwActive(state: HwaccelState): boolean {
  return state.method !== "none";
}

/**
 * Decode-side flags placed before `-i`: hardware decode with the frames
 * downloaded to system memory (`-hwaccel_output_format nv12`) so the CPU
 * filter chains the rest of the pipeline uses (scale, tone-map, subtitles,
 * tile) keep working unchanged. Decoding is the expensive part; encode-side
 * upload is appended separately by hwEncodeFilterTail when there is one.
 */
export function hwDecodeArgs(state: HwaccelState): string[] {
  if (!hwActive(state)) return [];
  switch (state.method) {
    case "nvenc":
      return ["-hwaccel", "cuda", "-hwaccel_output_format", "nv12"];
    case "vaapi":
    case "qsv":
      return ["-hwaccel", state.method, "-hwaccel_device", state.device!, "-hwaccel_output_format", "nv12"];
    default:
      return [];
  }
}

/** Encoder-init flags placed before `-i` when the output is hardware-encoded. */
export function hwEncodeInitArgs(state: HwaccelState): string[] {
  if (!hwActive(state)) return [];
  switch (state.method) {
    case "vaapi":
      return ["-init_hw_device", `vaapi=va:${state.device}`, "-filter_hw_device", "va"];
    case "qsv":
      return [
        "-init_hw_device", `vaapi=va:${state.device}`,
        "-init_hw_device", "qsv=hw@va",
        "-filter_hw_device", "hw",
      ];
    default:
      return [];
  }
}

/** Filter-chain tail that uploads frames to the hw encoder (nvenc takes system frames — none). */
export function hwEncodeFilterTail(state: HwaccelState): string[] {
  if (!hwActive(state)) return [];
  switch (state.method) {
    case "vaapi":
      return ["format=nv12", "hwupload"];
    case "qsv":
      return ["format=nv12", "hwupload=extra_hw_frames=64", "format=qsv"];
    default:
      return [];
  }
}

/**
 * Quality/speed options for the hw encoders — replaces the software
 * `-preset veryfast -crf 23`, which hardware encoders reject outright (vaapi
 * has no `-preset`, nvenc's preset names differ). Per-method equivalent:
 * vaapi CQP via `-qp`, qsv via `-global_quality`, nvenc via p-profile +
 * `-crf` (cq level). With a bitrate cap the caller still pushes
 * -maxrate/-bufsize; here only the rate-control base is set.
 */
export function hwEncodeQualityArgs(state: HwaccelState, capKbps?: number): string[] | null {
  if (!hwActive(state)) return null;
  switch (state.method) {
    case "vaapi":
      return capKbps !== undefined ? ["-b:v", `${capKbps}k`] : ["-qp", "23"];
    case "qsv":
      return capKbps !== undefined ? ["-b:v", `${capKbps}k`] : ["-global_quality", "23"];
    default:
      return ["-preset", "p5", "-crf", "23"];
  }
}

/** Hardware encoder for a profile codec when one is available and compiled in, else null. */
export function hwEncoderFor(state: HwaccelState, codec: string): string | null {
  if (state.method === "none") return null;
  const encoder = HW_ENCODERS[state.method]?.[codec];
  if (!encoder || !state.encoders.has(encoder)) return null;
  return encoder;
}

/** Plain-object snapshot for the admin console / contract schemas. */
export function hwaccelStatus(state: HwaccelState): {
  requested: HwaccelRequest;
  method: HwaccelMethod | "none";
  device: string | null;
  available: HwaccelCapability[];
  disabledAfterFailure: boolean;
  note: string | null;
} {
  return {
    requested: state.requested,
    method: state.method,
    device: state.device,
    available: state.available,
    disabledAfterFailure: state.disabledAfterFailure,
    note: state.note,
  };
}