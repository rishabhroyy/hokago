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
  type MediaErrorDetail,
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

import type {
  StartPlaybackResponse as PlaybackStart,
  AudioTrackSwitchBody,
} from "@hokago/contract/playback";
import type { SubtitleTrackInfo, AudioTrackInfo, FontDescriptor as FontInfo, MediaFileTrickplayResponse as TrickplayIndex } from "@hokago/contract/media-files";
import { api } from "./api-client";
import { BROWSER_DEVICE_PROFILE } from "./device-profile";
import { getPrimaryProfile } from "./profile";
import { clearDetailCache, fetchMediaItemDetail } from "./browse-api";
import { paths, useRouter } from "./router";
import { Icon } from "./ui/icons";
import { loadTrackPrefs, matchAudioPref, matchSubtitlePref, saveAudioPref, saveQualityPref, saveSubtitlePref, type TrackPrefs } from "./track-prefs";
import { audioTrackLabel } from "./language-names";
import { useJassubRenderer } from "./useJassubRenderer";

// An empty WebVTT that vidstack loads (so the track is a real, selectable entry
// in the stock captions menu) but which draws nothing — JASSUB does the actual
// ASS rendering. Registering our subtitles this way lets the default player UI
// own switching/off while keeping libass as the renderer.
const EMPTY_VTT = "data:text/vtt," + encodeURIComponent("WEBVTT\n\n");

// Heartbeat cadence — server-side resume + continue-watching depend on it,
// and the API's idle reaper uses it to tell "paused in a tab" from "dead".
const HEARTBEAT_MS = 10_000;

