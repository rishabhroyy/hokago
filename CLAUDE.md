# CLAUDE.md — hokago

Self-hosted media server. Movies, TV, anime. `AGENTS.md` (auto-loaded) holds the working
agreement, commands, and build order. This file is the constitution. There is no
`docs/design.md` anymore — if a doc and the code disagree, the code is right.

---

## Non-negotiables

Violating any of these is a bug, not a tradeoff. Every one is load-bearing for something
non-obvious.

1. **No music. Ever.** `MediaKind` is video-only. Don't add ID3, album/artist/track, or
   MusicBrainz. Don't "leave room for it."
2. **No email. Anywhere.** No SMTP, no email column, no password-reset-by-mail. Auth is
   username + password; reset is admin action or CLI; invites are codes shared manually.
3. **No API key is ever required.** We ship no key and depend on none. Keyless providers +
   local files only. No optional key-required tier exists.
4. **The browser only ever loads fonts and artwork from our own origin.** Never hotlink,
   never `@import` Google Fonts, never emit a third-party `<link>`. The server may fetch
   bytes once in the background and store them forever — that's fine and expected. This
   invariant is what makes JASSUB's COOP/COEP work; break it and every poster vanishes.
5. **`packages/metadata` contains interfaces only.** No AGPL or non-commercial data or code
   in the core repo, ever, not even temporarily. Encumbered adapters live in
   `packages-optional/`, fetched at runtime by the operator. This cannot be retrofitted.
6. **One hardcoded UI, no theming system.** hokago ships a single design
   (`apps/web/tailwind.config.ts` + `src/app.css` are the source of truth). No
   `ThemeManifest`, no `data-theme` switching, no per-user theme import. One dark-mode
   toggle (`.dark` class on `<html>`, `localStorage`-remembered, see `src/ui/useTheme.tsx`).
7. **Anime is not a `MediaKind`.** It's `ContentProfile.ANIME` on the Library, which forks the
   parser and provider order.
8. **Confidence is derived from `Evidence`, never authored.** `MediaItem.confidence` is a
   materialized recomputation, not a number a provider handed us.
9. **Valkey is a cache, not a source of truth.** Postgres derived state answers "what work
   exists"; a boot reconciler re-enqueues anything missing. Losing Valkey must lose zero work.
10. **Every job is idempotent**, keyed on content hash, not job ID. Safe to run twice, always.
11. **Bind mounts only. No named docker volumes**, including Postgres — **except Postgres's own
    UID.** `/config/db` is owned by Postgres's internal UID (typically 999), not PUID/PGID.
    Documented deliberate exception, not a bug.
12. **Chromecast is permanently out.** No public domain is in scope. Don't add hooks for it,
    don't use it as an example anywhere — including the device-profile abstraction.
13. **`hokago` is always lowercase.** Docs, UI, package names, containers. Everywhere.
14. **Every playback start creates a `PlaybackSession`, including Direct Play.** This is what
    "who's watching now" and watch-party per-participant transcode state are built on — don't
    reintroduce a bare `sessionKey` string in its place.
15. **`contentProfile` is a default, not a hard wall, for `MediaKind.MOVIE`.** The resolver may
    try the anime provider chain for a movie regardless of its library's profile — cheap,
    evidence-gated, and it's why an anime movie sitting in a general Movies library (a common
    *arr layout) doesn't lose AniList. Series/episode parsing still forks hard on the profile.

---

## Principles (when the invariants don't say)

- **Local-first.** Network providers are enrichment, never a dependency. Every external
  service on earth being down must be a non-event.
- **Degrade, never error.** Users never see a provider name, a 429, or a retry button.
  Admins see everything, in the admin UI and logs. It's a *user-facing* rule, not a
  hide-problems-from-operators rule.
- **Never block, but stay fixable.** Everything imports and plays immediately, even at low
  confidence. Nothing is quarantined. Every match is correctable, always.
- **Crash-only.** `kill -9` at any moment must be survivable. No state in worker memory
  that isn't recoverable from Postgres.
- **Explicit over magic.** Plain handlers, visible control flow. No decorator/DI cleverness.
- **Honest limits.** Scanning targets ~95% on messy libraries, not 100%. Some filenames are
  genuinely ambiguous (`Spice and Wolf 2` — episode or batch? unknowable). Don't paper over it.

---

## The file everything generates from

- **`packages/db/prisma/schema.prisma`** — the data model. Types flow from here.

Written and reviewed. **Do not redesign it.** Extend if genuinely needed, but raise it
first.

Styling has no equivalent contract file — hokago ships one hardcoded design
(`apps/web/tailwind.config.ts` + `src/app.css`), not a token system multiple
themes resolve against.

---

## Stack

TypeScript / Node 22 end to end. Fastify + `@fastify/websocket`. Zod → OpenAPI → generated
TS client. Prisma + PostgreSQL. BullMQ + Valkey. React + Vite + Tailwind + shadcn/ui (in-repo,
editable). Vidstack player. JASSUB subtitles. Custom ffmpeg build **with `--enable-chromaprint`**.

Rejected, don't relitigate: Go backend, NestJS, s6-overlay single container, Postgres-as-queue,
`anitomy-js` (use `anitomy` by yjl9903 — the TS port, no node-gyp).

## Layout

```
apps/api      apps/worker      apps/web
packages/     contract  db  metadata  parser  ffmpeg  fonts
packages-optional/     ← AGPL/non-commercial, runtime-fetched, never vendored
infra/docker  infra/hwaccel.transcoding.yml
```

---

## Working agreement

- **Work the build order in `AGENTS.md`.** Don't skip ahead. Step 2 ships a fully
  offline zero-network server; that's deliberate — it's both the foundation and the permanent
  worst-case fallback.
- **Small, reviewable commits.** One concern each.
- **When in doubt, ask.** Don't invent and hope. I'd much rather answer a question
  than unwind a wrong assumption three layers deep.
- **When you think something is wrong, say so.** But change it
  explicitly rather than diverging silently — silent divergence between docs and code is the
  failure mode I'm most trying to avoid.
- **Don't add dependencies casually.** Especially native/node-gyp ones — they wreck multi-arch
  Docker builds.
- **Tests where logic is subtle**: parser, evidence scoring, `episode_offset` resolution,
  playback decisions. Not everywhere.
