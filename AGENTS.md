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
- `pnpm --filter @hokago/scanner scan <path>` — run the step-2 scan→NFO→art pipeline directly (not job-queued yet)
- `pnpm --filter @hokago/providers search` — ad-hoc provider search script

## Codegen is mandatory, and order matters

`packages/db/generated/`, `packages/contract/generated/`, and `packages/fonts/vendor/` are all gitignored. Every package `exports` map resolves to `./dist/*.js` (with `.js`-suffixed subpath exports), so:

1. Run the three codegen steps above, then `pnpm -r build`, **before** `typecheck` or dev of any dependent app — typecheck resolves imports against `dist/` and will fail spuriously otherwise.
2. NodeNext module resolution: **all relative imports must carry `.js` extensions** in source.

## Dev workflow

- `docker compose up -d postgres valkey` — publishes 5432/6379 for host-run services. `/config` bind-mounts into `./data/config`; media roots are added per-library (see `docker-compose.yml`).
- API: `pnpm --filter @hokago/api dev` (tsx watch). Worker: `pnpm --filter @hokago/worker dev`. Web: `pnpm --filter @hokago/web dev`.
- Vite proxies API paths + `/ws` to `HOKAGO_API_ORIGIN` (default `http://localhost:3000`). `HOKAGO_COEP=credentialless` flips the COEP fallback (default `require-corp`). Keep the proxy path list in `apps/web/vite.config.ts` in sync with any new API prefix.
- `.env` holds compose-only vars (`HOKAGO_CONFIG_DIR`, `POSTGRES_PASSWORD`, ...). The app code reads `DATABASE_URL` / `VALKEY_URL` directly from the environment.

## Architecture (own: where things live)

- `apps/api` — Fastify + WS, auth, playback decision engine. `build` copies `src/admin.html` into dist (keep that `cp` if you touch the build script).
- `apps/worker` — BullMQ consumer; **owns all ffmpeg**. Jobs: scan, parse, resolve, probe, fonts, art, segments, transcode.
- `apps/web` — React 19 + Vite + Tailwind v4 + vidstack + JASSUB. Single hardcoded design in `apps/web/tailwind.config.ts` + `src/app.css`, with a dark-mode toggle (see `src/ui/useTheme.tsx`). No theme system, no tokens contract.
- `packages/metadata` — **interfaces only** (license firewall). No provider data/code in the core repo, ever. AGPL/non-commercial adapters live in `packages-optional/` (never vendored, runtime-fetched).
- `packages/scanner` — evidence-based pipeline. Parser registry lives in `packages/scanner/src/parsers/` (anitomy for ANIME, scene regexes for GENERAL), noisy-OR confidence in `evidence.ts`. Known limitation (deferred): container-level confidence isn't computed yet, only leaves.

## Build order (was §19 of docs/design.md; that file is gone)

Work top to bottom; don't skip ahead. Ordering principle: build the thing that always works first, then layer the thing that needs the internet on top.

- **Done:** Step 0 license firewall (`packages/metadata` interfaces only) · Step 1 foundations (schema, contract, ffmpeg image, font subsets, compose) · Step 2 local-first scan pipeline (scan → group → NFO → embedded tags/art → generated art, run via `pnpm --filter @hokago/scanner scan <path>`, not yet job-queued) · Step 3 job infrastructure (reconciler, idempotency, checkpointing, graceful shutdown, admin queue UI) · Step 4 parser registry + evidence engine + resolution + collections (parser profiles in `packages/scanner/src/parsers/`, noisy-OR confidence in `packages/scanner/src/evidence.ts`, `resolveMetadataStep` in `apps/worker`, `IdMapping.episodeOffset` + `Collection`/`CollectionEntry` in the schema) · Step 6 keyless network providers (TVmaze, AniList/Jikan, MAL — BullMQ queues + per-provider limiters in `apps/worker`) · Step 7 playback decision engine + HLS · Step 8 player (vidstack + JASSUB + fonts + track switching + COOP/COEP) · Step 9 auth, profiles, watch state, continue-watching + WS layer · dark mode (replaces the cut theming step).
- **Next:** probe + fonts + subtitles + artwork store (eager font extraction, `.mks`, `fonts/`, PGS flagging) → segments (intro/outro skip) + trickplay → watch parties → optional user-key tier → hwaccel overlay, wizard, PUID/PGID, base path → native clients + offline downloads. Chromecast: **never**; AirPlay rides along with the native clients.

## Gotchas

- `hokago` is always lowercase — code, UI, packages, commits.
- Conventional commits (`feat:`/`fix:`/...), small one-concern commits (see `git log`).
- Model changes: update `packages/db/prisma/schema.prisma` and call it out in the commit. Don't redesign the schema silently.
- No third-party fonts/artwork links ever emitted to the browser — everything must be served from our own origin (JASSUB's COOP/COEP depends on it).
