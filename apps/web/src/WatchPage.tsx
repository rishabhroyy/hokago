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
  type MediaVolumeChange,
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
import type { WatchPartyResponse } from "@hokago/contract/watch-party";
import { api } from "./api-client";
import { BROWSER_DEVICE_PROFILE } from "./device-profile";
import { getPrimaryProfile } from "./profile";
import { clearDetailCache, fetchMediaItemDetail } from "./browse-api";
import { paths, useRouter } from "./router";
import { Icon } from "./ui/icons";
import { loadTrackPrefs, matchAudioPref, matchSubtitlePref, saveAudioPref, saveQualityPref, saveSubtitlePref, saveVolumePref, type TrackPrefs } from "./track-prefs";
import { audioTrackLabel } from "./language-names";
import { useJassubRenderer } from "./useJassubRenderer";
import { useParty, type PartyCommand } from "./useParty";
import { leaveParty, linkPartySession } from "./party-api";

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
const HLS_SEGMENT_SECONDS = 4;

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
  locked,
}: {
  playerRef: RefObject<MediaPlayerInstance | null>;
  offsetMs: number;
  absoluteDurationMs: number;
  onScrub: (mediaTimeMs: number) => void;
  trickplay: TrickplayIndex | null;
  /** Watch-party guests: the host owns the timeline — gestures are inert. */
  locked?: boolean;
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
    // Every sheet image is the FULL grid (the tile filter emits empty black
    // cells for a partial tail sheet) — the row denominator is the fixed
    // grid row count, never ceil(tiles/cols). Deriving it from the tile
    // count mis-crops/black-screens the last sheet of nearly every video.
    const rows = Math.ceil(trickplay.tilesPerSheet / trickplay.cols);
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
      tabIndex={locked ? -1 : 0}
      aria-label="Seek"
      aria-disabled={locked || undefined}
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
        if (locked) return;
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
        if (!locked) seekToPct(p);
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
        if (locked) return;
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
  // Watch party membership, from the ?party= share link. Held in state so a
  // local leave() can drop the room without remounting the player.
  const [partyId, setPartyId] = useState<string | null>(params.get("party"));
  const party = useParty(partyId, profileId);
  // The party-sync machinery lives below the playback-start effect; this ref
  // lets the start flow call it without a TDZ dance in its dependency array.
  const applyPartyCommandRef = useRef<(cmd: PartyCommand) => void>(() => {});
  const [partyReady, setPartyReady] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dismissedEnded, setDismissedEnded] = useState(false);

  const copyInvite = useCallback(() => {
    if (!party.party) return;
    const url = `${location.origin}${paths.party(party.party.inviteCode)}`;
    navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  }, [party.party]);

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
  // Remembered volume level — fed to the `volume` prop, which vidstack applies
  // at every media load, so a mid-session adjustment carries across restarts.
  const [volume, setVolume] = useState<number>(() => loadTrackPrefs().volume ?? 1);
  // Slider drags fire volume-change per tick; coalesce through rAF so a drag
  // doesn't re-render the player subtree at 60Hz. The flush is the single
  // persist + state commit, so the prop vidstack reads at the next load is
  // always the last value.
  const volumeRafRef = useRef(0);
  const handleVolumeChange = useCallback((detail: MediaVolumeChange) => {
    const next = detail.volume;
    if (volumeRafRef.current) cancelAnimationFrame(volumeRafRef.current);
    volumeRafRef.current = requestAnimationFrame(() => {
      volumeRafRef.current = 0;
      saveVolumePref(next);
      setVolume(next);
    });
  }, []);
  useEffect(
    () => () => {
      if (volumeRafRef.current) cancelAnimationFrame(volumeRafRef.current);
    },
    [],
  );
  const userInteractedRef = useRef(false);
  const userPausedRef = useRef(false);
  const autoplayUnmuteArmedRef = useRef(false);
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
  // vidstack re-creates a <Track> (unregister + re-register, new object
  // identity, list reorder) whenever ANY of its props change — flipping
  // `default` on selection changes therefore nukes the active selection and
  // shuffles the caption menu. Snapshot the default per player mount instead;
  // remounts (keyNonce) re-snapshot the live selection, mid-mount switches go
  // through the menu's own changeTextTrackMode and never touch `default`.
  //
  // A title change (mediaFileId) reuses this same WatchPage instance without
  // bumping keyNonce, so a memo keyed on keyNonce alone froze at whichever
  // track (or no-track) happened to exist on the very first mount and never
  // moved again — the caption menu's notion of "active" drifted from JASSUB's
  // for every subsequent episode, which is what made the first click in a
  // session look like a no-op. The tracks-fetch effect below owns the actual
  // reset once a new title's tracks are known; this only covers the
  // keyNonce (mid-title remount) case, mirroring the old memo's behavior.
  const [mountDefaultId, setMountDefaultId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setMountDefaultId(trackDefaultId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyNonce]);

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
        // Resolve this title's subtitle default the moment its tracks are
        // known (same shape as defaultSubtitleId above) and apply it to both
        // JASSUB and the caption menu's default marker directly — waiting on
        // the render-order-dependent memos left both stuck on the previous
        // title's (or the pre-fetch, pre-title empty) track id.
        const renderableSubs = data.subtitles.filter((t) => !t.requiresBurnIn);
        const subtitleDefault =
          prefs.subtitle === null
            ? null
            : ((matchSubtitlePref(renderableSubs, prefs.subtitle) ?? renderableSubs[0])?.id ?? null);
        setSubtitleSelection(subtitleDefault);
        setMountDefaultId(subtitleDefault);
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
        audioDecodeFallbackTriedRef.current = false;
        setAbsoluteDurationMs(data.absoluteDurationMs ?? 0);
        // Party members link their session so heartbeats flow into the
        // member list (positions + liveness) and the server knows the
        // member's stream is live.
        if (partyIdRef.current) void linkPartySession(partyIdRef.current, data.sessionId);
        // Late-join catch-up: the initial snapshot can land while our session
        // doesn't exist yet (the WS command no-ops), leaving a guest at their
        // own resume point. Re-apply the party anchor now that we can play.
        const partyAnchor = partyLiveRef.current;
        if (partyAnchor && !partyIsHostRef.current) applyPartyCommandRef.current(partyAnchor);
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
        if (!outcome.restarted || !startRef.current) {
          // Covered-frontier fast path: the server didn't restart anything
          // and no src reload (hence no canplay) will fire — the target is
          // already playable on the current timeline. Land it by hand. User
          // scrubs double-seek harmlessly (the gesture already set the same
          // target); party commands and retries have no gesture feedback
          // and NEED this to arrive at the anchor.
          const p = playerRef.current;
          if (p) {
            const offsetMs = timelineOffsetRef.current;
            const max = Number.isFinite(p.duration) ? p.duration : Infinity;
            p.currentTime = Math.max(0, Math.min((targetMs - offsetMs) / 1000, max));
          }
          return;
        }
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
      // Guests in a live party: the host owns the timeline.
      if (partyLockedRef.current) return;
      seekTargetRef.current = Math.max(0, Math.round(mediaTimeMs));
      // The host with a live party: every scrub is also a party command —
      // the room's anchor follows the host's playhead (WAITING sets the
      // start position, PLAYING/PAUSED moves the whole room).
      const live = partyLiveRef.current;
      if (partyIdRef.current && live) {
        party.control(live.state, seekTargetRef.current);
      }
      if (seekDebounceRef.current === null) {
        seekDebounceRef.current = window.setTimeout(() => {
          seekDebounceRef.current = null;
          commitRestart(buildSeekRequest(seekTargetRef.current));
        }, 200);
      }
    },
    [commitRestart, buildSeekRequest, party.control],
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

  // ── Watch-party sync (the timekeeper's client) ───────────────────────────
  // Server commands land via party.command; this client applies them and
  // never fights them. partyAppliedStateRef tracks the last APPLIED state —
  // for the host, echo suppression means their own commands never reach
  // apply, so applied-state and party-state legitimately differ.
  const partyLockedRef = useRef(false);
  useEffect(() => {
    partyLockedRef.current = party.locked;
  }, [party.locked]);
  // Latest live party anchor (state + position + issuedAt) for the
  // stale-closure callbacks (commitSeek, playback start catch-up).
  const partyLiveRef = useRef<PartyCommand | null>(null);
  useEffect(() => {
    partyLiveRef.current =
      party.party && party.party.state !== "ENDED"
        ? { state: party.party.state, positionMs: party.party.positionMs, issuedAt: party.party.issuedAt }
        : null;
  }, [party.party]);
  const partyIsHostRef = useRef(false);
  useEffect(() => {
    partyIsHostRef.current = party.isHost;
  }, [party.isHost]);
  const partyApplyingRef = useRef(false);
  const partyAppliedStateRef = useRef<PartyCommand["state"] | null>(null);
  // Guests resync when their position drifts more than this from the server
  // anchor — absorbs buffer jitter while pulling stalled members back.
  const PARTY_RESYNC_TOLERANCE_MS = 3000;

  const applyPartyCommand = useCallback(
    (cmd: PartyCommand) => {
      const player = playerRef.current;
      const session = startRef.current;
      if (!player || !session) return;
      const prev = partyAppliedStateRef.current;
      // The anchor is PAUSED-flat; while PLAYING it advances with wall clock.
      const targetMs =
        cmd.state === "PLAYING"
          ? cmd.positionMs + Math.max(0, Date.now() - Date.parse(cmd.issuedAt))
          : cmd.positionMs;
      const myMs = Math.round((player.currentTime || 0) * 1000 + timelineOffsetRef.current);
      const drifted = Math.abs(targetMs - myMs) > PARTY_RESYNC_TOLERANCE_MS;
      const stateChanged = prev !== cmd.state;
      partyApplyingRef.current = true;
      try {
        if (stateChanged || drifted) {
          userPausedRef.current = cmd.state !== "PLAYING";
          if (drifted) {
            if (session.method === "DIRECT_PLAY") {
              // The file is the media: seek and set state directly.
              player.currentTime = Math.max(0, targetMs / 1000);
              if (cmd.state === "PLAYING") player.play().catch(() => {});
              else player.pause();
            } else {
              // Restart the stream at the target — the replay machinery
              // relands playback on canplay under the play state we just set.
              player.pause();
              const base = buildSeekRequest(targetMs);
              commitRestart({
                ...base,
                apply: (outcome) => {
                  base.apply(outcome);
                  // Fast path (target inside the server's written frontier):
                  // no src reload happened, so canplay never fires and the
                  // play state set above wouldn't land — apply it by hand.
                  if (outcome.restarted) return;
                  if (cmd.state === "PLAYING") playerRef.current?.play().catch(() => {});
                  else playerRef.current?.pause();
                },
              });
            }
          } else if (cmd.state === "PLAYING") {
            player.play().catch(() => {});
          } else {
            player.pause();
          }
        }
        // Same state within tolerance: nothing — a guest's local pause holds
        // until their drift passes the tolerance, then they're pulled back.
      } finally {
        partyApplyingRef.current = false;
      }
      partyAppliedStateRef.current = cmd.state;
    },
    [buildSeekRequest, commitRestart],
  );
  applyPartyCommandRef.current = applyPartyCommand;

  useEffect(() => {
    if (party.command) applyPartyCommand(party.command);
  }, [party.command, applyPartyCommand]);

  // Live party id for the stale-closure callbacks (commitSeek, handlers).
  const partyIdRef = useRef(partyId);
  useEffect(() => {
    partyIdRef.current = partyId;
  }, [partyId]);

  // Leaving the room on unmount (back-nav, tab close). The StrictMode
  // double-mount self-heals for guests: the remount's socket re-asserts
  // membership server-side, so the transient leave is invisible to the room.
  // The room ref matters here: at the transient mount-1 cleanup the snapshot
  // hasn't arrived yet (null), so nothing is left — and a host MUST never
  // auto-leave anyway, because a host leave ENDS the party for everyone. A
  // dead host's party ends via the reaper instead.
  const partyRoomRef = useRef<{ isHost: boolean } | null>(null);
  useEffect(() => {
    partyRoomRef.current =
      party.party && party.party.state !== "ENDED" ? { isHost: party.isHost } : null;
  }, [party.party, party.isHost]);
  const partyLeftRef = useRef(false);
  useEffect(
    () => () => {
      const id = partyIdRef.current;
      const room = partyRoomRef.current;
      if (id && !partyLeftRef.current && room && !room.isHost) leaveParty(id);
    },
    [],
  );

  // The party's own Start button: the host's trusted play drives the whole
  // room — command the server (guests apply via WS), then restart our own
  // stream at the party anchor so everyone lands together.
  const startPartyPlayback = useCallback(() => {
    if (!party.party) return;
    const targetMs = party.party.positionMs;
    party.control("PLAYING", targetMs);
    userPausedRef.current = false;
    if (startRef.current?.method === "DIRECT_PLAY") {
      const player = playerRef.current;
      if (player) {
        player.currentTime = Math.max(0, targetMs / 1000);
        player.play().catch(() => {});
      }
    } else {
      const base = buildSeekRequest(targetMs);
      commitRestart({
        ...base,
        apply: (outcome) => {
          base.apply(outcome);
          // Covered-frontier fast path: no reload, no canplay — the restart
          // is a local seek; resume explicitly (the party is now PLAYING).
          if (!outcome.restarted) playerRef.current?.play().catch(() => {});
        },
      });
    }
  }, [party.party, party.control, buildSeekRequest, commitRestart]);

  const leaveCurrentParty = useCallback(() => {
    partyLeftRef.current = true;
    party.leave();
    setPartyId(null);
  }, [party.leave]);
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
    // The host of a live party re-anchors the room at the actual resume
    // point. The party anchor is wall-clock-extrapolated (positionMs +
    // elapsed since issuedAt) and is only re-issued on seeks/play-pause —
    // a position-preserving restart (quality or audio-track switch) that
    // lands here after a 15-30s re-encode gap would otherwise leave the
    // guests that far AHEAD (the anchor kept advancing while the host's
    // new stream buffered), with nothing pulling them back until the next
    // host gesture. Re-issuing here (not at the click: the clock would run
    // through the gap either way) snaps the room onto the host's stream.
    const partyAnchor = partyLiveRef.current;
    if (partyIdRef.current && partyIsHostRef.current && partyAnchor) {
      const anchorMs = Math.round((player.currentTime || 0) * 1000 + timelineOffsetRef.current);
      party.control(partyAnchor.state, anchorMs);
    }
    // Autoplay: navigating into /watch carries the user activation from the
    // detail-page click (same-document navigation) — but by the time canplay
    // arrives (transcode start + HLS buffering, or any restart long after the
    // last click) the 5s activation window is gone, and an unmuted play()
    // rejects NotAllowedError — a silent black screen. Muted playback is
    // always permitted: try the unmuted play() first (fast starts like the
    // initial REMUX land inside the activation window and keep their sound),
    // and on NotAllowedError fall back to a muted start.
    //
    // Clearing `muted` afterwards is itself subject to the autoplay gate:
    // the browser pauses a muted-started element (a trusted pause, no JS
    // involved) when unmuted without a fresh user gesture — even after the
    // play() promise resolved and playback was under way. Volume is only
    // restored on the next real interaction (pointer/key), which makes the
    // unmute legal; until then the video plays silently and the Mute button
    // shows the muted state.
    if (!userPausedRef.current) {
      const video = playerRef.current?.el?.querySelector("video") as HTMLVideoElement | null;
      if (!video || video.paused === false) return;
      if (video.muted) {
        // User muted the video themselves — play() on a muted element is
        // always permitted, and their mute must not be touched.
        player.play().catch(() => {});
        return;
      }
      const armUnmuteOnGesture = () => {
        if (autoplayUnmuteArmedRef.current) return;
        autoplayUnmuteArmedRef.current = true;
        const unlock = () => {
          // Only a real user gesture can legally unmute: synthetic input
          // (CDP, programmatic dispatchEvent) carries no user activation, and
          // unmuting on it makes the browser pause playback (a trusted pause,
          // per the autoplay policy). Stay armed in that case.
          if (!navigator.userActivation?.isActive) return;
          window.removeEventListener("pointerdown", unlock, true);
          window.removeEventListener("keydown", unlock, true);
          const v = playerRef.current?.el?.querySelector("video") as HTMLVideoElement | null;
          if (v?.muted) v.muted = false;
        };
        window.addEventListener("pointerdown", unlock, true);
        window.addEventListener("keydown", unlock, true);
      };
      const startMuted = (retries = 1) => {
        if (video.paused === false || userPausedRef.current) return;
        video.muted = true;
        player
          .play()
          .then(() => {
            if (!video.paused && video.muted) armUnmuteOnGesture();
          })
          .catch((e: unknown) => {
            // vidstack's canPlayQueue can still serve a stale muted=false
            // after this handler, unmuting the element before hls.js's
            // deferred play() lands — retry once, after which the mute sticks
            // (the queue item is served once per element load).
            if (
              retries > 0 &&
              !userPausedRef.current &&
              e instanceof DOMException &&
              (e.name === "NotAllowedError" || e.name === "AbortError")
            ) {
              startMuted(retries - 1);
            }
          });
      };
      // Fast start with a live activation window (initial REMUX): plain
      // unmuted play() succeeds and keeps its sound. Slow starts (transcode,
      // restarts) reject NotAllowedError once the activation expires.
      player
        .play()
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === "NotAllowedError") startMuted();
        });
    }
  }, [party.control]);

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

  // MEDIA_ERR_DECODE (3) on a DIRECT_PLAY stream means the file itself is
  // undecodable (e.g. malformed HE-AAC signaling from a bad source rip) —
  // not a transient network hiccup, and direct play never transforms a byte,
  // so retrying it fails identically forever. One escalation attempt per
  // session: report it to the server (persists past DIRECT_PLAY for this
  // file going forward) and let it spawn a REMUX with audio forced to
  // re-encode, exactly like a quality-switch's DIRECT_PLAY->TRANSCODE
  // fallback.
  const audioDecodeFallbackTriedRef = useRef(false);
  const tryAudioDecodeFallback = useCallback((): boolean => {
    const session = startRef.current;
    if (!session || session.method !== "DIRECT_PLAY" || audioDecodeFallbackTriedRef.current) return false;
    audioDecodeFallbackTriedRef.current = true;
    const sessionId = session.sessionId;
    const positionMs = Math.round(
      (playerRef.current && Number.isFinite(playerRef.current.currentTime) ? playerRef.current.currentTime : 0) * 1000 +
        timelineOffsetRef.current,
    );
    commitRestart({
      attempt: 0,
      maxRetries: 1,
      targetMs: positionMs,
      run: async () => {
        const { data, response } = await api.POST("/playback/{sessionId}/quality", {
          params: { path: { sessionId } },
          body: { positionMs, reportAudioDecodeError: true },
        });
        // Session moved on (user navigated to a different title) while this
        // was in flight — its outcome describes a session nobody's watching
        // anymore; discard rather than clobber whatever's playing now.
        if (startRef.current?.sessionId !== sessionId) return { ok: true, restarted: false };
        if (response?.status === 503) return { ok: false, retryable: true, message: "transcoder busy — retrying" };
        if (!data?.restarted) return { ok: false, message: "server could not recover this file" };
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
        setPlayerError(null);
        const method = outcome.method ?? startRef.current.method;
        setStart((prev) => (prev ? { ...prev, method, playlistUrl: outcome.playlistUrl ?? null, streamUrl: outcome.streamUrl ?? null } : prev));
        setKeyNonce((n) => n + 1);
        userPausedRef.current = false;
        bumpSrcNonce();
        applyRestart(method, outcome.segmentFrom ?? null, outcome.actualStartMs ?? null, positionMs);
      },
      onFail: (message) => setPlayerError(message),
    });
    return true;
  }, [commitRestart, applyRestart, bumpSrcNonce]);

  // A stream died mid-playback (hls.js fatal, element error, dead session).
  // Park the restart queue — its targets describe a broken pipeline — and
  // surface a recovery card; the player stays mounted underneath so Try again
  // reloads against the same session instead of starting from scratch.
  const handleMediaError = useCallback(
    (detail: MediaErrorDetail) => {
      if (detail.code === 3) {
        if (tryAudioDecodeFallback()) return;
        // Fallback already fired once for this session and a restart is
        // still in flight (a stray duplicate decode-error event, e.g. from
        // the old element mid-teardown) — let it finish instead of racing
        // it with a stale error card.
        if (restartLatestRef.current !== null) return;
      }
      restartLatestRef.current = null;
      pendingSeekRef.current = null;
      setPlayerError(detail.message || `playback error${detail.code ? ` (${detail.code})` : ""}`);
    },
    [tryAudioDecodeFallback],
  );

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
        className="absolute left-[max(1.25rem,var(--hokago-safe-left))] top-[calc(var(--hokago-safe-top)+1.25rem)] z-10 flex h-10 w-10 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-md transition-colors hover:bg-black/65"
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
            <div className="absolute bottom-[calc(var(--hokago-safe-bottom)+1rem)] left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-full bg-black/70 px-4 py-2 text-xs text-white/80 backdrop-blur">
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
              volume={volume}
              onVolumeChange={handleVolumeChange}
              onProviderChange={handleProviderChange}
              onCanPlay={handleCanPlay}
              onError={handleMediaError}
              onPlay={(event) => {
            userInteractedRef.current = true;
            userPausedRef.current = false;
            // Party rules: guests must not start playback while the room is
            // parked (WAITING/PAUSED); the host's trusted play is a room
            // command everyone else follows over WS.
            const roomState = party.party?.state;
            if (roomState && roomState !== "ENDED") {
              if (!party.isHost && !partyApplyingRef.current && roomState !== "PLAYING") {
                playerRef.current?.pause();
              } else if (party.isHost && event.isOriginTrusted) {
                const player = playerRef.current;
                if (player) {
                  party.control("PLAYING", Math.round(player.currentTime * 1000 + timelineOffsetRef.current));
                }
              }
            }
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
            // The host's trusted pause drives the room — everyone parks.
            const pplayer = playerRef.current;
            if (pplayer && party.party && party.isHost && event.isOriginTrusted && party.party.state !== "ENDED") {
              party.control("PAUSED", Math.round(pplayer.currentTime * 1000 + timelineOffsetRef.current));
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
            // Host reaching the end parks the room (guests pause at the tail);
            // the party ends when the host navigates away or leaves.
            if (party.party && party.isHost && party.party.state !== "ENDED") {
              party.control("PAUSED", Math.round(player.currentTime * 1000 + timelineOffsetRef.current));
            }
          }}
        >
          <MediaProvider>
            {/* DIRECT_PLAY audio tracks come from the native element and show up
                in the stock audio menu automatically; these are the subtitles. */}
            {renderable.map((t, index) => (
              <Track
                key={t.id}
                id={t.id}
                src={EMPTY_VTT}
                kind="subtitles"
                // Never show the DB row id — a track with neither title nor
                // language falls back to a positional label instead.
                label={t.title ?? t.lang ?? `Subtitle ${index + 1}`}
                language={t.lang ?? undefined}
                // The live selection (which may diverge from the remembered
                // pref) is what a fresh player mount re-activates — a manual
                // subtitle choice survives method-changing remounts.
                default={t.id === mountDefaultId}
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
                  locked={party.locked}
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
    {/* ── watch party chrome ─────────────────────────────────────────── */}
    {party.party && party.party.state !== "ENDED" && (
      <>
        <WaitingRoom
          party={party.party}
          me={profileId}
          isHost={party.isHost}
          ready={partyReady}
          onReady={party.setReady}
          onStart={startPartyPlayback}
          copied={copied}
          onCopy={copyInvite}
        />
        <PartyPill
          party={party.party}
          me={profileId}
          isHost={party.isHost}
          open={panelOpen}
          onToggle={() => setPanelOpen((v) => !v)}
          onCopy={copyInvite}
          copied={copied}
        />
        {panelOpen && (
          <PartyPanel
            party={party.party}
            me={profileId}
            onClose={() => setPanelOpen(false)}
            onLeave={leaveCurrentParty}
            copied={copied}
            onCopy={copyInvite}
          />
        )}
      </>
    )}
    {party.party?.state === "ENDED" && !dismissedEnded && (
      <div className="absolute left-1/2 top-[calc(var(--hokago-safe-top)+1.25rem)] z-40 -translate-x-1/2 rounded-full bg-red-950/90 px-4 py-2 text-sm text-red-100 shadow-lg ring-1 ring-red-400/30">
        The party ended —{" "}
        {party.party.members.find((m) => m.profileId === party.party!.hostProfileId)?.name ?? "the host"} left.
        <button className="ml-3 text-red-300 underline underline-offset-2 hover:text-white" onClick={() => setDismissedEnded(true)}>
          watch alone
        </button>
      </div>
    )}
    </div>
  );
}

// ── watch party chrome ─────────────────────────────────────────────────────

function MemberFace({ member, size = 28 }: { member: { name: string; avatarUrl: string | null }; size?: number }) {
  if (member.avatarUrl) {
    return (
      <img
        src={member.avatarUrl}
        alt=""
        style={{ height: size, width: size }}
        className="shrink-0 rounded-full object-cover ring-2 ring-white/80 dark:ring-black/40"
      />
    );
  }
  return (
    <span
      style={{ height: size, width: size, fontSize: Math.round(size * 0.44) }}
      className="flex shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,#45ADDD,#187AA5)] font-display font-bold text-white ring-2 ring-white/80 dark:ring-black/40"
    >
      {member.name[0]?.toUpperCase() ?? "?"}
    </span>
  );
}

/** Host-guest pickup room shown over the paused player while the party is
 *  WAITING: the invite code, the roll call of members, and the gate controls
 *  (guests toggle ready; the host starts). */
function WaitingRoom({
  party,
  me,
  isHost,
  ready,
  onReady,
  onStart,
  copied,
  onCopy,
}: {
  party: WatchPartyResponse;
  me: string | null;
  isHost: boolean;
  ready: boolean;
  onReady: (ready: boolean) => void;
  onStart: () => void;
  copied: boolean;
  onCopy: () => void;
}) {
  if (party.state !== "WAITING") return null;
  const guests = party.members.filter((m) => m.profileId !== party.hostProfileId);
  const everyoneReady = guests.every((m) => m.ready);
  const myMember = me ? party.members.find((m) => m.profileId === me) : null;
  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-[2px]">
      <div className="pointer-events-auto w-[min(92vw,420px)] rounded-2xl bg-wii-deep/95 p-6 text-white shadow-2xl ring-1 ring-white/15 dark:bg-paper dark:text-wii-ink dark:ring-line">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-h2 font-bold tracking-tight">Watch party</h2>
          <button
            className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 font-mono text-card-head font-bold tracking-[0.2em] transition hover:bg-white/20 dark:bg-wii-deep/10 dark:hover:bg-wii-deep/20"
            onClick={onCopy}
            title="Copy invite link"
          >
            {party.inviteCode}
            {copied ? <Icon name="check" className="h-3.5 w-3.5" /> : <Icon name="copy" className="h-3.5 w-3.5" />}
          </button>
        </div>
        <div className="mt-5 space-y-2.5">
          {party.members.map((m) => {
            const isMe = m.profileId === me;
            return (
              <div key={m.profileId} className="flex items-center gap-3">
                <MemberFace member={m} />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {m.name}
                  {isMe && <span className="text-white/50 dark:text-wii-ink/50"> (you)</span>}
                  {m.profileId === party.hostProfileId && !isMe && (
                    <span className="ml-1.5 rounded-full bg-amber-400/20 px-2 py-0.5 text-kicker font-bold uppercase tracking-wider text-amber-300 dark:text-amber-700">
                      host
                    </span>
                  )}
                </span>
                {isMe && isHost ? (
                  <span className="font-mono text-kicker font-bold uppercase tracking-wider text-white/50 dark:text-wii-ink/50">
                    host
                  </span>
                ) : m.ready ? (
                  <span className="font-mono text-kicker font-bold uppercase tracking-wider text-emerald-400 dark:text-emerald-600">
                    ready
                  </span>
                ) : (
                  <span className="font-mono text-kicker font-bold uppercase tracking-wider text-white/40 dark:text-wii-ink/40">
                    …
                  </span>
                )}
              </div>
            );
          })}
        </div>
        {isHost ? (
          <div className="mt-6">
            <button
              className="w-full rounded-xl bg-wii-deep font-display text-card-head font-bold text-white shadow-[0_2px_0_rgba(0,0,0,0.35)] transition hover:brightness-110 active:translate-y-px disabled:opacity-40 dark:bg-wii-deep"
              onClick={onStart}
              disabled={!everyoneReady}
              title={everyoneReady ? "Start the party" : "Waiting for everyone to be ready"}
            >
              {everyoneReady ? "Start party" : `Waiting for ${guests.filter((m) => !m.ready).length} guest${guests.filter((m) => !m.ready).length === 1 ? "" : "s"}…`}
            </button>
            <p className="mt-2 text-center text-kicker text-white/50 dark:text-wii-ink/50">
              Everyone joins on the code link above — scrubbing here while waiting sets the start point.
            </p>
          </div>
        ) : (
          <button
            className={`mt-6 w-full rounded-xl py-2.5 font-display text-card-head font-bold transition active:translate-y-px ${
              ready
                ? "bg-emerald-500/90 text-white dark:bg-emerald-600"
                : "bg-wii-deep text-white dark:bg-wii-deep"
            }`}
            onClick={() => onReady(!ready)}
          >
            {ready ? "I'm ready — waiting for host" : "I'm ready"}
          </button>
        )}
        {myMember && (
          <p className="mt-3 text-center text-kicker text-white/50 dark:text-wii-ink/50">
            {myMember.ready ? "Locked to the host's timeline once the party starts." : "Mark ready when you're settled — playback starts when everyone is."}
          </p>
        )}
      </div>
    </div>
  );
}

/** Compact status chip (top-left, under the back button): member avatars, the
 *  invite code, and host/guest role. Opens the member panel. */
function PartyPill({
  party,
  me,
  isHost,
  open,
  onToggle,
  onCopy,
  copied,
}: {
  party: WatchPartyResponse;
  me: string | null;
  isHost: boolean;
  open: boolean;
  onToggle: () => void;
  onCopy: () => void;
  copied: boolean;
}) {
  const meMember = me ? party.members.find((m) => m.profileId === me) : null;
  return (
    <button
      onClick={onToggle}
      className={`absolute left-[calc(max(1.25rem,var(--hokago-safe-left))+2.75rem)] top-[calc(var(--hokago-safe-top)+1.25rem)] z-40 flex items-center gap-2 rounded-full px-3 py-1.5 shadow-lg ring-1 transition hover:brightness-110 ${
        open
          ? "bg-white/95 text-wii-ink ring-line dark:bg-wii-deep/95 dark:text-white dark:ring-white/20"
          : "bg-wii-deep/95 text-white ring-white/20 dark:bg-paper/95 dark:text-wii-ink dark:ring-line"
      }`}
      title={open ? "Close party panel" : "Party — click for details"}
    >
      <span className="flex -space-x-1.5">
        {party.members.slice(0, 4).map((m) => (
          <MemberFace key={m.profileId} member={m} size={22} />
        ))}
      </span>
      <span className="flex flex-col items-start leading-none">
        <span className="font-mono text-kicker font-bold tracking-[0.18em]">{party.inviteCode}</span>
        <span className="text-kicker opacity-60">
          {isHost ? "you're hosting" : meMember ? "synced to host" : party.members.length + " watching"}
        </span>
      </span>
      <button
        className="ml-1 rounded-full bg-white/10 px-2 py-1 font-mono text-kicker font-bold tracking-wider transition hover:bg-white/25 dark:bg-wii-deep/10 dark:hover:bg-wii-deep/25"
        onClick={(e) => {
          e.stopPropagation();
          onCopy();
        }}
        title="Copy invite link"
      >
        {copied ? "copied" : "copy"}
      </button>
    </button>
  );
}

/** Member roster: live positions, staleness, and the leave action. */
function PartyPanel({
  party,
  me,
  onClose,
  onLeave,
  copied,
  onCopy,
}: {
  party: WatchPartyResponse;
  me: string | null;
  onClose: () => void;
  onLeave: () => void;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="absolute left-[calc(max(1.25rem,var(--hokago-safe-left))+2.75rem)] top-[calc(var(--hokago-safe-top)+4.75rem)] z-40 w-[min(88vw,340px)] rounded-2xl bg-wii-deep/95 p-4 text-white shadow-2xl ring-1 ring-white/15 dark:bg-paper dark:text-wii-ink dark:ring-line">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-card-head font-bold">Party</h3>
        <button onClick={onClose} className="text-white/50 transition hover:text-white dark:text-wii-ink/50 dark:hover:text-wii-ink" title="Close">
          <Icon name="x" className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-1 flex items-center justify-between">
        <p className="text-kicker text-white/50 dark:text-wii-ink/50">
          {party.state === "PLAYING" ? "playing together" : party.state === "PAUSED" ? "paused" : "waiting to start"}
        </p>
        <button
          className="flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 font-mono text-kicker font-bold tracking-[0.15em] transition hover:bg-white/20 dark:bg-wii-deep/10 dark:hover:bg-wii-deep/20"
          onClick={onCopy}
          title="Copy invite link"
        >
          {party.inviteCode}
          {copied ? <Icon name="check" className="h-3 w-3" /> : <Icon name="copy" className="h-3 w-3" />}
        </button>
      </div>
      <ul className="mt-3 space-y-2">
        {party.members.map((m) => {
          const isMe = m.profileId === me;
          const isHostMember = m.profileId === party.hostProfileId;
          const stale = !m.reportedAt || Date.now() - Date.parse(m.reportedAt) > 30_000;
          return (
            <li key={m.profileId} className="flex items-center gap-2.5">
              <MemberFace member={m} size={26} />
              <span className="min-w-0 flex-1 truncate text-sm">
                {m.name}
                {isMe && <span className="text-white/50 dark:text-wii-ink/50"> (you)</span>}
                {isHostMember && (
                  <span className="ml-1.5 rounded-full bg-amber-400/20 px-1.5 py-0.5 text-kicker font-bold uppercase tracking-wider text-amber-300 dark:text-amber-700">
                    host
                  </span>
                )}
              </span>
              <span className="font-mono text-kicker tabular-nums text-white/60 dark:text-wii-ink/60">
                {stale ? "away" : "in sync"}
              </span>
            </li>
          );
        })}
      </ul>
      <button
        onClick={onLeave}
        className="mt-4 w-full rounded-xl bg-red-500/15 py-2 text-small font-bold text-red-400 ring-1 ring-red-400/30 transition hover:bg-red-500/25 dark:text-red-600"
      >
        {me === party.hostProfileId ? "End party" : "Leave party"}
      </button>
    </div>
  );
}
