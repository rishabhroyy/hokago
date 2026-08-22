# Native clients — architecture & implementation

Status: **split architecture, in progress.** Desktop (macOS/Windows/Linux)
stays a thin Tauri webview shell over `apps/web` — unchanged, still the
right call for desktop. iOS, Android, and Android TV are being rebuilt as a
genuinely native app (`native/flutter`, Flutter) — the old webview shells
(`native/ios`, `native/android`) are retired. If the code and this file
disagree, the code is right — fix this file.

**Why the split**: the original north star ("one codebase, one UI, one
player, webview shells only") was a deliberate, considered decision — and
it's the right one for desktop, where a webview genuinely looks native. On
phone and TV it didn't hold: a webview never looks or feels native on those
form factors, no matter how much CSS effort goes in. Rishabh's call
(2026-08-22): rebuild mobile/TV natively, keep desktop as-is. This reverses
part of the old north star on purpose — see `PLANS/HOKAGO_NATIVE_MOBILE_APP_PLAN.md`
in the workspace for the full reasoning.

## Desktop (unchanged) — Tauri webview shell

Everything in the original north star still holds for `native/tauri`:

- `apps/web` is the single UI source **and the player** for desktop (React +
  Tailwind + vidstack + hls.js + JASSUB, running inside the Tauri webview).
- The bridge contract (`packages/native-bridge`, `window.hokagoNative`) is
  now **desktop-only** — Tauri injects it (`on_page_load` eval), and
  `apps/web` still treats it as an optional capability layer. iOS/Android no
  longer use this bridge at all (see below) — they're not a webview.
- Downloads: native (`~/Downloads/hokago/`), same as before.
- Offline mode: bundles `apps/web/dist`, same Discord-style
  freshness-then-fallback model, same as before.
- CI: `tauri-macos` / `tauri-windows` / `tauri-linux` jobs in
  `.github/workflows/native.yml`, unchanged.

See the "Shell implementations — Tauri desktop" section below for the
implementation details, which are all still accurate.

## Mobile/TV (new) — native Flutter app

`native/flutter` is a single Dart/Flutter codebase covering iOS, Android
phone, and Android TV (`phone`/`tv` product flavors). It is **not** a
webview — no `packages/native-bridge`, no bundled `apps/web/dist`, no
`window.hokagoNative`. It talks to the same typed API `apps/web` uses,
directly.

### Why native instead of another webview, and why this was tractable

The original north star rejected native reimplementation specifically
because a second UI/player is a second codebase to keep in sync. Two things
made native viable this time:

1. **The player can be genuinely native without becoming a second codebase
   to maintain.** `media_kit` (libmpv) renders ASS/SSA subtitles natively —
   the same rendering pedigree JASSUB wraps in WASM, just the real desktop
   engine — plus native HLS and hardware decode. The playback *decision*
   logic (DIRECT_PLAY/REMUX/TRANSCODE, timeline offsets, seek/audio-track
   restarts) still lives entirely server-side and is just re-implemented
   client-side against the same contract (`playback/start`, `/seek`,
   `/audio-track`, `/heartbeat`) — there's no shared code to fork, because
   there never was any client-side playback logic to begin with.
2. **The typed contract (`packages/contract`) stays the single source of
   truth.** The Dart client is hand-written (no codegen toolchain — see
   below) but every model is read directly from the zod schemas in
   `packages/contract/src/*.ts`, not guessed. When the contract changes,
   the Dart models need a matching manual update — same discipline as
   before, just not automated by `openapi-typescript` the way the web
   client is.

The real cost, paid on purpose: **parity is no longer free.** The old
webview shells got 100% feature parity for zero UI work, by construction. A
true native UI means every web feature gets hand-re-implemented in Dart and
kept in sync by hand going forward.

### Stack

- **Flutter** (not React Native) — chosen specifically because `media_kit`
  (libmpv) solves the ASS-subtitle problem that has no good story on
  React Native's stack (ExoPlayer/AVPlayer/react-native-video don't render
  ASS), and because Immich's mobile app — the explicit visual/quality
  reference — is Flutter.
