import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MediaPlayer,
  MediaProvider,
  Track,
  hasTriggerEvent,
  isHLSProvider,
  useMediaState,
  type AudioTrack,
  type MediaAudioTrackChangeEvent,
  type MediaPlayerInstance,
  type MediaProviderAdapter,
  type MediaTextTrackChangeEvent,
  type TextTrack,
} from "@vidstack/react";
import {
  defaultLayoutIcons,
  DefaultVideoLayout,
  DefaultMenuSection,
  DefaultMenuRadioGroup,
} from "@vidstack/react/player/layouts/default";
import JASSUB from "jassub";
// Vite bundles these from the installed dependency and serves them from our
// own origin — never a CDN — same reasoning as the hls.js fix below (/).
import jassubWorkerUrl from "jassub/dist/worker/worker.js?worker&url";
import jassubWasmUrl from "jassub/dist/wasm/jassub-worker.wasm?url";
import jassubModernWasmUrl from "jassub/dist/wasm/jassub-worker-modern.wasm?url";

import type {
  StartPlaybackResponse as PlaybackStart,
  AudioTrackSwitchBody,
} from "@hokago/contract/playback";
import type { SubtitleTrackInfo, AudioTrackInfo, FontDescriptor as FontInfo } from "@hokago/contract/media-files";
import { api } from "./api-client";
import { BROWSER_DEVICE_PROFILE } from "./device-profile";
import { getPrimaryProfile } from "./profile";
import { clearDetailCache, fetchMediaItemDetail } from "./browse-api";
import { paths, useRouter } from "./router";
import { Icon } from "./ui/icons";
import { loadTrackPrefs, matchAudioPref, matchSubtitlePref, saveAudioPref, saveSubtitlePref } from "./track-prefs";
import { audioTrackLabel } from "./language-names";

// An empty WebVTT that vidstack loads (so the track is a real, selectable entry
// in the stock captions menu) but which draws nothing — JASSUB does the actual
// ASS rendering. Registering our subtitles this way lets the default player UI
// own switching/off while keeping libass as the renderer.
const EMPTY_VTT = "data:text/vtt," + encodeURIComponent("WEBVTT\n\n");

// Heartbeat cadence — server-side resume + continue-watching depend on it,
// and the API's idle reaper uses it to tell "paused in a tab" from "dead".
const HEARTBEAT_MS = 10_000;

// Mirrors HLS_SEGMENT_SECONDS in packages/ffmpeg (Node-only, not importable
// here): transcode playlists restart at a segment boundary, so the timeline
// offset at a restart is always an exact multiple of this.
const HLS_SEGMENT_SECONDS = 6;

const eq = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

// Shape of the non-standard HTMLMediaElement.audioTracks list (Chrome/Safari).
interface NativeAudioTrack {
  id: string;
  label: string;
  language: string;
  enabled: boolean;
}
interface NativeAudioTrackList {
  readonly length: number;
  [index: number]: NativeAudioTrack;
}

/** True when a media event was triggered by a real user gesture (menu radio
 *  click/keypress) rather than auto-selection or a programmatic change. */
const isUserGesture = (event: Event) =>
  hasTriggerEvent(event, "click") || hasTriggerEvent(event, "keydown") || hasTriggerEvent(event, "pointerup");

