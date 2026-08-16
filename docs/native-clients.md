# Native clients — architecture & implementation

Status: **implemented.** The backend plumbing, the bridge contract, the web-side
TV/downloads/update-gate code, and all three shell families (Tauri desktop,
iOS WKWebView, Android WebView phone+TV) exist, and `.github/workflows/native.yml`
builds and releases them on every `v*` tag. If the code and this file disagree,
the code is right — fix this file.

## North star

- **One codebase, one UI, one player.** `apps/web` is the single source of truth
  for the UI **and the media player** (React + Tailwind + vidstack + hls.js +
  JASSUB). Every native app is a thin **webview shell** embedding the same SPA,
  so the UI and playback are byte-for-byte identical across web/mobile/desktop/
  TV. Any approach that re-implements the UI *or* the player in a native toolkit
  (SwiftUI/Compose/AVPlayer/ExoPlayer) is a second codebase to keep in sync and
  is **rejected**. There is no native media player; the web player runs inside
  the webview on every platform.
- **Bridges are narrow.** A shell only supplies what a webview cannot:
  stable per-install identity, a secure store that survives webview data wipes,
  and (non-TV) real download bytes to device storage. Everything else — routing,
  auth, TV pairing, account switching, D-pad navigation, playback decisions —
  lives in the web app and is exercised identically in a plain browser.
- **Clients are thin.** All logic, decisions, and state (playback method,
  transcoding, watch state, downloads) live server-side. A client just calls
  the typed API and plays bytes.
- **Updates are Discord-style.** The SPA is fetched fresh from the server on
  every launch — a webview shell can never ship stale UI. The shell itself
  only needs updating when *native* capabilities change, which the web app
  detects via `window.hokagoNative.appVersion` against `MIN_NATIVE_VERSION`
  and surfaces through `NativeUpdateGate`.
