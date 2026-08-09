# AGENTS.md — hokago

Self-hosted media server (movies/TV/anime). `CLAUDE.md` (auto-loaded) holds the invariants and principles — it's the constitution now. There is no `docs/design.md` anymore; if a doc and the code disagree, **the code is right and the doc is wrong** — fix the doc.

## Commands

pnpm workspaces, Node >= 22, `packageManager: pnpm@11.13.1`. Run everything via `pnpm -r ...` or `pnpm --filter @hokago/<pkg>`.

- `pnpm -r typecheck` — verification gate. There is **no test suite and no lint script**; typecheck + build is the only CI-able check. Don't invent a test runner.
- `pnpm -r build`
- `pnpm --filter @hokago/db generate` — Prisma client (required, output is gitignored)
- `pnpm --filter @hokago/contract generate` — zod schemas → `generated/openapi.json` + `generated/schema.d.ts`
- `pnpm --filter @hokago/fonts build` — subsets @fontsource fonts into `packages/fonts/vendor/` (gitignored)
- `pnpm --filter @hokago/db migrate:dev|migrate:deploy|studio`
- `pnpm --filter @hokago/scanner scan <path>` — run the scan→NFO→art pipeline directly (host-side; same pipeline the worker runs as jobs)
- `pnpm --filter @hokago/scanner seed:anime [path] [name]` — scan + inline provider resolution (AniList→MAL chain, no queues); creates bare SERIES items for empty folders so they resolve real metadata/art via providers. `--retry-missing` re-runs only items with no `ExternalId` (fast; use after rate-limit backoff).
- `pnpm --filter @hokago/providers search` — ad-hoc provider search script
- Host-side maintenance CLI (`scan`, `seed:anime`, episode-title repair) runs via tsx and **does** spawn ffmpeg on the host — one-off tooling, never part of the serving runtime.

### Dev loop (api + worker run in containers; web runs on the host)

- `pnpm dev:web` — the **only** host-side dev process: Vite dev server on :5173 with HMR, proxying API paths + `/ws` to `HOKAGO_API_ORIGIN` (default `http://localhost:3000`, the container API).
- `pnpm docker:up` — full stack: postgres, valkey, API (`hokago`, publishes :3000), worker (`hokago-worker`).
- `pnpm docker:rebuild` — after changes to `apps/api`, `apps/worker`, or `packages/*`: rebuilds images **and** force-recreates containers. This is the only thing that recreates them — `docker compose up -d` alone won't.
- `pnpm docker:logs [svc]` · `pnpm docker:ps` · `pnpm docker:down` — logs / status / full teardown (postgres data lives in bind mounts, survives `down`).

## Codegen is mandatory, and order matters

`packages/db/generated/`, `packages/contract/generated/`, and `packages/fonts/vendor/` are all gitignored. Every package `exports` map resolves to `./dist/*.js` (with `.js`-suffixed subpath exports), so:

1. Run the three codegen steps above, then `pnpm -r build`, **before** `typecheck` or dev of any dependent app — typecheck resolves imports against `dist/` and will fail spuriously otherwise. (The container image does its own codegen in `node-builder`, so this host-side requirement is only for the web dev server and host CLI scripts.)
2. NodeNext module resolution: **all relative imports must carry `.js` extensions** in source.

## Dev workflow

Everything runs in containers **except the web app**. `pnpm docker:up` starts postgres, valkey, the API (`hokago`, :3000) and the worker (`hokago-worker`); the web dev server runs on the host (`pnpm dev:web`, :5173, Vite HMR) and proxies to the container API. ffmpeg — playback transcodes and every worker job — runs only inside containers, never on the host.

- **Web changes** → just edit; Vite HMR picks it up. No rebuild, no container.
- **API/worker/packages changes** → `pnpm docker:rebuild`. Source edits are inert in a running container — a stale image looks exactly like a bug that "doesn't take effect".
- **Contract/schema changes** → two steps: host-side codegen + build for the web dev server and host CLI scripts (`pnpm --filter @hokago/contract generate`, `pnpm --filter @hokago/db generate`, then `pnpm -r build`), **and** `pnpm docker:rebuild` for the containers. The Dockerfile's `node-builder` stage re-runs all codegen inside the image (`rm -rf` of generated dirs first — deterministic; host artifacts never leak in).
- Port `:3000` on the host must be free — a stray host-side API/worker will EADDRINUSE the container API. No host API/worker dev processes exist anymore.
- The API container boots with `prisma migrate deploy` (idempotent — fresh postgres works). `restart: unless-stopped` survives reboots.
- `/config` bind-mounts into `./data/config`; media roots are mounted per-service (see `docker-compose.yml`). `.env` holds compose-only vars (`HOKAGO_CONFIG_DIR`, `POSTGRES_PASSWORD`, `ANIME_LIBRARY_PATH`, `HOKAGO_JWT_SECRET`, ...); the app reads `DATABASE_URL`/`VALKEY_URL` from the environment.
- `HOKAGO_COEP=credentialless` flips the COEP fallback (default `require-corp`). Keep the proxy path list in `apps/web/vite.config.ts` in sync with any new API prefix.
- Transcode concurrency is capped per-API-process by `HOKAGO_MAX_TRANSCODES` (default 2); busy slots return 503 and clients retry. Idle sessions (no heartbeat 5 min) are reaped on a 60s sweep plus a boot sweep when the API starts.
- Scan parallelism: the scan walk probes files and ingests leaves with bounded pools (`PROBE_CONCURRENCY`/`INGEST_CONCURRENCY` in `packages/scanner/src/constants.ts`). Worker-side caps: `HOKAGO_ARTWORK_CONCURRENCY` (default 4, bounds ffmpeg) and `HOKAGO_SCAN_CONCURRENCY` (default 1, parallel libraries).

