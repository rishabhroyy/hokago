/**
 * Bridge glue: how the web app talks to its native shell. Everything here
 * degrades to browser behavior when no shell is present (window.hokagoNative
 * is undefined), so the browser build is untouched and feature parity between
 * browser and shell is the default, not a special case.
 */
import {
  getNativeBridge,
  isTvShell,
  supportsDownloads,
  needsNativeUpdate,
  type NativePlatform,
} from "@hokago/native-bridge";
import { ensureAccessToken } from "./api-client";

export function shellPlatform(): NativePlatform | null {
  return getNativeBridge()?.platform ?? null;
}

export function clientKey(): string | null {
  return getNativeBridge()?.clientKey ?? null;
}

/** The per-install deviceId the API minted at login/pairing — needed for downloads. */
export function getDeviceId(): string | null {
  return localStorage.getItem("hokago_device_id");
}

export function storeDeviceId(id: string | null): void {
  if (id) localStorage.setItem("hokago_device_id", id);
  else localStorage.removeItem("hokago_device_id");
}

/**
 * Shells that download files natively keep the access token mirrored into
 * their own secure storage (the bridge storage facade does this on every
 * set). The web only refreshes tokens on API calls, so a long-idle session
 * could leave the mirror stale for a native download — keep the token warm
 * while a shell session is alive.
 */
let warmTimer: ReturnType<typeof setInterval> | null = null;
export function startTokenWarmth(): void {
  if (!getNativeBridge() || warmTimer) return;
  warmTimer = setInterval(() => {
    void ensureAccessToken();
  }, 4 * 60_000);
}

export { getNativeBridge, isTvShell, supportsDownloads, needsNativeUpdate };

/** Resolve a native-download-capable platform's name for display. */
export function platformLabel(platform: NativePlatform): string {
  switch (platform) {
    case "ios": return "iOS";
    case "android": return "Android";
    case "macos": return "macOS";
    case "windows": return "Windows";
    case "linux": return "Linux";
    case "androidtv": return "Android TV";
    case "googletv": return "Google TV";
    default: return platform;
  }
}

/** The contract's DevicePlatform value for this shell (for /auth/login). */
export function loginPlatform(): "IOS" | "IPADOS" | "ANDROID" | "MACOS" | "WINDOWS" | "LINUX" | "TVOS" | "ANDROIDTV" | "GOOGLETV" | undefined {
  const p = shellPlatform();
  if (!p) return undefined;
  return p.toUpperCase() as "IOS" | "IPADOS" | "ANDROID" | "MACOS" | "WINDOWS" | "LINUX" | "TVOS" | "ANDROIDTV" | "GOOGLETV";
}