- **Chromecast is never** (invariant). AirPlay rides along with the native
  clients (it's just a playback target profile).

## Platform matrix

| Platform | Shell | Player | Downloads | Auth UI |
|---|---|---|---|---|
| Web | browser | vidstack + hls.js + JASSUB (in-app) | — (never, browser) | login/pair |
| iOS / iPadOS | native WKWebView (no Capacitor) | web player in webview | yes (native, `downloads.save`) | login + pair |
| Android (phone) | native WebView | web player in webview | yes | login + pair |
| macOS / Windows / Linux | Tauri 2 | web player in webview | yes (native, `~/Downloads/hokago/`) | login + pair |
| Android TV / Google TV | native WebView (same app, `tv` flavor) | web player in webview | **no** (by design) | **pairing only** + account switcher |
| ~~tvOS~~ | — | — | — | — |

**tvOS was dropped**: Apple forbids third-party apps from using WKWebView on
tvOS, so a tvOS client would mean re-implementing the entire UI in SwiftUI —
a second codebase, rejected by the north star. Android TV keeps WebView
availability, so it ships.

TV apps must not offer downloads/offline (explicit product decision). They
authenticate exclusively through the TV pairing flow — there is no soft
keyboard password entry — and multi-profile switching happens in-app via the
account switcher (no passwords needed; sessions are already on the device).

## The bridge contract (implemented, `packages/native-bridge`)

Every shell injects a `window.hokagoNative` object into **every page load** of
the remote SPA, before the first script runs (Tauri: `on_page_load` eval of a
generated script; iOS: a `WKUserScript` at document start; Android:
`evaluateJavascript` on `onPageStarted`). The web app treats it as an optional
capability layer — the browser build never sees it, and every consumer degrades
gracefully. The single source of truth is
`packages/native-bridge/src/bridge.ts`; shells must match it exactly.

```ts
interface NativeBridge {
  platform: "ios" | "android" | "macos" | "windows" | "linux" | "androidtv" | "googletv";
  appVersion: string;   // the git tag, e.g. "0.2.0" — the web gates on MIN_NATIVE_VERSION
  appBuild: string;     // native build number (CFBundleVersion / versionCode)
  clientKey: string;    // stable per-install UUID, sent as LoginBody.clientKey / PairingRequestBody.clientKey
  storage: { get(key): string | null; set(key, value): void; delete(key): void };  // synchronous
  downloads: {
    save(url: string, filename: string): Promise<{ localPath: string; sizeBytes: number }>;
    /** Desktop only: reveal the file in the OS file manager. */
    open?(localPath: string): void;
    /** Every saved file on disk — the offline library's existence check. */
    list(): Promise<{ localPath: string; sizeBytes: number }[]>;
    /** A playable URL for a local file (hokago-file:// scheme — the shell serves it). */
    localUrl(localPath: string): string;
    /** Reads a local text sidecar (subtitle) back for offline JASSUB. */
    readText?(localPath: string): Promise<string>;
  };
}
```

- **Storage** is a *mirror*. The web app keeps its canonical tokens in
  `localStorage` and writes every change through to `bridge.storage` too; the
  shell persists that copy in the OS secure store (Tauri: keyring with a plain
  file fallback for headless Linux; iOS: Keychain; Android: AES-GCM wrapped by
  the Android Keystore, plain-prefs fallback). Result: wiping webview storage
  never kills a session. Reads are synchronous everywhere (Android's
  `addJavascriptInterface` and Tauri's IPC are sync; iOS serves reads from
  localStorage and re-seeds it asynchronously from the Keychain after a wipe).
- **Native → web events**: shells dispatch
  `window.dispatchEvent(new CustomEvent("hokago-native", { detail: { type: ... } }))`.
  `type: "back"` is the one consumed by the web app (TV/remote back at router
  root). Download completion uses an internal `downloadResult` correlation id
  that the injected shim resolves into the `downloads.save` promise.
- **Web → native events**: the SPA dispatches the same `hokago-native` event
  with `type: "route"` (detail: `{ view: route.view }`) on every route change
  while in a shell. Shells use it to flip native chrome for the player:
  iOS hides the status bar + home indicator on player/offlineWatch routes,
  Android hides the system bars (immersive) the same way. Old shells that
  don't listen are unaffected; plain browsers never dispatch it.
- **Downloads never see tokens in JS.** The web hands the shell a resolved
  artifact URL + filename; the native side attaches `Authorization: Bearer
  <token>` from its own secure-store mirror (`hokago_access_token`). The web
  keeps that mirror warm via `startTokenWarmth` (refresh every 4 min while a
  shell session is alive).
- **Base URL**: each shell has a first-run setup screen (Tauri: a local
  `index.html` in `native/tauri/ui/`; iOS: `ServerSetupViewController`; Android:
  an inline setup view) that stores the server URL and navigates the webview to
  it. The web app resolves origin-relative API paths against `window.location`
  via `resolveUrl` (`packages/native-bridge/src/bridge.ts`) — no client code
  assumes a fixed host.

## How the web app runs in a shell

1. **Base URL** — first-run setup screen per shell; stored in native config
   (`{config_dir}/hokago/server.json` on desktop, `UserDefaults`/prefs elsewhere).
   Desktop exposes a "Change Server…" menu item that navigates back to the setup
   page (`show_setup` command).
2. **Safe areas** — the SPA viewport is `viewport-fit=cover` and all fixed
   chrome (top nav, player buttons, banners/toasts) pads itself with
   `--hokago-safe-*` CSS vars (`env(safe-area-inset-*)` at :root). iOS
   resolves those natively; Android shells re-inject the same vars as literal
   pixels from their window insets (`displayCutout` + `systemBars`) so even
   WebView engines that don't forward env() values land in the right place.
   The shells render edge-to-edge (`.ignoresSafeArea()` / `decorFitsSystemWindows
   = false`) and the web page owns all inset math.
3. **Token store** — `apps/web/src/api-client.ts` writes through the bridge
   (`read`/`write`/`erase` in `api-client.ts`), falling back to `localStorage`
   in a browser. The cookie mirror (`hokago_access`, SameSite=Lax) stays for the
   web player's subresource fetches (`<video>`/`<img>`/fonts can't send headers);
   native downloaders send `Authorization` themselves and need no cookie.