// Mirrors HLS_SEGMENT_SECONDS in packages/ffmpeg (Node-only, not importable
// here): transcode playlists are numbered in segment units, so the playlist's
// first segment index (segmentFrom) is derived from this.
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
  trickplay,
}: {
  playerRef: RefObject<MediaPlayerInstance | null>;
  offsetMs: number;
  absoluteDurationMs: number;
  onScrub: (mediaTimeMs: number) => void;
  trickplay: TrickplayIndex | null;
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

  // The tile under the hover position. Sheet generation is grid-aligned to
  // the absolute 10s grid (tile N of sheet M = (M*tilesPerSheet + N) *
  // intervalMs of media time), so this is pure arithmetic — no VTT needed.
  // object-position cropping: pct = tile/(tiles-1) along each axis (guarded
  // for 1-column/1-row sheets where the division is undefined).
  const hoverTile = useMemo(() => {
    if (!trickplay || pointerPct === null) return null;
    const mediaSec = (pointerPct / 100) * endSec;
    const tileIndex = Math.floor((mediaSec * 1000) / trickplay.intervalMs);
    const totalTiles = trickplay.sheets.reduce((sum, s) => sum + s.tiles, 0);
    if (totalTiles === 0) return null;
    const i = Math.min(tileIndex, totalTiles - 1);
    const sheetIndex = Math.floor(i / trickplay.tilesPerSheet);
    const sheet = trickplay.sheets[sheetIndex];
    if (!sheet) return null;
    const inSheet = i % trickplay.tilesPerSheet;
    const col = inSheet % trickplay.cols;
    const rows = Math.ceil(sheet.tiles / trickplay.cols);
    const row = Math.floor(inSheet / trickplay.cols);
    return {
      sheet,
      col,
      row,
      position: `${(trickplay.cols > 1 ? col / (trickplay.cols - 1) : 0) * 100}% ${(rows > 1 ? row / (rows - 1) : 0) * 100}%`,
    };
  }, [trickplay, pointerPct, endSec]);

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
        {hoverTile && trickplay && (
          <img
            src={hoverTile.sheet.url}
            alt=""
            draggable={false}
            // Sprite crop via object-fit:none: the sheet renders at its
            // intrinsic 5xN grid, object-position slides the tile into view.
            // Displayed at half the tile's native size (sharp on retina).
            style={{
              width: Math.round(trickplay.tileWidth / 2),
              height: Math.round(trickplay.tileHeight / 2),
              objectFit: "none",
              objectPosition: hoverTile.position,
              borderRadius: 6,
              pointerEvents: "none",
            }}
          />
        )}
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
  // Playback never started (bad /start, auth, 404 after retries). No player
  // exists yet, so there is nothing to retry in place.
  const [error, setError] = useState<string | null>(null);
  // Mid-playback failure (stream/segment death, switch failure) — the player
  // stays mounted underneath so Try again reloads against the same session.
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [subtitleError, setSubtitleError] = useState(false);
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
  // Live mirror of srcNonce for the seek machinery — bumping must never depend
  // on a state value the commit callback might close over stale.
  const srcNonceRef = useRef(0);
  const [fonts, setFonts] = useState<FontInfo[]>([]);
  // Scrubber-preview index; null until fetched/absent (no sheets generated
  // yet) — the slider just shows the clock until this arrives.
  const [trickplay, setTrickplay] = useState<TrickplayIndex | null>(null);
  const playerRef = useRef<MediaPlayerInstance>(null);
  // Client-side seek applied on the next canplay after a restart. Tagged with
  // the src nonce the seek was issued for: two restarts committed before the
  // first canplay (rapid scrubs, a scrub mid audio-switch) must never apply
  // the newer target onto the older stream's rebased timeline.
  const pendingSeekRef = useRef<{ targetSec: number; nonce: number } | null>(null);
  // Live mirror of `start` for the restart machinery below — it must never
  // depend on a state value the commit callback might close over stale.
  const startRef = useRef(start);
  useEffect(() => {
    startRef.current = start;
  }, [start]);
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
  // Subtitle worker/track failures surface a dismissible banner — not the
  // full recovery card — because they don't take the stream down.
  const handleSubtitleRenderFailed = useCallback(() => {
    setSubtitleError(true);
  }, []);

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

  // Live copy of the active subtitle track (id, or null = off), fed by the
  // player's text-track-change and seeded from the player's own active track
  // while still unset. This — not the remembered pref — is what a player
  // remount (quality method change) re-applies via the Track `default` prop,
  // so a manual selection survives a full player teardown instead of snapping
  // back to the pref. JASSUB follows the same value.
  const [subtitleSelection, setSubtitleSelection] = useState<string | null | undefined>(undefined);
  const activeTextTrack = useMediaState("textTrack", playerRef);
  useEffect(() => {
    if (subtitleSelection === undefined && activeTextTrack) {
      setSubtitleSelection(activeTextTrack.id ?? null);
    }
  }, [activeTextTrack, subtitleSelection]);
  const trackDefaultId = subtitleSelection === undefined ? defaultSubtitleId : subtitleSelection;

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
    // The <video> element itself is derived from the mounted player DOM below
    // (see the videoEl effect), not from this callback — a torn-down mount's
    // provider-change can fire late with its stale element, and JASSUB would
    // attach to a detached video forever.
  }, []);

  // The provider's <video> arrives a beat after the player subtree mounts
  // (and again after every keyNonce remount). Poll the mounted player for it
  // rather than trusting provider-change callbacks (see above). Bound the
  // attempts: if the src fails to load there is no video, and the error card
  // owns the failure story then.
  useEffect(() => {
    let raf = 0;
    let attempts = 0;
    const tick = () => {
      const video = (playerRef.current?.el?.querySelector("video") as HTMLVideoElement | null) ?? null;
      if (video?.isConnected) {
        setVideoEl((prev) => (prev === video ? prev : video));
        return;
      }
      if (++attempts < 120) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [keyNonce, start?.method]);

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
    api
      .GET("/media-files/{id}/trickplay", { params: { path: { id: mediaFileId } } })
      .then(({ data }) => {
        if (!cancelled && data) setTrickplay(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mediaFileId, prefs.audio]);

  // JASSUB renders ASS client-side — attached directly to the underlying
  // <video>, independent of DIRECT_PLAY/REMUX/TRANSCODE, since libass just
  // needs the video element's clock, not its source. Lifecycle (creation,
  // offset lockstep, seek force-renders, failure surfacing) lives in the hook.
  useJassubRenderer({
    videoEl,
    subtitleId: subtitleSelection ?? null,
    subtitles: renderable,
    mediaFileId,
    fonts,
    timelineOffsetMs,
    onRenderFailed: handleSubtitleRenderFailed,
  });

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
        // - TRANSCODE: accurate seek starts the stream at the exact resume
        //   position (actualStartMs) — frame-exact, no client seek needed.
        // - REMUX: the file starts at the keyframe at-or-before the resume
        //   point — offset is that point, so no client seek either.
        // - DIRECT_PLAY: the file is the media itself — offset 0, seek to
        //   the exact resume once the file opens.
        if (data.method === "TRANSCODE" || data.method === "REMUX") {
          // The stream starts at the anchored point; the video timeline is
          // relative to it. Self-seek the gap so continue-watching resumes on
          // the exact stored position — the anchored stream starts at-or-
          // before it, so the seek is small (within the first TRANSCODE
          // segment; the REMUX file is served only once complete).
          const anchor =
            data.actualStartMs ??
            (data.method === "TRANSCODE"
              ? Math.floor(data.resumePositionMs / (HLS_SEGMENT_SECONDS * 1000)) * HLS_SEGMENT_SECONDS * 1000
              : data.resumePositionMs);
          applyTimelineOffset(anchor);
          if (data.resumePositionMs - anchor > 1000) {
            pendingSeekRef.current = { targetSec: (data.resumePositionMs - anchor) / 1000, nonce: srcNonceRef.current };
          }
        } else if (data.resumePositionMs > 0) {
          pendingSeekRef.current = { targetSec: data.resumePositionMs / 1000, nonce: srcNonceRef.current };
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
  // (actualStartMs — the precise target for TRANSCODE, the keyframe at-or-
  // before it for REMUX), and the playlist's first segment. The video
  // timeline rebases to zero at the restart point, so the offset moves to the
  // anchor and a self-seek lands on the pre-restart position. The seek is
  // tagged with the src nonce it will load under — a canplay from any other
  // load must not apply it (see handleCanPlay).
  const applyRestart = useCallback(
    (method: PlaybackStart["method"], segmentFrom: number | null, actualStartMs: number | null | undefined, targetMs: number) => {
      if (method === "DIRECT_PLAY") {
        // The file itself is the media: offset 0, seek to the exact target.
        applyTimelineOffset(0);
        pendingSeekRef.current = { targetSec: targetMs / 1000, nonce: srcNonceRef.current };
        return;
      }
      if (method === "TRANSCODE") {
        // The stream's accurate seek lands exactly on the target, so the
        // timeline origin is actualStartMs (== targetMs for seeks) and the
        // self-seek is a no-op; the fallback keeps older servers working.
        const newOffset = actualStartMs ?? (segmentFrom ?? 0) * HLS_SEGMENT_SECONDS * 1000;
        applyTimelineOffset(newOffset);
        pendingSeekRef.current = { targetSec: (targetMs - newOffset) / 1000, nonce: srcNonceRef.current };
        return;
      }
      // REMUX: the restarted file starts at the keyframe at-or-before the
      // target (actualStartMs) — the file's own start is the timeline origin.
      const newOffset = actualStartMs ?? targetMs;
      applyTimelineOffset(newOffset);
      pendingSeekRef.current = { targetSec: (targetMs - newOffset) / 1000, nonce: srcNonceRef.current };
    },
    [applyTimelineOffset],
  );

  // --- Serialized restart pump ----------------------------------------------
  // Every server-side stream restart (seek / audio track / quality switch)
  // funnels through ONE latest-wins queue. Rapid scrubs, or a scrub landing
  // mid audio-switch, used to fire overlapping restarts at ffmpeg: each kills
  // the previous child and answers with its own timeline anchor, and whichever
  // response won the race could rebase the client onto a server state that
  // was already replaced — the clock then drifted by the whole keyframe gap.
  // Now a response is only applied while it still describes the latest
  // committed request; everything else just pumps the newer one.
  type RestartOutcome = {
    ok: boolean;
    retryable?: boolean;
    message?: string;
    restarted?: boolean;
    method?: PlaybackStart["method"];
    segmentFrom?: number | null;
    actualStartMs?: number | null;
    playlistUrl?: string | null;
    streamUrl?: string | null;
  };
  type RestartRequest = {
    id: number;
    attempt: number;
    maxRetries: number;
    targetMs: number;
    run: () => Promise<RestartOutcome>;
    apply: (outcome: RestartOutcome) => void;
    onFail?: (message: string) => void;
  };
  const restartLatestRef = useRef<RestartRequest | null>(null);
  const restartBusyRef = useRef(false);
  const restartIdRef = useRef(0);
  // Latest debounced scrub target + its pending debounce timer.
  const seekTargetRef = useRef(0);
  const seekDebounceRef = useRef<number | null>(null);

  const bumpSrcNonce = useCallback(() => {
    srcNonceRef.current += 1;
    setSrcNonce(srcNonceRef.current);
  }, []);

  const pumpRestart = useCallback(async () => {
    if (restartBusyRef.current) return;
    const req = restartLatestRef.current;
    if (!req || !startRef.current) {
      restartLatestRef.current = null;
      return;
    }
    restartLatestRef.current = null;
    restartBusyRef.current = true;
    let requeueDelay: number | null = null;
    try {
      const outcome = await req.run();
      if (restartLatestRef.current !== null) {
        // A newer request was committed mid-flight — this response describes
        // an intermediate server state that the newer request already
        // superseded. Never apply it (a transient wrong rebase); pump the
        // newer request now that the slot is free.
      } else if (outcome.retryable && req.attempt < req.maxRetries) {
        // Transcoder cap: the old child is already dead from the 503 path
        // server-side — re-queue and keep trying so the request lands
        // instead of parking the video at the target forever. The
        // `restartLatestRef === null` check above already proved no newer
        // commit clobbered the slot.
        restartLatestRef.current = { ...req, attempt: req.attempt + 1 };
        requeueDelay = 1000;
      } else if (outcome.ok) {
        req.apply(outcome);
      } else {
        req.onFail?.(outcome.message ?? "playback restart failed");
      }
    } catch {
      if (restartLatestRef.current === null) req.onFail?.("playback restart failed");
    } finally {
      restartBusyRef.current = false;
      if (restartLatestRef.current) {
        if (requeueDelay !== null) window.setTimeout(() => void pumpRestart(), requeueDelay);
        else void pumpRestart();
      }
    }
  }, []);

  const commitRestart = useCallback(
    (req: Omit<RestartRequest, "id">) => {
      restartLatestRef.current = { ...req, id: ++restartIdRef.current };
      void pumpRestart();
    },
    [pumpRestart],
  );

  // A server-side seek. The local video seek (instant feedback) already
  // happened in AbsoluteTimeSlider; this is where the stream actually restarts
  // when the target is beyond what's written/buffered.
  const buildSeekRequest = useCallback(
    (targetMs: number): Omit<RestartRequest, "id"> => ({
      attempt: 0,
      maxRetries: 5,
      targetMs,
      run: async () => {
        const sessionId = startRef.current?.sessionId;
        // DIRECT_PLAY seeks are purely local (the file is the media).
        if (!sessionId || startRef.current?.method === "DIRECT_PLAY") return { ok: true, restarted: false };
        const { data, response } = await api.POST("/playback/{sessionId}/seek", {
          params: { path: { sessionId } },
          body: { positionMs: targetMs },
        });
        // Session ended underneath (stop / tab close / re-login) — its
        // offsets describe a state nobody wants anymore.
        if (startRef.current?.sessionId !== sessionId) return { ok: true, restarted: false };
        if (response?.status === 503) return { ok: false, retryable: true, message: "transcoder busy" };
        return {
          ok: true,
          restarted: data?.restarted ?? false,
          segmentFrom: data?.segmentFrom ?? null,
          actualStartMs: data?.actualStartMs ?? null,
        };
      },
      apply: (outcome) => {
        if (!outcome.restarted || !startRef.current) return;
        // Bump before rebasing so the pending seek is tagged with the nonce
        // the reloading src will actually load under.
        bumpSrcNonce();
        applyRestart(startRef.current.method, outcome.segmentFrom ?? null, outcome.actualStartMs ?? null, targetMs);
      },
    }),
    [applyRestart, bumpSrcNonce],
  );

  // User-committed scrub, fired at the gesture (pointerup/keydown), never
  // from media events. The server is the source of truth for where the stream
  // restarts; the local video seek is just instant feedback while the target
  // is buffered. Debounced so held arrow keys / rapid scrubs coalesce into
  // one restart (each takes ~a second to yield its first segment).
  const commitSeek = useCallback(
    (mediaTimeMs: number) => {
      if (!Number.isFinite(mediaTimeMs)) return;
      seekTargetRef.current = Math.max(0, Math.round(mediaTimeMs));
      if (seekDebounceRef.current === null) {
        seekDebounceRef.current = window.setTimeout(() => {
          seekDebounceRef.current = null;
          commitRestart(buildSeekRequest(seekTargetRef.current));
        }, 200);
      }
    },
    [commitRestart, buildSeekRequest],
  );

  // Drop a pending debounce + queued restart when the player unmounts (tab
  // close, error).
  useEffect(
    () => () => {
      if (seekDebounceRef.current !== null) window.clearTimeout(seekDebounceRef.current);
      restartLatestRef.current = null;
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
      const session = startRef.current;
      if (!session || session.method === "DIRECT_PLAY") return;
      // The video timeline starts at the resume point (media-absolute), not
      // zero — convert before telling the server where to restart.
      const positionMs = Math.round((playerRef.current?.currentTime ?? 0) * 1000 + timelineOffsetRef.current);
      const sessionId = session.sessionId;
      commitRestart({
        attempt: 0,
        maxRetries: 1,
        targetMs: positionMs,
        run: async () => {
          const body: AudioTrackSwitchBody = { audioStreamIndex: absoluteIndex, positionMs };
          const { data, response } = await api.POST("/playback/{sessionId}/audio-track", {
            params: { path: { sessionId } },
            body,
          });
          if (response?.status === 503) return { ok: false, retryable: true, message: "transcoder busy — audio switch retried" };
          if (!data) return { ok: false, retryable: false, message: "audio switch failed" };
          return { ok: true, restarted: data.restarted, segmentFrom: data.segmentFrom, actualStartMs: data.actualStartMs };
        },
        apply: (outcome) => {
          if (!outcome.restarted || !startRef.current) return;
          // A restart is explicit intent to keep watching: the menu/slider click
          // that triggered it bubbles into vidstack's click-to-toggle and lands
          // as a *trusted* pause during the teardown, which would otherwise
          // silence the autoplay resume below.
          userPausedRef.current = false;
          // Audio switches never change the method (the server restarts with
          // live.method) — a src bust reloads the pipeline without the full
          // key remount that visibly "refreshed" the player.
          bumpSrcNonce();
          applyRestart(startRef.current.method, outcome.segmentFrom ?? null, outcome.actualStartMs ?? null, positionMs);
        },
        onFail: (message) => setPlayerError(message),
      });
    },
    [audioTracks, commitRestart, applyRestart, bumpSrcNonce],
  );

  const handleCanPlay = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    const pending = pendingSeekRef.current;
    // Only apply a pending seek to the src it was issued for: a canplay from
    // a superseded load (a newer restart already bumped the nonce) must not
    // rebase playback onto the wrong timeline. A stuck stale seek is also
    // harmless to keep — every restart overwrites it before its own canplay.
    if (pending && pending.nonce === srcNonceRef.current) {
      pendingSeekRef.current = null;
      // Clamp defensively: a restart that anchored past the element's
      // duration (end-of-file remux) would otherwise park playback at a
      // position the media can't reach.
      const max = Number.isFinite(player.duration) ? player.duration : Infinity;
      player.currentTime = Math.max(0, Math.min(pending.targetSec, max));
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
      const session = startRef.current;
      if (!session) return;
      // The video timeline starts at the resume point (media-absolute), not
      // zero — convert before telling the server where to restart.
      const positionMs = Math.round((playerRef.current?.currentTime ?? 0) * 1000 + timelineOffsetRef.current);
      const sessionId = session.sessionId;
      commitRestart({
        attempt: 0,
        maxRetries: 1,
        targetMs: positionMs,
        run: async () => {
          const { data, response } = await api.POST("/playback/{sessionId}/quality", {
            params: { path: { sessionId } },
            body: opt.reset
              ? { positionMs, reset: true }
              : {
                  positionMs,
                  maxWidth: opt.maxWidth,
                  maxHeight: opt.maxHeight,
                  maxVideoBitrateKbps: opt.maxVideoBitrateKbps,
                },
          });
          if (response?.status === 503) return { ok: false, retryable: true, message: "transcoder busy — quality switch retried" };
          if (!data?.restarted) return { ok: true, restarted: false };
          return {
            ok: true,
            restarted: true,
            method: data.method,
            segmentFrom: data.segmentFrom,
            actualStartMs: data.actualStartMs,
            playlistUrl: data.playlistUrl,
            streamUrl: data.streamUrl,
          };
        },
        apply: (outcome) => {
          if (!outcome.restarted || !startRef.current) return;
          const prevMethod = startRef.current.method;
          const method = outcome.method ?? prevMethod;
          // The method can change (REMUX -> TRANSCODE when the new caps are
          // below the source resolution, TRANSCODE -> DIRECT_PLAY on reset) —
          // swap the src accordingly (fresh subtree: vidstack can't hot-swap
          // native <video> and MSE), then rebase like any other restart.
          if (method !== prevMethod) {
            setStart((prev) =>
              prev
                ? { ...prev, method, playlistUrl: outcome.playlistUrl ?? null, streamUrl: outcome.streamUrl ?? null }
                : prev,
            );
            setKeyNonce((n) => n + 1);
          }
          // See audio switch: restart = explicit intent to keep watching; the
          // triggering click's trusted pause must not silence the resume.
          userPausedRef.current = false;
          bumpSrcNonce();
          applyRestart(method, outcome.segmentFrom ?? null, outcome.actualStartMs ?? null, positionMs);
        },
        onFail: (message) => setPlayerError(message),
      });
    },
    [commitRestart, applyRestart, bumpSrcNonce],
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

  // The captions menu is the source of truth for which sub is active. Feed
  // the live selection from every change (auto + user): on a player remount
  // the fresh tracks re-apply the selection as `default`, so a manual choice
  // survives a full teardown. Persist only genuine user choices — auto
  // selection and programmatic changes fire no user gesture, so
  // hasTriggerEvent keeps them out.
  const handleTextTrackChange = useCallback((detail: TextTrack | null, nativeEvent: MediaTextTrackChangeEvent) => {
    setSubtitleSelection(detail?.id ?? null);
    if (!userInteractedRef.current && !isUserGesture(nativeEvent)) return;
    saveSubtitlePref(detail ? { id: detail.id, lang: detail.language || null, title: detail.label || null } : null);
  }, []);

  const handleNativeAudioTrackChange = useCallback((detail: AudioTrack | null, nativeEvent: MediaAudioTrackChangeEvent) => {
    if (!detail) return;
    if (!userInteractedRef.current && !isUserGesture(nativeEvent)) return;
    saveAudioPref({ streamIndex: null, id: detail.id, lang: detail.language || null, title: detail.label || null });
  }, []);

  // A stream died mid-playback (hls.js fatal, element error, dead session).
  // Park the restart queue — its targets describe a broken pipeline — and
  // surface a recovery card; the player stays mounted underneath so Try again
  // reloads against the same session instead of starting from scratch.
  const handleMediaError = useCallback((detail: MediaErrorDetail) => {
    restartLatestRef.current = null;
    pendingSeekRef.current = null;
    setPlayerError(detail.message || `playback error${detail.code ? ` (${detail.code})` : ""}`);
  }, []);

  const retryPlayback = useCallback(() => {
    setPlayerError(null);
    userPausedRef.current = false;
    const player = playerRef.current;
    const targetMs =
      player && Number.isFinite(player.currentTime)
        ? Math.round(player.currentTime * 1000 + timelineOffsetRef.current)
        : 0;
    const method = startRef.current?.method;
    if (method === "DIRECT_PLAY") {
      // The src is the file itself and unchanged — a nonce or src reload is a
      // no-op, so remount the player; the pending seek resumes the position.
      pendingSeekRef.current = { targetSec: targetMs / 1000, nonce: srcNonceRef.current };
      setKeyNonce((n) => n + 1);
      return;
    }
    // TRANSCODE/REMUX: reload the current src (a transient hiccup heals with a
    // plain reload) *and* commit a seek-restart, which respawns a dead ffmpeg
    // child server-side — the reload alone would fail exactly the same way.
    bumpSrcNonce();
    commitRestart(buildSeekRequest(targetMs));
  }, [buildSeekRequest, commitRestart, bumpSrcNonce]);

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
      ) : (
        <>
          {/* Recovery card: the player stays mounted underneath so Try again
              reloads against the same session instead of starting from scratch. */}
          {src && playerError && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black/80 text-white">
              <div className="text-sm text-white/80">Playback stopped.</div>
              <div className="max-w-md px-6 text-center text-xs text-white/50">{playerError}</div>
              <div className="flex gap-3">
                <button
                  className="rounded-full bg-white/90 px-5 py-2 text-sm font-medium text-black transition-colors hover:bg-white"
                  onClick={retryPlayback}
                >
                  Try again
                </button>
                <button
                  className="rounded-full bg-white/10 px-5 py-2 text-sm text-white/80 transition-colors hover:bg-white/20"
                  onClick={() => (window.history.length > 1 ? window.history.back() : navigate(mediaItemId ? paths.detail(mediaItemId) : paths.home()))}
                >
                  Back
                </button>
              </div>
            </div>
          )}
          {subtitleError && (
            <div className="absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-full bg-black/70 px-4 py-2 text-xs text-white/80 backdrop-blur">
              Couldn’t load the subtitle track.
              <button
                className="text-white/60 underline transition-colors hover:text-white"
                onClick={() => setSubtitleError(false)}
              >
                Dismiss
              </button>
            </div>
          )}
          {src ? (
            <MediaPlayer
              key={keyNonce}
              ref={playerRef}
              className="h-full w-full"
              src={src}
              playsInline
              title={title ?? "hokago"}
              onProviderChange={handleProviderChange}
              onCanPlay={handleCanPlay}
              onError={handleMediaError}
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
                // The live selection (which may diverge from the remembered
                // pref) is what a fresh player mount re-activates — a manual
                // subtitle choice survives method-changing remounts.
                default={t.id === trackDefaultId}
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
                  trickplay={trickplay}
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
      </>
    )}
    </div>
  );
}
