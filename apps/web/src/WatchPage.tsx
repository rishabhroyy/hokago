import { useCallback, useEffect, useRef, useState } from "react";
import {
  MediaPlayer,
  MediaProvider,
  isHLSProvider,
  isVideoProvider,
  useMediaState,
  FullscreenButton,
  MuteButton,
  PlayButton,
  Time,
  TimeSlider,
  type MediaPlayerInstance,
  type MediaProviderAdapter,
} from "@vidstack/react";
import JASSUB from "jassub";
// Vite bundles these from the installed dependency and serves them from our
// own origin — never a CDN — same reasoning as the hls.js fix below (§1.1/§13.3).
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
import { fetchMediaItemDetail } from "./browse-api";
import { Icon } from "./ui/icons";

// Chrome/Chromium-only, not in lib.dom.d.ts — DIRECT_PLAY's only way to expose
// a container's other audio streams to the client (§11.4).
interface HTMLMediaElementWithAudioTracks extends HTMLVideoElement {
  audioTracks?: ArrayLike<{ enabled: boolean }>;
}

export function WatchPage({ mediaFileId }: { mediaFileId: string }) {
  const params = new URLSearchParams(location.search);
  const mediaItemId = params.get("mediaItemId") ?? "";
  const profileId = params.get("profileId") ?? "dev";

  const [start, setStart] = useState<PlaybackStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [subtitles, setSubtitles] = useState<SubtitleTrackInfo[]>([]);
  const [fonts, setFonts] = useState<FontInfo[]>([]);
  const [selectedSubtitleId, setSelectedSubtitleId] = useState<string | null>(null);
  const [audioTracks, setAudioTracks] = useState<AudioTrackInfo[]>([]);
  const [selectedAudioIndex, setSelectedAudioIndex] = useState<number | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const playerRef = useRef<MediaPlayerInstance>(null);
  const jassubRef = useRef<JASSUB | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const paused = useMediaState("paused", playerRef);
  const muted = useMediaState("muted", playerRef);

  useEffect(() => {
    if (!mediaItemId) return;
    fetchMediaItemDetail(mediaItemId)
      .then((detail) => setTitle(detail?.title ?? null))
      .catch(() => {});
  }, [mediaItemId]);

  // Vidstack's HLS provider defaults `library` to a cdn.jsdelivr.net URL — a
  // third-party hotlink that breaks local-first and is exactly what COEP:
  // require-corp is watching for (§13.3). hls.js is already an installed
  // dependency, so point it at the same bundled copy instead of a CDN.
  const handleProviderChange = useCallback((provider: MediaProviderAdapter | null) => {
    if (isHLSProvider(provider)) provider.library = () => import("hls.js");
    setVideoEl(isVideoProvider(provider) ? provider.video : null);
  }, []);

  // Track list (§13's audio/subtitle switcher, Step 8) — text formats only;
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
        const firstRenderable = data.subtitles.find((t) => !t.requiresBurnIn);
        setSelectedSubtitleId(firstRenderable?.id ?? null);
        setAudioTracks(data.audio);
        const defaultAudio = data.audio.find((a) => a.isDefault) ?? data.audio[0];
        setSelectedAudioIndex(defaultAudio?.streamIndex ?? null);
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
  }, [mediaFileId]);

  // JASSUB renders ASS client-side (§13.1) — attached directly to the
  // underlying <video>, independent of DIRECT_PLAY/DIRECT_STREAM/TRANSCODE,
  // since libass just needs the video element's clock, not its source.
  useEffect(() => {
    if (!videoEl || !selectedSubtitleId) return;
    const track = subtitles.find((t) => t.id === selectedSubtitleId);
    if (!track || track.requiresBurnIn) return;

    const availableFonts = Object.fromEntries(fonts.map((f) => [f.family, f.url]));
    const instance = new JASSUB({
      video: videoEl,
      subUrl: `/media-files/${mediaFileId}/subtitle-tracks/${selectedSubtitleId}`,
      workerUrl: jassubWorkerUrl,
      wasmUrl: jassubWasmUrl,
      modernWasmUrl: jassubModernWasmUrl,
      availableFonts,
    });
    jassubRef.current = instance;

    return () => {
      instance.destroy();
      jassubRef.current = null;
    };
  }, [videoEl, selectedSubtitleId, mediaFileId, subtitles, fonts]);

  // DIRECT_PLAY: the container's other audio streams ride along in the same
  // file, so switching is just toggling the browser's native AudioTrackList —
  // no request, no restart (§11.4). Order matches ascending streamIndex among
  // audio streams, not the absolute container index audioTracks stores.
  useEffect(() => {
    if (start?.method !== "DIRECT_PLAY" || !videoEl || selectedAudioIndex === null) return;
    const nativeTracks = (videoEl as HTMLMediaElementWithAudioTracks).audioTracks;
    if (!nativeTracks) return;
    const ordered = [...audioTracks].sort((a, b) => a.streamIndex - b.streamIndex);
    const targetPos = ordered.findIndex((t) => t.streamIndex === selectedAudioIndex);
    for (let i = 0; i < nativeTracks.length; i++) {
      nativeTracks[i].enabled = i === targetPos;
    }
  }, [start?.method, videoEl, selectedAudioIndex, audioTracks]);

  // DIRECT_STREAM/TRANSCODE: only one audio track is ever baked into segments
  // (§11.4), so switching means asking the server to restart ffmpeg with a
  // different track, then forcing hls.js to refetch the (now different-content)
  // playlist URL and reseek — a cache-busting query nonce is what forces the refetch.
  const handleAudioChange = useCallback(
    (absoluteIndex: number) => {
      setSelectedAudioIndex(absoluteIndex);
      if (!start || start.method === "DIRECT_PLAY") return;
      const positionMs = Math.round((playerRef.current?.currentTime ?? 0) * 1000);
      const body: AudioTrackSwitchBody = { audioStreamIndex: absoluteIndex, positionMs };
      api
        .POST("/playback/{sessionId}/audio-track", { params: { path: { sessionId: start.sessionId } }, body })
        .then(({ error }) => {
          if (error) throw new Error("audio-track switch failed");
          pendingSeekRef.current = positionMs / 1000;
          setReloadNonce((n) => n + 1);
        })
        .catch((err: Error) => setError(err.message));
    },
    [start],
  );

  const handleCanPlay = useCallback(() => {
    if (pendingSeekRef.current === null || !playerRef.current) return;
    playerRef.current.currentTime = pendingSeekRef.current;
    pendingSeekRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .POST("/playback/start", { body: { profileId, mediaItemId, mediaFileId, deviceProfile: BROWSER_DEVICE_PROFILE } })
      .then(({ data, error }) => {
        if (error) throw new Error("playback/start failed");
        if (!cancelled) setStart(data as PlaybackStart);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [mediaFileId, mediaItemId, profileId]);

  const src =
    start?.method === "DIRECT_PLAY"
      ? { src: `/media-files/${mediaFileId}/direct`, type: "video/mp4" as const }
      : start?.playlistUrl
        ? {
            src: reloadNonce > 0 ? `${start.playlistUrl}?r=${reloadNonce}` : start.playlistUrl,
            type: "application/x-mpegurl" as const,
          }
        : undefined;

  const iconBtn = "flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20";

  return (
    <div className="fixed inset-0 h-screen w-screen overflow-hidden bg-[#161210] text-white">
      {src && (
        <MediaPlayer
          ref={playerRef}
          className="h-full w-full"
          src={src}
          controls={false}
          onProviderChange={handleProviderChange}
          onCanPlay={handleCanPlay}
        >
          <MediaProvider />
        </MediaPlayer>
      )}

      <div className="pointer-events-none absolute inset-x-0 top-0 z-[4] bg-[linear-gradient(180deg,rgba(0,0,0,0.55)_0%,transparent_100%)] p-6">
        <div className="pointer-events-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button className={iconBtn} onClick={() => history.back()} title="Back">
              <Icon name="back" className="h-[18px] w-[18px]" />
            </button>
            <div>
              <div className="text-[13.5px] font-bold text-white">{title ?? "hokago"}</div>
              <div className="text-[12px] text-white/60">
                {error ? `error: ${error}` : start ? start.method.replace("_", " ").toLowerCase() : "starting playback…"}
              </div>
            </div>
          </div>
          <button className="flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-[12.5px] font-bold text-white/80" title="Watch party">
            <Icon name="users" className="h-4 w-4" />
            Watch party
          </button>
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[4] bg-[linear-gradient(0deg,rgba(0,0,0,0.65)_0%,transparent_100%)] px-6 pb-5 pt-10">
        <div className="pointer-events-auto flex flex-col gap-3">
          <TimeSlider.Root className="group relative flex h-4 w-full cursor-pointer items-center">
            <TimeSlider.Track className="relative h-1 w-full rounded-full bg-white/25">
              <TimeSlider.TrackFill className="absolute h-full rounded-full bg-accent" />
            </TimeSlider.Track>
            <TimeSlider.Thumb className="absolute top-1/2 left-[var(--slider-fill-percent)] h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent opacity-0 shadow transition-opacity group-hover:opacity-100" />
          </TimeSlider.Root>

          <div className="flex items-center gap-3">
            <PlayButton className={iconBtn}>
              <Icon name={paused ? "play" : "pause"} className="h-[18px] w-[18px]" />
            </PlayButton>
            <MuteButton className={iconBtn}>
              <Icon name={muted ? "mute" : "vol"} className="h-[18px] w-[18px]" />
            </MuteButton>
            <div className="font-mono text-[12px] text-white/70">
              <Time type="current" /> / <Time type="duration" />
            </div>

            <div className="ml-auto flex items-center gap-2">
              {audioTracks.length > 1 && (
                <select
                  className="rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-[12px] text-white"
                  value={selectedAudioIndex ?? ""}
                  onChange={(e) => handleAudioChange(Number(e.target.value))}
                >
                  {audioTracks.map((t) => (
                    <option key={t.streamIndex} value={t.streamIndex} className="text-ink">
                      {t.title ?? t.lang ?? `track ${t.streamIndex}`}
                    </option>
                  ))}
                </select>
              )}
              {subtitles.length > 0 && (
                <select
                  className="rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-[12px] text-white"
                  value={selectedSubtitleId ?? ""}
                  onChange={(e) => setSelectedSubtitleId(e.target.value || null)}
                >
                  <option value="" className="text-ink">off</option>
                  {subtitles.map((t) => (
                    <option key={t.id} value={t.id} disabled={t.requiresBurnIn} className="text-ink">
                      {t.title ?? t.lang ?? t.id}
                      {t.requiresBurnIn ? " (burn-in only)" : ""}
                    </option>
                  ))}
                </select>
              )}
              <FullscreenButton className={iconBtn}>
                <Icon name="expand" className="h-[18px] w-[18px]" />
              </FullscreenButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