3. **TV mode** (Android TV/Google TV) — entirely web-side: pairing
   (`TvPairFlow`, `POST /auth/pair/request` + poll `/status` at ~3.5s to stay
   under the 20/min limit), the account switcher (`TvAccountsView`, sessions in
   `tv-session.ts` keyed per account, active account drives `api-client.ts`),
   and D-pad navigation (`useTvKeyboardNav` in `apps/web/src/ui/tv-keys.ts` —
   TV focusables are real `button`/`a`/`[tabindex]` elements, and the media grid
   already is). The shell only hosts the SPA and forwards `KEYCODE_BACK`.
4. **Downloads UI** — `DownloadsView` + `apps/web/src/downloads.ts`: enumerate
   files (`GET /media-items/:id/files`) → `POST /downloads` → poll `GET
   /downloads/:id` until `READY` → `GET /downloads/:id/artifact` →
   `bridge.downloads.save(url, filename)` → native bytes land in
   `~/Downloads/hokago/` (desktop), `Documents/hokago/` (iOS), or the app's
   external downloads dir `Android/data/com.hokago.app/files/Download/hokago/`
   (Android — public `Downloads/` needs permissions/MediaStore on modern
   Android and has no real path, so saves live app-scoped and are exposed via
   the FileProvider `open`). Downloads are hidden on TV platforms and in a
   plain browser.

## Update policy

`packages/native-bridge/src/versions.ts` holds `MIN_NATIVE_VERSION` (the
minimum *shell* version the current web UI requires) plus per-platform store
URLs. The web app compares `window.hokagoNative.appVersion` against it and
renders `NativeUpdateGate` when the shell is too old. Bump `MIN_NATIVE_VERSION`
only when a change touches native-level capability (a new bridge method, a
player/font API the old webview can't run). Pure web changes never require a
store update — the next launch just fetches the new SPA.

## Offline mode

Downloads are only useful offline, so the shells bundle a copy of the built
SPA and the web app gets an offline library.

- **Boot fallback**: each shell bundles `apps/web/dist` and serves it from a
  real origin root (Tauri: the `hokago-spa://` custom scheme; iOS: a
  `WKURLSchemeHandler` for `hokago-spa://localhost/` loaded via
  `loadHTMLString` with that base URL; Android: a fake `http://hokago-app.local`
  origin intercepted in `shouldInterceptRequest`). file:// can't work — the
  SPA's asset URLs are absolute (/assets/...), its history router needs a root
  path, and localStorage is origin-scoped. The shell tries the configured
  server first (Discord-model freshness); when it can't be reached it loads
  the bundled SPA instead. The bundled SPA is *exactly the same app* — no
  fork — so offline behaviour is the same code path as online.
- **Offline library** (`apps/web/src/offline.ts`, `/offline`): a local
  manifest of every saved download, with title/kind/poster metadata captured
  at download time (DetailView). It re-hydrates against `downloads.list()` so
  vanished files drop out. `OfflineView` renders it; `OfflineWatchPage`
  (`/offline/watch/:downloadId`) plays a saved file through
  `downloads.localUrl()` — a `hokago-file://` custom scheme the shell serves
  with Range support so seeking works.
- **Offline watch-state**: playback progress is queued locally
  (`queueWatchState`) and flushed to `/watch-state/sync` the moment
  connectivity returns (`useConnectivity` polls `/health` every 5s while
  offline; a `back online` toast confirms the sync). The server's sync route
  predates this and is unchanged — plain upserts, no watchDay credit.
- **Detection**: `navigator.onLine` + a `/health` probe. An offline banner
  appears at the top of every view and links into the offline library.

## Shell implementations

- **Tauri desktop** (`native/tauri`) — Tauri 2, wry webview, config +
  clientKey in `src-tauri/src/config.rs`, bridge + keyring mirror + reqwest
  downloads in `src-tauri/src/bridge.rs`. Remote origins (`http(s)://**`) get
  core IPC via the capability in `src-tauri/capabilities/main.json`; the
  `hokago-file://`/`hokago-spa://` schemes are registered on the builder. The
  injected shim is appended to Tauri's IPC init script (document start, not
  page-load completion, so the SPA always sees the bridge). Storage follows
  the iOS/Android facade: sync reads from localStorage, write-through to the
  OS keyring, re-seeded on boot (`storage_hydrate`). The /health probe runs
  Rust-side (`probe_server`) because a webview fetch from a custom origin is
  CORS-blocked. Icon: the committed 1024px `icon.png` (hokago logo on white);
  `tauri icon` derives `.icns`/`.ico` — run it locally and commit the result.
