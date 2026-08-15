import { useCallback, useEffect, useState } from "react";
import { getNativeBridge } from "@hokago/native-bridge";
import { useProfileId } from "../profile";
import { paths, useRouter } from "../router";
import { offlineEntries, reconcileOfflineManifest, removeOfflineEntry, type OfflineEntry } from "../offline";
import { Icon } from "../ui/icons";
import { useWiiSound } from "../ui/useWiiSound";

function fmtBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function posterFor(e: OfflineEntry): string | null {
  return e.posterUrl ?? null;
}

/**
 * The offline library: everything saved to this device, playable with no
 * server. Reachable from the Downloads view's "offline library" link and from
 * the offline-mode splash. Poster art is server-hosted, so it degrades to a
 * styled monogram when the server is unreachable — the list stays usable.
 */
export function OfflineView() {
  const { navigate } = useRouter();
  const s = useWiiSound();
  const profileId = useProfileId();
  const [entries, setEntries] = useState<OfflineEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setEntries(await reconcileOfflineManifest());
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const play = (e: OfflineEntry) => {
    if (!profileId) return;
    s.select();
    navigate(paths.offlineWatch(e.downloadId, profileId));
  };

  const remove = (e: OfflineEntry) => {
    removeOfflineEntry(e.downloadId);
    setEntries((prev) => prev.filter((x) => x.downloadId !== e.downloadId));
  };

  const bridge = getNativeBridge();

  return (
    <div className="mx-auto min-h-screen max-w-[900px] px-6 pb-24 pt-28">
      <div className="mb-2 flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-paper ring-1 ring-line">
          <Icon name="wifi-off" className="h-5 w-5 text-wii-deep" />
        </span>
        <div>
          <h1 className="font-display text-title font-bold">Offline library</h1>
          <p className="text-meta text-ink-3">saved on this device — plays without the server</p>
        </div>
      </div>

      {!loaded ? (
        <p className="mt-6 text-meta text-ink-3">loading…</p>
      ) : entries.length === 0 ? (
        <p className="mt-6 max-w-[460px] text-meta text-ink-2">
          Nothing saved yet. Hit the download button on any movie or episode while online — it lands here and plays
          even with no server reachable.
        </p>
      ) : (
        <ul className="mt-6 flex flex-col gap-3">
          {entries.map((e) => {
            const poster = posterFor(e);
            return (
              <li key={e.downloadId} className="panel flex items-center gap-4 rounded-[22px] px-4 py-4">
                <button
                  className="h-16 w-12 shrink-0 overflow-hidden rounded-[10px] bg-paper ring-1 ring-line"
                  onClick={() => play(e)}
                  aria-label={`play ${e.title}`}
                >
                  {poster ? (
                    <img src={poster} alt="" className="h-full w-full object-cover" loading="lazy" />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center font-display text-section font-black text-wii-deep">
                      {e.title[0]?.toUpperCase() ?? "?"}
                    </span>
                  )}
                </button>
                <div className="min-w-0 flex-1">
                  <button className="truncate text-meta font-bold text-ink hover:text-wii-deep" onClick={() => play(e)}>
                    {e.title}
                  </button>
                  {e.subtitle && <div className="truncate text-small font-semibold text-ink-2">{e.subtitle}</div>}
                  <div className="mt-0.5 flex items-center gap-2 font-mono text-kicker uppercase tracking-[0.1em] text-ink-3">
                    <span>{e.kind.toLowerCase()}</span>
                    <span>·</span>
                    <span>{fmtBytes(e.sizeBytes)}</span>
                    {e.durationMs != null && (
                      <>
                        <span>·</span>
                        <span>{Math.round(e.durationMs / 60000)} min</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button className="btn btn-primary" onClick={() => play(e)}>
                    <Icon name="play" className="h-4 w-4" />
                    Play
                  </button>
                  {bridge?.downloads?.open && (
                    <button className="btn btn-ghost" onClick={() => bridge.downloads.open?.(e.localPath)}>
                      <Icon name="monitor" className="h-4 w-4" />
                      Show in folder
                    </button>
                  )}
                  <button
                    className="icobtn flex h-9 w-9 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-accent/10 hover:text-accent"
                    title="Remove from this device"
                    onClick={() => remove(e)}
                  >
                    <Icon name="trash" className="h-4 w-4" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
