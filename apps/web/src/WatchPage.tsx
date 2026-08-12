import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import {
  MediaPlayer,
  MediaProvider,
  Track,
  hasTriggerEvent,
  isHLSProvider,
  useMediaRemote,
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
import { loadTrackPrefs, matchAudioPref, matchSubtitlePref, saveAudioPref, saveQualityPref, saveSubtitlePref, type TrackPrefs } from "./track-prefs";
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

// Quality menu options — encode caps sent to /playback/start (merged into the
// device profile) and /playback/:id/quality. "Original" carries no caps: the
// decider gets the device profile's own ceiling and lands on the easiest tier
// that works — DIRECT_PLAY when the file direct-plays, otherwise the encode
// best effort. It's also the reset: a capped transcode returns to DIRECT_PLAY.
interface QualityOption {
  label: string;
  reset?: boolean;
  maxWidth?: number;
  maxHeight?: number;
  maxVideoBitrateKbps?: number;
}
const QUALITY_OPTIONS: QualityOption[] = [
  { label: "Original", reset: true },
  { label: "1080p", maxWidth: 1920, maxHeight: 1080, maxVideoBitrateKbps: 8000 },
  { label: "720p", maxWidth: 1280, maxHeight: 720, maxVideoBitrateKbps: 3500 },
  { label: "480p", maxWidth: 854, maxHeight: 480, maxVideoBitrateKbps: 1500 },
];

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

/**
 * Absolute-coordinate time slider replacing the stock one, which scales to
 * the *stream* timeline — shortened on resumes, re-scaled on every seek/
 * quality restart — so its size and the absolute clock disagree. This one
 * maps playhead + offset onto the file's full duration, keeping the thumb,
 * buffered bar, hover preview, and clock on one scale. Builds on the stock
 * class names + CSS vars (--slider-fill/progress/pointer) so the bundled
 * layout styles apply unchanged.
 */
function AbsoluteTimeSlider({
  playerRef,
  offsetMs,
  absoluteDurationMs,
  onScrub,
}: {
  playerRef: RefObject<MediaPlayerInstance | null>;
  offsetMs: number;
  absoluteDurationMs: number;
  onScrub: (mediaTimeMs: number) => void;
}) {
  const remote = useMediaRemote(playerRef);
  const rootRef = useRef<HTMLDivElement>(null);
  const currentTime = useMediaState("currentTime", playerRef) as number;
  const duration = useMediaState("duration", playerRef) as number;
  const bufferedEnd = useMediaState("bufferedEnd", playerRef) as number;
  const [pointerPct, setPointerPct] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  // State flushes are async — under React's concurrent batching a pointerup
  // can commit against a render that hasn't seen pointerdown yet, reading a
  // stale `dragging` and dropping the seek. The gate lives on a ref so the
  // commit decision is exactly synchronous with the input events.
  const draggingRef = useRef(false);

  // The playbar's total span: the file's real duration when the server
  // reported it (always does), else the element duration shifted by the offset.
  const endSec =
    absoluteDurationMs > 0
      ? absoluteDurationMs / 1000
      : Number.isFinite(duration)
        ? duration + offsetMs / 1000
        : 0;
  const posSec = Number.isFinite(currentTime) ? currentTime + offsetMs / 1000 : 0;
  const pct = endSec > 0 ? Math.min(100, Math.max(0, (posSec / endSec) * 100)) : 0;
  const bufferedPct = endSec > 0 ? Math.min(100, Math.max(0, ((bufferedEnd + offsetMs / 1000) / endSec) * 100)) : 0;
  const shownPct = pointerPct ?? pct;

  const pctFromClientX = (clientX: number) => {
    const el = rootRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 ? Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)) : 0;
  };

  const seekToPct = useCallback(
    (p: number) => {
      if (!endSec) return;
      // The absolute target (media time), converted back to the stream
      // timeline (media coordinates). Clamp at 0: on a resumed stream the
      // target can fall before the timeline origin — a negative seek is a
      // no-op in the media element, and the *server* restart below is what
      // actually lands the position (the local seek is only instant
      // feedback while the target is already buffered).
      const mediaSec = (p / 100) * endSec;
      const streamSec = mediaSec - offsetMs / 1000;
      remote.seek(streamSec > 0 ? streamSec : 0);
      onScrub(Math.round(mediaSec * 1000));
    },
    [remote, endSec, offsetMs, onScrub],
  );

  if (!endSec) {
    return <div className="vds-time-slider vds-slider" aria-disabled="true" />;
  }

  return (
    <div
      ref={rootRef}
      className="vds-time-slider vds-slider"
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-valuetext={`${formatClock(posSec)} of ${formatClock(endSec)}`}
      data-active={dragging || undefined}
      style={
        {
          "--slider-fill": `${(dragging ? shownPct : pct).toFixed(2)}%`,
          "--slider-progress": `${bufferedPct.toFixed(2)}%`,
          "--slider-pointer": `${shownPct.toFixed(2)}%`,
        } as CSSProperties
      }
      onPointerDown={(e) => {
        if (e.button !== 0 && e.pointerType === "mouse") return;
        e.preventDefault();
        // Capture keeps the drag over the video; a late pointerId (e.g.
        // synthesized events) throws — never let it abort the gesture.
        try {
          rootRef.current?.setPointerCapture(e.pointerId);
        } catch {
          /* noop */
        }
        draggingRef.current = true;
        setDragging(true);
        setPointerPct(pctFromClientX(e.clientX));
      }}
      // A completed gesture (click or drag end) bubbles up to vidstack's
      // click-to-toggle and lands as a *trusted* pause right as the seek
      // fires — after a restart remount the autoplay guard then respects it
      // and playback is frozen at the seek target ("seek didn't work").
      // Seeks never toggle play/pause; keep the gesture from reaching the
      // player. (Same-element handlers still run — only ancestors are cut.)
      onClick={(e) => e.stopPropagation()}
      onPointerMove={(e) => {
        // Hover (no buttons) moves the preview; drag moves the thumb+fill.
        if (draggingRef.current || e.buttons === 0) setPointerPct(pctFromClientX(e.clientX));
      }}
      onPointerUp={(e) => {
        if (!draggingRef.current) return;
        const p = pctFromClientX(e.clientX);
        draggingRef.current = false;
        setDragging(false);
        setPointerPct(null);
        seekToPct(p);
      }}
      onPointerCancel={() => {
        draggingRef.current = false;
        setDragging(false);
        setPointerPct(null);
      }}
      onPointerLeave={() => {
        if (!draggingRef.current) setPointerPct(null);
      }}
      onKeyDown={(e) => {
        const stepSec = e.shiftKey ? 10 : 5;
        let next: number | null = null;
        if (e.key === "ArrowLeft") next = pct - (stepSec / endSec) * 100;
        else if (e.key === "ArrowRight") next = pct + (stepSec / endSec) * 100;
        else if (e.key === "PageUp") next = pct + 10;
        else if (e.key === "PageDown") next = pct - 10;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = 100;
        if (next !== null) {
          e.preventDefault();
          seekToPct(Math.min(100, Math.max(0, next)));
        }
      }}
    >
      <div className="vds-slider-track" />
      <div className="vds-slider-progress vds-slider-track" />
      <div className="vds-slider-track-fill vds-slider-track" />
      <div className="vds-slider-thumb" />
      <div
        className="vds-slider-preview"
        data-visible={pointerPct !== null || undefined}
        style={{ position: "absolute", bottom: "calc(100% + 8px)", left: "var(--slider-pointer)", transform: "translateX(-50%)" }}
      >
        <span className="vds-slider-value">{formatClock((shownPct / 100) * endSec)}</span>
      </div>
    </div>
  );
}

