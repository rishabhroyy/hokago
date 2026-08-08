/** playback start/seek/audio-track + heartbeat/continue-watching. */

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
  /** Where playback should resume (ms) — 0 when starting fresh. Server-side state, so callers need no stored position. */
  resumePositionMs: z.number().default(0),
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
  year: z.number().int().nullable(),
  posterUrl: z.string().nullable(),
  backdropUrl: z.string().nullable(),
  mediaFileId: z.string().nullable(),
});

export const ContinueWatchingEntry = z.object({
  mediaItem: MediaItemRef.passthrough(),
  /** Detail page to land on — the series for an episode, the item itself otherwise. */
  detailItemId: z.string(),
  positionMs: z.number(),
  durationMs: z.number().nullable(),
  upNext: z.boolean(),
});
export type ContinueWatchingEntry = z.infer<typeof ContinueWatchingEntry>;
export const ContinueWatchingResponse = z.array(ContinueWatchingEntry);

/** One row per (profile, item, calendar day) — the day-by-day watch history. */
export const WatchHistoryQuery = z.object({ profileId: z.string(), mediaItemId: z.string() });
export type WatchHistoryQuery = z.infer<typeof WatchHistoryQuery>;

export const WatchHistoryEntry = z.object({
  date: z.coerce.date(),
  /** Total watch time credited that day (seek jumps excluded). */
  watchedMs: z.number(),
  /** Start of the day's first watch span. */
  firstStartedAt: z.coerce.date().nullable(),
  /** End of the day's last watch span. */
  lastEndedAt: z.coerce.date().nullable(),
  /** Completions (rewatch events) that day. */
  completions: z.number(),
});
export type WatchHistoryEntry = z.infer<typeof WatchHistoryEntry>;

export const WatchHistoryResponse = z.array(WatchHistoryEntry);

export const ErrorResponse = z.object({ error: z.string() });
