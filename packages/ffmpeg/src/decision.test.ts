import assert from "node:assert/strict";
import { test } from "node:test";

import { decidePlaybackMethod } from "./decision.js";
import type { DeviceProfile, PlaybackCandidateInput } from "./device-profile.js";

const baseInput: PlaybackCandidateInput = {
  container: "mov,mp4,m4a,3gp,3g2,mj2",
  videoCodec: "h264",
  bitDepth: 8,
  audioCodec: "aac",
  width: 1920,
  height: 1080,
  bitrateKbps: 4000,
  isHdr: false,
  subtitleRequiresBurnIn: false,
  audioKnownBroken: false,
  videoKnownBroken: false,
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

test("videoKnownBroken forces TRANSCODE even though the codec name is otherwise supported", () => {
  // Unlike audioKnownBroken, this must skip REMUX too, not just DIRECT_PLAY
  // -- a REMUX copies video verbatim, so it can never fix a broken video
  // stream the way it can fix an audio one by re-encoding.
  const decision = decidePlaybackMethod({ ...baseInput, videoKnownBroken: true }, profile);
  assert.equal(decision.method, "TRANSCODE");
});

test("10-bit HEVC forces TRANSCODE against a profile that only claims plain 8-bit hevc support", () => {
  // The actual real-world bug this guards: a device profile built from a
  // capability probe that only ever tested an 8-bit HEVC codec string
  // reports "hevc" as supported regardless of the source's real bit depth
  // -- letting DIRECT_PLAY/REMUX hand a 10-bit bitstream to a device that
  // can only decode 8-bit.
  const decision = decidePlaybackMethod(
    { ...baseInput, videoCodec: "hevc", bitDepth: 10 },
    { ...profile, supportedVideoCodecs: ["h264", "hevc"] },
  );
  assert.equal(decision.method, "TRANSCODE");
});

test("10-bit HEVC direct-plays once the profile explicitly claims hevc10 support", () => {
  const decision = decidePlaybackMethod(
    { ...baseInput, videoCodec: "hevc", bitDepth: 10 },
    { ...profile, supportedVideoCodecs: ["h264", "hevc", "hevc10"] },
  );
  assert.equal(decision.method, "DIRECT_PLAY");
});

test("8-bit HEVC is unaffected by the bit-depth check -- plain hevc support is still enough", () => {
  const decision = decidePlaybackMethod(
    { ...baseInput, videoCodec: "hevc", bitDepth: 8 },
    { ...profile, supportedVideoCodecs: ["h264", "hevc"] },
  );
  assert.equal(decision.method, "DIRECT_PLAY");
});

test("missing bitDepth (null) is treated as 8-bit, not as an unknown requiring hevc10", () => {
  const decision = decidePlaybackMethod(
    { ...baseInput, videoCodec: "hevc", bitDepth: null },
    { ...profile, supportedVideoCodecs: ["h264", "hevc"] },
  );
  assert.equal(decision.method, "DIRECT_PLAY");
});