## Architecture (own: where things live)

- `apps/api` — Fastify + WS, auth, playback decision engine, admin backend (`/admin-api` + `/admin/queues`). The admin console UI lives in the web app at `/admin` (`apps/web/src/admin/`); there is no server-rendered admin page anymore.
- `apps/worker` — BullMQ consumer; **owns all ffmpeg**. Jobs: scan, parse, resolve, probe, fonts, art, segments, transcode.
- `apps/web` — React 19 + Vite + Tailwind v4 + vidstack + JASSUB. Single hardcoded design in `apps/web/tailwind.config.ts` + `src/app.css`, with a dark-mode toggle (see `src/ui/useTheme.tsx`). No theme system, no tokens contract.
- `packages/metadata` — **interfaces only** (license firewall). No provider data/code in the core repo, ever. AGPL/non-commercial adapters live in `packages-optional/` (never vendored, runtime-fetched).
- `packages/scanner` — evidence-based pipeline. Parser registry lives in `packages/scanner/src/parsers/` (anitomy for ANIME, scene regexes for GENERAL), noisy-OR confidence in `evidence.ts`. Known limitation (deferred): container-level confidence isn't computed yet, only leaves.
- `packages/providers` — keyless providers (TVmaze, AniList, Jikan) + match gate in `match.ts`: normalized exact equality, falling back to ordered-subsequence containment (short folder name vs fuller provider title, e.g. "Frieren" → "Frieren: Beyond Journey's End"), guarded by min query length + year ±1.
- Detail-page descriptive fields (overview, originalTitle, rating 0–10, genres, studio) flow provider → `MetadataMatch` → `fillDescriptiveFields` (only when unset) → `MediaItemDetail` contract → DetailView. Tagline intentionally absent (no keyless provider exposes one).

## Build order (was §19 of docs/design.md; that file is gone)

Work top to bottom; don't skip ahead. Ordering principle: build the thing that always works first, then layer the thing that needs the internet on top.

- **Done:** Step 0 license firewall (`packages/metadata` interfaces only) · Step 1 foundations (schema, contract, ffmpeg image, font subsets, compose) · Step 2 local-first scan pipeline (scan → group → NFO → embedded tags/art → generated art, run via `pnpm --filter @hokago/scanner scan <path>`, not yet job-queued) · Step 3 job infrastructure (reconciler, idempotency, checkpointing, graceful shutdown, admin console UI in the web app) · Step 4 parser registry + evidence engine + resolution + collections (parser profiles in `packages/scanner/src/parsers/`, noisy-OR confidence in `packages/scanner/src/evidence.ts`, `resolveMetadataStep` in `apps/worker`, `IdMapping.episodeOffset` + `Collection`/`CollectionEntry` in the schema) · Step 6 keyless network providers (TVmaze, AniList/Jikan, MAL — BullMQ queues + per-provider limiters in `apps/worker`) · Step 7 playback decision engine + HLS · Step 8 player (vidstack + JASSUB + fonts + track switching + COOP/COEP) · Step 9 auth, profiles, watch state, continue-watching + WS layer · dark mode (replaces the cut theming step).
- **Next:** probe + fonts + subtitles + artwork store (eager font extraction, `.mks`, `fonts/`, PGS flagging) → segments (intro/outro skip) + trickplay → watch parties → optional user-key tier → hwaccel overlay, wizard, PUID/PGID, base path → native clients + offline downloads. Chromecast: **never**; AirPlay rides along with the native clients.

## Gotchas

- API and worker run in containers. After changing `apps/api`, `apps/worker`, or `packages/*`, run `pnpm docker:rebuild` — nothing else recreates the containers, and a running container never sees source edits.
- `:3000` is the container API. If anything host-side claims it, the API container crash-loops on EADDRINUSE (logs show it as a startup failure). Vice versa: the containers claim `:3000` and `:5173` belongs to the web dev server.
- The web dev server and host CLI scripts import package `dist/` output — after a contract/schema change you must run the host codegen + build (see Dev workflow) or the web app fails typecheck/dev with stale types.
- `hokago` is always lowercase — code, UI, packages, commits.
- Conventional commits (`feat:`/`fix:`/...), small one-concern commits (see `git log`).
- Model changes: update `packages/db/prisma/schema.prisma` and call it out in the commit. Don't redesign the schema silently.
- No third-party fonts/artwork links ever emitted to the browser — everything must be served from our own origin (JASSUB's COOP/COEP depends on it).
