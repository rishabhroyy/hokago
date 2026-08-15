import { createHokagoClient } from "@hokago/contract/client";
import { getNativeBridge, isTvShell } from "@hokago/native-bridge";
import { getActiveAccount, updateActiveTokens, removeAccount, addAccount } from "./tv-session";

const ACCESS_KEY = "hokago_access_token";
const REFRESH_KEY = "hokago_refresh_token";
const DEVICE_KEY = "hokago_device_id";
// Mirror of the access token for the browser to send on media/font/artwork
// subresource requests — `<video>`, `<img>` and CSS font fetches can't carry
// an Authorization header, so the API's authenticate decorator falls back to
// this cookie. SameSite=Lax: cross-site subresource loads never include it,
// and same-origin img/video/font requests always do.
const ACCESS_COOKIE = "hokago_access";

// ── Storage: bridge mirror in a shell, localStorage in a plain browser. The
// native shells persist this to Keychain/Keystore on every write, so sessions
// survive webview data wipes; the localStorage copy keeps the two in sync.
function read(key: string): string | null {
  const bridge = getNativeBridge();
  if (bridge) return bridge.storage.get(key);
  return localStorage.getItem(key);
}

function write(key: string, value: string): void {
  const bridge = getNativeBridge();
  if (bridge) bridge.storage.set(key, value);
  localStorage.setItem(key, value);
}

function erase(key: string): void {
  const bridge = getNativeBridge();
  if (bridge) bridge.storage.delete(key);
  localStorage.removeItem(key);
}

export function storeAccessToken(token: string): void {
  // TV mode: tokens live per-account, rotated in the active account object.
  const active = getActiveAccount();
  if (active) {
    updateActiveTokens(token);
  } else {
    write(ACCESS_KEY, token);
  }
  const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  const maxAge = typeof payload.exp === "number" ? Math.max(60, Math.round(payload.exp - Date.now() / 1000)) : 900;
  document.cookie = `${ACCESS_COOKIE}=${token}; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearAccessCookie(): void {
  document.cookie = `${ACCESS_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`;
}

/** Seed the cookie from a token that survived a reload (active TV account or the legacy key). */
const bootToken = getAccessToken();
if (bootToken) storeAccessToken(bootToken);

export function storeDeviceId(deviceId: string | null): void {
  if (deviceId) write(DEVICE_KEY, deviceId);
  else erase(DEVICE_KEY);
}

export function getDeviceId(): string | null {
  return read(DEVICE_KEY);
}

/**
 * Commit a fresh auth result. TV mode: register it as a new account (making
 * it active). Everywhere else: the legacy single-session keys.
 */
export function storeAuthResult(auth: {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  deviceId: string | null;
  username?: string;
}): void {
  if (isTvShell()) {
    addAccount({
      username: auth.username ?? "user",
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      sessionId: auth.sessionId,
      deviceId: auth.deviceId,
    });
  } else {
    write(ACCESS_KEY, auth.accessToken);
    write(REFRESH_KEY, auth.refreshToken);
    storeAccessToken(auth.accessToken);
  }
  storeDeviceId(auth.deviceId);
}

// One in-flight refresh at a time — concurrent 401s must not race.
let refreshInFlight: Promise<string | null> | null = null;

function getAccessToken(): string | null {
  const active = getActiveAccount();
  if (active) return active.accessToken;
  return read(ACCESS_KEY);
}

function getRefreshToken(): string | null {
  const active = getActiveAccount();
  if (active) return active.refreshToken;
  return read(REFRESH_KEY);
}

function tokenExpiresInMs(token: string): number | null {
  try {
    const payload = JSON.parse(
      atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    );
    return typeof payload.exp === "number" ? payload.exp * 1000 - Date.now() : null;
  } catch {
    return null;
  }
}

/**
 * Exchanges the stored refresh token for a new access token. Raw fetch on
 * purpose — must never go through this same wrapper (no auth header, no
 * refresh-on-refresh recursion). Returns the new access token, or null if the
 * refresh token is gone/expired/revoked.
 */
async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch("/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { accessToken: string };
        storeAccessToken(data.accessToken);
        return data.accessToken;
      } catch {
        return null;
      }
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/**
 * The token to send: the cached one when it's still got legs, otherwise a
 * silent refresh. This is what makes sessions survive the 15-minute access
 * token TTL — the refresh token (30 days, sliding) does the rest.
 */
export async function ensureAccessToken(): Promise<string | null> {
  const token = getAccessToken();
  if (!token) return null;
  const remaining = tokenExpiresInMs(token);
  if (remaining === null || remaining > 60_000) return token;
  return refreshAccessToken();
}

/**
 * A session that can't refresh anymore is over. TV mode: drop that account
 * (revoke server-side, best-effort) and fall to the account switcher; a
 * browser goes to the login gate.
 */
function sessionDead(): void {
  const active = getActiveAccount();
  if (active) {
    void fetch("/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: active.refreshToken }),
    }).catch(() => {});
    removeAccount(active.id);
    location.assign("/");
    return;
  }
  clearAuth();
  if (location.pathname !== "/login") location.assign("/login");
}

export function clearAuth(): void {
  const active = getActiveAccount();
  if (active) {
    void fetch("/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: active.refreshToken }),
    }).catch(() => {});
    removeAccount(active.id);
    location.assign("/");
    return;
  }
  erase(ACCESS_KEY);
  erase(REFRESH_KEY);
  erase(DEVICE_KEY);
  clearAccessCookie();
}

async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = await ensureAccessToken();
  // Start from the request's OWN headers. openapi-fetch passes a Request
  // object plus a bare init; per the fetch spec, init.headers would REPLACE
  // the Request's headers entirely — dropping Content-Type: application/json
  // and making the API answer 415 on every body-sending request.
  const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);

  let res = await fetch(input, { ...init, headers });
  if (res.status !== 401) return res;

  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  // Never try to refresh our way out of an /auth/ failure — a bad password
  // isn't a token problem.
  if (url.includes("/auth/")) return res;

  // One retry with a freshly refreshed token; if the refresh itself fails,
  // the session is truly over — drop it and show the appropriate gate.
  const fresh = await refreshAccessToken();
  if (!fresh) {
    sessionDead();
    return res;
  }
  headers.set("Authorization", `Bearer ${fresh}`);
  res = await fetch(input, { ...init, headers });
  return res;
}

export const api: ReturnType<typeof createHokagoClient> = createHokagoClient("", { fetch: authFetch });