- **iOS** (`native/ios`) — raw WKWebView, no Capacitor. Xcode project generated
  from `project.yml` with XcodeGen (committed; CI runs `brew install xcodegen
  && xcodegen generate`). Bridge: `WKUserScript` at document start + a
  `WKScriptMessageHandler`; tokens in the Keychain; downloads via
  `URLSession.downloadTask` with the Bearer header; `hokago-file://` served by
  a `WKURLSchemeHandler`, `hokago-spa://` likewise (`SpaSchemeHandler`).
  App icon lives in `hokago/Assets.xcassets` (1024px, no alpha); the launch
  screen is a black `LaunchBackground` color (no white flash). Webview
  chrome: no bounce, black under-page background. The `route` event hides
  the status bar + home indicator (`statusBarHidden` +
  `persistentSystemOverlays`) on player routes, and swings phones to
  landscape while watching (portrait elsewhere; iPads keep free rotation).
  AirPlay is on.
- **Android** (`native/android`) — raw WebView with a synchronous
  `addJavascriptInterface` bridge; phone + TV product flavors; AES-GCM
  Keystore-backed secure store; downloads via `HttpURLConnection` into the
  app's external downloads dir (opened with a FileProvider); `hokago-file://`
  intercepted in `shouldInterceptRequest` with Range support, as are the
  `web-dist` assets behind the fake `http://hokago-app.local` origin.
  `WebChromeClient` implements `onShowCustomView`/`onHideCustomView`, so the
  player's fullscreen button gets a real native fullscreen view (immersive
  bars, phones lock to landscape — the same in-webview renderer, just
  chromeless). The `route` event hides the system bars on player routes and
  swings phones to landscape while watching (portrait elsewhere; tablets
  rotate freely; TV untouched).
  Window insets are forwarded into the page as `--hokago-safe-*` CSS vars
  (edge-to-edge on every API level; short-edges cutout mode). Release builds are signed
  in CI with a key held in **repo secrets** — never committed: the APK
  signature is Android's trust anchor, and a leaked key lets anyone ship
  malicious updates over the install base. The secrets are
  `ANDROID_KEYSTORE_BASE64` (base64 of the .keystore), `ANDROID_KEYSTORE_PASSWORD`,
  `ANDROID_KEY_ALIAS` (hokago), `ANDROID_KEY_PASSWORD`; the android job decodes
  them and fails loudly if unset. Local `assembleRelease` without the env vars
  falls back to the debug keystore (installable, but the signature is
  machine-local — only for sideload testing, never for releases).
  Gradle wrapper is **not** committed — CI uses `gradle/actions/setup-gradle`
  with `gradle-version` and invokes `gradle` directly. Adaptive icon: white
  background + the logo as foreground; TV banner is `drawable-xhdpi/banner.png`.

## CI delivery (`.github/workflows/native.yml`)

