# CLAUDE.md — hokago

Self-hosted media server. Movies, TV, anime. **Read `docs/design.md` before writing anything.**
This file is the constitution; the design doc is the reference. If they conflict, the design doc
wins and this file is wrong — tell me.

---

## Non-negotiables

Violating any of these is a bug, not a tradeoff. Every one is load-bearing for something
non-obvious, cross-referenced to the doc.

1. **No music. Ever.** `MediaKind` is video-only. Don't add ID3, album/artist/track, or
   MusicBrainz. Don't "leave room for it." (§2)
2. **No email. Anywhere.** No SMTP, no email column, no password-reset-by-mail. Auth is
   username + password; reset is admin action or CLI; invites are codes shared manually. (§7.1)
3. **No API key is ever required.** We ship no key and depend on none. Keyless providers +
   local files only. The optional TMDB tier is settings-only, off by default, and **never**
   appears in the first-run wizard or as a nag. (§8.4, §8.6)
4. **The browser only ever loads fonts and artwork from our own origin.** Never hotlink,
   never `@import` Google Fonts, never emit a third-party `<link>`. The server may fetch
   bytes once in the background and store them forever — that's fine and expected. This
   invariant is what makes JASSUB's COOP/COEP work; break it and every poster vanishes.
   (§1.1, §3.5, §13.3)
5. **`packages/metadata` contains interfaces only.** No AGPL or non-commercial data or code
   in the core repo, ever, not even temporarily. Encumbered adapters live in
   `packages-optional/`, fetched at runtime by the operator. This cannot be retrofitted. (§8.5)
6. **Every component consumes theme tokens only.** Never a hardcoded color, radius, font, or
   duration. This single rule is the difference between "100% themeable" being true or false. (§15.1)
7. **Anime is not a `MediaKind`.** It's `ContentProfile.ANIME` on the Library, which forks the
   parser and provider order. (§7.2)
8. **Confidence is derived from `Evidence`, never authored.** `MediaItem.confidence` is a
   materialized recomputation, not a number a provider handed us. (§7.5)
9. **Valkey is a cache, not a source of truth.** Postgres derived state answers "what work
   exists"; a boot reconciler re-enqueues anything missing. Losing Valkey must lose zero work. (§9.6.2)
10. **Every job is idempotent**, keyed on content hash, not job ID. Safe to run twice, always. (§9.6.1)
11. **Bind mounts only. No named docker volumes**, including Postgres. (§16.1)
12. **Chromecast is permanently out.** No public domain is in scope. Don't add hooks for it. (§18.3)
13. **`hokago` is always lowercase.** Docs, UI, package names, containers. Everywhere.

---

## Principles (when the doc doesn't say)

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

## The two files everything generates from

- **`packages/db/prisma/schema.prisma`** — the data model. Types flow from here.
- **`packages/theme/src/tokens.ts`** — the token contract. All styling flows from here.

Both are written and reviewed. **Do not redesign them.** Extend if genuinely needed, but
raise it first and update `docs/design.md` in the same change.

---

## Stack (decided; §5)

TypeScript / Node 22 end to end. Fastify + `@fastify/websocket`. Zod → OpenAPI → generated
TS client. Prisma + PostgreSQL. BullMQ + Valkey. React + Vite + Tailwind + shadcn/ui (in-repo,
editable). Vidstack player. JASSUB subtitles. Custom ffmpeg build **with `--enable-chromaprint`**.

Rejected, don't relitigate: Go backend, NestJS, s6-overlay single container, Postgres-as-queue,
`anitomy-js` (use `anitomy` by yjl9903 — the TS port, no node-gyp).

## Layout

```
apps/api      apps/worker      apps/web
packages/     contract  db  metadata  parser  theme  ffmpeg  fonts
packages-optional/     ← AGPL/non-commercial, runtime-fetched, never vendored
infra/docker  infra/hwaccel.transcoding.yml
```

---

## Working agreement

- **Work the build order in `docs/design.md` §19.** Don't skip ahead. Step 2 ships a fully
  offline zero-network server; that's deliberate — it's both the foundation and the permanent
  worst-case fallback.
- **Small, reviewable commits.** One concern each.
- **When the doc is ambiguous, ask.** Don't invent and hope. I'd much rather answer a question
  than unwind a wrong assumption three layers deep.
- **When you think the doc is wrong, say so.** It's a draft, not scripture. But change it
  explicitly rather than diverging silently — silent divergence between doc and code is the
  failure mode I'm most trying to avoid.
- **Don't add dependencies casually.** Especially native/node-gyp ones — they wreck multi-arch
  Docker builds.
- **Tests where logic is subtle**: parser, evidence scoring, `episode_offset` resolution,
  playback decisions, theme validation. Not everywhere.
