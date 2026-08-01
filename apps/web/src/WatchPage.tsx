import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MediaPlayer,
  MediaProvider,
  Track,
  isHLSProvider,
  isVideoProvider,
  useMediaState,
  type MediaPlayerInstance,
  type MediaProviderAdapter,
} from "@vidstack/react";
import { defaultLayoutIcons, DefaultVideoLayout } from "@vidstack/react/player/layouts/default";
import JASSUB from "jassub";
// Vite bundles these from the installed dependency and serves them from our
// own origin — never a CDN — same reasoning as the hls.js fix below (§1.1/§13.3).
import jassubWorkerUrl from "jassub/dist/worker/worker.js?worker&url";
import jassubWasmUrl from "jassub/dist/wasm/jassub-worker.wasm?url";
import jassubModernWasmUrl from "jassub/dist/wasm/jassub-worker-modern.wasm?url";

import type { StartPlaybackResponse as PlaybackStart } from "@hokago/contract/playback";
import type { SubtitleTrackInfo, FontDescriptor as FontInfo } from "@hokago/contract/media-files";
import { api } from "./api-client";
import { BROWSER_DEVICE_PROFILE } from "./device-profile";
import { fetchMediaItemDetail } from "./browse-api";
import { Icon } from "./ui/icons";

// An empty WebVTT that vidstack loads (so the track is a real, selectable entry
// in the stock captions menu) but which draws nothing — JASSUB does the actual
// ASS rendering. Registering our subtitles this way lets the default player UI
// own switching/off while keeping libass (§13.1) as the renderer.
const EMPTY_VTT = "data:text/vtt," + encodeURIComponent("WEBVTT\n\n");

export function WatchPage({ mediaFileId }: { mediaFileId: string }) {
  const params = new URLSearchParams(location.search);
  const mediaItemId = params.get("mediaItemId") ?? "";
  const profileId = params.get("profileId") ?? "dev";

  const [start, setStart] = useState<PlaybackStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [subtitles, setSubtitles] = useState<SubtitleTrackInfo[]>([]);
  const [fonts, setFonts] = useState<FontInfo[]>([]);
  const playerRef = useRef<MediaPlayerInstance>(null);
  const jassubRef = useRef<JASSUB | null>(null);
  const [title, setTitle] = useState<string | null>(null);

  // Bitmap subs (PGS/VOBSUB) are burned in server-side, so only text subs
  // become selectable menu entries here; the first one is the default.
  const renderable = useMemo(() => subtitles.filter((t) => !t.requiresBurnIn), [subtitles]);

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
        if (!cancelled && data) setSubtitles(data.subtitles);
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
    });
    jassubRef.current = instance;

    return () => {
      instance.destroy();
      jassubRef.current = null;
    };
  }, [videoEl, selectedSubtitleId, mediaFileId, renderable, fonts]);

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
        ? { src: start.playlistUrl, type: "application/x-mpegurl" as const }
        : undefined;

  return (
    <div className="fixed inset-0 h-screen w-screen overflow-hidden bg-black text-white">
      <button
        className="absolute left-5 top-5 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-md transition-colors hover:bg-black/65"
        onClick={() => history.back()}
        title="Back"
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
        >
          <MediaProvider>
            {/* DIRECT_PLAY audio tracks come from the native element and show up
                in the stock audio menu automatically; these are the subtitles. */}
            {renderable.map((t, i) => (
              <Track
                key={t.id}
                id={t.id}
                src={EMPTY_VTT}
                kind="subtitles"
                label={t.title ?? t.lang ?? t.id}
                language={t.lang ?? undefined}
                default={i === 0}
              />
            ))}
          </MediaProvider>
          <DefaultVideoLayout icons={defaultLayoutIcons} />
        </MediaPlayer>
      ) : (
        <div className="flex h-full w-full items-center justify-center text-sm text-white/70">
          Starting playback…
        </div>
      )}
    </div>
  );
}
