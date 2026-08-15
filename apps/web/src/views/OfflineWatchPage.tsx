import { useCallback, useEffect, useRef, useState } from "react";
import { getNativeBridge } from "@hokago/native-bridge";
import { offlineEntry, queueWatchState, removeOfflineEntry } from "../offline";
import { paths, useRouter } from "../router";
import { Icon } from "../ui/icons";

/**
 * Offline playback: plays a locally-saved download with the platform's native
 * <video> element — the file is a self-contained artifact served by the
 * shell's custom scheme (downloads.localUrl). No HLS, no transcode decision,
 * no heartbeat: position is queued locally and flushed to /watch-state/sync
 * on reconnect (see useConnectivity).
 */
export function OfflineWatchPage({ downloadId, profileId }: { downloadId: string; profileId: string }) {
  const { navigate } = useRouter();
  const entry = offlineEntry(downloadId);
  const bridge = getNativeBridge();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const savedRef = useRef(0);

  const src = entry && bridge?.downloads?.localUrl ? bridge.downloads.localUrl(entry.localPath) : null;

  const savePosition = useCallback(() => {
    if (!entry || !videoRef.current) return;
    const pos = videoRef.current.currentTime;
    if (Math.abs(pos - savedRef.current) < 1) return;
    savedRef.current = pos;
    const durationMs = entry.durationMs;
    const watched = durationMs != null && pos >= durationMs * 0.95;
    queueWatchState({
      mediaItemId: entry.mediaItemId,
      positionMs: Math.round(pos * 1000),
      durationMs,
      watched,
      lastWatchedAt: new Date().toISOString(),
    });
  }, [entry]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !entry) return;
    const save = () => savePosition();
    const saveOnExit = () => {
      savePosition();
      video.pause();
    };
    video.addEventListener("pause", save);
    video.addEventListener("ended", save);
    const id = setInterval(save, 5000);
    window.addEventListener("pagehide", saveOnExit);
    return () => {
      video.removeEventListener("pause", save);
      video.removeEventListener("ended", save);
      clearInterval(id);
      window.removeEventListener("pagehide", saveOnExit);
    };
  }, [entry, savePosition]);

  if (!entry) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-8 text-center">
        <h1 className="font-display text-title font-bold">Download not found</h1>
        <p className="max-w-[420px] text-meta text-ink-2">This item isn't saved on this device anymore.</p>
        <button className="btn btn-primary" onClick={() => navigate(paths.offline())}>
          Back to offline library
        </button>
      </div>
    );
  }

  if (!src) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-8 text-center">
        <h1 className="font-display text-title font-bold">Playback unavailable</h1>
        <p className="max-w-[420px] text-meta text-ink-2">This build can't serve local files to the player.</p>
        <button className="btn btn-primary" onClick={() => navigate(paths.offline())}>
          Back
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <div className="flex items-center gap-3 px-6 pb-3 pt-6">
        <button className="icobtn flex h-9 w-9 items-center justify-center rounded-full text-ink-3 hover:text-ink" onClick={() => navigate(paths.offline())}>
          <Icon name="back" className="h-4 w-4" />
        </button>
        <div className="min-w-0">
          <div className="truncate font-display text-meta font-bold text-ink">{entry.title}</div>
          {entry.subtitle && <div className="truncate text-kicker font-semibold text-ink-3">{entry.subtitle}</div>}
        </div>
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-3 py-1 font-mono text-kicker font-bold uppercase tracking-[0.1em] text-amber-600 dark:text-amber-400">
          <Icon name="wifi-off" className="h-3 w-3" />
          offline
        </span>
      </div>

      <div className="mx-auto w-full max-w-[1200px] flex-1 px-6">
        {error && <p className="mb-3 rounded-2xl bg-accent/10 px-4 py-2.5 text-small font-semibold text-accent">{error}</p>}
        <div className="aspect-video w-full overflow-hidden rounded-[20px] bg-black ring-1 ring-line">
          <video
            ref={videoRef}
            src={src}
            controls
            playsInline
            autoPlay
            className="h-full w-full"
            onError={() => setError("this file can't be played on this device — try a transcode variant")}
          />
        </div>
        <p className="mt-3 text-center text-kicker font-semibold uppercase tracking-[0.12em] text-ink-3">
          progress saved locally — syncs when the server is reachable
        </p>
      </div>

      <div className="mx-auto w-full max-w-[1200px] px-6 pb-10 pt-4 text-center">
        <button
          className="btn btn-ghost"
          onClick={() => {
            removeOfflineEntry(entry.downloadId);
            navigate(paths.offline());
          }}
        >
          <Icon name="trash" className="h-4 w-4" />
          Remove from this device
        </button>
      </div>
    </div>
  );
}
