/**
 * Bridge glue: how the web app talks to its native shell. Everything here
 * degrades to browser behavior when no shell is present (window.hokagoNative
 * is undefined), so the browser build is untouched and feature parity between
 * browser and shell is the default, not a special case.
 */
import {
  getNativeBridge,
  isNative,
  isTvShell,
  supportsDownloads,
  needsNativeUpdate,
  type NativePlatform,
} from "@hokago/native-bridge";
import { api, ensureAccessToken, getDeviceId, storeDeviceId } from "./api-client";

export function shellPlatform(): NativePlatform | null {
  return getNativeBridge()?.platform ?? null;
}

export function clientKey(): string | null {
  return getNativeBridge()?.clientKey ?? null;
}

// Re-exported (not redeclared): storeAuthResult writes deviceId through
// api-client.ts's bridge-aware read/write, so that's the one copy that must
// stay canonical — a second, plain-localStorage implementation here would
// only coincidentally agree with it.
export { getDeviceId, storeDeviceId };

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

/**
 * Device linking (canDownload()'s deviceId check) only happens as a side
 * effect of /auth/login, when clientKey + platform are present on that
 * request. A session that predates the shell having a clientKey yet
 * (upgrading from an older app version, or any session created before
 * device-gated downloads existed) never gets a deviceId and stays stuck
 * forever — the app never calls /auth/login again for an already-signed-in
 * session, so nothing else would ever backfill it. Runs once at boot,
 * alongside startTokenWarmth; a no-op once a deviceId is already stored.
 */
export async function ensureDeviceRegistered(): Promise<void> {
  const key = clientKey();
  const platform = loginPlatform();
  if (!key || !platform || getDeviceId() !== null) return;
  if (!(await ensureAccessToken())) return; // not signed in yet — /auth/login will link it
  try {
    const { data } = await api.POST("/auth/device", {
      body: { clientKey: key, deviceName: "hokago app", platform },
    });
    if (data?.deviceId) storeDeviceId(data.deviceId);
  } catch {
    // best-effort — retried on next boot
  }
}

export { getNativeBridge, isNative, isTvShell, supportsDownloads, needsNativeUpdate };

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