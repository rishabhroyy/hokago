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
  supportedVideoCodecs: [
    "h264",
    "vp9",
    ...(canPlayHevc("8bit") ? ["hevc"] : []),
    // A distinct claim from plain "hevc", required by decidePlaybackMethod
    // for any 10-bit HEVC source (see packages/ffmpeg/src/decision.ts) --
    // 8-bit (Main) and 10-bit (Main10) are different decode profiles, and
    // real devices can and do support one without the other. Previously
    // only the 8-bit string was ever tested, so a device that could ONLY
    // decode 8-bit HEVC still had plain "hevc" reported as supported --
    // DIRECT_PLAY/REMUX would then hand it a 10-bit bitstream it couldn't
    // actually decode, instead of falling through to TRANSCODE.
    ...(canPlayHevc("10bit") ? ["hevc10"] : []),
  ],
  supportedAudioCodecs: ["aac", "opus"],
  supportsHdr: false,
  subtitleMode: "external",
  // Deliberately NO maxWidth/maxHeight/maxVideoBitrateKbps: these caps are
  // *encode* constraints, and the decider feeding them in would cap
  // DIRECT_PLAY/REMUX at 1080p — browsers decode 4K h264/hevc natively. The
  // decider gets a raw profile (capability-only checks); encode caps arrive
  // only via the quality menu, and the server defaults them when encoding.
};

// HEVC's codec string is hvc1.<profile>.<compat-flags>.<tier+level>.<constraint>.
// Profile 1 = Main (8-bit); profile 2 = Main10 (10-bit) -- everything else
// held constant so this only ever tests the one thing that differs.
const HEVC_CODEC_STRINGS = {
  "8bit": 'video/mp4; codecs="hvc1.1.6.L120.90"',
  "10bit": 'video/mp4; codecs="hvc1.2.4.L120.90"',
} as const;

/**
 * Chrome/macOS (and Safari) decode HEVC natively via VideoToolbox — canPlayType
 * reflects that. When true the server REMUXes HEVC-in-MKV to a fragmented MP4
 * (copy, no re-encode) and the browser plays it with hardware decode — the
 * direct-play experience for the dominant anime file format. Bit depth is
 * tested separately (see HEVC_CODEC_STRINGS) since 8-bit and 10-bit support
 * genuinely differ across real hardware/OS/browser combinations.
 */
function canPlayHevc(depth: keyof typeof HEVC_CODEC_STRINGS): boolean {
  if (typeof document === "undefined") return false;
  try {
    const v = document.createElement("video");
    return v.canPlayType(HEVC_CODEC_STRINGS[depth]) !== "";
  } catch {
    return false;
  }
}