- **State**: `flutter_riverpod`, plain `StateNotifierProvider`s — no
  codegen (`riverpod_generator`/`build_runner`) to keep the toolchain small.
- **Routing**: `go_router`, paths mirror `apps/web/src/router.tsx` 1:1
  (`/`, `/library/:id`, `/title/:id`, `/watch/:mediaFileId`, `/search`,
  `/downloads`).
- **HTTP**: `dio`, wrapped in `HokagoApiClient` (`lib/core/api/api_client.dart`)
  — mirrors `apps/web/src/api-client.ts`'s token-refresh semantics exactly
  (single-flight silent refresh at <60s remaining, one 401 retry, `/auth/*`
  routes never trigger a refresh loop).
- **Player**: `media_kit` + `media_kit_video` (libmpv). Subtitle tracks:
  DIRECT_PLAY/DIRECT_STREAM use the container's own embedded tracks
  natively; REMUX/TRANSCODE (which don't carry subtitle streams) fetch the
  server's extracted sidecar text (`/media-files/{id}/subtitle-tracks/{id}`)
  and feed it in-memory via `SubtitleTrack.data` (media_kit's
  `SubtitleTrack.uri` has no per-request header support, and every hokago
  route needs a bearer token).
- **Downloads**: `background_downloader` — real OS-managed downloads (iOS
  background `URLSession`, Android `WorkManager`), resumable, notification
  progress, survives app kill. A local flat-JSON manifest
  (`lib/core/downloads/offline_manifest.dart`) tracks what's on disk,
  mirroring `apps/web/src/offline.ts`'s `OfflineEntry` shape but as a file
  instead of localStorage.
- **Secure storage**: `flutter_secure_storage` (Keychain / Keystore-backed)
  for tokens, device id, and the client-key — same role as the bridge's
  `storage` facade played for the old webview shells, just native from the
  start instead of a JS↔native mirror.
- **Fonts**: the same three families as `apps/web/tailwind.config.ts` (Zen
  Maru Gothic / Plus Jakarta Sans / JetBrains Mono), bundled as local app
  assets sourced from `github.com/google/fonts`' canonical OFL files (same
  upstream the web's `@fontsource/*` packages repackage) — not a runtime
  Google Fonts fetch, matching the self-hosted-everything spirit of
  `CLAUDE.md`'s invariant #4 even though that invariant is literally
  browser-scoped.
- **No codegen toolchain** (no `openapi_generator`/Java, no
  `build_runner`/`riverpod_generator`) — a deliberate simplification to
  keep the local toolchain small; the tradeoff is hand-maintained Dart
  models instead of generated ones.

### Visual parity with the webui

Rishabh's explicit call: the app should look as close as possible to
`apps/web`'s actual design (`apps/web/tailwind.config.ts` +
`apps/web/src/app.css`), laid out for mobile/TV instead of desktop
breakpoints — not a generic "native Material app" reinterpretation. Ported
directly (values copied from the CSS, not eyeballed):

- **Colors**: `lib/core/theme/app_theme.dart`'s `HokagoColors` — the exact
  `.dark` scope hex values.
- **Type scale**: `HokagoText` — same purpose-named sizes as the Tailwind
  config's `fontSize` block, with the same font-family pairing the web
  actually uses (`text-title`/`-section`/`-title-xl` → Zen Maru Gothic,
  `text-kicker` → JetBrains Mono, everything else → Plus Jakarta Sans).
- **Wallpaper**: `HokagoBackground` — the four-radial-gradient-aura "wii
  dream" background from `.dark body::before`, painted via a
  `CustomPainter` (Flutter's `RadialGradient` is circle-only; elliptical
  auras need a per-layer canvas scale transform to match the CSS's
  independent x/y radii).