On every `v*` tag: `tauri-macos` (arm64 .dmg), `tauri-windows` (x64 .msi),
`tauri-linux` (AppImage/deb), `ios` (simulator .zip + unsigned sideload .ipa),
`android` (phone + TV release APKs, self-signed with the committed keystore).
Each job strips the leading `v` and bakes the tag into the app version
(Cargo.toml + tauri.conf.json for Tauri, project.yml for XcodeGen,
`-PappVersion*` for Gradle). A dedicated `release` job creates **one** draft
GitHub Release first (with install notes — e.g. the `xattr -cr` Gatekeeper fix
for ad-hoc-signed macOS builds); every build job `needs:` it and only uploads
assets (tauri-action reuses the existing release; `gh release upload
--clobber` likewise). Never race two `gh release create` calls — that was the
multi-draft bug. `release.yml` (GHCR image) and `native.yml` (clients) both
trigger on the same tag; neither needs the other to run.

## Backend plumbing — DONE (do not rebuild)

Everything below is implemented and working; build on it, don't replace it.

### Auth & devices
- **Persistent sessions** already existed (15m access JWT + 30d sliding opaque
  refresh token, hashed in the revocable `sessions` table). Native clients log
  in once, store the refresh token in the secure store, and refresh silently
  forever.
- **Device registration**: `POST /auth/login` accepts `clientKey` (stable
  per-install UUID) + `deviceName` + `platform`; the server upserts a `Device`
  row and binds the session to it. `GET /auth/devices`, `DELETE /auth/devices/:id`
  (revokes every session bound to it and cascades its downloads).
- **Multi-account devices**: a device may be paired to many accounts via the
  `DeviceAccount` join model. The device list shows owned **and** linked
  devices; deleting a device is allowed by the owner *or* any linked account.
  This is what makes TV account switching possible without re-pairing.
- **TV pairing** (no password entry on TVs): `POST /auth/pair/request` (TV,
  unauthenticated, rate-limited) → 6-digit code; `POST /auth/pair/verify`
  (logged-in phone/PC) approves it and registers the TV's `Device`;
  `POST /auth/pair/status` (TV polls) mints the session **exactly once**
  (atomic APPROVED→COMPLETE claim) and returns tokens + `deviceId` + `username`
  (so the TV can label the newly added account).
- **Liveness re-check**: access tokens carry `sessionId`; `authenticate`
  re-checks the session isn't revoked and the account isn't disabled (30s
  in-memory cache; revoke/logout invalidate it immediately). Revoked/disabled
  accounts lose access within seconds, not 15m.
- **Login/pairing rate limiting**: in-memory sliding window, per real client IP
  and per username (`HOKAGO_LOGIN_RATE_LIMIT_IP`,
  `HOKAGO_LOGIN_RATE_LIMIT_USERNAME`).

### Network topology support
- **Real client IP**: `clientIp()` (`apps/api/src/rate-limit.ts`) prefers
  `CF-Connecting-IP` (always trusted — Cloudflare), otherwise the resolvers on
  Fastify `req.ip` backed by `trustProxy` configured from `HOKAGO_TRUST_PROXY` —
  `true`, a hop count (`1`/`2`), or a comma-separated proxy IP list. Set it when
  behind nginx/caddy/CF Tunnel.
- **Proxy-friendly URLs**: the API only ever emits origin-relative paths;
  proxies at any prefix that preserves paths work. **Sub-path hosting**
  (`/hokago/...`) is deliberately out of scope — a host should own its root, and
  the app is not base-path aware. Never add `HOKAGO_BASE_PATH`/`basePath`
  plumbing.
- **WebSockets** (watch party `/ws/party/*`, presence `/ws/presence`)
  authenticate via JWT query param; reverse proxies must forward the
  `Upgrade`/`Connection` headers.
- **Streaming through proxies**: preserve `Range`/206, do not buffer long
  responses, set generous timeouts (HLS segments are on-demand ffmpeg; REMUX
  blocks until the remux completes). COOP/COEP headers (set by `web-routes.ts`)
  must pass through or JASSUB offline fonts break.

