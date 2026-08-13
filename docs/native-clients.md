# Native clients — intentions & architecture

Status: **backend plumbing is done; no native client exists yet.** This file is
the contract for future agents who build the client suite. If the code and this
file disagree, the code is right — fix this file.

## North star

- **One codebase, one UI.** `apps/web` is the single source of truth for the UI
  (React + Tailwind + the hardcoded design in `tailwind.config.ts`/`app.css`).
  Every native app is a thin **webview shell** embedding that same app, so the
  UI is 1:1 byte-for-byte across web/mobile/desktop/TV. Any approach that
  re-implements the UI in a native toolkit (SwiftUI/Compose/RN-rendered) is a
  second codebase to keep in sync and is **rejected**.
- **Native feel comes from bridges, not from re-rendering.** Each shell
  provides: a native media player, a native download manager + file storage, a
  secure token store, native scroll/gesture physics, and (TV) remote/D-pad key
  mapping onto DOM events. The web app must not be forked to add these — it
  talks to a platform bridge instead.
- **Clients are thin.** All logic, decisions, and state (playback method,
  transcoding, watch state, downloads) live server-side. A client just calls
  the typed API and plays bytes.
- **Chromecast is never** (invariant). AirPlay rides along with the native
  clients (it's just a playback target profile).

## Platform matrix

| Platform | Shell | Player | Downloads | Auth UI |
|---|---|---|---|---|
| Web | browser | vidstack + hls.js + JASSUB | — (never, browser) | login/pair |
| iOS / iPadOS | Capacitor (or native WKWebView shell) | AVPlayer | yes (via bridge) | login + pair |
| Android | Capacitor | ExoPlayer / Media3 | yes | login + pair |
| macOS / Windows / Linux | Tauri | libmpv / system media framework | yes | login + pair |
| tvOS | native TVML/webview shell | AVPlayer | **no** (by design) | **pairing only** (no keyboard) |
| Android TV / Google TV | webview shell | ExoPlayer | **no** | **pairing only** |

TV apps must not offer downloads/offline (explicit product decision). They
authenticate exclusively through the TV pairing flow — there is no soft
keyboard password entry.

## How the web app runs in a shell

The shell loads the built SPA (the API serves it at `/`; the shell can also
bundle it offline-updatable). Configuration that must flow shell → web app:

1. **Base URL** — where the API lives. All API calls go through
   `createHokagoClient(baseUrl, { fetch })` (`packages/contract/src/client.ts`);
   the shell injects `baseUrl` (via query param, `localStorage` seed, or a
   `window.hokagoConfig` bridge).
2. **Token store** — `apps/web/src/api-client.ts` persists tokens in
   `localStorage` + a cookie mirror. In a shell these must be swapped for the
   native secure store (Keychain/Keystore/`keytar`): implement the
   `Storage`/`SecureStorage` bridge and wire it into `api-client.ts`. The
   cookie mirror is web-only (media elements can't send headers) — a native
   player sends `Authorization: Bearer` itself, so no cookie is needed.
3. **Embedded relative URLs** — the API emits origin-relative paths
   (`posterUrl`, `playlistUrl`, `streamUrl`, download artifact URLs). Clients
   resolve them against the configured base URL. No client code may assume
   same-origin or a fixed host.

## The platform bridge interface (to build)

Define one typed bridge (`packages/client-core` or similar; web app imports it
with a no-op browser implementation). Suggested surface:

- `storage` / `secureStorage` (get/set/delete) — `api-client.ts`, `track-prefs.ts`, `useTheme.tsx`
- `baseUrl` (+ `resolveUrl(relative)` for every `src`/`url` the web app embeds)
- `nativePlayer` — swap vidstack+hls.js+JASSUB for AVPlayer/ExoPlayer/libmpv. The **protocol** to reimplement is `WatchPage.tsx`'s contract: `POST /playback/start` → decide DIRECT_PLAY (play `/media-files/:id/direct`), REMUX (`streamUrl`, progressive MP4), or TRANSCODE (`playlistUrl`, HLS); the timeline-offset math (`actualStartMs`/`resumePositionMs`), the seek/audio/quality restart pump, heartbeat at 10s, and `POST /playback/:sessionId/stop`.
- `downloadManager` — orchestrate `/downloads`, persist bytes to app sandbox storage, track per-item progress, serve the local file to the player, register subtitles/fonts for the offline renderer.
- `watchState` — offline progress queue; on reconnect `POST /watch-state/sync`.
- TV: `keyMapper` (D-pad/back/OK → DOM `keydown`), and `pairFlow` (request/status polling).
- Deep links / router: the web app's router uses `history.pushState` — shells map app-link URIs (e.g. `hokago://title/...`) into `location` before load.

## Backend plumbing — DONE (do not rebuild)

Everything below is implemented and working; build on it, don't replace it.

### Auth & devices
- **Persistent sessions** already existed (15m access JWT + 30d sliding opaque refresh token, hashed in the revocable `sessions` table). Native clients log in once, store the refresh token in the secure store, and refresh silently forever.
- **Device registration**: `POST /auth/login` accepts `clientKey` (stable per-install UUID) + `deviceName` + `platform`; the server upserts a `Device` row and binds the session to it (`Device` model). `GET /auth/devices`, `DELETE /auth/devices/:id` (revokes every session bound to it and cascades its downloads).
- **TV pairing** (no password entry on TVs): `POST /auth/pair/request` (TV, unauthenticated, rate-limited) → 6-digit code; `POST /auth/pair/verify` (logged-in phone/PC) approves it and registers the TV's `Device`; `POST /auth/pair/status` (TV polls) mints the session **exactly once** (atomic APPROVED→COMPLETE claim) and returns tokens + `deviceId`.
- **Liveness re-check**: access tokens carry `sessionId`; `authenticate` re-checks the session isn't revoked and the account isn't disabled (30s in-memory cache; revoke/logout invalidate it immediately). Revoked/disabled accounts lose access within seconds, not 15m.
- **Login/pairing rate limiting**: in-memory sliding window, per real client IP and per username (`HOKAGO_LOGIN_RATE_LIMIT_IP`, `HOKAGO_LOGIN_RATE_LIMIT_USERNAME`).

### Network topology support
- **Real client IP**: `clientIp()` (`apps/api/src/rate-limit.ts`) prefers `CF-Connecting-IP` (always trusted — Cloudflare), then `X-Forwarded-For` **only** when `HOKAGO_TRUST_PROXY=true` (opt-in: `trustProxy`). Set that env when behind nginx/caddy/CF Tunnel.
- **Proxy-friendly URLs**: the API only ever emits origin-relative paths; proxies at any prefix that preserves paths work. **Sub-path hosting** (`/hokago/...`) is deliberately out of scope — a host should own its root (subdomain per service), and the app is not base-path aware. Never add `HOKAGO_BASE_PATH`/`basePath` plumbing.
- **WebSockets** (watch party `/ws/party/*`, presence `/ws/presence`) authenticate via JWT query param; reverse proxies must forward the `Upgrade`/`Connection` headers (Cloudflare Tunnel does; nginx needs `proxy_set_header Upgrade $http_upgrade;`).
- **Streaming through proxies**: preserve `Range`/206, do not buffer long responses, set generous timeouts (HLS segments are on-demand ffmpeg; REMUX blocks until the remux completes). COOP/COEP headers (set by `web-routes.ts`) must pass through or JASSUB offline fonts break.

### Offline downloads
- `POST /downloads` (`{mediaItemId, mediaFileId, deviceId, variant, subtitleTrackIds?}`).
  - `variant: {kind: "original"}` — the raw file, copied.
  - `variant: {kind: "transcode", maxHeight?, maxBitrateKbps?}` — ffmpeg to a self-contained **faststart MP4** (h264 8-bit 4:2:0, AAC, `buildDownloadArgs` in `packages/ffmpeg/src/download.ts`). Caps are clamped like playback.
  - Text subtitle tracks (SRT/VTT/ASS) are packaged as sidecars for either variant; a bitmap track (PGS/VOBSUB/DVBSUB) on `original` is rejected (422) and on `transcode` is burned into the encode. ASS tracks pull the file's fonts (`MediaFileFont` → `/config/fonts/<hash>`) into the artifact.
- Worker job (`download` BullMQ queue, `HOKAGO_DOWNLOAD_CONCURRENCY` default 2) builds the artifact in `configDir()/downloads/<id>` **atomically** (tmp dir → rename), writes `manifest.json`, and flips the `Download` row to `READY`.
- Serving (all authenticated, all origin-relative):
  - `GET /downloads` · `GET /downloads/:id` · `DELETE /downloads/:id`
  - `GET /downloads/:id/artifact` — manifest (media + subtitle sidecars + fonts)
  - `GET /downloads/:id/artifact/media` (Range/206) · `.../subtitles/:trackId` · `.../fonts/:hash`
- A client's download flow: enumerate files via `GET /media-items/:id/files` → create the download → poll `GET /downloads/:id` until `READY` → fetch the artifact → store locally → delete the server copy when confirmed on-device (or keep for other devices). Downloads are per-device (device-scoped) and server-tracked.
- **Offline playback state**: play locally, queue progress, then `POST /watch-state/sync` (`{profileId, entries[]}`) on reconnect — upserts the same `PlaybackState` rows heartbeats write (continue-watching/resume just work). No `WatchDay` credit for offline time (live-heartbeat only, by design).

### Files manifest
`GET /media-items/:id/files` lists **all** of an item's playable files (browse only ever exposed the first): container, duration, size, bitrate, video stream summary, full audio/subtitle track lists, and `isPrimary`. This is what the download/version picker uses.

### Typed client
All new routes are in the OpenAPI doc; binary routes (direct file, subtitle text, fonts, trickplay sheets, HLS playlist/segments, download artifacts) are now registered too (typed as strings — `openapi-fetch` returns a `Response` regardless). Regenerate with `pnpm --filter @hokago/contract generate` after contract changes.

## Client auth flows

1. **First launch (mobile/desktop)**: username/password once → store `refreshToken` + `sessionId` in the secure store → silent refresh forever. Send `clientKey` (persisted UUID) + `deviceName` + `platform` on login so the device appears in the account's device list.
2. **TV**: `pair/request` → show 6-digit code + a "enter code at <server>/pair" hint → poll `pair/status` (every ~5s) → on `COMPLETE`, store the returned tokens exactly like login. Handle `EXPIRED` by re-requesting.
3. **Logout**: `POST /auth/logout` with the refresh token (revokes the session server-side), clear the secure store.
4. **Token refresh**: mirror `api-client.ts` (single in-flight refresh mutex, refresh when <60s left, one 401 retry). A failed refresh = session over → clear → login/pair UI.

## Deployment topologies the clients must tolerate

- **Tailscale**: works with no special handling — the client just needs a base URL (`http://<tailscale-host>:3000` or a tailnet HTTPS hostname).
- **Cloudflare Tunnel**: enable WebSockets (on by default in `cloudflared`); rate limiting uses `CF-Connecting-IP` automatically.
- **Cloudflare Zero Trust (Access) in front**: interactive SSO can't run inside a native app, and hokago has its own auth. The recommended setup: a Cloudflare Access policy that does **not** require identity for the hokago hostname (IP/tunnel-allow only), leaving hokago's JWT auth as the single auth layer. If policy-level auth is required, use an Access **service token** (client-id/secret headers) baked into the native client — but hokago's API is not Access-aware and won't consume Access headers itself.
- **nginx/caddy/other**: `HOKAGO_TRUST_PROXY=true` + forward `X-Forwarded-For`/`X-Forwarded-Proto`; forward WebSocket `Upgrade`; keep `Range` + COOP/COEP headers; raise buffering/timeouts for streaming.
- **With or without a proxy**: the API binds `0.0.0.0:3000` and serves the SPA itself. No proxy config is ever required; everything is origin-relative so subdomain-proxying works out of the box.

## Seams in the web app to refactor (when building the shell)

- `apps/web/src/api-client.ts` — `localStorage`/`document.cookie`/`location.assign` are the only web-isms; extract behind the bridge.
- `apps/web/src/router.tsx` — `history.pushState`/`popstate`; shells seed `location` from deep links.
- `apps/web/src/WatchPage.tsx` — the entire player is browser-media-coupled (vidstack, hls.js, JASSUB-wasm, `HTMLVideoElement.audioTracks`, `requestVideoFrameCallback`, autoplay policy). Its *protocol* is the portable part; the renderer is replaced per platform. Do not port vidstack/hls.js/JASSUB to a native player — implement the protocol with AVPlayer/ExoPlayer/libmpv.
- `apps/web/src/device-profile.ts` — `BROWSER_DEVICE_PROFILE`; each native platform declares its own profile (`supportedContainers`/codecs/subtitleMode) and passes it to `/playback/start`. `subtitleMode: "external"` for players that render soft subs natively, `"burn"` otherwise.
- Fonts: the web app fetches `@font-face` rules from `/fonts` at boot; native players render their own text but ASS offline subtitles need the packaged fonts (`/downloads/:id/artifact/fonts/*`) wired to the subtitle renderer the same way JASSUB's `availableFonts` maps hashes.

## Open items (deliberately not done yet)

- **Offline subtitle burn-in on TV** and full image-subtitle offline (only burn-in-on-transcode + text sidecars exist).
- **`POST /watch-state/sync` doesn't write `WatchDay`** — offline time is not credited to history stats. Revisit if clients want it.
- **Download resume**: the server artifact is idempotent per download, but a client that loses its partial file must restart. Range-resumable client-side downloading is a client concern; the API supports Range on `/artifact/media`.
- **Download space/cleanup UI**, per-device download quotas.
- **Offline self-updating shells** (bundle the SPA in the app, update from the server).

## Non-negotiable guardrails

- Never fork the web UI for a platform. UI changes happen in `apps/web` once.
- Never add a second auth system. The JWT/refresh/device/pairing layer is the only one.
- Chromecast: never. AirPlay only as a native playback target.
- No third-party font/artwork URLs ever served to a client — everything from our origin (COOP/COEP depends on it).
- Keep every new API route in the contract (`packages/contract`) + OpenAPI doc, or generated clients won't see it.
