/**
 * Offline downloads layer.
 *
 * The Discord model holds: when the server is reachable, the SPA is fresh
 * every launch and everything is live. Offline, the shell serves a bundled
 * copy of this SPA, and this module is what makes downloads useful without a
 * server:
 *   - a local manifest of what's saved on this device (metadata captured at
 *     download time — the server's DetailView data),
 *   - a watch-progress queue that flushes to /watch-state/sync on reconnect.
 *
 * The manifest lives in localStorage (webview-persistent, origin of the SPA
 * copy the shell serves) and is re-hydrated from the native bridge
 * (downloads.list()) which is the ground truth for what bytes exist on disk.
 */
import { getNativeBridge, supportsOffline } from "@hokago/native-bridge";

export { supportsOffline };

export interface OfflineEntry {
  downloadId: string;
  mediaItemId: string;
  mediaFileId: string;
  title: string;
  kind: "MOVIE" | "SERIES" | "EPISODE";
  /** Episode titles/labels (e.g. "Episode 3") for a series download. */
  subtitle?: string;
  posterUrl?: string;
  backdropUrl?: string;
  durationMs: number | null;
  localPath: string;
  sizeBytes: number;
  /** Subtitle sidecar local paths (read back via bridge readText for JASSUB). */
  subtitlePaths: string[];
}

const MANIFEST_KEY = "hokago_offline_library";
const QUEUE_KEY = "hokago_offline_watch_queue";
const VIEW_KEY = "hokago_offline_viewed";

// The offline SPA loads from a custom-scheme origin (hokago-spa:// / file://),
// but the manifest is written while online from the *server* origin —
// localStorage is origin-scoped, so the offline copy would see an empty
// manifest. The bridge secure-store mirror is origin-independent (Keychain /
// Keystore / keyring), so reads prefer it and writes mirror through it.
function rawRead(key: string): string | null {
  const bridge = getNativeBridge();
  if (bridge?.storage) {
    const v = bridge.storage.get(key);
    if (v != null) return v;
  }
  return localStorage.getItem(key);
}

function rawWrite(key: string, value: string): void {
  const bridge = getNativeBridge();
  if (bridge?.storage) bridge.storage.set(key, value);
  localStorage.setItem(key, value);
}

function rawDelete(key: string): void {
  const bridge = getNativeBridge();
  if (bridge?.storage) bridge.storage.delete(key);
  localStorage.removeItem(key);
}

function readManifest(): Record<string, OfflineEntry> {
  try {
    return JSON.parse(rawRead(MANIFEST_KEY) ?? "{}") as Record<string, OfflineEntry>;
  } catch {
    return {};
  }
}

function writeManifest(map: Record<string, OfflineEntry>): void {
  rawWrite(MANIFEST_KEY, JSON.stringify(map));
}

/** Register a successfully-saved download with its display metadata. */
export function recordOfflineEntry(entry: OfflineEntry): void {
  const map = readManifest();
  map[entry.downloadId] = entry;
  writeManifest(map);
}

export function offlineEntries(): OfflineEntry[] {
  return Object.values(readManifest()).sort((a, b) => a.title.localeCompare(b.title));
}

export function offlineEntry(downloadId: string): OfflineEntry | null {
  return readManifest()[downloadId] ?? null;
}

export function removeOfflineEntry(downloadId: string): void {
  const map = readManifest();
  delete map[downloadId];
  writeManifest(map);
}

/**
 * Re-hydrate the manifest from the native bridge's list of files on disk —
 * the truth for what actually exists. The metadata stored at download time is
 * kept; anything the shell no longer has is dropped (e.g. after a reinstall).
 */
export async function reconcileOfflineManifest(): Promise<OfflineEntry[]> {
  const bridge = getNativeBridge();
  if (!bridge?.downloads?.list) return offlineEntries();
  try {
    const local = await bridge.downloads.list();
    const onDisk = new Set(local.map((l) => l.localPath));
    const map = readManifest();
    for (const id of Object.keys(map)) {
      if (!onDisk.has(map[id]!.localPath)) delete map[id];
    }
    writeManifest(map);
  } catch {
    // bridge failure — keep what we have
  }
  return offlineEntries();
}

// ── Offline watch-state queue ───────────────────────────────────────────────

export interface OfflineWatchEntry {
  mediaItemId: string;
  positionMs: number;
  durationMs: number | null;
  watched: boolean;
  lastWatchedAt: string | null;
}

function readQueue(): Record<string, OfflineWatchEntry> {
  try {
    return JSON.parse(rawRead(QUEUE_KEY) ?? "{}") as Record<string, OfflineWatchEntry>;
  } catch {
    return {};
  }
}

function writeQueue(q: Record<string, OfflineWatchEntry>): void {
  rawWrite(QUEUE_KEY, JSON.stringify(q));
}

/** Queue a position change for later sync (offline playback only). */
export function queueWatchState(entry: OfflineWatchEntry): void {
  const q = readQueue();
  const prev = q[entry.mediaItemId];
  if (prev && (prev.lastWatchedAt ?? "") > (entry.lastWatchedAt ?? "")) return; // never regress
  q[entry.mediaItemId] = entry;
  writeQueue(q);
  markOfflineViewed(entry.mediaItemId);
}

export function pendingWatchSync(): OfflineWatchEntry[] {
  return Object.values(readQueue());
}

/** True when the queued watch state for this item hasn't been synced yet. */
export function hasPendingWatchSync(mediaItemId: string): boolean {
  return mediaItemId in readQueue();
}

/**
 * Flush the queue to /watch-state/sync. Called when connectivity returns;
 * entries are only dropped on a successful response. Needs profileId, which
 * lives in the live session — offline playback reads it from localStorage.
 * Uses the shell's configured server origin (bridge.serverUrl) so the call
 * reaches the real server even when this SPA copy is served from a local
 * custom scheme.
 */
export async function flushWatchSync(profileId: string): Promise<number> {
  const entries = pendingWatchSync();
  if (entries.length === 0) return 0;
  const bridge = getNativeBridge();
  const headers: Record<string, string> = {};
  const token = localStorage.getItem("hokago_access_token");
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (bridge) {
    const stored = bridge.storage.get("hokago_access_token");
    if (stored) headers["Authorization"] = `Bearer ${stored}`;
  }
  const base = bridge?.serverUrl ? bridge.serverUrl.replace(/\/$/, "") : "";
  const res = await fetch(`${base}/watch-state/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ profileId, entries }),
  });
  if (!res.ok) throw new Error(`sync failed: ${res.status}`);
  const q = readQueue();
  for (const e of entries) delete q[e.mediaItemId];
  writeQueue(q);
  return entries.length;
}

// ── "seen the offline splash" flag ──────────────────────────────────────────

export function hasSeenOfflineHint(): boolean {
  return localStorage.getItem(VIEW_KEY) === "1";
}
export function markOfflineHintSeen(): void {
  localStorage.setItem(VIEW_KEY, "1");
}

function markOfflineViewed(mediaItemId: string): void {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    const set = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    set.add(mediaItemId);
    localStorage.setItem(VIEW_KEY, JSON.stringify([...set]));
  } catch {
    /* non-fatal */
  }
}
