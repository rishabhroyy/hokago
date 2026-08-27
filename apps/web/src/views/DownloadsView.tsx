import { useCallback, useEffect, useState } from "react";
import type { DownloadInfo } from "@hokago/contract/downloads";
import { getNativeBridge } from "@hokago/native-bridge";
import { api } from "../api-client";
import { getDeviceId } from "../native";
import { fetchMediaItemDetail } from "../browse-api";
import { useProfileId } from "../profile";
import { canDownload, createDownload, deleteDownload, localFor, saveToDevice, waitReady } from "../downloads";
import { paths, useRouter } from "../router";
import { Icon } from "../ui/icons";
import { useWiiSound } from "../ui/useWiiSound";

function fmtBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const STATUS_LABEL: Record<DownloadInfo["status"], string> = {
  QUEUED: "queued",
  PROCESSING: "preparing…",
  READY: "ready",
  FAILED: "failed",
};

export function DownloadsView() {
  const { navigate } = useRouter();
  const s = useWiiSound();
  const profileId = useProfileId();
  const [downloads, setDownloads] = useState<DownloadInfo[] | null>(null);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const deviceId = getDeviceId();
    const { data, error } = await api.GET("/downloads", { params: deviceId ? { query: { deviceId } } : {} });
    if (error) {
      setError("could not load downloads");
      return;
    }
    setDownloads(
      (data ?? []).map((d) => ({
        ...d,
        createdAt: new Date(d.createdAt ?? Date.now()),
        updatedAt: new Date(d.updatedAt ?? Date.now()),
      })),
    );
    setError(null);
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => {
      // Keep polling while anything is still queued/processing.
      setDownloads((prev) => {
        if (prev?.some((d) => d.status === "QUEUED" || d.status === "PROCESSING")) void load();
        return prev;
      });
    }, 2000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (!downloads) return;
    const missing = downloads.filter((d) => !(d.mediaItemId in titles)).map((d) => d.mediaItemId);
    if (missing.length === 0) return;
    for (const id of missing) {
      void fetchMediaItemDetail(id, profileId ?? undefined).then((item) => {
        if (item) setTitles((t) => ({ ...t, [id]: item.title }));
      });
    }
  }, [downloads, titles, profileId]);

  const start = async (d: DownloadInfo) => {
    if (saving[d.id]) return;
    setSaving((x) => ({ ...x, [d.id]: true }));
    const outcome = await saveToDevice(d.id);
    if (outcome.ok) {
      s.jingle();
    } else {
      setError(outcome.error);
    }
    setSaving((x) => ({ ...x, [d.id]: false }));
    void load();
  };

  const download = async (d: DownloadInfo) => {
    if (saving[d.id]) return;
    setSaving((x) => ({ ...x, [d.id]: true }));
    const { id } = await createDownload({ mediaItemId: d.mediaItemId, mediaFileId: d.mediaFileId });
    const status = await waitReady(id);
    if (status === "READY") {
      const outcome = await saveToDevice(id);
      if (!outcome.ok) setError(outcome.error);
    } else {
      setError(status === "FAILED" ? "the server failed to build the download" : "download timed out");
    }
    setSaving((x) => ({ ...x, [d.id]: false }));
    void load();
  };

  if (!canDownload()) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-8 text-center">
        <h1 className="font-display text-title font-bold">Downloads</h1>
        <p className="max-w-[420px] text-meta text-ink-2">
          Downloads are available on the hokago iOS, Android, macOS, Windows and Linux apps.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-screen max-w-[900px] px-6 pb-24 pt-28">
       <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-title font-bold">Downloads</h1>
        <div className="flex gap-2">
          <button className="btn btn-ghost" onClick={() => navigate(paths.anicli())}>Acquire (ani-cli)</button>
          <button className="btn btn-ghost" onClick={() => navigate(paths.offline())}>
            <Icon name="wifi-off" className="h-4 w-4" /> Offline library
          </button>
        </div>
      </div>
      {error && (
        <p className="mb-5 rounded-2xl bg-accent/10 px-4 py-2.5 text-small font-semibold text-accent">{error}</p>
      )}
      {downloads === null ? (
        <p className="text-meta text-ink-3">loading…</p>
      ) : downloads.length === 0 ? (
        <p className="text-meta text-ink-2">
          Nothing here yet — hit the download button on any movie or episode.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {downloads.map((d) => {
            const local = localFor(d.id);
            const bridge = getNativeBridge();
            return (
              <li key={d.id} className="panel flex items-center gap-4 rounded-[22px] px-5 py-4">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-paper ring-1 ring-line">
                  <Icon name="download" className="h-5 w-5 text-wii-deep" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-meta font-bold text-ink">{titles[d.mediaItemId] ?? "…"}</div>
                  <div className="mt-0.5 flex items-center gap-2 font-mono text-kicker uppercase tracking-[0.1em] text-ink-3">
                    <span>{d.variant === "original" ? "original" : "transcode"}</span>
                    <span>·</span>
                    <span>{STATUS_LABEL[d.status]}</span>
                    <span>·</span>
                    <span>{fmtBytes(d.sizeBytes)}</span>
                    {local && (
                      <span className="normal-case tracking-normal text-wii-deep">
                        · saved to this device{local.sizeBytes > 0 ? ` (${fmtBytes(local.sizeBytes)})` : ""}
                      </span>
                    )}
                  </div>
                  {d.status === "FAILED" && d.error && (
                    <div className="mt-1 truncate text-kicker text-accent">{d.error}</div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {d.status === "QUEUED" || d.status === "PROCESSING" ? (
                    <span className="text-kicker font-semibold text-ink-3">server is building this…</span>
                  ) : d.status === "READY" && !local ? (
                    <button className="btn btn-primary" disabled={saving[d.id]} onClick={() => void start(d)}>
                      <Icon name="download" className="h-4 w-4" />
                      {saving[d.id] ? "saving…" : "Save to this device"}
                    </button>
                  ) : d.status === "FAILED" ? (
                    <button className="btn btn-ghost" disabled={saving[d.id]} onClick={() => void download(d)}>
                      <Icon name="refresh" className="h-4 w-4" />
                      Retry
                    </button>
                  ) : null}
                  {local && bridge?.downloads?.open && (
                    <button className="btn btn-ghost" onClick={() => bridge.downloads.open?.(local.localPath)}>
                      <Icon name="monitor" className="h-4 w-4" />
                      Show in folder
                    </button>
                  )}
                  <button
                    className="icobtn flex h-9 w-9 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-accent/10 hover:text-accent"
                    title="Remove download"
                    onClick={() => {
                      void deleteDownload(d.id);
                      void load();
                    }}
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