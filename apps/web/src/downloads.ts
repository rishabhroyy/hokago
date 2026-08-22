/**
 * Downloads orchestration for shells that can save files to real device
 * storage (iOS/Android/macOS/Windows/Linux — TVs never download).
 *
 * Flow: create the server download (POST /downloads) → poll until READY →
 * fetch the artifact manifest → save each artifact through the native bridge
 * (which attaches the session's Authorization itself). The server row stays
 * as the record of the download; the local copy is tracked in localStorage.
 */
import { getNativeBridge, resolveUrl, supportsDownloads } from "@hokago/native-bridge";
import { api } from "./api-client";
import { getDeviceId } from "./native";
import { removeOfflineEntry } from "./offline";
import type { MediaFileDescriptor } from "@hokago/contract/browse";

export interface LocalDownload {
  localPath: string;
  sizeBytes: number;
}

const LOCAL_KEY = "hokago_local_downloads";

function readLocal(): Record<string, LocalDownload> {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "{}") as Record<string, LocalDownload>;
  } catch {
    return {};
  }
}

function writeLocal(map: Record<string, LocalDownload>): void {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(map));
}

export function localFor(downloadId: string): LocalDownload | null {
  return readLocal()[downloadId] ?? null;
}

export function recordLocalDownload(downloadId: string, local: LocalDownload): void {
  const map = readLocal();
  map[downloadId] = local;
  writeLocal(map);
}

export function clearLocalDownload(downloadId: string): void {
  const map = readLocal();
  delete map[downloadId];
  writeLocal(map);
}

export function canDownload(): boolean {
  return supportsDownloads() && getDeviceId() !== null;
}

export function textSubtitleTracks(file: Pick<MediaFileDescriptor, "subtitleTracks">): string[] {
  return file.subtitleTracks.filter((t) => t.format !== "PGS" && t.format !== "VOBSUB" && t.format !== "DVBSUB").map((t) => t.id);
}

export type SaveOutcome = { ok: true; localPath: string; sizeBytes: number } | { ok: false; error: string };

/** Extra text subtitles get packaged as sidecars the native save also fetches. */
export async function createDownload(opts: {
  mediaItemId: string;
  mediaFileId: string;
  subtitleTrackIds?: string[];
}): Promise<{ id: string }> {
  const deviceId = getDeviceId();
  if (!deviceId) throw new Error("no device registered on this install");
  const { data, error } = await api.POST("/downloads", {
    body: {
      mediaItemId: opts.mediaItemId,
      mediaFileId: opts.mediaFileId,
      deviceId,
      variant: { kind: "original" },
      subtitleTrackIds: opts.subtitleTrackIds,
    },
  });
  if (error || !data) throw new Error(error?.error ?? "could not start download");
  return { id: data.id };
}

const POLL_MS = 1500;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

export async function waitReady(downloadId: string, signal?: { cancelled: boolean }): Promise<"READY" | "FAILED" | "TIMEOUT"> {
  const started = Date.now();
  for (;;) {
    if (signal?.cancelled) return "TIMEOUT";
    const { data } = await api.GET("/downloads/{id}", { params: { path: { id: downloadId } } });
    if (data?.status === "READY" || data?.status === "FAILED") return data.status;
    if (Date.now() - started > POLL_TIMEOUT_MS) return "TIMEOUT";
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** Pulls the READY artifact's bytes through the native bridge. Returns the saved file. */
export async function saveToDevice(downloadId: string, onProgress?: (received: number, total: number) => void): Promise<SaveOutcome> {
  const bridge = getNativeBridge();
  if (!bridge?.downloads) return { ok: false, error: "this build can't save files" };

  const { data, error } = await api.GET("/downloads/{id}/artifact", { params: { path: { id: downloadId } } });
  if (error || !data) return { ok: false, error: error?.error ?? "artifact unavailable" };

  // Wire progress events from the managed download bridge (desktop) — throttled ~150ms from Rust
  let off: (() => void) | null = null;
  if (onProgress) {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail as { type?: string; receivedBytes?: number; totalBytes?: number };
      if (d?.type === "download-progress" && typeof d.receivedBytes === "number") onProgress(d.receivedBytes, d.totalBytes ?? d.receivedBytes);
    };
    window.addEventListener("hokago-native", handler as EventListener);
    off = () => window.removeEventListener("hokago-native", handler as EventListener);
  }

  try {
    if (data.media) {
      const saved = await bridge.downloads.save(resolveUrl(data.media.url), data.media.filename);
      onProgress?.(saved.sizeBytes, saved.sizeBytes);
      // Sidecars (subtitles, fonts) ride along next to the media file.
      await Promise.all(
        data.subtitles.map((s) =>
          bridge.downloads.save(resolveUrl(`/downloads/${downloadId}/artifact/subtitles/${s.trackId}`), s.filename).catch(() => null),
        ),
      );
      await Promise.all(data.fonts.map((f) => bridge.downloads.save(resolveUrl(f.url), f.filename).catch(() => null)));
      return { ok: true, localPath: saved.localPath, sizeBytes: saved.sizeBytes };
    }
    return { ok: false, error: "artifact has no media file" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "download failed" };
  } finally {
    off?.();
  }
}

export function cancelSave(id: string): void {
  const b = getNativeBridge() as unknown as { downloads?: { cancel?: (id: string) => Promise<void> } };
  b?.downloads?.cancel?.(id).catch(() => {});
}

export async function deleteDownload(downloadId: string): Promise<void> {
  clearLocalDownload(downloadId);
  removeOfflineEntry(downloadId);
  await api.DELETE("/downloads/{id}", { params: { path: { id: downloadId } } });
}