export function WatchPage({ mediaFileId }: { mediaFileId: string }) {
  const { navigate } = useRouter();
  const params = new URLSearchParams(location.search);
  const mediaItemId = params.get("mediaItemId") ?? "";
  const queryProfileId = params.get("profileId");
  // "dev" is the historical router default, not a real profile — resolve the
  // account's primary profile so heartbeats land on a real profileId row.
  const [profileId, setProfileId] = useState<string | null>(queryProfileId && queryProfileId !== "dev" ? queryProfileId : null);

  const [start, setStart] = useState<PlaybackStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [subtitles, setSubtitles] = useState<SubtitleTrackInfo[]>([]);
  const [audioTracks, setAudioTracks] = useState<AudioTrackInfo[]>([]);
  const [selectedAudioIndex, setSelectedAudioIndex] = useState<number | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [fonts, setFonts] = useState<FontInfo[]>([]);
  const playerRef = useRef<MediaPlayerInstance>(null);
  const jassubRef = useRef<JASSUB | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const skipNextSeekRef = useRef(false);
  const scrubTimerRef = useRef<number | null>(null);
  const lastScrubPosRef = useRef(0);
  // Media-absolute time at the video timeline's zero point. The server speaks
  // media time end-to-end (playlist MEDIA-SEQUENCE, remux -ss target, stored
  // watch positions); the <video>/hls.js timeline restarts at the resume or
  // restart point, so every client↔server position exchange converts through
  // this offset (currentTime + offset = media time).
  const timelineOffsetRef = useRef(0);
  // State mirror of the ref above — JASSUB needs to react to offset changes
  // (its cue times are media-absolute, the video clock is timeline-relative),
  // and refs alone don't re-render.
  const [timelineOffsetMs, setTimelineOffsetMs] = useState(0);
  const prefs = useMemo(() => loadTrackPrefs(), []);
  const userInteractedRef = useRef(false);
  const [title, setTitle] = useState<string | null>(null);

  const applyTimelineOffset = useCallback((ms: number) => {
    timelineOffsetRef.current = ms;
    setTimelineOffsetMs(ms);
  }, []);

  // Bitmap subs (PGS/VOBSUB) are burned in server-side, so only text subs
  // become selectable menu entries here; the first one is the default.
  const renderable = useMemo(() => subtitles.filter((t) => !t.requiresBurnIn), [subtitles]);

  // Remembered subtitle preference drives the caption-menu default: null pref
  // means subs off (no default track), a matching track gets selected, and
  // without any preference the first renderable track stays the default.
  const defaultSubtitleId = useMemo(() => {
    if (prefs.subtitle === null) return null;
    if (prefs.subtitle) return (matchSubtitlePref(renderable, prefs.subtitle) ?? renderable[0])?.id ?? null;
    return renderable[0]?.id ?? null;
  }, [prefs.subtitle, renderable]);

  // The stock captions menu is the source of truth for which sub is active;
  // JASSUB just follows it. `id` on each <Track> is our subtitle id.
  const activeTextTrack = useMediaState("textTrack", playerRef);
  const selectedSubtitleId = activeTextTrack?.id ?? null;

  useEffect(() => {
    if (!mediaItemId) return;
    fetchMediaItemDetail(mediaItemId)
      .then((detail) => setTitle(detail?.title ?? null))
      .catch(() => {});
  }, [mediaItemId]);

  // Vidstack's HLS provider defaults `library` to a cdn.jsdelivr.net URL — a
  // third-party hotlink that breaks local-first and is exactly what COEP:
  // require-corp is watching for . hls.js is already an installed
  // dependency, so point it at the same bundled copy instead of a CDN.
  const handleProviderChange = useCallback((provider: MediaProviderAdapter | null) => {
    if (isHLSProvider(provider)) {
      provider.library = () => import("hls.js");
      // The transmux worker transfers fragment buffers via postMessage; under
      // COEP: require-corp the transferred ArrayBuffer arrives detached and
      // the probe sees empty data ("Failed to find demuxer"), stalling every
      // segment past the first. Transmux on the main thread instead.
      //
      // Transcodes serve the playlist with every segment listed (VOD), but
      // ffmpeg writes them on demand — the segment route holds the request
      // until the file is stable. hls.js's default first-byte timeout (10s)
      // aborts those held fetches and retries them in a storm; with no first
      // byte it treats the pending fetch as live and streams it the moment
      // the segment lands. maxLoadTimeMs still bounds a dead session (the
      // route 404s quickly once its ffmpeg child dies).
      provider.config = {
        enableWorker: false,
        fragLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: Infinity,
            maxLoadTimeMs: 120_000,
            timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
            errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
          },
        },
      };
    }
    // JASSUB needs the underlying <video> element whatever the provider type —
    // the HLS provider (MSE, TRANSCODE) is a different provider type but still
    // manages a native <video>, and without it libass never attaches.
    setVideoEl((provider as { video?: HTMLVideoElement } | null)?.video ?? null);
  }, []);

 // Track list ('s audio/subtitle switcher, Step 8) — text formats only;
  // PGS/VOBSUB never show up here since /tracks still lists them but the
  // subtitle-text route 422s for bitmap formats (server forces burn-in instead).
  useEffect(() => {
    if (!mediaFileId) return;
    let cancelled = false;
    api
      .GET("/media-files/{id}/tracks", { params: { path: { id: mediaFileId } } })
      .then(({ data }) => {
        if (cancelled || !data) return;
        setSubtitles(data.subtitles);
        setAudioTracks(data.audio);
        const def = data.audio.find((a) => a.isDefault) ?? data.audio[0];
        const chosen = matchAudioPref(data.audio, prefs.audio) ?? def;
        setSelectedAudioIndex(chosen?.streamIndex ?? null);
      })
      .catch(() => {});
    api
      .GET("/media-files/{id}/fonts", { params: { path: { id: mediaFileId } } })
      .then(({ data }) => {
        if (!cancelled && data) setFonts(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mediaFileId, prefs.audio]);

 // JASSUB renders ASS client-side — attached directly to the
  // underlying <video>, independent of DIRECT_PLAY/DIRECT_STREAM/TRANSCODE,
  // since libass just needs the video element's clock, not its source.
  useEffect(() => {
    if (!videoEl || !selectedSubtitleId) return;
    const track = renderable.find((t) => t.id === selectedSubtitleId);
    if (!track) return;

    const availableFonts = Object.fromEntries(fonts.map((f) => [f.family, f.url]));
    const instance = new JASSUB({
      video: videoEl,
      subUrl: `/media-files/${mediaFileId}/subtitle-tracks/${selectedSubtitleId}`,
      workerUrl: jassubWorkerUrl,
      wasmUrl: jassubWasmUrl,
      modernWasmUrl: jassubModernWasmUrl,
      availableFonts,
      // ASS cue times are media-absolute; the video clock is timeline-relative
      // (resume/restart rebase). Without this offset every resumed session's
      // subs would lag by the whole resume position.
      timeOffset: timelineOffsetRef.current / 1000,
    });
    jassubRef.current = instance;

    return () => {
      instance.destroy();
      jassubRef.current = null;
    };
  }, [videoEl, selectedSubtitleId, mediaFileId, renderable, fonts]);

  // Keep JASSUB's offset in lockstep with restarts (seek / audio switch) —
  // the field is read every rendered frame, so mutating it is live.
  useEffect(() => {
    if (jassubRef.current) jassubRef.current.timeOffset = timelineOffsetMs / 1000;
  }, [timelineOffsetMs]);

  // JASSUB renders from requestVideoFrameCallback, which only fires on
  // PRESENTED frames. A big seek (especially past the buffered frontier) leaves
  // currentTime at the target while hls.js buffers — no frames present, so
  // JASSUB keeps rendering the stale pre-seek frame time for many seconds
  // ("subs show a scene from minutes ago"). Force a render at the seek target
  // the moment `seeking` fires so cues track where we actually are.
  useEffect(() => {
    const jassub = jassubRef.current;
    if (!videoEl || !jassub) return;
    const forceSeekRender = () => {
      const last = jassub._lastDemandTime;
      void jassub.manualRender({
        mediaTime: videoEl.currentTime,
        width: videoEl.videoWidth || last?.width || 0,
        height: videoEl.videoHeight || last?.height || 0,
        expectedDisplayTime: performance.now(),
      });
    };
    videoEl.addEventListener("seeking", forceSeekRender);
    return () => videoEl.removeEventListener("seeking", forceSeekRender);
  }, [videoEl, selectedSubtitleId]);

  // Deep links / reloads sometimes carry no real profileId — resolve the
  // primary profile, then start playback once we actually have one.
  useEffect(() => {
    if (profileId) return;
    getPrimaryProfile().then((p) => {
      if (p) setProfileId(p.id);
    });
  }, [profileId]);

  useEffect(() => {
    if (!profileId) return;
    let cancelled = false;
    const startPlayback = async () => {
      for (let attempt = 0; ; attempt++) {
        const { data, response } = await api.POST("/playback/start", {
          body: {
            profileId,
            mediaItemId,
            mediaFileId,
            deviceProfile: BROWSER_DEVICE_PROFILE,
            // Honor the remembered audio track from the very first frame —
            // the server uses it for both the codec decision and the muxed
            // track. undefined leaves the file's default in charge.
            audioStreamIndex: prefs.audio?.streamIndex ?? undefined,
          },
        });
        if (data) return data as PlaybackStart;
        // Transcoder busy (concurrency cap) — back off and retry.
        if (response?.status === 503 && attempt < 4) {
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        throw new Error("playback/start failed");
      }
    };
    startPlayback()
      .then((data) => {
        if (cancelled) {
          // StrictMode double-mount: this /start was the mount-1 attempt, the
          // effect already cleaned up. Kill the server session so it doesn't
          // transcode the whole file for a player that will never mount.
          api
            .POST("/playback/{sessionId}/stop", {
              params: { path: { sessionId: data.sessionId } },
            })
            .catch(() => {});
          return;
        }
        setStart(data);
        // The video timeline is relative to where playback resumed, but the
        // server speaks media-absolute time. Track the offset so every
        // position the client sends (seek, audio switch, heartbeat) can be
        // converted back to media time.
        // - TRANSCODE: playlist starts at the resume segment — offset is the
        //   segment start; no client seek needed (media sequence handles it).
        // - REMUX: the file starts at the keyframe at-or-before the resume
        //   point — offset is that point, so no client seek either.
        // - DIRECT_PLAY: the file is the media itself — offset 0, seek to
        //   the exact resume once the file opens.
        if (data.method === "TRANSCODE") {
          applyTimelineOffset(Math.floor(data.resumePositionMs / (HLS_SEGMENT_SECONDS * 1000)) * HLS_SEGMENT_SECONDS * 1000);
        } else if (data.method === "REMUX") {
          applyTimelineOffset(data.resumePositionMs);
        } else if (data.resumePositionMs > 0) {
          pendingSeekRef.current = data.resumePositionMs / 1000;
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [mediaFileId, mediaItemId, profileId]);

  // Heartbeat + stop: the entire server-side watch-state machine
  // (PlaybackState, continue-watching, resume position, watch-day stats) is
  // fed from these two calls — without them nothing tracks anything.
  useEffect(() => {
    if (!start?.sessionId) return;

    const heartbeat = () => {
      const player = playerRef.current;
      if (!player) return;
      const durationMs = player.duration ? Math.round(player.duration * 1000) : undefined;
      api
        .POST("/playback/{sessionId}/heartbeat", {
          params: { path: { sessionId: start.sessionId } },
          body: { positionMs: Math.round(player.currentTime * 1000 + timelineOffsetRef.current), durationMs },
        })
        .catch(() => {});
    };
    const stop = () => {
      // keepalive: the fetch must survive tab close — without it the browser
      // cancels in-flight requests on unload and the ffmpeg child keeps
      // running until the server's idle reaper notices (5 min later).
      api
        .POST("/playback/{sessionId}/stop", {
          params: { path: { sessionId: start.sessionId } },
          keepalive: true,
        })
        .catch(() => {});
    };

    const interval = window.setInterval(heartbeat, HEARTBEAT_MS);
    // Tab close: React unmount doesn't reliably run — pagehide does.
    window.addEventListener("pagehide", stop);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("pagehide", stop);
      stop();
      // Heartbeats mutated watched flags + positions on the server; any
      // cached detail (the series page most of all) is now stale. Drop it so
      // back-navigation refetches and gray-out / durations render fresh.
      clearDetailCache();
    };
  }, [start?.sessionId]);

  // DIRECT_PLAY exposes the container's other audio streams natively, so the
  // stock audio menu switches them client-side. TRANSCODE/DIRECT_STREAM bake one
 // audio track into the segments , so switching means asking the server
  // to restart ffmpeg on that track, then forcing hls.js to refetch the (now
  // different-content) playlist and reseek — a cache-busting nonce is what forces
  // the refetch. This is the on-demand media-server model, not HLS audio groups.
  const handleAudioChange = useCallback(
    (absoluteIndex: number) => {
      setSelectedAudioIndex(absoluteIndex);
      const track = audioTracks.find((t) => t.streamIndex === absoluteIndex);
      saveAudioPref(
        track
          ? { streamIndex: track.streamIndex, id: null, lang: track.lang, title: track.title }
          : { streamIndex: absoluteIndex, id: null, lang: null, title: null },
      );
      if (!start || start.method === "DIRECT_PLAY") return;
      // The video timeline starts at the resume point (media-absolute), not
      // zero — convert before telling the server where to restart.
      const positionMs = Math.round((playerRef.current?.currentTime ?? 0) * 1000 + timelineOffsetRef.current);
      const body: AudioTrackSwitchBody = { audioStreamIndex: absoluteIndex, positionMs };
      api
        .POST("/playback/{sessionId}/audio-track", { params: { path: { sessionId: start.sessionId } }, body })
        .then(({ data, error }) => {
          if (error) throw new Error("audio-track switch failed");
          if (data && start.method === "TRANSCODE" && data.segmentFrom != null) {
            // New playlist starts at the target segment (continuous PTS, so
            // segment N begins at N*6s) — rebase the offset and reseek to the
            // exact pre-switch position on the fresh timeline.
            applyTimelineOffset(data.segmentFrom * HLS_SEGMENT_SECONDS * 1000);
            pendingSeekRef.current = (positionMs - timelineOffsetRef.current) / 1000;
          } else {
            // REMUX: the restarted file starts at the keyframe at-or-before the
            // target (actualStartMs). Rebase the offset to it and self-seek to
            // the exact pre-switch position so the video doesn't jump back.
            const newOffset = data?.actualStartMs ?? positionMs;
            applyTimelineOffset(newOffset);
            pendingSeekRef.current = (positionMs - newOffset) / 1000;
          }
          setReloadNonce((n) => n + 1);
        })
        .catch((err: Error) => setError(err.message));
    },
    [start, audioTracks, applyTimelineOffset],
  );

  const handleCanPlay = useCallback(() => {
    if (pendingSeekRef.current === null || !playerRef.current) return;
    playerRef.current.currentTime = pendingSeekRef.current;
    pendingSeekRef.current = null;
    // The seek we just applied fires a `seeked` event — don't let it
    // round-trip into a redundant /seek restart.
    skipNextSeekRef.current = true;
  }, []);

  // DIRECT_PLAY switches audio client-side via native <video> tracks; honor the
  // remembered audio preference by enabling the matching native track once
  // metadata is available. TRANSCODE/REMUX apply it through the tracks effect
  // instead (server-driven restarts).
  // `audioTracks` is non-standard (Chrome/Safari) and missing from lib.dom.
  useEffect(() => {
    if (start?.method !== "DIRECT_PLAY" || !videoEl || !prefs.audio) return;
    const list = (videoEl as HTMLVideoElement & { audioTracks?: NativeAudioTrackList }).audioTracks;
    if (!list || list.length === 0) return;
    const { audio } = prefs;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const match =
        (audio.id != null && t.id === audio.id) ||
        (audio.title != null && eq(t.label, audio.title)) ||
        (audio.lang != null && eq(t.language, audio.lang));
      if (match) {
        if (!t.enabled) t.enabled = true;
        break;
      }
    }
  }, [start?.method, videoEl, prefs.audio]);

  // Persist genuine user track choices. Auto-selection (default track on load)
  // and programmatic changes don't fire a user gesture, so hasTriggerEvent
  // keeps them out; the user must have clicked Play by the time they reach the
  // menus anyway, which is the second guard.
  const handleTextTrackChange = useCallback((detail: TextTrack | null, nativeEvent: MediaTextTrackChangeEvent) => {
    if (!userInteractedRef.current && !isUserGesture(nativeEvent)) return;
    saveSubtitlePref(detail ? { id: detail.id, lang: detail.language || null, title: detail.label || null } : null);
  }, []);

  const handleNativeAudioTrackChange = useCallback((detail: AudioTrack | null, nativeEvent: MediaAudioTrackChangeEvent) => {
    if (!detail) return;
    if (!userInteractedRef.current && !isUserGesture(nativeEvent)) return;
    saveAudioPref({ streamIndex: null, id: detail.id, lang: detail.language || null, title: detail.label || null });
  }, []);

  // Scrubbing in TRANSCODE/DIRECT_STREAM: the server must restart ffmpeg at
  // the target segment, then we reload the (rewritten) playlist. Debounced so
  // scrub-drag fires one /seek for the final position, not a kill/respawn
  // storm per scrub event.
  const handleSeeked = useCallback(() => {
    if (!start || start.method === "DIRECT_PLAY") return;
    const player = playerRef.current;
    if (!player) return;
    if (skipNextSeekRef.current) {
      skipNextSeekRef.current = false;
      return;
    }
    if (player.currentTime < 1) return;
    lastScrubPosRef.current = Math.round(player.currentTime * 1000 + timelineOffsetRef.current);
    if (scrubTimerRef.current !== null) window.clearTimeout(scrubTimerRef.current);
    scrubTimerRef.current = window.setTimeout(() => {
      api
        .POST("/playback/{sessionId}/seek", {
          params: { path: { sessionId: start.sessionId } },
          body: { positionMs: lastScrubPosRef.current },
        })
        .then(({ data }) => {
          if (!data?.restarted) return;
          if (start.method === "TRANSCODE" && data.segmentFrom != null) {
            applyTimelineOffset(data.segmentFrom * HLS_SEGMENT_SECONDS * 1000);
          } else {
            // REMUX: rebase to the restarted file's actual keyframe start and
            // self-seek to the exact scrub target so playback lands precisely.
            const newOffset = data.actualStartMs ?? lastScrubPosRef.current;
            applyTimelineOffset(newOffset);
            pendingSeekRef.current = (lastScrubPosRef.current - newOffset) / 1000;
          }
          setReloadNonce((n) => n + 1);
        })
        .catch(() => {});
    }, 2500);
  }, [start, applyTimelineOffset]);

  const src =
    start?.method === "DIRECT_PLAY"
      ? { src: `/media-files/${mediaFileId}/direct`, type: "video/mp4" as const }
      : start?.method === "REMUX" && start.streamUrl
        ? {
            // Native <video> + range requests against the live remux — no
            // MSE, which is exactly why HEVC works here. Restarts (seek past
            // the written frontier, audio switch) truncate and rewrite the
            // file, so the nonce forces a fresh open.
            src: reloadNonce > 0 ? `${start.streamUrl}?r=${reloadNonce}` : start.streamUrl,
            type: "video/mp4" as const,
          }
        : start?.playlistUrl
          ? {
              src: reloadNonce > 0 ? `${start.playlistUrl}?r=${reloadNonce}` : start.playlistUrl,
              type: "application/x-mpegurl" as const,
            }
          : undefined;

  // Server-side audio switching only makes sense while transcoding; DIRECT_PLAY
  // already has a native audio menu, so we don't double it up.
  const serverAudioMenu =
    start && start.method !== "DIRECT_PLAY" && audioTracks.length > 1 ? (
      <DefaultMenuSection label="Audio">
        <DefaultMenuRadioGroup
          value={String(selectedAudioIndex ?? "")}
          options={audioTracks.map((t) => ({
            label: audioTrackLabel(t),
            value: String(t.streamIndex),
          }))}
          onChange={(v) => handleAudioChange(Number(v))}
        />
      </DefaultMenuSection>
    ) : null;

  return (
    <div className="fixed inset-0 h-screen w-screen overflow-hidden bg-black text-white">
      <button
        className="absolute left-5 top-5 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-md transition-colors hover:bg-black/65"
        onClick={() => {
          // A reloaded or deep-linked player has no in-app page to go back to —
          // fall back to the title page instead of dropping out of the app.
          if (window.history.length > 1) window.history.back();
          else navigate(mediaItemId ? paths.detail(mediaItemId) : paths.home());
        }}
        title="Back"
        aria-label="Back to title"
      >
        <Icon name="back" className="h-[18px] w-[18px]" />
      </button>
      {error ? (
        <div className="flex h-full w-full items-center justify-center text-sm text-white/70">
          Couldn’t start playback.
        </div>
      ) : src ? (
        <MediaPlayer
          ref={playerRef}
          className="h-full w-full"
          src={src}
          playsInline
          title={title ?? "hokago"}
          onProviderChange={handleProviderChange}
          onCanPlay={handleCanPlay}
          onSeeked={handleSeeked}
          onPlay={() => {
            userInteractedRef.current = true;
          }}
          onTextTrackChange={handleTextTrackChange}
          onAudioTrackChange={handleNativeAudioTrackChange}
          onPause={() => {
            // Persist position promptly on pause — don't wait for the next
            // 10s tick, in case the tab is throttled or closed soon after.
            const player = playerRef.current;
            if (!player || !start?.sessionId) return;
            api
              .POST("/playback/{sessionId}/heartbeat", {
                params: { path: { sessionId: start.sessionId } },
                body: { positionMs: Math.round(player.currentTime * 1000 + timelineOffsetRef.current) },
              })
              .catch(() => {});
          }}
          onEnded={() => {
            // Final heartbeat at end-of-video flips `watched` server-side
            // (playCount++ / watch-day completion) immediately.
            const player = playerRef.current;
            if (!player || !start?.sessionId) return;
            api
              .POST("/playback/{sessionId}/heartbeat", {
                params: { path: { sessionId: start.sessionId } },
                body: {
                  positionMs: Math.round(player.currentTime * 1000 + timelineOffsetRef.current),
                  durationMs: player.duration ? Math.round(player.duration * 1000) : undefined,
                },
              })
              .catch(() => {});
          }}
        >
          <MediaProvider>
            {/* DIRECT_PLAY audio tracks come from the native element and show up
                in the stock audio menu automatically; these are the subtitles. */}
            {renderable.map((t) => (
              <Track
                key={t.id}
                id={t.id}
                src={EMPTY_VTT}
                kind="subtitles"
                label={t.title ?? t.lang ?? t.id}
                language={t.lang ?? undefined}
                default={t.id === defaultSubtitleId}
              />
            ))}
          </MediaProvider>
          <DefaultVideoLayout icons={defaultLayoutIcons} slots={{ settingsMenuItemsEnd: serverAudioMenu }} />
        </MediaPlayer>
      ) : (
        <div className="flex h-full w-full items-center justify-center text-sm text-white/70">
          Starting playback…
        </div>
      )}
    </div>
  );
}