/** True when a media event was triggered by a real user gesture (menu radio
 *  click/keypress) rather than auto-selection or a programmatic change. */
const isUserGesture = (event: Event) =>
  hasTriggerEvent(event, "click") || hasTriggerEvent(event, "keydown") || hasTriggerEvent(event, "pointerup");

// mm:ss (h:mm:ss past an hour) for the playbar clock slots.
function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return h > 0 ? `${h}:${mm}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * Playbar time slots rendered in media-absolute time. On resumed/restarted
 * streams the element clock restarts at the resume point, so the stock
 * currentTime/endTime would show a shortened episode; adding the timeline
 * offset (clamped to the file's real duration from the start response) keeps
 * the playbar honest — 12:34 of a resumed episode reads 22:34 / 24:00.
 */
function PlayerTimeClock({
  kind,
  playerRef,
  offsetMs,
  absoluteDurationMs,
}: {
  kind: "current" | "end";
  playerRef: RefObject<MediaPlayerInstance | null>;
  offsetMs: number;
  absoluteDurationMs: number;
}) {
  const currentTime = useMediaState("currentTime", playerRef) as number;
  const duration = useMediaState("duration", playerRef) as number;
  const endSeconds = absoluteDurationMs > 0 ? absoluteDurationMs / 1000 : duration + offsetMs / 1000;
  if (kind === "end") {
    if (!Number.isFinite(endSeconds)) return null;
    return <span className="font-mono tabular-nums">{formatClock(endSeconds)}</span>;
  }
  // currentTime is Infinity before metadata loads — the stock layout shows
  // 0:00 then; keep the slot empty instead of flashing the clamped file end.
  if (!Number.isFinite(currentTime)) return null;
  const shown = Math.max(0, Math.min(currentTime + offsetMs / 1000, endSeconds));
  return <span className="font-mono tabular-nums">{formatClock(shown)}</span>;
}

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
  // Cache-buster appended to the stream/playlist URL, and the MediaPlayer
  // remount key. Split so a same-method restart (seek, audio, quality) only
  // bumps the src nonce — the provider type doesn't change, and the full
  // key remount visibly "refreshed" the whole player UI on every seek. The
  // key still forces a fresh subtree when the method actually changes
  // (native <video> <-> HLS/MSE), which vidstack can't hot-swap.
  const [srcNonce, setSrcNonce] = useState(0);
  const [keyNonce, setKeyNonce] = useState(0);
  const [fonts, setFonts] = useState<FontInfo[]>([]);
  const playerRef = useRef<MediaPlayerInstance>(null);
  const jassubRef = useRef<JASSUB | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  // Live mirror of `start` for the seek machinery below — seeking must never
  // depend on a state value the commit callback might close over stale.
  const startRef = useRef(start);
  useEffect(() => {
    startRef.current = start;
  }, [start]);
  // One /seek in flight, latest-wins queue. Every committed scrub replaces
  // the queued target; a response only pumps the queue when it's free. This
  // keeps rapid scrubs / held arrow keys from firing a kill-respawn storm at
  // ffmpeg (each restart takes ~a second to yield its first segment).
  const seekQueueRef = useRef<number | null>(null);
  const seekInFlightRef = useRef(false);
  const seekTimerRef = useRef<number | null>(null);
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
  // Media-absolute duration of the file (ms), from the start response — the
  // playbar's end time. The element's own duration is stream-relative on
  // RESUMEd REMUX/TRANSCODE, which would show a shortened total.
  const [absoluteDurationMs, setAbsoluteDurationMs] = useState(0);
  // Live mirror of the remembered quality pref: the menu checkmark must
  // re-render the moment the pref changes, and the frozen `prefs` memo can't.
  const [qualitySelection, setQualitySelection] = useState<TrackPrefs["quality"] | undefined>(
    () => loadTrackPrefs().quality ?? undefined,
  );
  const userInteractedRef = useRef(false);
  const userPausedRef = useRef(false);
  const [title, setTitle] = useState<string | null>(null);

  // Caps for the current quality selection — null for a fresh user or an
  // "Original" pick means the device profile's own ceiling applies.
  const qualityCaps = useMemo(() => {
    const q = qualitySelection;
    if (!q || q.maxWidth == null || q.maxHeight == null || q.maxVideoBitrateKbps == null) return null;
    return { maxWidth: q.maxWidth, maxHeight: q.maxHeight, maxVideoBitrateKbps: q.maxVideoBitrateKbps };
  }, [qualitySelection]);

  // Which menu entry is active: the remembered label when it's still a valid
  // option, else the remembered caps matched against the option set.
  const selectedQuality = useMemo(() => {
    const q = qualitySelection;
    if (!q || q.maxWidth == null) return QUALITY_OPTIONS[0].label;
    const byCaps = QUALITY_OPTIONS.find((o) => o.maxWidth === q.maxWidth && o.maxHeight === q.maxHeight);
    return byCaps?.label ?? q.label;
  }, [qualitySelection]);

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
            deviceProfile: qualityCaps ? { ...BROWSER_DEVICE_PROFILE, ...qualityCaps } : BROWSER_DEVICE_PROFILE,
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
        setAbsoluteDurationMs(data.absoluteDurationMs ?? 0);
        // The video timeline is relative to where playback resumed, but the
        // server speaks media-absolute time. Track the offset so every
        // position the client sends (seek, audio switch, heartbeat) can be
        // converted back to media time.
        // - TRANSCODE: playlist starts at the resume segment — offset is the
        //   exact keyframe the server's seek landed on (actualStartMs);
        //   no client seek needed (media sequence handles it).
        // - REMUX: the file starts at the keyframe at-or-before the resume
        //   point — offset is that point, so no client seek either.
        // - DIRECT_PLAY: the file is the media itself — offset 0, seek to
        //   the exact resume once the file opens.
        if (data.method === "TRANSCODE" || data.method === "REMUX") {
          // The stream starts at the anchored point (keyframe or its segment
          // boundary); the video timeline is relative to it. Self-seek the
          // gap so continue-watching resumes on the exact stored position —
          // the anchored stream starts at-or-before it, so the seek is small
          // (within the first TRANSCODE segment; the REMUX file is served
          // only once complete).
          const anchor =
            data.actualStartMs ??
            (data.method === "TRANSCODE"
              ? Math.floor(data.resumePositionMs / (HLS_SEGMENT_SECONDS * 1000)) * HLS_SEGMENT_SECONDS * 1000
              : data.resumePositionMs);
          applyTimelineOffset(anchor);
          if (data.resumePositionMs - anchor > 1000) {
            pendingSeekRef.current = (data.resumePositionMs - anchor) / 1000;
          }
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
      // Media-absolute duration: the element's duration is stream-relative on
      // resumed streams; adding the timeline offset yields the file's total.
      const durationMs = player.duration ? Math.round(player.duration * 1000 + timelineOffsetRef.current) : undefined;
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

  // Unifies every restart path (seek / audio / quality): the server responds
  // with the method, the exact media time the new stream starts at
  // (actualStartMs — the keyframe or the keyframe's segment boundary), and
  // the playlist's first segment. The video timeline rebases to zero at the
  // restart point, so the offset moves to the anchor and a self-seek lands on
  // the pre-restart position. All three handlers used to duplicate this.
  const applyRestart = useCallback(
    (method: PlaybackStart["method"], segmentFrom: number | null, actualStartMs: number | null | undefined, targetMs: number) => {
      if (method === "DIRECT_PLAY") {
        // The file itself is the media: offset 0, seek to the exact target.
        applyTimelineOffset(0);
        pendingSeekRef.current = targetMs / 1000;
        return;
      }
      if (method === "TRANSCODE") {
        // The playlist's MEDIA-SEQUENCE starts at the anchored segment, so
        // the timeline origin is exactly segmentFrom * segment seconds.
        const newOffset = actualStartMs ?? (segmentFrom ?? 0) * HLS_SEGMENT_SECONDS * 1000;
        applyTimelineOffset(newOffset);
        pendingSeekRef.current = (targetMs - newOffset) / 1000;
        return;
      }
      // REMUX: the restarted file starts at the keyframe at-or-before the
      // target (actualStartMs) — the file's own start is the timeline origin.
      const newOffset = actualStartMs ?? targetMs;
      applyTimelineOffset(newOffset);
      pendingSeekRef.current = (targetMs - newOffset) / 1000;
    },
    [applyTimelineOffset],
  );

  // User-committed scrub, fired at the gesture (pointerup/keydown), never
  // from media events. The server is the source of truth for where the stream
  // restarts; the local video seek is just instant feedback while the target
  // is buffered. No dependence on hls.js firing `seeked` — an event that a
  // clamped or no-op seek (click at the current position, backward below the
  // resume point) never produces, which silently ate scrubs.
  const commitSeek = useCallback((mediaTimeMs: number) => {
    if (!Number.isFinite(mediaTimeMs)) return;
    seekQueueRef.current = Math.max(0, Math.round(mediaTimeMs));
    if (seekTimerRef.current === null) {
      seekTimerRef.current = window.setTimeout(() => {
        seekTimerRef.current = null;
        pumpSeek(0);
      }, 200);
    }
  }, []);

  const pumpSeek = useCallback(
    (attempt: number) => {
      const session = startRef.current;
      if (!session || session.method === "DIRECT_PLAY") {
        seekQueueRef.current = null;
        return;
      }
      if (seekInFlightRef.current) return;
      const target = seekQueueRef.current;
      if (target === null) return;
      seekQueueRef.current = null;
      seekInFlightRef.current = true;
      const sessionId = session.sessionId;
      api
        .POST("/playback/{sessionId}/seek", {
          params: { path: { sessionId } },
          body: { positionMs: target },
        })
        .then(({ data, response }) => {
          seekInFlightRef.current = false;
          // Session died underneath (stop / tab close / re-login) — its
          // offsets describe a state nobody wants anymore.
          if (startRef.current?.sessionId !== sessionId) {
            seekQueueRef.current = null;
            return;
          }
          if (response?.status === 503 && attempt < 5) {
            // Transcoder cap: the old child is already dead from the 503
            // path server-side — re-queue and keep trying so the seek lands
            // instead of parking the video at the target forever. Never
            // clobber a newer commit that queued during the flight.
            if (seekQueueRef.current === null) seekQueueRef.current = target;
            window.setTimeout(() => pumpSeek(attempt + 1), 1000);
            return;
          }
          if (data?.restarted) {
            applyRestart(startRef.current.method, data.segmentFrom ?? null, data.actualStartMs, target);
            setSrcNonce((n) => n + 1);
          }
          // A newer commit queued mid-flight: pump it now that the slot is free.
          if (seekQueueRef.current !== null) window.setTimeout(() => pumpSeek(0), 50);
        })
        .catch(() => {
          // Transient network failure: the queue stays available for the
          // next scrub; the video keeps playing the buffered position.
          seekInFlightRef.current = false;
        });
    },
    [applyRestart],
  );

  // Drop a pending debounce when the player unmounts (tab close, error).
  useEffect(
    () => () => {
      if (seekTimerRef.current !== null) window.clearTimeout(seekTimerRef.current);
      seekQueueRef.current = null;
    },
    [],
  );
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
          if (!data) return;
          // Restart responses always carry the method and the exact anchored
          // stream start; rebase the timeline and self-seek to the exact
          // pre-switch position on the fresh timeline.
          applyRestart(start.method, data.segmentFrom, data.actualStartMs, positionMs);
          // A restart is explicit intent to keep watching: the menu/slider click
          // that triggered it bubbles into vidstack's click-to-toggle and lands
          // as a *trusted* pause during the teardown, which would otherwise
          // silence the autoplay resume below.
          userPausedRef.current = false;
          // Audio switches never change the method (the server restarts with
          // live.method) — a src bust reloads the pipeline without the full
          // key remount that visibly "refreshed" the player.
          setSrcNonce((n) => n + 1);
        })
        .catch((err: Error) => setError(err.message));
    },
    [start, audioTracks, applyTimelineOffset, applyRestart],
  );

  const handleCanPlay = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (pendingSeekRef.current !== null) {
      // Clamp defensively: a restart that anchored past the element's
      // duration (end-of-file remux) would otherwise park playback at a
      // position the media can't reach.
      const target = pendingSeekRef.current;
      pendingSeekRef.current = null;
      const max = Number.isFinite(player.duration) ? player.duration : Infinity;
      player.currentTime = Math.max(0, Math.min(target, max));
    }
    // Autoplay: navigating into /watch carries the user activation from the
    // detail-page click (same-document navigation), so play() normally
    // succeeds; when the browser blocks it (NotAllowedError) the big play
    // button is the fallback. A deliberate user pause silences this for
    // later restarts — src reloads (seek/quality switches) fire canPlay
    // again and must not fight the paused state.
    if (!userPausedRef.current) {
      player.play().catch(() => {});
    }
  }, []);

  // Quality switch — restarts the server-side encode at new caps (the server
  // decides REMUX vs TRANSCODE for the new resolution) and swaps src on the
  // fresh timeline, mirroring the audio-track switch flow.
  const handleQualityChange = useCallback(
    (label: string) => {
      const opt = QUALITY_OPTIONS.find((o) => o.label === label);
      if (!opt) return;
      saveQualityPref({
        label: opt.label,
        maxWidth: opt.maxWidth ?? null,
        maxHeight: opt.maxHeight ?? null,
        maxVideoBitrateKbps: opt.maxVideoBitrateKbps ?? null,
      });
      // Mirror to state so the checkmark moves immediately with the click.
      setQualitySelection({
        label: opt.label,
        maxWidth: opt.maxWidth ?? null,
        maxHeight: opt.maxHeight ?? null,
        maxVideoBitrateKbps: opt.maxVideoBitrateKbps ?? null,
      });
      if (!start) return;
      // The video timeline starts at the resume point (media-absolute), not
      // zero — convert before telling the server where to restart.
      const positionMs = Math.round((playerRef.current?.currentTime ?? 0) * 1000 + timelineOffsetRef.current);
      api
        .POST("/playback/{sessionId}/quality", {
          params: { path: { sessionId: start.sessionId } },
          body: opt.reset
            ? { positionMs, reset: true }
            : {
                positionMs,
                maxWidth: opt.maxWidth,
                maxHeight: opt.maxHeight,
                maxVideoBitrateKbps: opt.maxVideoBitrateKbps,
              },
        })
        .then(({ data, error }) => {
          if (error) throw new Error("quality switch failed");
          if (!data?.restarted) return;
          // The method can change (REMUX -> TRANSCODE when the new caps are
          // below the source resolution, TRANSCODE -> DIRECT_PLAY on reset) —
          // swap the src accordingly, then rebase like any other restart.
          setStart((prev) =>
            prev
              ? { ...prev, method: data.method, playlistUrl: data.playlistUrl, streamUrl: data.streamUrl }
              : prev,
          );
          applyRestart(data.method, data.segmentFrom, data.actualStartMs, positionMs);
          // See audio switch: restart = explicit intent to keep watching; the
          // triggering click's trusted pause must not silence the resume.
          userPausedRef.current = false;
          setSrcNonce((n) => n + 1);
          if (data.method !== start.method) setKeyNonce((n) => n + 1);
        })
        .catch((err: Error) => setError(err.message));
    },
    [start, applyTimelineOffset, applyRestart],
  );

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

  const src =
    start?.method === "DIRECT_PLAY"
      ? { src: `/media-files/${mediaFileId}/direct`, type: "video/mp4" as const }
      : start?.method === "REMUX" && start.streamUrl
        ? {
            // Native <video> + range requests against the live remux — no
            // MSE, which is exactly why HEVC works here. Restarts (seek past
            // the written frontier, audio switch) truncate and rewrite the
            // file, so the nonce forces a fresh open.
            src: srcNonce > 0 ? `${start.streamUrl}?r=${srcNonce}` : start.streamUrl,
            type: "video/mp4" as const,
          }
        : start?.playlistUrl
          ? {
              src: srcNonce > 0 ? `${start.playlistUrl}?r=${srcNonce}` : start.playlistUrl,
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

  const qualityMenu = start ? (
    <DefaultMenuSection label="Quality">
      <DefaultMenuRadioGroup
        value={selectedQuality}
        options={QUALITY_OPTIONS.map((o) => ({ label: o.label, value: o.label }))}
        onChange={handleQualityChange}
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
          key={keyNonce}
          ref={playerRef}
          className="h-full w-full"
          src={src}
          playsInline
          title={title ?? "hokago"}
          onProviderChange={handleProviderChange}
          onCanPlay={handleCanPlay}
          onPlay={() => {
            userInteractedRef.current = true;
            userPausedRef.current = false;
          }}
          onTextTrackChange={handleTextTrackChange}
          onAudioTrackChange={handleNativeAudioTrackChange}
          onPause={(event) => {
            // A real user pressing pause must silence autoplay for later
            // restarts (seek/quality reloads fire canPlay again) — programmatic
            // pauses (src reloads, tab throttling) must not.
            if (event.isOriginTrusted) {
              userPausedRef.current = true;
            }
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
                  durationMs: player.duration
                    ? Math.round(player.duration * 1000 + timelineOffsetRef.current)
                    : undefined,
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
          <DefaultVideoLayout
            icons={defaultLayoutIcons}
            slots={{
              currentTime: (
                <PlayerTimeClock
                  kind="current"
                  playerRef={playerRef}
                  offsetMs={timelineOffsetMs}
                  absoluteDurationMs={absoluteDurationMs}
                />
              ),
              timeDivider: <span className="opacity-60">/</span>,
              endTime: (
                <PlayerTimeClock
                  kind="end"
                  playerRef={playerRef}
                  offsetMs={timelineOffsetMs}
                  absoluteDurationMs={absoluteDurationMs}
                />
              ),
              timeSlider: (
                <AbsoluteTimeSlider
                  playerRef={playerRef}
                  offsetMs={timelineOffsetMs}
                  absoluteDurationMs={absoluteDurationMs}
                  onScrub={commitSeek}
                />
              ),
              settingsMenuItemsEnd: (
                <>
                  {qualityMenu}
                  {serverAudioMenu}
                </>
              ),
            }}
          />
        </MediaPlayer>
      ) : (
        <div className="flex h-full w-full items-center justify-center text-sm text-white/70">
          Starting playback…
        </div>
      )}
    </div>
  );
}
