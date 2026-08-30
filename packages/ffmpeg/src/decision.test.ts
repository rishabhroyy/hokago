import assert from "node:assert/strict";
import { test } from "node:test";

import { decidePlaybackMethod } from "./decision.js";
import type { DeviceProfile, PlaybackCandidateInput } from "./device-profile.js";

const baseInput: PlaybackCandidateInput = {
  container: "mov,mp4,m4a,3gp,3g2,mj2",
  videoCodec: "h264",
  audioCodec: "aac",
  width: 1920,
  height: 1080,
  bitrateKbps: 4000,
  isHdr: false,
  subtitleRequiresBurnIn: false,
  audioKnownBroken: false,
};

const profile: DeviceProfile = {
  supportedContainers: ["mov,mp4,m4a,3gp,3g2,mj2"],
  supportedVideoCodecs: ["h264"],
  supportedAudioCodecs: ["aac"],
  maxWidth: 1920,
  maxHeight: 1080,
  maxVideoBitrateKbps: 8000,
  subtitleMode: "external",
};

test("compatible h264/aac direct plays", () => {
  const decision = decidePlaybackMethod(baseInput, profile);
  assert.equal(decision.method, "DIRECT_PLAY");
});

test("audioKnownBroken skips DIRECT_PLAY even though the codec name is supported", () => {
  const decision = decidePlaybackMethod({ ...baseInput, audioKnownBroken: true }, profile);
  assert.notEqual(decision.method, "DIRECT_PLAY");
  // Video is fine — a copy-remux (with audio forced to re-encode by the
  // caller, see buildRemuxArgs call sites) is enough, no need for a full
  // re-encode of the video too.
  assert.equal(decision.method, "REMUX");
});

test("audioKnownBroken with an incompatible video codec still needs a real transcode", () => {
  const decision = decidePlaybackMethod(
    { ...baseInput, audioKnownBroken: true, videoCodec: "mpeg2video" },
    profile,
  );
  assert.equal(decision.method, "TRANSCODE");
});