- **Primary action button**: `WiiButton` — the glossy blue pill
  (`.btn-primary`/`.wii-btn`: gradient stops, pill radius, inset-highlight
  shadow, press-scale animation), not a stock Material button.
- **Floating cards**: `HokagoPanel` — the frosted/blurred panel
  (`.panel`: backdrop blur + two-layer shadow) used for login/setup.
- **Pill-radius inputs**: matching `.input`'s 999px radius.

Not yet ported: the CSS's inset box-shadows on cards/tiles (Flutter has no
true inset shadow primitive — would need a custom painter per surface, not
done yet), the `.skeleton` shimmer loading state, and per-screen pixel
auditing beyond the surfaces above. Flag drift against the web app as it's
found.

### Android TV

`phone`/`tv` product flavors (`android/app/build.gradle.kts`,
`manifestPlaceholders["isTv"]`), a `src/tv/AndroidManifest.xml` overlay
adding the `LEANBACK_LAUNCHER` intent-filter — same split the retired
webview shell used. D-pad focus navigation and the TV pairing/account-
switcher flow (mirroring `apps/web`'s `TvPairFlow`/`TvAccountsView`) are
**not yet built** — the flavor exists structurally, the TV-specific UX
doesn't yet.

**tvOS is out of scope, not just dropped.** The old reasoning ("Apple
forbids third-party WKWebView on tvOS") no longer applies — a native
Flutter app isn't a webview. But Flutter itself has **zero official tvOS
support**; the only route is `flutter-tvos`, a third-party fork with its
own custom engine and CLI. That's a toolchain-install decision, not a code
decision — out of scope until/unless Rishabh explicitly approves installing
it.

### What's deliberately not done yet

- TV D-pad navigation + pairing/account-switcher UX.
- Trickplay scrubber preview, quality-switch menu, watch-party sync in the
  player (the server endpoints exist — `/media-files/{id}/trickplay`,
  `/playback/{id}/quality`, `/parties/*` — just no client for them yet).
- `Prefs`/`Search` parity polish, a dedicated Pair screen (TV pairing is a
  web-only flow today from the mobile app's perspective).
- Per-screen visual audit beyond the shared theme primitives above.
- Store signing/notarization (same as desktop: ad-hoc/sideload only, real
  App Store/Play Store distribution is future work, matching the existing
  desktop posture).

## Platform matrix

| Platform | Shell | Player | Downloads | Auth UI |
|---|---|---|---|---|
| Web | browser | vidstack + hls.js + JASSUB (in-app) | — (never, browser) | login/pair |
| iOS / iPadOS | native Flutter (`native/flutter`) | native (media_kit/libmpv) | yes (`background_downloader`) | login (pairing not yet ported) |
| Android (phone) | native Flutter (`native/flutter`) | native (media_kit/libmpv) | yes | login |
| macOS / Windows / Linux | Tauri 2 (`native/tauri`, unchanged) | web player in webview | yes (native, `~/Downloads/hokago/`) | login + pair |
| Android TV / Google TV | native Flutter (`tv` flavor) | native (media_kit/libmpv) | **no** (by design) | not yet ported (was pairing + account switcher on the old shell) |
| ~~tvOS~~ | — | — | — | — (Flutter has no official tvOS support; see above) |

TV apps must not offer downloads/offline (explicit product decision,
carried over unchanged).

## The bridge contract — desktop only now

`packages/native-bridge` (`window.hokagoNative`) is injected by **Tauri
only**. iOS/Android/TV are native Flutter and talk to the typed API
directly — there is no bridge, no storage mirror, no `hokago-native` DOM
events, because there's no webview for any of that to apply to. Don't add
bridge plumbing for the Flutter app; it's a different integration model
entirely (see "Mobile/TV" above).

The rest of this section (storage mirror, native↔web events, base URL
setup, safe areas, downloads UI) describes the **desktop Tauri shell only**
going forward.

- **Storage** is a *mirror*. The web app keeps its canonical tokens in
  `localStorage` and writes every change through to `bridge.storage` too; the
  shell persists that copy in the OS secure store (Tauri: keyring with a plain
  file fallback for headless Linux). Result: wiping webview storage
  never kills a session. Reads are synchronous (Tauri's IPC is sync).
- **Native → web events**: the shell dispatches
  `window.dispatchEvent(new CustomEvent("hokago-native", { detail: { type: ... } }))`.
  `type: "back"` is the one consumed by the web app.
- **Web → native events**: the SPA dispatches the same `hokago-native` event
  with `type: "route"` (detail: `{ view: route.view }`) on every route change
  while in the shell.
- **Downloads never see tokens in JS.** The web hands the shell a resolved
  artifact URL + filename; the native side attaches `Authorization: Bearer
  <token>` from its own secure-store mirror (`hokago_access_token`). The web
  keeps that mirror warm via `startTokenWarmth` (refresh every 4 min while a
  shell session is alive).
- **Base URL**: a local `index.html` in `native/tauri/ui/` stores the server
  URL and navigates the webview to it. The web app resolves origin-relative
  API paths against `window.location` via `resolveUrl`
  (`packages/native-bridge/src/bridge.ts`) — no client code assumes a fixed
  host.

## Update policy

`packages/native-bridge/src/versions.ts` holds `MIN_NATIVE_VERSION` — this
still gates the Tauri desktop shell the same way it always did. The Flutter
app reads its own version via `package_info_plus` and will need an
equivalent gate wired up if/when a `NativeUpdateGate`-style check is needed
for mobile/TV (not done yet — flag if this becomes a real upgrade-safety
concern once the Flutter app ships beyond ad-hoc sideloads).

## Offline mode

**Desktop (Tauri, unchanged)**: bundles a copy of the built SPA, serves it
from the `hokago-spa://` custom scheme when the configured server can't be
reached (Discord-model freshness-then-fallback). See the original
implementation notes below.

**Mobile/TV (Flutter, new)**: no bundled SPA — there's no web UI to fall
back to, because the UI isn't a webview. Offline playback works from the
local download manifest (`lib/core/downloads/offline_manifest.dart`) +
`background_downloader`'s saved files directly; there's no "boot fallback"
concept because the app never depended on fetching a remote SPA to begin
with. Offline watch-state queue/flush-on-reconnect (mirroring
`apps/web/src/offline.ts`'s `queueWatchState`/`flushWatchSync`) is not yet
wired into the Flutter app's player — flagged as a gap, not silently
skipped.

## Shell implementations

- **Tauri desktop** (`native/tauri`) — unchanged, Tauri 2, wry webview,
  config + clientKey in `src-tauri/src/config.rs`, bridge + keyring mirror +
  reqwest downloads in `src-tauri/src/bridge.rs`. Icon: the committed 1024px
  `icon.png`; `tauri icon` derives `.icns`/`.ico` — run it locally and
  commit the result.
- **Flutter mobile/TV** (`native/flutter`) — see "Mobile/TV (new)" above for
  the full architecture. Bundle id `com.hokago.app`, same as the retired
  webview shells (Keychain/Keystore entries carry over across the swap —
  existing sessions on a device survive the upgrade).

## CI delivery (`.github/workflows/native.yml`)

On every `v*` tag: `tauri-macos` (arm64 .dmg), `tauri-windows` (x64 .msi),
`tauri-linux` (AppImage/deb) — unchanged. `ios` (simulator .zip + unsigned
sideload .ipa) and `android` (phone + TV release APKs, signed with the
committed keystore) now build `native/flutter` via `subosito/flutter-action`
+ `flutter build ipa`/`flutter build apk --flavor <phone|tv>` instead of
XcodeGen/Gradle-webview. Android signing secrets
(`ANDROID_KEYSTORE_BASE64`/`ANDROID_KEYSTORE_PASSWORD`/`ANDROID_KEY_ALIAS`/
`ANDROID_KEY_PASSWORD`) are unchanged — same repo secrets, same keystore. A
dedicated `release` job creates **one** draft GitHub Release first; every
build job `needs:` it and only uploads assets. Never race two
`gh release create` calls — that was the multi-draft bug, still applies.

## Backend plumbing — DONE (do not rebuild)

Everything below is implemented and working, unchanged by the mobile/TV
architecture swap; build on it, don't replace it.

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
  This is what makes TV account switching possible without re-pairing (not
  yet wired into the Flutter TV flavor's UI — see "What's deliberately not
  done yet").
- **TV pairing** (no password entry on TVs): `POST /auth/pair/request` (TV,
  unauthenticated, rate-limited) → 6-digit code; `POST /auth/pair/verify`
  (logged-in phone/PC) approves it and registers the TV's `Device`;
  `POST /auth/pair/status` (TV polls) mints the session **exactly once**
  (atomic APPROVED→COMPLETE claim) and returns tokens + `deviceId` + `username`.
- **Liveness re-check**: access tokens carry `sessionId`; `authenticate`
  re-checks the session isn't revoked and the account isn't disabled (30s
  in-memory cache; revoke/logout invalidate it immediately).
- **Login/pairing rate limiting**: in-memory sliding window, per real client IP
  and per username (`HOKAGO_LOGIN_RATE_LIMIT_IP`,
  `HOKAGO_LOGIN_RATE_LIMIT_USERNAME`).

### Network topology support
- **Real client IP**: `clientIp()` (`apps/api/src/rate-limit.ts`) prefers
  `CF-Connecting-IP` (always trusted — Cloudflare), otherwise the resolvers on
  Fastify `req.ip` backed by `trustProxy` configured from `HOKAGO_TRUST_PROXY`.
- **Proxy-friendly URLs**: the API only ever emits origin-relative paths.
  **Sub-path hosting** is deliberately out of scope — never add
  `HOKAGO_BASE_PATH`/`basePath` plumbing.
- **WebSockets** (watch party `/ws/party/*`, presence `/ws/presence`)
  authenticate via JWT query param; reverse proxies must forward the
  `Upgrade`/`Connection` headers.
- **Streaming through proxies**: preserve `Range`/206, do not buffer long
  responses, set generous timeouts. COOP/COEP headers (set by
  `web-routes.ts`) matter for the web player only — libmpv on native clients
  has no such constraint.

### Offline downloads
- `POST /downloads` (`{mediaItemId, mediaFileId, deviceId, variant,
  subtitleTrackIds?}`).
  - `variant: {kind: "original"}` — the raw file, copied.
  - `variant: {kind: "transcode"}` — ffmpeg to a self-contained faststart
    MP4 (`buildDownloadArgs` in `packages/ffmpeg/src/download.ts`).
  - Text subtitle tracks are packaged as sidecars for either variant; a
    bitmap track (PGS/VOBSUB/DVBSUB) on `original` is rejected (422) and on
    `transcode` is burned into the encode.
- Worker job (`download` BullMQ queue) builds the artifact atomically, writes
  `manifest.json`, flips the `Download` row to `READY`.
- Serving (all authenticated, all origin-relative): `GET/POST/DELETE
  /downloads[/:id]`, `GET /downloads/:id/artifact[/media|/subtitles/:id|/fonts/:hash]`.
- Client flow (same for Tauri and Flutter): enumerate files via
  `GET /media-items/:id/files` → create the download → poll `GET
  /downloads/:id` until `READY` → fetch the artifact manifest → save each
  file locally (Tauri: reqwest to disk; Flutter: `background_downloader`).

### Files manifest
`GET /media-items/:id/files` lists **all** of an item's playable files.

### Typed client
All new routes are in the OpenAPI doc (`packages/contract/generated/openapi.json`).
The web app consumes it via a generated TS client; the Flutter app's Dart
models are hand-written against the same source `packages/contract/src/*.ts`
zod schemas (see "Stack" above for why — no Java/build_runner toolchain).
Keep both in sync by hand when the contract changes.

## Client auth flows

1. **First launch (mobile/desktop)**: username/password once → store
   `refreshToken` + `sessionId` in the secure store → silent refresh forever.
   Send `clientKey` (persisted UUID) + `deviceName` + `platform` on login.
2. **TV**: `pair/request` → show 6-digit code → poll `pair/status` → on
   `COMPLETE`, store tokens as a new account. **Not yet built in the Flutter
   TV flavor** — the backend flow is ready, the client UI isn't.
3. **Logout**: `POST /auth/logout` with the refresh token, clear the secure
   store.
4. **Token refresh**: single in-flight refresh mutex, refresh when <60s
   left, one 401 retry. Implemented identically in `apps/web/src/api-client.ts`
   and `native/flutter/lib/core/api/api_client.dart`.

## Deployment topologies the clients must tolerate

- **Tailscale**: works with no special handling.
- **Cloudflare Tunnel**: enable WebSockets; rate limiting uses
  `CF-Connecting-IP` automatically.
- **Cloudflare Zero Trust (Access) in front**: interactive SSO can't run
  inside a native app — recommend a policy that doesn't require identity for
  the hokago hostname, or an Access service token baked into the client.
- **nginx/caddy/other**: `HOKAGO_TRUST_PROXY` + forward
  `X-Forwarded-For`/`X-Forwarded-Proto`; forward WebSocket `Upgrade`; keep
  `Range` + COOP/COEP headers (web only); raise buffering/timeouts.
- **With or without a proxy**: the API binds `0.0.0.0:3000` and serves the
  SPA itself. Everything is origin-relative.
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
- **Download resume (desktop done)**: Tauri desktop now stages to `.part`, resumes via `Range` (206), and caps concurrency at 2. iOS/Android still restart from zero.
- **Download space/cleanup UI**, per-device download quotas.
- **Desktop native downloads UI polish (done)**: `save_download` now emits throttled `download-progress` events (150 ms) into the web promise; DetailView shows a determinate bar, cancel is available via `downloads.cancel`.
- **TV home-screen deep linking** (leanback intent → route) and Android TV
  content rows; the webview currently just launches at the SPA root.
- **Store signing/notarization** for the store distributions (ad-hoc device
  builds ship; macOS notarization + Apple/Play signing are future work).
- **`git log`/docs**: verify AGENTS.md build-order "Next" line once native
  shells land.

## Non-negotiable guardrails

- Desktop: never fork the web UI or the player. Changes happen in
  `apps/web` once, same as always.
- Mobile/TV: the Flutter app is a deliberate, approved exception to "no
  second UI" — but it must not diverge from the web's *feature set* or
  *product decisions*, only its rendering technology. New features land in
  the web app's IA first; the Flutter app follows, it doesn't lead.
- Never add a second auth system. The JWT/refresh/device/pairing layer is
  the only one, for every client.
- Chromecast: never. AirPlay only as a native playback target (desktop) /
  whatever the native player's platform integration offers (mobile).
- No third-party font/artwork URLs ever served to the *web* client —
  everything from our origin. The Flutter app's bundled fonts are a
  build-time asset, not a runtime fetch, so this doesn't apply to it the
  same way, but the spirit (self-host, don't depend on third-party CDNs at
  runtime) still does.
- Keep every new API route in the contract (`packages/contract`) + OpenAPI
  doc, and update the Flutter Dart models by hand to match.
- Never break `window.hokagoNative` compat (desktop) without bumping
  `MIN_NATIVE_VERSION`.
