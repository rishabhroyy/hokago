import { useCallback, useEffect, useRef, useState } from "react";
import {
  MediaPlayer,
  MediaProvider,
  isHLSProvider,
  isVideoProvider,
  type MediaPlayerInstance,
  type MediaProviderAdapter,
} from "@vidstack/react";
import JASSUB from "jassub";
// Vite bundles these from the installed dependency and serves them from our
// own origin — never a CDN — same reasoning as the hls.js fix below (§1.1/§13.3).
import jassubWorkerUrl from "jassub/dist/worker/worker.js?worker&url";
import jassubWasmUrl from "jassub/dist/wasm/jassub-worker.wasm?url";
import jassubModernWasmUrl from "jassub/dist/wasm/jassub-worker-modern.wasm?url";

import { BROWSER_DEVICE_PROFILE } from "./device-profile";

interface PlaybackStart {
  sessionId: string;
  method: "DIRECT_PLAY" | "DIRECT_STREAM" | "TRANSCODE";
  reasons: string[];
  playlistUrl: string | null;
}

interface SubtitleTrackInfo {
  id: string;
  lang: string | null;
  title: string | null;
  format: string;
  forced: boolean;
  sdh: boolean;
  requiresBurnIn: boolean;
}

interface AudioTrackInfo {
  streamIndex: number;
  codec: string;
  lang: string | null;
  title: string | null;
  isDefault: boolean;
}

interface FontInfo {
  hash: string;
  family: string;
  weight: number | null;
  style: string | null;
  url: string;
}

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
    fetch(`/media-files/${mediaFileId}/tracks`)
      .then((res) => res.json() as Promise<{ audio: AudioTrackInfo[]; subtitles: SubtitleTrackInfo[] }>)
      .then((data) => {
        if (cancelled) return;
        setSubtitles(data.subtitles);
        const firstRenderable = data.subtitles.find((t) => !t.requiresBurnIn);
        setSelectedSubtitleId(firstRenderable?.id ?? null);
        setAudioTracks(data.audio);
        const defaultAudio = data.audio.find((a) => a.isDefault) ?? data.audio[0];
        setSelectedAudioIndex(defaultAudio?.streamIndex ?? null);
      })
      .catch(() => {});
    fetch(`/media-files/${mediaFileId}/fonts`)
      .then((res) => res.json() as Promise<FontInfo[]>)
      .then((data) => {
        if (!cancelled) setFonts(data);
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
      fetch(`/playback/${start.sessionId}/audio-track`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioStreamIndex: absoluteIndex, positionMs }),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`audio-track ${res.status}`);
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
    fetch("/playback/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId,
        mediaItemId,
        mediaFileId,
        deviceProfile: BROWSER_DEVICE_PROFILE,
      }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`playback/start ${res.status}`);
        return res.json() as Promise<PlaybackStart>;
      })
      .then((data) => {
        if (!cancelled) setStart(data);
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

  return (
    <div className="watch-page">
      <h1 style={{ fontFamily: "var(--hk-font-display)" }}>hokago — watch</h1>
      <p className="watch-page__meta">
        {error
          ? `error: ${error}`
          : start
            ? `method: ${start.method} · reasons: ${start.reasons.join(", ")}`
            : "starting playback…"}
      </p>
      {src && (
        <MediaPlayer
          ref={playerRef}
          className="watch-page__player"
          src={src}
          controls
          onProviderChange={handleProviderChange}
          onCanPlay={handleCanPlay}
        >
          <MediaProvider />
        </MediaPlayer>
      )}
      {audioTracks.length > 1 && (
        <label className="watch-page__meta">
          audio:{" "}
          <select value={selectedAudioIndex ?? ""} onChange={(e) => handleAudioChange(Number(e.target.value))}>
            {audioTracks.map((t) => (
              <option key={t.streamIndex} value={t.streamIndex}>
                {t.title ?? t.lang ?? `track ${t.streamIndex}`}
              </option>
            ))}
          </select>
        </label>
      )}
      {subtitles.length > 0 && (
        <label className="watch-page__meta">
          subtitles:{" "}
          <select
            value={selectedSubtitleId ?? ""}
            onChange={(e) => setSelectedSubtitleId(e.target.value || null)}
          >
            <option value="">off</option>
            {subtitles.map((t) => (
              <option key={t.id} value={t.id} disabled={t.requiresBurnIn}>
                {t.title ?? t.lang ?? t.id}
                {t.requiresBurnIn ? " (burn-in only)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