### Offline downloads
- `POST /downloads` (`{mediaItemId, mediaFileId, deviceId, variant,
  subtitleTrackIds?}`).
  - `variant: {kind: "original"}` — the raw file, copied.
  - `variant: {kind: "transcode", maxHeight?, maxBitrateKbps?}` — ffmpeg to a
    self-contained **faststart MP4** (h264 8-bit 4:2:0, AAC, `buildDownloadArgs`
    in `packages/ffmpeg/src/download.ts`). Caps are clamped like playback.
  - Text subtitle tracks (SRT/VTT/ASS) are packaged as sidecars for either
    variant; a bitmap track (PGS/VOBSUB/DVBSUB) on `original` is rejected (422)
    and on `transcode` is burned into the encode. ASS tracks pull the file's
    fonts (`MediaFileFont` → `/config/fonts/<hash>`) into the artifact.
- Worker job (`download` BullMQ queue, `HOKAGO_DOWNLOAD_CONCURRENCY` default 2)
  builds the artifact in `configDir()/downloads/<id>` **atomically** (tmp dir →
  rename), writes `manifest.json`, and flips the `Download` row to `READY`.
- Serving (all authenticated, all origin-relative):
  - `GET /downloads` · `GET /downloads/:id` · `DELETE /downloads/:id`
  - `GET /downloads/:id/artifact` — manifest (media + subtitle sidecars + fonts)
  - `GET /downloads/:id/artifact/media` (Range/206) · `.../subtitles/:trackId` ·
    `.../fonts/:hash`
- A client's download flow: enumerate files via `GET /media-items/:id/files` →
  create the download → poll `GET /downloads/:id` until `READY` → fetch the
  artifact → store locally → delete the server copy when confirmed on-device.
  Downloads are per-device and device-scoped; a device may be owned or linked
  (multi-account). `watch-state/sync` covers offline playback progress.

### Files manifest
`GET /media-items/:id/files` lists **all** of an item's playable files (browse
only ever exposed the first): container, duration, size, bitrate, video stream
summary, full audio/subtitle track lists, and `isPrimary`. This is what the
download/version picker uses.

### Typed client
All new routes are in the OpenAPI doc; binary routes (direct file, subtitle
text, fonts, trickplay sheets, HLS playlist/segments, download artifacts) are
registered too (typed as strings — `openapi-fetch` returns a `Response`
regardless). Regenerate with `pnpm --filter @hokago/contract generate` after
contract changes.

## Client auth flows

1. **First launch (mobile/desktop)**: username/password once → store
   `refreshToken` + `sessionId` in the secure store → silent refresh forever.
   Send `clientKey` (persisted UUID) + `deviceName` + `platform` on login so
   the device appears in the account's device list.
2. **TV**: `pair/request` → show 6-digit code + a "enter code at <server>/pair"
   hint → poll `pair/status` (every ~3.5s; 20/min limit) → on `COMPLETE`, store
   the returned tokens as a new account (label it with the returned `username`)
   and switch to it. Handle `EXPIRED` by re-requesting.
3. **TV account switching**: `TvAccountsView` lists the accounts paired to this
   device (`GET /auth/devices` + `DeviceAccount` links); switching sets the
   active account (`tv-session.ts`) and reloads — no password needed.
4. **Logout**: `POST /auth/logout` with the refresh token (revokes the session
   server-side), clear the secure store.
5. **Token refresh**: mirror `api-client.ts` (single in-flight refresh mutex,
   refresh when <60s left, one 401 retry). A failed refresh = session over →
   clear → login/pair UI.

## Deployment topologies the clients must tolerate

- **Tailscale**: works with no special handling — the client just needs a base
  URL (`http://<tailscale-host>:3000` or a tailnet HTTPS hostname).
- **Cloudflare Tunnel**: enable WebSockets (on by default in `cloudflared`);
  rate limiting uses `CF-Connecting-IP` automatically.
