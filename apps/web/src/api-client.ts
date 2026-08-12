import { createHokagoClient } from "@hokago/contract/client";

const ACCESS_KEY = "hokago_access_token";
const REFRESH_KEY = "hokago_refresh_token";
// Mirror of the access token for the browser to send on media/font/artwork
// subresource requests — `<video>`, `<img>` and CSS font fetches can't carry
// an Authorization header, so the API's authenticate decorator falls back to
// this cookie. SameSite=Lax: cross-site subresource loads never include it,
// and same-origin img/video/font requests always do.
const ACCESS_COOKIE = "hokago_access";

export function storeAccessToken(token: string): void {
  localStorage.setItem(ACCESS_KEY, token);
  const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  const maxAge = typeof payload.exp === "number" ? Math.max(60, Math.round(payload.exp - Date.now() / 1000)) : 900;
  document.cookie = `${ACCESS_COOKIE}=${token}; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearAccessCookie(): void {
  document.cookie = `${ACCESS_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`;
}

// One in-flight refresh at a time — concurrent 401s must not race.
let refreshInFlight: Promise<string | null> | null = null;

function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_KEY);
}

// Seed the cookie from any token that survived a reload. A fresh login and
// every refresh set it too, but a mid-TTL token must land in the cookie
// before the first <video>/<img> subresource request fires — otherwise the
// media stalls until the token approaches expiry and a refresh happens.
const bootToken = getAccessToken();
if (bootToken) storeAccessToken(bootToken);

function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

export function clearAuth(): void {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
  clearAccessCookie();
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
async function ensureAccessToken(): Promise<string | null> {
  const token = getAccessToken();
  if (!token) return null;
  const remaining = tokenExpiresInMs(token);
  if (remaining === null || remaining > 60_000) return token;
  return refreshAccessToken();
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
  // the session is truly over — clear both tokens and show the login gate.
  const fresh = await refreshAccessToken();
  if (!fresh) {
    clearAuth();
    if (location.pathname !== "/login") location.assign("/login");
    return res;
  }
  headers.set("Authorization", `Bearer ${fresh}`);
  res = await fetch(input, { ...init, headers });
  return res;
}

export const api: ReturnType<typeof createHokagoClient> = createHokagoClient("", { fetch: authFetch });
