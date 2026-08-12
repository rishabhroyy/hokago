/** playback start/seek/audio-track + heartbeat/continue-watching. */

import { z } from "zod";

export const PlaybackMethod = z.enum(["DIRECT_PLAY", "DIRECT_STREAM", "REMUX", "TRANSCODE"]);

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
  /** REMUX only: the progressive fragmented-MP4 stream URL (native <video>, range requests). */
  streamUrl: z.string().nullable().default(null),
  /** Where playback should resume (ms) — 0 when starting fresh. Server-side state, so callers need no stored position. */
  resumePositionMs: z.number().default(0),
  /**
   * Media-absolute duration of the file (ms) — the player's playbar total.
   * Streams started mid-file (REMUX/TRANSCODE resume) report a shorter
   * element duration, so clients use this for the displayed end time while
   * seeking in stream-relative coordinates.
   */
  absoluteDurationMs: z.number().default(0),
  /**
   * Exact media time the stream starts at — the client's timeline offset.
   * TRANSCODE (accurate seek) starts at the raw resume/target position,
   * frame-exact; REMUX starts at the keyframe at-or-before it. The client
   * self-seeks from here to resumePositionMs so continue-watching lands on
   * the exact stored position.
   */
  actualStartMs: z.number().optional(),
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
  /**
   * TRANSCODE (accurate seek) restarts land on the exact target; REMUX lands
   * on the keyframe at-or-before it — the position the restarted stream
   * actually starts at. The client's timeline offset uses this so subs and
   * positions stay exact after a restart.
   */
  actualStartMs: z.number().optional(),
});

export const AudioTrackSwitchBody = z.object({ audioStreamIndex: z.number(), positionMs: z.number() });
export type AudioTrackSwitchBody = z.infer<typeof AudioTrackSwitchBody>;

/** Quality switch — new encode caps. Omitted fields keep the session's current caps. */
export const QualitySwitchBody = z.object({
  /** Media-absolute position to restart from — the client converts its timeline time like /seek. */
  positionMs: z.number(),
  /** Drop forced caps and re-decide with the session's start profile — a capped
   *  TRANSCODE falls back up the ladder to DIRECT_PLAY when the source allows. */
  reset: z.boolean().optional(),
  maxWidth: z.number().optional(),
  maxHeight: z.number().optional(),
  maxVideoBitrateKbps: z.number().optional(),
});
export type QualitySwitchBody = z.infer<typeof QualitySwitchBody>;

/**
 * Quality-switch response — mirrors SeekResponse but carries the stream URLs
 * because the method itself can change (e.g. REMUX at 1080p -> TRANSCODE at
 * 480p, or a capped TRANSCODE -> DIRECT_PLAY on reset), and the client must
 * swap its src (streamUrl <-> playlistUrl <-> direct file).
 */
export const QualitySwitchResponse = z.object({
  restarted: z.boolean(),
  method: PlaybackMethod,
  segmentFrom: z.number().nullable(),
  pid: z.number().nullable(),
  killedPid: z.number().optional(),
  /**
   * TRANSCODE (accurate seek) restarts land on the exact target; REMUX lands
   * on the keyframe at-or-before it — the position the restarted stream
   * actually starts at.
   */
  actualStartMs: z.number().optional(),
  playlistUrl: z.string().nullable(),
  streamUrl: z.string().nullable(),
});

export const AudioTrackSwitchResponse = z.object({
  restarted: z.boolean(),
  segmentFrom: z.number(),
  pid: z.number(),
  killedPid: z.number(),
  /**
   * TRANSCODE (accurate seek) restarts land on the exact target; REMUX lands
   * on the keyframe at-or-before it — the position the restarted stream
   * actually starts at.
   */
  actualStartMs: z.number().optional(),
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
  /** Show title for an EPISODE mediaItem (the series it belongs to), null otherwise. */
  seriesTitle: z.string().nullable(),
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

/** Manual watched-marking (right-click menu): per-profile, idempotent. */
export const SetWatchedParams = z.object({ mediaItemId: z.string() });
export type SetWatchedParams = z.infer<typeof SetWatchedParams>;

export const SetWatchedBody = z.object({
  profileId: z.string(),
  /** true = mark watched, false = reset to unwatched (position and count cleared). */
  watched: z.boolean().default(true),
});
export type SetWatchedBody = z.infer<typeof SetWatchedBody>;

export const SetWatchedResponse = z.object({ ok: z.boolean(), watched: z.boolean() });

export const ErrorResponse = z.object({ error: z.string() });
