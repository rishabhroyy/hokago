/**
 * The native-shell bridge contract.
 *
 * Every shell (iOS WKWebView, Android WebView, Tauri on macOS/Windows/Linux)
 * injects a `window.hokagoNative` object into every page load of the remote
 * SPA, before the first script runs. The web app treats it as an optional
 * capability layer — the browser build simply never sees it — so a feature
 * that needs a native capability must degrade gracefully when it's absent.
 *
 * All web logic, decisions and state stay in the web app; the bridge only
 * covers what a webview can't do itself:
 *   - stable per-install identity (clientKey) + platform/version reporting
 *   - storage that survives webview data wipes (native secure store mirror)
 *   - saving download bytes to real device storage
 *   - TV: nothing else — pairing, account switching and D-pad navigation
 *     are web-side (TV mode), the shell just hosts the same SPA.
 */

export const NATIVE_PLATFORMS = [
  "ios",
  "android",
  "macos",
  "windows",
  "linux",
  "androidtv",
  "googletv",
] as const;
export type NativePlatform = (typeof NATIVE_PLATFORMS)[number];

/** Platforms that can download files to device storage (TVs cannot). */
export const DOWNLOAD_PLATFORMS: readonly NativePlatform[] = ["ios", "android", "macos", "windows", "linux"];
export const TV_PLATFORMS: readonly NativePlatform[] = ["androidtv", "googletv"];

export interface NativeDownloadSaveResult {
  /** Absolute path/identifier of the saved file on device storage. */
  localPath: string;
  sizeBytes: number;
}

export interface NativeStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export interface NativeBridge {
  /** Shell platform — the web uses it for device profiles and TV mode. */
  platform: NativePlatform;
  /** App shell version (the tag, e.g. "0.2.0") — the web compares it against MIN_NATIVE_VERSION. */
  appVersion: string;
  /** Native build number (CFBundleVersion / versionCode). */
  appBuild: string;
  /** Stable per-install UUID generated at first launch — sent as LoginBody.clientKey / PairingRequestBody.clientKey. */
  clientKey: string;
  /** Synchronous storage mirror; persists through webview data clears. */
  storage: NativeStorage;
  /**
   * Downloads an absolute URL (already resolved against the server origin)
   * to platform storage. The native side attaches `Authorization: Bearer
   * <token>` from the webview session itself, so the web never hands tokens
   * to the bridge.
   */
  downloads: {
    save(url: string, filename: string): Promise<NativeDownloadSaveResult>;
    /** Desktop only: reveal the file in the OS file manager. */
    open?(localPath: string): void;
  };
}

/**
 * Native → web events. Shells dispatch `window.dispatchEvent(new CustomEvent("hokago-native", { detail }))`.
 */
export type NativeEvent =
  | { type: "back" }
  | { type: "download-progress"; downloadId: string; receivedBytes: number; totalBytes: number };

declare global {
  interface Window {
    hokagoNative?: NativeBridge;
  }
}

export function getNativeBridge(): NativeBridge | null {
  return typeof window !== "undefined" ? (window.hokagoNative ?? null) : null;
}

export function isNative(): boolean {
  return getNativeBridge() !== null;
}

export function isTvShell(): boolean {
  const bridge = getNativeBridge();
  return bridge !== null && TV_PLATFORMS.includes(bridge.platform);
}

export function supportsDownloads(): boolean {
  const bridge = getNativeBridge();
  return bridge !== null && DOWNLOAD_PLATFORMS.includes(bridge.platform);
}

/**
 * Resolves an API-emitted origin-relative path ("/artwork/...", "/auth/login")
 * against the shell's server origin (the origin the SPA itself was loaded
 * from — the API serves the SPA, so same-origin in a shell). In a plain
 * browser this is a no-op passthrough. Never assumes a fixed host.
 */
export function resolveUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl) || pathOrUrl.startsWith("data:") || pathOrUrl.startsWith("blob:")) {
    return pathOrUrl;
  }
  return new URL(pathOrUrl, window.location.href).href;
}
