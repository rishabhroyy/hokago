/** §11.1/§11.2/§11.4 — playback start/seek/audio-track + heartbeat/continue-watching. */

import { z } from "zod";

export const PlaybackMethod = z.enum(["DIRECT_PLAY", "DIRECT_STREAM", "TRANSCODE"]);

export const DeviceProfile = z.object({
  supportedContainers: z.array(z.string()),
  supportedVideoCodecs: z.array(z.string()),
  supportedAudioCodecs: z.array(z.string()),
  maxVideoBitrateKbps: z.number().optional(),
  maxWidth: z.number().optional(),
  maxHeight: z.number().optional(),
  supportsHdr: z.boolean().optional(),
  subtitleMode: z.enum(["none", "external", "burn"]),
  enableDirectPlay: z.boolean().optional(),
  enableDirectStream: z.boolean().optional(),
});
export type DeviceProfile = z.infer<typeof DeviceProfile>;

export const StartPlaybackBody = z.object({
  profileId: z.string(),
  mediaItemId: z.string(),
  mediaFileId: z.string(),
  deviceProfile: DeviceProfile,
  subtitleTrackId: z.string().optional(),
  audioStreamIndex: z.number().optional(),
});
export type StartPlaybackBody = z.infer<typeof StartPlaybackBody>;

export const StartPlaybackResponse = z.object({
  sessionId: z.string(),
  method: PlaybackMethod,
  reasons: z.array(z.string()),
  playlistUrl: z.string().nullable(),
});
export type StartPlaybackResponse = z.infer<typeof StartPlaybackResponse>;

export const PlaybackSessionParams = z.object({ sessionId: z.string() });

export const SeekBody = z.object({ positionMs: z.number() });
export type SeekBody = z.infer<typeof SeekBody>;

export const SeekResponse = z.object({
  restarted: z.boolean(),
  segmentFrom: z.number(),
  pid: z.number(),
  killedPid: z.number().optional(),
});

export const AudioTrackSwitchBody = z.object({ audioStreamIndex: z.number(), positionMs: z.number() });
export type AudioTrackSwitchBody = z.infer<typeof AudioTrackSwitchBody>;

export const AudioTrackSwitchResponse = z.object({
  restarted: z.boolean(),
  segmentFrom: z.number(),
  pid: z.number(),
  killedPid: z.number(),
});

export const HeartbeatBody = z.object({
  positionMs: z.number(),
  durationMs: z.number().optional(),
});
export type HeartbeatBody = z.infer<typeof HeartbeatBody>;

export const HeartbeatResponse = z.object({ ok: z.boolean(), watched: z.boolean() });

export const StopResponse = z.object({ ok: z.boolean() });

export const ContinueWatchingQuery = z.object({ profileId: z.string() });
export type ContinueWatchingQuery = z.infer<typeof ContinueWatchingQuery>;

export const MediaItemRef = z.object({
  id: z.string(),
  kind: z.enum(["MOVIE", "SERIES", "SEASON", "EPISODE"]),
  title: z.string(),
  sortTitle: z.string(),
  parentId: z.string().nullable(),
  seasonNumber: z.number().nullable(),
  episodeNumber: z.number().nullable(),
});

export const ContinueWatchingEntry = z.object({
  mediaItem: MediaItemRef.passthrough(),
  positionMs: z.number(),
  durationMs: z.number().nullable(),
  upNext: z.boolean(),
});
export type ContinueWatchingEntry = z.infer<typeof ContinueWatchingEntry>;
export const ContinueWatchingResponse = z.array(ContinueWatchingEntry);

export const ErrorResponse = z.object({ error: z.string() });
