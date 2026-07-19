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

// subtitleMode "external": JASSUB renders soft subs client-side (§13.1) — this
// is the whole point of Step 8, so burn-in is never requested here.
export const BROWSER_DEVICE_PROFILE: BrowserDeviceProfile = {
  supportedContainers: ["mp4", "webm"],
  supportedVideoCodecs: ["h264", "vp9"],
  supportedAudioCodecs: ["aac", "opus"],
  supportsHdr: false,
  subtitleMode: "external",
};
