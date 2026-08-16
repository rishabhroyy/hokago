/**
 * Native-shell version policy (the "Discord model").
 *
 * The SPA is loaded fresh from the server on every launch, so UI/logic
 * updates never need an app store release. A native app update is only
 * required when the SHELL itself must change: new bridge surface, a new
 * native capability the web now relies on, OS SDK bumps, etc.
 *
 * Bump MIN_NATIVE_VERSION in the same commit that ships a native-level
 * change (a new bridge field, changed download semantics...). The web shows
 * an "app update required" gate to shells older than it. Store links for the
 * gate live in STORE_URLS.
 *
 * Convention: MIN_NATIVE_VERSION = the first native-app release that
 * contains the change. It must never exceed the version of a shell built
 * from the same tag, so keep it ≤ the tag of the release it ships in.
 */
export const MIN_NATIVE_VERSION = "0.3.0";

/** Where to send someone who must update their shell. */
export const STORE_URLS: Record<string, string> = {
  ios: "https://apps.apple.com/", // per-app link when the WebID is set up
  android: "https://play.google.com/store/apps/", // per-app link when the WebID is set up
  androidtv: "https://play.google.com/store/apps/",
  googletv: "https://play.google.com/store/apps/",
  macos: "https://github.com/", // repo releases — filled in by scripts/native-release.md
  windows: "https://github.com/",
  linux: "https://github.com/",
};

function versionAtLeast(appVersion: string, minimum: string): boolean {
  const a = appVersion.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const b = minimum.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av > bv;
  }
  return true;
}

/** True when this shell must be updated before the web UI can work fully. */
export function needsNativeUpdate(appVersion: string): boolean {
  return !versionAtLeast(appVersion, MIN_NATIVE_VERSION);
}

export function storeUrlFor(platform: string): string {
  return STORE_URLS[platform] ?? STORE_URLS.linux;
}