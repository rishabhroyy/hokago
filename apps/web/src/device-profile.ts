// What we tell /playback/start this browser can do. Mirrors the shape of
// packages/ffmpeg/src/device-profile.ts's DeviceProfile, duplicated rather than
// imported since that package is Node-only (ffmpeg arg building, fs) and isn't
// meant to ship to the browser bundle.
export interface BrowserDeviceProfile {
  supportedContainers: string[];
  supportedVideoCodecs: string[];
  supportedAudioCodecs: string[];
  maxVideoBitrateKbps?: number;
  maxWidth?: number;
  maxHeight?: number;
  supportsHdr?: boolean;
  subtitleMode: "none" | "external" | "burn";
  enableDirectPlay?: boolean;
  enableDirectStream?: boolean;
}

// subtitleMode "external": JASSUB renders soft subs client-side — this
// is the whole point of Step 8, so burn-in is never requested here.
export const BROWSER_DEVICE_PROFILE: BrowserDeviceProfile = {
  supportedContainers: ["mp4", "webm"],
  supportedVideoCodecs: ["h264", "vp9", ...(canPlayHevc() ? ["hevc"] : [])],
  supportedAudioCodecs: ["aac", "opus"],
  supportsHdr: false,
  subtitleMode: "external",
  // Real screen ceiling — transcodes never exceed it (the server also
  // defaults these, so a profile without caps still gets sane encoding).
  maxWidth: 1920,
  maxHeight: 1080,
  maxVideoBitrateKbps: 8000,
};

/**
 * Chrome/macOS (and Safari) decode HEVC natively via VideoToolbox — canPlayType
 * reflects that. When true the server REMUXes HEVC-in-MKV to a fragmented MP4
 * (copy, no re-encode) and the browser plays it with hardware decode — the
 * direct-play experience for the dominant anime file format.
 */
function canPlayHevc(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const v = document.createElement("video");
    return v.canPlayType('video/mp4; codecs="hvc1.1.6.L120.90"') !== "";
  } catch {
    return false;
  }
}
