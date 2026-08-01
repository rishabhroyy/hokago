# AGENTS.md — hokago

Self-hosted media server (movies/TV/anime). **Read `docs/design.md` before writing anything** — it's the constitution. `CLAUDE.md` (auto-loaded) holds the 15 load-bearing invariants and principles; `docs/design.md` is the reference for every §. If they conflict, the doc wins and `CLAUDE.md` is wrong — tell the user.

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
- `apps/web` — React 19 + Vite + Tailwind v4 + vidstack + JASSUB. Single hardcoded design, no theming; tokens in `apps/web/tailwind.config.ts` are verbatim from `docs/ui-handoff/` (the prototype `reference-prototype.html` is the source of truth).
- `packages/metadata` — **interfaces only** (license firewall §8.5). No provider data/code in the core repo, ever. AGPL/non-commercial adapters live in `packages-optional/` (never vendored, runtime-fetched).
- `packages/scanner` — evidence-based pipeline. **Known limitation (by design, defer to step 4):** `parse-filename.ts` is a single generic regex placeholder, not the parser registry; container-level confidence isn't computed yet, only leaves.

## Gotchas

- Work the build order in `docs/design.md` §19; don't skip ahead. Step 2 (offline scan pipeline) is done; step 3+ is job infrastructure.
- `hokago` is always lowercase — code, UI, packages, commits.
- Conventional commits (`feat:`/`fix:`/...), small one-concern commits (see `git log`).
- Model changes require a schema change **and** a `docs/design.md` update in the same commit. Don't redesign `packages/db/prisma/schema.prisma` silently.
- No third-party fonts/artwork links ever emitted to the browser — everything must be served from our own origin (JASSUB's COOP/COEP depends on it).