- **Cloudflare Zero Trust (Access) in front**: interactive SSO can't run inside
  a native app, and hokago has its own auth. Recommended: a Cloudflare Access
  policy that does **not** require identity for the hokago hostname
  (IP/tunnel-allow only), leaving hokago's JWT auth as the single auth layer.
  If policy-level auth is required, use an Access **service token**
  (client-id/secret headers) baked into the native client — but hokago's API is
  not Access-aware and won't consume Access headers itself.
- **nginx/caddy/other**: `HOKAGO_TRUST_PROXY` + forward
  `X-Forwarded-For`/`X-Forwarded-Proto`; forward WebSocket `Upgrade`; keep
  `Range` + COOP/COEP headers; raise buffering/timeouts for streaming.
- **With or without a proxy**: the API binds `0.0.0.0:3000` and serves the SPA
  itself. Everything is origin-relative so subdomain-proxying works out of the
  box.

## Where the web app touches the bridge

- `apps/web/src/api-client.ts` — token read/write/erase through
  `bridge.storage` (fallback `localStorage`), `storeAuthResult`, TV account
  routing.
- `apps/web/src/native.ts` — `shellPlatform`, `clientKey`, `getDeviceId`,
  `startTokenWarmth` (4-min token refresh in shells), `loginPlatform`.
- `apps/web/src/tv-session.ts` — per-account sessions for TV switchers.
- `apps/web/src/views/TvAccountsView.tsx`, `ui/TvPairFlow.tsx` — TV account
  switcher + pairing flow.
- `apps/web/src/views/DownloadsView.tsx`, `src/downloads.ts`, the DetailView
  download button — downloads UI (native-only).
- `apps/web/src/views/NativeUpdateGate.tsx` — stale-shell gate.
- `apps/web/src/ui/tv-keys.ts` — D-pad → DOM keydown mapping (`useTvKeyboardNav`).
- `apps/web/src/views/LoginView.tsx` — sends `clientKey`/`deviceName`/`platform`
  and calls `storeAuthResult`.
- `apps/web/src/router.tsx` / `App.tsx` / `TopNav.tsx` — TV routes (`/accounts`),
  downloads route, update gate, TV-gated shell.

## Open items (deliberately not done yet)

- **Offline subtitle burn-in on TV** and full image-subtitle offline (only
  burn-in-on-transcode + text sidecars exist).
- **`POST /watch-state/sync` doesn't write `WatchDay`** — offline time is not
  credited to history stats. Revisit if clients want it.
- **Download resume**: the server artifact is idempotent per download, but a
  client that loses its partial file must restart. Range-resumable client-side
  downloading is a client concern; the API supports Range on `/artifact/media`.
- **Download space/cleanup UI**, per-device download quotas.
- **Desktop native downloads UI polish** (progress reporting into the web
  promise; currently the web polls the server `Download` row instead).
- **TV home-screen deep linking** (leanback intent → route) and Android TV
  content rows; the webview currently just launches at the SPA root.
- **Store signing/notarization** for the store distributions (ad-hoc device
  builds ship; macOS notarization + Apple/Play signing are future work).
- **`git log`/docs**: verify AGENTS.md build-order "Next" line once native
  shells land.

## Non-negotiable guardrails

- Never fork the web UI or the player for a platform. Changes happen in
  `apps/web` once.
- Never add a second auth system. The JWT/refresh/device/pairing layer is the
  only one.
- Never add a native media player (AVPlayer/ExoPlayer/libmpv) — the web player
  runs in the webview; a native player is a second renderer to keep in sync.
- Chromecast: never. AirPlay only as a native playback target.
- No third-party font/artwork URLs ever served to a client — everything from
  our origin (COOP/COEP depends on it).
- Keep every new API route in the contract (`packages/contract`) + OpenAPI doc,
  or generated clients won't see it.
- Never break `window.hokagoNative` compat without bumping `MIN_NATIVE_VERSION`.
