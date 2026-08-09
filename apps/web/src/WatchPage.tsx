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
import { fetchMediaItemDetail } from "./browse-api";
import { paths, useRouter } from "./router";
import { Icon } from "./ui/icons";

// An empty WebVTT that vidstack loads (so the track is a real, selectable entry
// in the stock captions menu) but which draws nothing — JASSUB does the actual
// ASS rendering. Registering our subtitles this way lets the default player UI
// own switching/off while keeping libass as the renderer.
const EMPTY_VTT = "data:text/vtt," + encodeURIComponent("WEBVTT\n\n");

// Heartbeat cadence — server-side resume + continue-watching depend on it,
// and the API's idle reaper uses it to tell "paused in a tab" from "dead".
const HEARTBEAT_MS = 10_000;

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
  // require-corp is watching for . hls.js is already an installed
  // dependency, so point it at the same bundled copy instead of a CDN.
  const handleProviderChange = useCallback((provider: MediaProviderAdapter | null) => {
    if (isHLSProvider(provider)) {
      provider.library = () => import("hls.js");
      // The transmux worker transfers fragment buffers via postMessage; under
      // COEP: require-corp the transferred ArrayBuffer arrives detached and
      // the probe sees empty data ("Failed to find demuxer"), stalling every
      // segment past the first. Transmux on the main thread instead.
      provider.config = { enableWorker: false };
    }
    setVideoEl(isVideoProvider(provider) ? provider.video : null);
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
        setSelectedAudioIndex(def?.streamIndex ?? null);
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
    });
    jassubRef.current = instance;

    return () => {
      instance.destroy();
      jassubRef.current = null;
    };
  }, [videoEl, selectedSubtitleId, mediaFileId, renderable, fonts]);

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
          body: { profileId, mediaItemId, mediaFileId, deviceProfile: BROWSER_DEVICE_PROFILE },
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
        // Resume: DIRECT_PLAY/REMUX have no server-produced segments — the
        // player seeks itself (REMUX starts at the keyframe before the resume
        // point; the exact position is applied once the file opens).
        // Transcodes start at the resume segment via the playlist's media
        // sequence, so no client seek is needed there.
        if (data.method !== "TRANSCODE" && data.resumePositionMs > 0) {
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
          body: { positionMs: Math.round(player.currentTime * 1000), durationMs },
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
    // The seek we just applied fires a `seeked` event — don't let it
    // round-trip into a redundant /seek restart.
    skipNextSeekRef.current = true;
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
    lastScrubPosRef.current = Math.round(player.currentTime * 1000);
    if (scrubTimerRef.current !== null) window.clearTimeout(scrubTimerRef.current);
    scrubTimerRef.current = window.setTimeout(() => {
      api
        .POST("/playback/{sessionId}/seek", {
          params: { path: { sessionId: start.sessionId } },
          body: { positionMs: lastScrubPosRef.current },
        })
        .then(({ data }) => {
          if (data?.restarted) setReloadNonce((n) => n + 1);
        })
        .catch(() => {});
    }, 2500);
  }, [start]);

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
            label: t.title ?? t.lang ?? `Track ${t.streamIndex}`,
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
          onPause={() => {
            // Persist position promptly on pause — don't wait for the next
            // 10s tick, in case the tab is throttled or closed soon after.
            const player = playerRef.current;
            if (!player || !start?.sessionId) return;
            api
              .POST("/playback/{sessionId}/heartbeat", {
                params: { path: { sessionId: start.sessionId } },
                body: { positionMs: Math.round(player.currentTime * 1000) },
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
                  positionMs: Math.round(player.currentTime * 1000),
                  durationMs: player.duration ? Math.round(player.duration * 1000) : undefined,
                },
              })
              .catch(() => {});
          }}
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
