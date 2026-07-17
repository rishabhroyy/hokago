# hokago — Design Document

**Status:** Draft v0.3 — pre-implementation
**Purpose:** Single source of truth for architecture and scope. Written to be read by both humans and Claude Code. Every decision below has a stated rationale; if you change a decision, change the rationale with it.

**Changes in v0.3:** generated artwork pipeline specified (§8.7); fonts re-resolved — the font *store* is the primitive, four sources, portable theme bundles (§1.1, §15.2); movie artwork decided → option (b) (§8.6); Chromecast permanently out, AirPlay deferred to native clients (§18.3); font roles are plural (§1.1, §15.2).

**Changes in v0.2:** bind-mounts-only storage (§16.1); collections model for movies-within-series (§7.3); honest artwork assessment (§8.6); job robustness (§9.6); music removed entirely; watch parties in scope (§17).

---

## 0. How to use this document

- **§1–§4** are context. Read once.
- **§5–§18** are binding decisions. Claude Code should treat these as constraints, not suggestions.
- **§19** is the build order. Work top to bottom.
- **§20** lists what is still undecided. Nothing in §20 blocks starting.
- **§21** is the research appendix — the evidence behind the decisions, with sources.

---

## 1. Identity

**Name:** hokago (放課後 — "after school"). Nods to K-On!, whose light music club is an after-school club. Always lowercase, everywhere: docs, UI, package names, container names.

**Logo:** existing SVG (provided separately).

**Wordmark:** Zen Maru Gothic, Medium (500), all lowercase.

**Tone:** the polish of Immich, the scope of Jellyfin, opinionated where Jellyfin is configurable, forgiving where Jellyfin is strict.

### 1.1 Fonts — the font store is the primitive

**First, a myth to kill: self-hosting does not degrade quality. At all.** woff2 is lossless compression of the same glyph outlines; rendering is byte-identical to what Google Fonts serves. There is no quality axis here.

The *real* issue is **file size**, and it's specific: **Zen Maru Gothic Medium contains 7,866 glyphs** (full kana + kanji) — a multi-megabyte face. Google Fonts hides this with dynamic `unicode-range` subsets so the browser fetches only the ranges it needs. But the wordmark is **`hokago`** — five unique latin glyphs (`h o k a g`). Subset to those and it's under 5KB, *better* than Google Fonts.

**Licensing is clean:** Zen Maru Gothic is **SIL OFL 1.1** — redistribution, bundling, modification, and commercial use all explicitly permitted. Copyright 2021 The Zen Maru Gothic Authors. `@fontsource/zen-maru-gothic` exists on npm, pre-split by weight.

#### The actual invariant

Not "fonts must be vendored at build time." That was too strong, and it breaks portable themes. The real rule is:

> **The browser only ever loads fonts from our own origin. Where the *server* got the bytes is unconstrained.**

This is exactly how artwork already works (§3.5 *fetch once*): download the bytes, store them, serve from our origin, never hotlink. **Fonts are artwork.** Same primitive, same rules, same store.

That invariant is what buys us COOP/COEP immunity (§13.3) and privacy. A **server-side, one-time, background fetch** violates none of it. What's rejected is only the narrow thing: **the browser hotlinking a third party on every page load**, which blocks first paint, leaks every user's IP, and dies on a Pi-hole or a no-route tailnet.

#### Four sources, one store

All four converge on the same hash-deduped font store (§7.7, §13.2), which is served from our origin:

| # | Source | Mechanism | Notes |
|---|---|---|---|
| 1 | **Vendored** (build-time) | baked into image | **The floor.** Wordmark subset + default theme's faces. Guarantees a zero-network first boot renders correctly. |
| 2 | **Theme bundle** | `/config/themes/<name>/` | Theme carries its own fonts. **Drop in the folder, done.** Fully offline, portable. ← *the answer to "download themes and just stick them in"* |
| 3 | **Theme-declared remote** | server-side fetch-once job | Theme JSON names a font URL; worker fetches **once**, hashes into store, serves locally forever. Never touches Google again. |
| 4 | **Manual drop-in** | `/config/fonts/` | Loose fonts for hand-written themes. |

**Source 2 is the primary path** and the format themes ship in:

```
/config/themes/my-theme/
  theme.json          # tokens, incl. font role → family mapping
  fonts/
    Whatever-400.woff2
    Whatever-700.woff2
```

Drop the folder in. hokago hashes the fonts into the store, validates `theme.json` against the token contract, registers the theme. **One step, no network, no second scavenger hunt for the font.**

**Source 3 is your "contact once", and it's genuinely fine** — because it's a background job on the server, not a blocking request from every browser. The theme simply isn't offered until its fonts resolve; if the fetch fails, the theme still applies with its fallback stack (§3.2 — degrade, never error). Retried by the normal job machinery (§9.6).

**Only the floor (source 1) is non-negotiable.** Something must render on a cold, offline, first boot. Everything above the floor is droppable, fetchable, and replaceable.

#### Multiple fonts, plural — corrected

**Nothing is restricted to one face.** Zen Maru Gothic Medium 500 is the **wordmark**, and that's the only place it's fixed. The default theme is free to mix faces across roles, and any theme may use as many as it likes.

Font is therefore **not one token — it's a set of roles**, each resolving to a family in the store (§15.2):

```
font.display   # hero titles, big type
font.body      # descriptions, synopses
font.ui        # nav, buttons, labels
font.mono      # technical detail, codec info
font.wordmark  # the logo lockup — Zen Maru Gothic Medium 500 by default
```

Each role takes a **stack**, not a single family, so an unresolved font degrades to the next entry instead of breaking the theme.

**Reference-theme licensing note:** the shipped themes (`netflix-ish`, `crunchyroll-ish`) must **approximate with OFL faces only** — Netflix Sans and Lato-as-licensed-by-Crunchyroll are not ours to redistribute. User-installed themes are the user's business; we don't redistribute those.

---

## 2. Vision

A self-hosted media server for **all video media** — movies, TV, anime — that:

1. Works completely offline, with zero API keys, on first run.
2. Never blocks the user, never shows a provider error, never dead-ends.
3. Is themeable to the point that a user can make it look like Crunchyroll, Netflix, or anything else, at runtime, per profile.
4. Handles anime properly — ASS subtitles, embedded fonts, absolute vs. seasonal numbering, movies inside series — because that's where every general-purpose media server falls down.
5. Deploys as a small docker compose stack a normal person can bring up without understanding it.

### Non-goals (explicit)

| Not doing | Why |
|---|---|
| **Music. Ever.** | Decided. Removes ID3 parsing, gapless playback, album/artist/track hierarchy, MusicBrainz (and its brutal 1 req/sec limit), and the entire non-video UI fork. |
| Email of any kind (SMTP, invites, password reset) | #1 source of self-hosted setup pain. Admin actions + CLI + invite links instead. |
| AniList / MAL list sync, scrobbling | Out of scope by decision. |
| Requiring any API key for core function | Hard constraint. Optional user-supplied keys only (§8.4). |
| Torrent / debrid / indexer integration in core | Legal and scope minefield. Extension boundary only (§2.1). |
| Manga / comics reader | Follows from "no music" — we're a video server. |
| Being a *arr replacement | We consume what *arr writes. Critically, we *depend* on this — see §8.6. |

### 2.1 Extension boundary

Anything that acquires media (torrents, NZB, debrid, indexer RSS) lives behind a plugin interface and ships disabled/absent. Core stays clean. Seanime's model; it's correct.

---

## 3. Core principles

These override local convenience.

1. **Local-first.** Everything renders from data on disk. Network providers are *enrichment*, never a dependency. If every external service on earth is down, hokago is fully functional.
2. **Degrade, never error.** The user never sees a provider name, a rate-limit message, a 429, or a retry button. Failures are invisible and retried in the background.
3. **Never block, but stay fixable.** Everything imports and plays immediately, even at low confidence. Nothing is quarantined. But every match is correctable, always, everywhere — an uncorrectable wrong match is the worst outcome in the product.
4. **Self-healing.** When new evidence arrives (dataset refresh, provider returns, file renamed, NFO appears), low-confidence items are silently re-resolved. The library gets more correct over time without user action.
5. **Fetch once.** Every byte of metadata and artwork stored locally on first fetch. Artwork downloaded, never hotlinked. Re-fetch only on lifecycle TTL or an ETag/incremental signal.
6. **Crash-only.** Any process can be killed at any moment without data loss or corruption. State lives in Postgres, never in worker memory. §9.6.
7. **LLM-buildable.** One language, conventional frameworks, explicit over magic, schema as source of truth. §5.

---

## 4. Prior art

| Project | What we take | What we reject |
|---|---|---|
| **Immich** | The polish bar. OpenAPI-generated clients. BullMQ pipeline + admin queue UI. Pre-baked Postgres image. `hwaccel.transcoding.yml` `extends:` pattern. | Photo-domain assumptions. Named volumes. |
| **Jellyfin** | Direct Play / Direct Stream / Transcode hierarchy. Device profiles. Trickplay. Chromaprint intro detection. | Lazy font extraction (buggy). Bundled project-wide TMDB key. Chromecast pain (§18). |
| **Seanime** | Loose scanning as a headline feature. Extension boundary for acquisition. | Anime-only. Desktop-centric. |
| **Plex** | Chained metadata agents: NFO primary, online below, local image assets always preferred. | Everything else. |
| **Kodi** | The NFO standard. Artwork conventions. EDL. Season 00 = specials. | — |

---

## 5. Stack

Chosen primarily for **LLM-buildability**, an explicit requirement. Criteria: one language end to end (no type desync across a boundary); conventional over clever (training-data presence → better completions); explicit over magic (traceable execution); schema as source of truth.

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript, Node 22 | One language across api/worker/web |
| API | **Fastify** | Explicit handlers, JSON-schema validation, minimal magic |
| Realtime | **`@fastify/websocket`** | Job progress + playback sessions + watch parties all ride one WS layer (§17) |
| Contract | **Zod → OpenAPI → generated TS client** | Immich's pattern. One source of truth; the LLM never hand-syncs types. Also the enabler for future mobile/desktop clients (§20.2) |
| ORM | **Prisma** | Structured schema file; best-represented TS ORM in training data |
| DB | **PostgreSQL** | Relational integrity + FTS for multi-title search |
| Queue | **BullMQ + Valkey** | Standard, documented. Ingest is a job graph. **Valkey is a cache, not a source of truth** — §9.6 |
| Frontend | **React + Vite + TS** | Conventional; shares patterns with a future RN client |
| Styling | **Tailwind + shadcn/ui** | Components live in-repo as editable code — Claude Code reads and modifies `<Button>` rather than fighting a library API. Already CSS-variable-themed → maps onto §15 |
| Player | **Vidstack** | Headless, fully customizable + HLS provider + React hooks. "100% customizable UI" is a hard requirement; a skinned player defeats it |
| Subtitles | **JASSUB** (libass/WASM) | §13 |
| Media | **Custom ffmpeg build** | Must include `--enable-chromaprint`. Not optional — §14 |
| Fonts | **Vendored OFL, build-time** | §1.1 |

### 5.1 Explicitly rejected

- **Go backend** — better transcode runtime, but a second language and a hand-synced type boundary. LLM-buildability wins.
- **Single container / s6-overlay** — multi-container is fine; user simplicity comes from compose + `extends:`.
- **Postgres-as-queue (`SKIP LOCKED`)** — elegant, but BullMQ is the documented standard and generates better.
- **`anitomy-js`** — native node-gyp binding, needs a C++ toolchain, wrecks multi-arch builds. Use the dependency-free TS port (`anitomy` by yjl9903).
- **NestJS** — see "explicit over magic."
- **Bundled project-wide TMDB key** — Jellyfin does this; one revocation breaks every install on earth. §8.4.
- **Runtime Google Fonts** — §1.1.
- **Named docker volumes** — §16.1.

---

## 6. Architecture

### 6.1 Containers

```
hokago          # Fastify API + WS + serves built web via @fastify/static
hokago-worker   # same image, different entrypoint; BullMQ consumer; owns all ffmpeg
postgres        # own ghcr image, extensions pre-installed
valkey
```

Plus `hwaccel.transcoding.yml`, pulled in via `extends:` — the user changes **one word** (`cpu` | `vaapi` | `qsv` | `nvenc` | `rkmpp`) instead of learning device cgroups and render GIDs. Highest-leverage deployment decision in the doc.

API and worker separated so a heavy transcode never makes the UI sluggish.

### 6.2 Repo

```
hokago/
  apps/
    api/                  # Fastify: routes, WS, auth, playback decision engine
    worker/               # jobs: scan, parse, resolve, probe, fonts, art, segments, transcode
    web/
  packages/
    contract/             # zod schemas → openapi → generated client
    db/                   # prisma schema + migrations
    metadata/             # provider + mapping INTERFACES ONLY (license firewall, §8.5)
    parser/               # parser registry: anitomy | scene
    theme/                # token contract: types + defaults + validator
    ffmpeg/               # command builders, probe wrappers
    fonts/                # vendored OFL subsets + subsetting build step
  packages-optional/      # ← AGPL / non-commercial adapters, fetched at runtime
  infra/
    docker/
    hwaccel.transcoding.yml
```

`packages-optional/` is not vendored, not bundled, not shipped. §8.5.

---

## 7. Data model

### 7.1 Core

```
accounts        id, username, password_hash (argon2), is_admin, created_at
profiles        id, account_id, name, avatar, theme_id, maturity_rating, prefs
sessions        id, account_id, refresh_token_hash, device, expires_at, revoked_at
invites         id, code, created_by, expires_at, used_at
```

Username + password only. No email column anywhere. JWT (short) + refresh token; sessions table so tokens are revocable. Password reset = admin action or `hokago-cli reset-password <user>`. Invites = generated code, shared manually.

### 7.2 Media

```
libraries       id, name, media_kinds[], root_path, writable, provider_order[], scan_mode
media_items     id, library_id, kind, parent_id, title, sort_title, kind_data (jsonb), confidence
media_files     id, media_item_id, path, size, mtime, inode, hash
media_streams   id, media_file_id, type, codec, lang, channels, hdr_meta, disposition
```

**`media_kind` values (video only):** `movie | series | season | episode`

**Anime is not a `media_kind`.** It's a series/episode/movie with a different provider order and parser. Otherwise *Cowboy Bebop* has to be filed as either "TV" or "anime" and both answers are wrong for someone.

**Specials use the Season 00 convention** (TVDB/Kodi). OVAs, specials, and shorts are episodes under a season numbered `0`. This is what every tool in the ecosystem already writes.

### 7.3 ⭐ Collections — movies inside series NEW

**This was the biggest gap in v0.1.** The naive model — "a movie is top-level, a series contains episodes" — is wrong for a huge fraction of real libraries:

- *Demon Slayer: Mugen Train* is a **movie that sits between S1 and S2** and is required viewing.
- *Made in Abyss: Dawn of the Deep Soul* — same shape.
- *Evangelion* has a series and a movie continuity that partly overlap.
- Doctor Who has feature-length specials.
- MCU / Star Wars are movie sets with series interleaved.
- Many anime "movies" are **recap compilations** of the TV series that most people want hidden.

```
collections         id, name, sort_title, kind (franchise | movie_set)
collection_entries  collection_id, media_item_id,
                    relation_type,   -- main | movie | ova | special | recap
                                     --  | side_story | prequel | sequel
                    release_order,   -- how it shipped
                    story_order,     -- chronological / recommended watch order
                    anchor           -- e.g. "after S1" — positions a movie inside a series
```

Rules:

- **Membership is many-to-many.** A movie is a first-class `movie` in the Movies browse **and** an entry in the Frieren franchise. Both, not either.
- **Two orderings.** `release_order` and `story_order` both stored, both surfaced, user-selectable per collection. The only correct answer — arguing which is "right" is how you lose.
- **`anchor`** renders a movie inline in the series page between S1 and S2, where the user expects it.
- **`relation_type: recap`** is filterable/hideable by default — a preference, not a deletion.
- **Populated from provider relation graphs.** AniList exposes relationships (prequels, sequels, side stories) directly; Wikidata exposes `part_of_series` / `follows` / `followed_by`. Free structure, no manual curation.
- Also creatable and editable by hand — providers will get franchises wrong.

**⚠️ Provider format mapping needs care.** AniList's `format` is `TV | MOVIE | OVA | ONA | SPECIAL`. An AniList "MOVIE" maps to our `movie` kind, **not** to a series — but it's still a member of the franchise collection. Get this wrong and *Mugen Train* becomes a one-episode series.

### 7.4 Identity

```
external_ids    entity_id, provider, provider_id, confidence
                providers: imdb | tvmaze | anilist | mal | anidb | wikidata | local
id_mappings     source_provider, source_id, target_provider, target_id,
                season_offset, episode_offset
```

`episode_offset` is load-bearing — how absolute numbering (`Series - 38`) resolves against seasonal (`S02E12`). Single most common anime failure mode in every other server.

Mappings are **unidirectional**; A→B ≠ B→A. Store both directions explicitly.

### 7.5 Evidence — the confidence engine

```
evidence        id, media_item_id, signal_type, source, value, weight, observed_at
```

Confidence is **derived, never stored as a magic number**. Makes re-resolution cheap, auditable, and enables §3.4 self-healing: new evidence → recompute → maybe re-resolve, silently.

| Signal | Weight |
|---|---|
| NFO `<uniqueid>` | ~certain |
| Embedded container tags | very strong |
| Sibling consistency (12 files, 01–12) | strong |
| Folder name | strong |
| ffprobe runtime | strong |
| Filename parse | medium |
| Audio/sub track languages | weak |
| Resolution / codec | weak |

**Runtime is the movie/episode discriminator.** A 24-minute file in a series folder is an episode; a 108-minute file in the same folder is very likely the movie (§7.3). This is how movies-in-series get detected without an NFO.

### 7.6 Metadata cache

```
metadata_cache  provider, external_id, payload (jsonb), etag, fetched_at,
                ttl_policy, lifecycle_state
artwork         id, entity_id, kind, source, bytes_path, width, height, hash
```

`artwork.bytes_path` — artwork **stored as bytes locally**. Never a remote URL. Never hotlinked, even where permitted.

**`entity_id` is polymorphic**, same pattern as `external_ids` (§7.4): a `MediaItem` or a `Collection`, never both. A franchise/collection gets its own poster rather than borrowing a member's — decided, schema updated to match.

### 7.7 Playback, segments, parties

```
playback_state    profile_id, media_item_id, position_ms, duration_ms, watched, updated_at
media_segments    media_item_id, type (intro|outro|recap|preview), start_ms, end_ms, source
                  source: chapter | community | fingerprint | manual   ← manual always wins
transcode_jobs    id, session_id, media_file_id, profile, state, segment_range
fonts             hash, family, path, source (subtitle|theme|user)   ← shared store, §1.1
subtitle_tracks   id, media_file_id, lang, format, forced, sdh, path|stream_index
watch_parties     id, host_profile_id, media_item_id, state, position_ms, issued_at
party_members     party_id, profile_id, joined_at, ready
```

---

## 8. Metadata subsystem

### 8.1 The core problem

Every database models media differently and none agree. AniDB splits a series per arc; TVDB models one series with seasons; TMDB does its own thing. Mapping is a subsystem, not a helper function.

### 8.2 Provider capability matrix

Registered by `(media_kind, capability)`, capability ∈ `identity | descriptive | artwork`.

| Provider | Kinds | Identity | Descriptive | Artwork | Terms | Rate limit |
|---|---|---|---|---|---|---|
| **Local NFO + sidecar art** | all | ✅ | ✅ | ✅ | none | none |
| **Embedded tags / attached_pic** | all | — | partial | ✅ | none | none |
| **Generated art (ffmpeg)** | all | — | — | ✅ | none | none |
| **TVmaze** | TV | ✅ | ✅ | ✅ | CC BY-SA 4.0 | ≥20 / 10s per IP |
| **AniList** | anime | ✅ | ✅ | ✅ | free, no key | 90/min (**degraded to 30/min**) |
| **Jikan** (MAL) | anime | ✅ | ✅ | ✅ | free, no key, self-hostable | ~60/min; MAL may limit upstream |
| **Wikidata** | all | ✅ (ID bridge) | partial | ✖ | CC0 | polite |
| **IMDb datasets** | movie, TV | ✅ | ✅ | ❌ | **non-commercial only** | n/a (bulk) |

**Excluded by the no-key rule:** TMDB, TheTVDB, Fanart.tv, OMDb, Trakt, OpenSubtitles. ~~MusicBrainz~~ — music dropped.

### 8.3 Resolution chain

Per library, per field, configurable order; default:

```
Local NFO  →  embedded tags/art  →  keyless network providers  →  generated art
(offline, authoritative)              (enrichment, failable)      (never fails)
```

Local image assets always beat NFO-referenced URLs (Plex's rule; it's right).

**Caching — "fetch once", precisely:**

| Lifecycle state | TTL |
|---|---|
| Ended / finished / released | infinite |
| Airing / ongoing | short (hours), episode list only |
| Unmatched / low confidence | scheduled retry w/ backoff |

Use the cheap paths:
- **Jikan** returns an ETag per request → `If-None-Match` → 304, zero work.
- **TVmaze** has an incremental updates endpoint → poll *that* once to learn which of 400 shows changed, instead of polling 400 shows. `?embed=` folds cast/episodes/seasons into one response — the rate-limit survival mechanism.
- **TVmaze** limits on the backend but not the edge cache → cache-friendly patterns are literally cheaper.

Every provider gets its **own** rate limiter. 20/10s vs 30/min are wildly different budgets.

### 8.4 The key question

Jellyfin ships one project-wide TMDB key, public in their repo. TMDB staff never clearly blessed it. Jellyfin's own maintainers noted that when Trakt had issues, the fix was *revoking the project key* — exactly why we won't. One revocation = every hokago install loses artwork simultaneously.

**Decision:** local-first + keyless is the default and always works. An **optional user-supplied-key tier ships disabled**. hokago never ships a key, never depends on one.

### 8.5 License firewall

License is **deferred**, not decided. Viable with one hard rule, from commit one:

> **No AGPL-encumbered or non-commercial-restricted data or code inside the core repo. Ever. Not even temporarily.**

- `packages/metadata` ships `MetadataProvider` and `MappingSource` **interfaces only**.
- AGPL datasets (anime-offline-database, Fribb/anime-lists) and non-commercial datasets (IMDb) live in `packages-optional/`, **fetched at runtime by the operator's instance** — not vendored, not bundled, not redistributed.
- A runtime download onto the operator's own box is a materially different posture from us redistributing it.

| Source | Constraint |
|---|---|
| anime-offline-database | AGPL-3.0, viral |
| Fribb/anime-lists | derives from AOD |
| TVmaze | CC BY-SA 4.0 — attribution + share-alike |
| IMDb datasets | personal / non-commercial only |
| ~~MusicBrainz~~ | *dropped — no music* |

Default landing zone if we take everything: **AGPL, non-commercial, with attribution**. The firewall keeps the option open. *Not legal advice — confirm before v1.0.*

**IMDb caveat:** ~6.2M titles / 9.6M people uncompressed, daily refresh. Do **not** import whole onto an N100. Filter by `titleType`, use the provided `isAdult` flag.

### 8.6 ⭐ Will it look beautiful with no keys? — the honest answer NEW

**Partly. It depends entirely on media kind, and you should know exactly where the line is.**

| Kind | Keyless artwork | Verdict |
|---|---|---|
| **Anime** | AniList + Jikan: posters, banners, character art | **Excellent.** Genuinely indistinguishable from a keyed setup. |
| **TV** | TVmaze: poster-format show art + landscape episode stills | **Good.** Thinner than TMDB — fewer backdrops, no logos, no textless variants — but a real poster wall. |
| **Movies** | **Nothing. No keyless source of movie artwork exists.** | **This is the gap.** |

**But here's what saves it, and it's why local-first is the *primary* path and not a fallback:**

**Radarr writes `poster.jpg` and `fanart.jpg` into the movie folder.** Sonarr does the same for series. The overwhelming majority of real self-hosted movie libraries **already have artwork sitting on disk**, because the *arr stack put it there. We're not scraping it — we're reading what's already next to the file. For those users, movies look exactly as good as they do in Plex: zero keys, zero network, instantly.

**The genuinely bare case** is a folder of movie files with no NFO, no artwork, never touched by *arr. Three mitigations:

1. **Smart frame selection, not naive.** Don't grab the frame at 10%. Use ffmpeg's `thumbnail` filter (which picks representative frames), then reject near-black and near-uniform frames, and prefer high-complexity frames. The difference between "looks broken" and "looks fine."
2. **Composed generated posters.** Good backdrop still → gradient scrim → title set in Zen Maru Gothic → 2:3 poster. **A consistently-styled generated wall genuinely looks better than a mixed-quality scraped one.** A design opportunity, not damage control.
3. **Generated-art style is themeable** — a token in the theme contract (§15), so the Netflix-ish theme composes differently than the default.

**⚠️ The tension, and the resolution:**

*"No API key screen. Ever."* and *"it needs to look beautiful"* conflict for the bare-movie-library user. Options considered: **(a)** hold the line, no key UI anywhere; **(b)** settings-only toggle; **(c)** one-time dismissible hint when coverage is low.

### ✅ DECIDED: (b) — settings-only toggle

- **The first-run wizard stays clean.** No key screen, no prompt, nothing blocking. Boots and works immediately.
- **A toggle exists in settings, off by default, never surfaced:** *Optional: movie artwork source* → user pastes their **own** TMDB key.
- **No nag, ever.** No modal, no banner, no "your library is missing artwork!" hint. If you never open settings, it does not exist.
- **We still never ship a key and never depend on one.** An opt-in user takes their own rate limits and their own revocation risk. Core function unchanged if they don't.

*Schema consequence:* a `settings` / `provider_config` row holding user-supplied credentials, encrypted at rest. Nothing else changes — the optional-key tier from §8.4 is exactly this, now with a defined surface.

---

## 8.7 ⭐ Generated artwork pipeline NEW

**The guarantee: every item always has artwork.** Generation is the terminal step of §8.3 and it cannot fail — worst case is an ugly frame, never a broken tile. But be precise about what generates *well*, because the honest answer splits by artwork kind.

### 8.7.1 What generates well, and what doesn't

| Kind | Aspect | Generatable? | Quality |
|---|---|---|---|
| **Backdrop / fanart** | 16:9 | ✅ **Yes, genuinely** | **Excellent.** A frame from the film *is* a 16:9 image from the film. Near-perfect substitute. |
| **Episode still** | 16:9 | ✅ Yes | **Excellent** — arguably better than official. TMDB/TVmaze episode stills *are* screenshots. Ours can be better-selected. |
| **Poster** | 2:3 | ⚠️ **Composed, not extracted** | See §8.7.3. There is no 2:3 image inside a 16:9 film. |
| **Logo / clearart** | transparent title treatment | ❌ **Never** | Not in the file. Not derivable. Absent unless a provider or local asset supplies it. |
| **Banner** | 16:5-ish | ⚠️ Composed | Same problem as poster, less severe. |

**So: backdrops are solved. Posters are designed. Logos are simply absent.** No amount of cleverness changes that, and the UI should be built so a missing logo is a non-event (the title renders as type, which is what the theme's `font.display` role is for).

### 8.7.2 Frame selection — deterministic, not naive

**Never grab the frame at 10%.** That lands on a studio logo card roughly as often as not.

```
1. Exclusion zones     skip first ~5% (logos, black, fade-in)
                       skip last ~15% (credits)
2. Candidate pass      ffmpeg `thumbnail` filter (picks the most
                       representative frame per batch of N, vs the
                       batch's median histogram) across the middle band
3. Reject              near-black / near-white   → mean luma outside band
                       low variance (fades, blanks, solid cards) → stddev floor
                       letterboxed bars → `cropdetect`, crop before scoring
                       motion blur → variance-of-Laplacian floor
4. Score               colorfulness (saturation spread), contrast, edge density
5. Diversity           N candidates spread across runtime; never two within
                       a few seconds of each other
6. Pick                highest score
```

**`cropdetect` matters more than it looks.** A 2.39:1 film in a 16:9 container has black bars baked in. Score them and you get garbage; composite them into a poster and it looks broken.

**Deterministic given the file** — same bytes, same output. Required for idempotency (§9.6.1: key on content hash, re-run is a no-op).

**No ML.** No face detection, no saliency model. That would mean a model container, which is an Immich-shaped dependency we don't want for a nice-to-have. Classical filters get most of the way.

### 8.7.3 The 2:3 problem — composition, not cropping

A poster is a **designed artifact with typography**, not a frame. Cropping 16:9 → 2:3 discards ~44% of the width; film composition doesn't survive it — faces get sliced, subjects go off-centre.

**Two strategies, both theme-selectable** (this is what the `generated-art composition style` token in §15.2 controls):

- **(a) Blur-extend** *(default)*. Place the full 16:9 frame in a 2:3 canvas; fill above and below with a blurred, darkened enlargement of the same frame. Nothing is lost, nothing is sliced. Familiar visual language — Apple Music and others do this.
- **(b) Weighted crop.** Crop to 2:3 biased slightly upward (heads live in the upper third). Riskier, occasionally better.

Then, both paths:
```
→ gradient scrim from bottom
→ title set in the theme's font.display, placed per theme token
→ output 2:3
```

**The insight worth holding onto:** a wall of *consistently composed* posters looks like a design system. A wall of *half-scraped, half-composed* posters looks broken. Consistency beats mixed authenticity — so a per-library **"compose all posters"** override is worth having even when some official art exists.

### 8.7.4 Generated art is always provisional

This is the part that makes it actually seamless rather than merely non-failing.

- Generated art is stored with `artwork.source = 'generated'` and **always loses** to any higher-priority source on re-resolution (§8.3).
- **It is replaced automatically, silently, forever after.** User drops a `poster.jpg` in → replaced next scan. An NFO appears → replaced. They enable the optional TMDB key (§8.6) a year later → the whole library upgrades in the background with no migration, no prompt, no button. That's §3.4 self-healing doing exactly what it's for.
- **Generated art is never written back to the media folder**, even when write-back is on and the library is writable (§10.4). It's derived data; it belongs in `/config/artwork`. Writing it into the media tree would pollute the library and confuse *arr.

### 8.7.5 Scope of the bare case, honestly

The generated path is the *only* source of movie posters **only** when all of these are true: it's a movie, it's not anime (AniList covers anime movies including in-series ones, §7.3 — but see §8.7.6 for the cross-library case), there's no NFO, no sidecar art, `poster.jpg` was never written by Radarr, and the optional key (§8.6) is off.

That's a real user. It's not a common one.

### 8.7.6 ⭐ Anime movies in a general-purpose library — resolved

`contentProfile` is set **per `Library`**, which forks parser and provider order (§7.2). But *arr conventions commonly split anime series and movies into separate folders — a "Movies" library often holds *Demon Slayer: Mugen Train* right alongside *Oppenheimer*, and nothing about that folder says "anime." If `contentProfile` were a hard wall, that movie would silently lose AniList and land in the bare-poster case (§8.7.5) for no reason a user would understand.

**Decision: `contentProfile` is the default provider order, not a hard boundary.** For `MediaKind.MOVIE` specifically, the resolver may also try the anime chain (AniList, then Jikan) as an **additional enrichment attempt**, regardless of the owning library's profile. This is not a schema change and not a new mechanism — it's the existing `Evidence` model (§7.5) doing exactly what it's for: a confident AniList hit is a strong signal like any other, and it's allowed to win even in a `GENERAL` library.

Why this is the right shape rather than (the rejected alternative) inferring `contentProfile` per item:

- **It's cheap and targeted.** Gated to `MediaKind.MOVIE` only — not full anime-parser overhead for every file in every general library, just one extra provider try for a kind that's a small fraction of any library.
- **It doesn't ask the operator to reorganize their *arr layout around our library boundaries**, which would be backwards — Radarr doesn't know or care what `hokago` calls a library.
- **It reuses infrastructure that already exists** rather than adding a per-item profile-inference system, which is real complexity for a narrow case.
- **The failure mode is graceful either way.** No AniList match → falls through to the normal chain → generated art if truly bare. Never worse than today; sometimes better.

`contentProfile` remains the primary, cheap default for everything else — series/episode parsing still forks hard on it, since trying both parsers on every TV file would be wasteful and rarely helps. This carve-out is movie-only.

---

## 9. Scanning & identity resolution

### 9.1 The honest position

"Any filename, any folder structure" is **not fully achievable**, and claiming it is, is the trap.

Anitomy's own docs concede it: `Spice and Wolf 2` is either episode 2 or a batch of season 2, and without the file extension there's no way to know. The information isn't in the filename. Seanime gets away with the claim because AniList's corpus is ~20k distinctive titles; for general media, where `The Office` is two shows and `Avatar` is three things, it's much worse.

**Target: ~95% on messy real-world libraries, with the remaining 5% non-blocking and correctable.** Not 100% with silent mislabeling.

### 9.2 The model: evidence accumulation, not path parsing

**(a) Group first, match second.** The unit of identity is the **folder**, not the file. Never resolve `- 08.mkv` alone. Resolve the directory as a set, where sibling numbering, consistent release group, and consistent runtime corroborate. *This is what actually allows loose naming.*

**(b) Every signal votes; nothing is authoritative alone.** A confident filename parse contradicted by ffprobe runtime is wrong, and the system should know it.

**(c) Mixed folders are normal, not an error.** A series folder with 12 × 24min files **and** one 108min file is the *Mugen Train* shape (§7.3) — the outlier is a movie, not a malformed episode. Detect via runtime clustering; never demand the user reorganise.

### 9.3 Parser registry

Forks by kind. Anitomy's author is explicit it's anime-optimised and works for movies/TV only "to some extent."

| Kind | Parser |
|---|---|
| anime | `anitomy` (TS port) — tokenizer, not regex |
| movie / TV | scene-release + Kodi folder-convention parser |

All behind `parseFilename()` so they're swappable.

**Known-unresolvable cases** (handle, don't pretend):
- `[Arigatou] Shuffle! - 08` — group or title?
- `Spice and Wolf 2` — episode or batch?
- Scene-release `.nfo` files are **ASCII-art release notes**, not Kodi NFOs, despite the shared extension. Detect and ignore. Real bug we'd otherwise ship.

### 9.4 Ingest job graph

```
scan
 └→ group (folder-level, runtime clustering)
     └→ parse
         └→ resolve (evidence → confidence → identity → collection membership)
             └→ probe (ffprobe)
                 ├→ extract-fonts        ← eager, at ingest. NOT lazy. (§13.2)
                 ├→ extract-subtitles
                 ├→ artwork (local → embedded → network → generated)
                 ├→ trickplay
                 └→ segments (§14)
```

### 9.5 File watching

- inotify **does not work on NFS/SMB.** Network shares are extremely common. It silently never fires.
- Periodic scan is the **mandatory fallback**, not an option. Document it.
- Track by `(inode, size, mtime, hash)` so renames/moves don't re-import or lose watch state.

### 9.6 ⭐ Job robustness — "seamless and recoverable like Immich" NEW

**Required, not aspirational.** This is what "fault-tolerant and robust" decomposes into.

**Free from BullMQ:** retries with exponential backoff, stalled-job detection (worker dies mid-job → job returns to queue), per-queue concurrency limits, per-queue rate limiting, delayed jobs, repeatable/cron jobs, failed-job retention.

**What we must build on top:**

1. **Every job is idempotent.** Safe to run twice, always. Key on **content hash**, not job ID. A re-run of `extract-fonts` on the same file is a no-op, not a duplicate.

2. **⚠️ Valkey is a cache, not a source of truth.** The important one. If Valkey dies and the queue is lost, you must not lose *work*. The source of truth for "what needs doing" is **derived state in Postgres** — `media_item has no artwork` → artwork job is needed. A **reconciler runs on boot** and re-enqueues everything missing. Valkey loss = re-derive, not data loss. This is stricter than Immich and it's the right call for a homelab where Valkey isn't on stable storage.

3. **Checkpointing.** A scan of 50,000 files must **resume**, not restart. Persist progress cursors.

4. **Graceful shutdown.** SIGTERM → stop accepting → finish or requeue in-flight → **kill ffmpeg child processes cleanly.** Orphaned ffmpeg chewing CPU after a container restart is a classic media-server bug. Track PIDs; reap them.

5. **Backpressure.** Never enqueue 50k jobs at once. Stream and batch, or the first scan OOMs Valkey and the admin UI becomes unusable.

6. **Poison-pill handling.** A file that crashes ffmpeg must not retry forever. After N failures → mark `needs_attention`, **stop retrying**, and **keep it playable if at all possible.** A file with no thumbnail still plays.

7. **Crash-only design.** No worker holds state in memory that isn't recoverable from Postgres. `kill -9` at any moment must be survivable.

8. **Admin queue UI.** Per-queue: view, pause, resume, retry-failed, clear. Immich has this; it's the difference between "debuggable" and "black box."

**Note the tension with §3.2:** job failures are invisible *to normal users*. They are highly visible *to the admin*, in the admin UI and logs. "Degrade, never error" is a user-facing rule, not a "hide problems from operators" rule.

---

## 10. Standards integration

### 10.1 Sidecar

- **Kodi NFO** — the big one. Kodi always scans NFO first regardless of scraper settings. `<VideoFileName>.nfo` recommended; also accept `movie.nfo`, `tvshow.nfo`. UTF-8 XML. `<movie>`, `<tvshow>`, `<episodedetails>` (we ignore `<artist>`/`<album>`/`<musicvideo>` — no music). `<uniqueid type="imdb">` carries external IDs.
- **Artwork — support both conventions, because the ecosystem disagrees:**
  - Kodi form: `<movie_name>-poster.jpg`, `-fanart.jpg`, `season01-poster.jpg`
  - **Radarr/Sonarr form: `poster.jpg`, `fanart.jpg`** — Radarr does *not* follow Kodi's convention. **This is the form that matters most** (§8.6).
  - Also: `banner.jpg`, `logo.png`, `background.jpg`, `folder.jpg`
- **Subtitles:** `.srt` / `.ass` / `.sub`+`.idx`, language + `forced` / `sdh` flags in filename (`.en.srt`, `.eng.forced.srt`).

### 10.2 In-container

- Embedded tags (MKV tags, MP4/iTunes atoms)
- **Attached cover art** — `attached_pic` mjpeg streams. Free artwork, already in the file.
- Font attachments (§13.2)
- Chapters (§14)

### 10.3 The two everyone misses

Both from Jellyfin's unresolved bug trail:

- **`.mks` files** — external Matroska subtitle containers bundling subs *and* fonts. Jellyfin Web won't even accept the upload.
- **A `fonts/` directory next to the media file** — described in Jellyfin's own PR discussion as seen "a bunch of times," still unsupported.

Nearly free to support; real differentiator for anime libraries.

### 10.4 Write-back (optional, off by default)

If the library is writable, optionally write **NFO + EDL** back out. Makes metadata portable, survives total DB loss. Jellyfin's EDL plugin requires a writeable library; most media mounts are read-only (§16.1 mounts `:ro` by default), so gate on a writability probe, never assume.

---

## 11. Playback pipeline

### 11.1 Decision engine

Client sends a **device profile**; server decides. Bake in from day one — retrofitting is agony.

```
Direct Play      container + video + audio + subs all supported
Direct Stream    remux — audio/container/subs unsupported, video fine
Transcode        video codec unsupported, bitrate cap, resolution, HDR→SDR, sub burn-in
```

Evaluation order (Jellyfin's StreamBuilder, which is correct): force flags → direct play eval vs profile → transcoding profile eval.

**Keep the profile abstraction general** — `airplay` should be expressible as just another profile with `subtitles: burn` (§18.3, §20.2). Chromecast is permanently out (§18.3) — don't use it as an example here or anywhere; there is nothing to build toward.

Gotchas: **MKV is not streamable in Firefox** (always remuxes). Subtitles can trigger *either* remux or full video transcode. HEVC browser support limited; AV1 growing. A client advertising "4K" does not support every 4K codec/profile/HDR format/bitrate.

### 11.2 On-demand HLS with seek

1. Generate the **full `.m3u8` immediately** with a static segment length, so the client behaves as if the whole video is ready.
2. On seek into an un-transcoded region: **kill the current ffmpeg job, restart at that segment.**

Requires `-force_key_frames` for deterministic segment boundaries — variable segment duration destabilises players. Segment cache on disk, disposable (§16.3).

### 11.3 HDR → SDR tone mapping

Naive conversion reads PQ Rec.2020 as SDR → grey, foggy, crushed gamut. Visible-quality bug, not an edge case.

- **CPU:** `zscale=t=linear:npl=100 → format=gbrpf32le → zscale=p=bt709 → tonemap=hable:desat=0 → zscale=t=bt709:m=bt709:r=tv → format=yuv420p`
- **GPU:** `libplacebo` (all three axes, one pass)
- **Gate on an ffprobe HDR check** so SDR files skip entirely.
- Dolby Vision: work the HDR10 base layer; enhancement layer ignored.

### 11.4 Transcode governance

Concurrent transcode limits, global and per-user — one remote 4K viewer melts an N100. Per-user bandwidth caps. Session reporting / "who's watching now" admin view.

---

## 12. Hardware acceleration

The #1 self-host support burden. The container can't see the GPU unless explicitly mapped; the method differs per vendor.

| Vendor | Needs |
|---|---|
| Intel / AMD | `devices: /dev/dri/renderD128`, `group_add: video, render` (GID via `getent group render`) |
| NVIDIA | NVIDIA Container Toolkit, `runtime: nvidia` |

**Solution: `hwaccel.transcoding.yml` + `extends:`** (Immich's pattern). One word. The difference between "works" and a support forum.

Preflight: worker probes available hwaccels on boot and **logs** what it found. Never silently fall back to CPU without saying so — in logs, not UI (§9.6 note).

---

## 13. Subtitles & fonts

The product differentiator, and where every competitor is weakest.

### 13.1 Rendering

**Client-side libass via WASM — `JASSUB`.** Not server-side burn-in: burn-in is the single most expensive transcode operation (compositing the sub layer *while* encoding = two transcodes at once). Crunchyroll uses the same underlying approach (SubtitlesOctopus). Jellyfin maintains its own libass-wasm fork.

### 13.2 Fonts — eager extraction, not lazy

ASS styles reference fonts **attached inside the MKV**. Don't extract → every sub falls back to a default font → typesetting visibly broken.

`ffmpeg -dump_attachment:t "" -i file.mkv ...`

Jellyfin does this **lazily at playback** and has shipped bugs repeatedly: fonts silently falling back on Android because the extractor didn't run; extraction failing when a font filename contains a space; the absurd workaround being "play it in a browser first, then your phone works."

**hokago extracts fonts eagerly at scan time**, deduped by hash into the **shared font store** (§1.1, §7.7). Sources: MKV attachments, `.mks` containers, sibling `fonts/` directory, **plus the three theme font sources from §1.1** (vendored, theme bundles, server-side fetch-once) **and `/config/fonts`**. One store, one origin, many sources. *This store is also what makes offline downloads with selectable ASS subs possible — see §20.2.*

### 13.3 The COOP/COEP trap

JASSUB uses `SharedArrayBuffer` → needs COOP/COEP. Without them: single-threaded fallback. Firefox has no threading at all.

**The trap:** `Cross-Origin-Embedder-Policy: require-corp` **blocks every cross-origin image.** If artwork were hotlinked, every poster would vanish.

**We're immune by construction** — §3.5 downloads artwork and serves it from our own origin; §1.1 self-hosts fonts. Both decisions pay off here. But this must be decided *together* with the image cache, not after. Fallback: `COEP: credentialless`.

### 13.4 Formats

- ASS/SSA — client-side render (the good path)
- SRT — trivial
- **PGS (bitmap)** — forces burn-in. Flag at scan time; the silent killer of Direct Play.

---

## 14. Media segments (intro/outro skip)

**Cascade, cheapest first.** Inverts Jellyfin's model, where the initial library-wide chromaprint analysis is very CPU-intensive.

```
1. Named chapters        free, instant, at scan time
2. Community DB          keyless, optional, enrichment-only
3. Chromaprint           expensive, last resort, off-peak scheduled
4. Manual                always wins
```

**Tier 1 is free money.** Many releases ship named chapters already. Jellyfin *still* can't use them — open request to infer intro/outro from well-known chapter names, because chapters are exposed only as chapters and clients can only skip when the server provides explicit INTRO/OUTRO segments. We do it at scan time, zero CPU.

**Tier 2** — keyless, no signup: IntroDB (anonymous API, crowd-verified), TheIntroDB (free API: intro/recap/credits/preview), aniskip (MAL ID → OP/ED times). All **proprietary** → enrichment only, never a dependency (§3.1).

**Tier 3 — chromaprint.** Audio fingerprinting (Shazam/AcoustID tech) detects repeated audio across a season; also credits. **Requires ffmpeg `--enable-chromaprint`** — why we build our own ffmpeg (§5), decided in the Dockerfile on day one.

Detection params (Jellyfin's defaults, reasonable start): intro within first 25% or 10min, whichever smaller, 15s–2min long; credits <4min. Schedulable, off-peak, thread-limited (2 threads on N100-class). First run a one-time cost, then incremental.

**Trickplay** rides the same ffmpeg pass. ~6MB per 90min at 320×180/10s; 1–4 min to generate. Cheap, enormous perceived polish.

---

## 15. Theming

Hard requirement → **the token contract is written before any UI.**

### 15.1 Mechanism

```
packages/theme  →  typed token set  →  CSS custom properties  →  data-theme on <html>
```

Themes are **validated JSON**, per profile, in Postgres, importable/exportable. Runtime switch, no rebuild. **Every shadcn component consumes tokens only. Never a hardcoded value.** This rule makes or breaks the requirement.

**Schema note:** `Theme.colorScheme` (dark|light) is its own column, mirroring `ThemeManifest.colorScheme` — not inferred from `color.bg` lightness. The switcher needs it to group reference themes (e.g. `oled` vs `light`) without parsing token values.

### 15.2 Token surface

Must cover more than color, or "make it look like Netflix" is impossible:

- color (bg, surface, text, accent, hover, focus…)
- radii, borders, shadows
- **typography — font *roles*, not one family** (§1.1): `font.display` / `font.body` / `font.ui` / `font.mono` / `font.wordmark`, each a **stack** so unresolved fonts degrade instead of breaking. Plus scale and weights. Families resolve against the font store.
- spacing scale
- motion (durations, easing)
- **poster aspect ratio** (2:3 vs 16:9 — Netflix vs Crunchyroll genuinely differ)
- card shape + hover behaviour
- nav layout (top bar vs sidebar)
- **generated-art composition style** (§8.7.3) — blur-extend vs weighted crop, scrim, title placement, display face
- collection display default: `release_order` or `story_order` (§7.3)

### 15.3 Ships with

`hokago` (default), `crunchyroll-ish`, `netflix-ish`, `light`, `oled`. Switcher in the profile menu, not buried in settings.

---

## 16. Deployment & storage

### 16.1 ⭐ Bind mounts only — no named volumes NEW

**Decision: everything is a bind mount to a real folder on disk. No docker named volumes anywhere, including Postgres.**

Rationale: named volumes hide data in `/var/lib/docker/volumes`, making backup opaque, migration painful, and Nix integration awkward. Self-hosters want to see their data.

```yaml
volumes:
  - /srv/hokago/config:/config        # exactly one config root
  - /mnt/media/anime:/media/anime:ro  # N media roots, user-defined
  - /mnt/media/movies:/media/movies:ro
  - /mnt/media/tv:/media/tv:ro
```

**Multiple media roots are first-class.** `libraries.root_path` already supports it. The user adds mounts to compose and points a library at each. Compose can't generate a dynamic mount list from one env var — the user edits the file. Normal and fine.

**Config layout — subdivided so backup/disposability is legible:**

```
/config
  /db          postgres data
  /artwork     downloaded + generated art
  /fonts       loose font drop-in (source 4, §1.1)
  /themes      theme bundles — drop a folder in, done (source 2, §1.1)
  /store       hash-deduped font store (all sources converge here)
  /cache       transcode segments, trickplay   ← disposable
  /logs
  config.yaml
```

**⚠️ Two real caveats that must be documented, not discovered:**

1. **`/config` must be on a local POSIX filesystem.** Postgres on a bind mount to NFS/SMB/exFAT/macOS-shared-folder will refuse to start or, worse, corrupt. **This is the #1 way someone will lose their database.** The first-run wizard should **probe and refuse** rather than let it happen.
2. **`/config` should be on an SSD.** It holds the transcode cache and trickplay. On spinning rust, seeking feels bad. Allow a `HOKAGO_CACHE_DIR` override to relocate `/config/cache` alone for people who insist.

Media roots mount `:ro` by default. Write-back (§10.4) requires explicitly mounting `:rw`, and the app probes writability rather than assuming.

### 16.2 Self-hoster expectations (non-negotiable)

- **PUID / PGID** — linuxserver convention. Without it: permission-denied bug reports forever. **Doubly true with bind mounts** — the mounted folders must be chownable to PUID:PGID or readable by it.

  **⚠️ Explicit exception: `/config/db`.** Stock Postgres images run internally as a fixed UID (typically `999`), not an arbitrary configurable one the way `hokago`/`hokago-worker` do. Fighting that with PUID/PGID recreates the exact permission hell those variables exist to prevent — this is the same reason Immich and Nextcloud carve Postgres out too. **`app`/`worker` containers honor PUID/PGID on their bind mounts; `/config/db` is owned by Postgres's own internal UID and is documented as a deliberate, permanent exception, not a bug.** The wizard's filesystem probe (§16.1) should check `/config/db` is writable by that UID specifically, not by PUID/PGID.
- **TZ** env var.
- **Base path support** — people run at `example.com/hokago`. Retrofitting is painful.
- **First-run wizard** — admin account, library paths, `/config` filesystem probe. **No API key screen** (§8.4, §8.6).

### 16.3 Backup story

- `pg_dump` for Postgres (plus the bind mount is right there and visible).
- **Everything else must be rebuildable from source files.** Losing `/config/cache` is a non-event. Losing `/config/artwork` costs a re-scan, not data.
- Optional NFO write-back (§10.4) means metadata survives even total DB loss.

### 16.4 Later

Nix flake + Tailscale (target deployment). **Nothing in the design may assume a public hostname or TLS we control.** See §18 — this constraint has teeth.

---

## 17. Watch parties ⭐ IN SCOPE

Feasible and reasonably cheap, because the WebSocket layer already exists for job progress and playback sessions (§5). Watch parties ride it rather than adding infrastructure. **This is why WS goes in early.**

**Protocol:** the **server is the timekeeper**, not the host client. Broadcasts `{command, position_ms, issued_at}`. Each client computes its own offset against `issued_at` and self-corrects. Tolerate ±N ms drift; hard-seek past a threshold.

**The hard parts** (why it's a later milestone, not core):
- Clock drift between clients.
- Buffering desync — one participant on a slow link stalls; do you pause everyone? (Yes, configurable, with a timeout.)
- **Different transcode states per participant.** A direct-plays; B is transcoding at 720p and 8 seconds behind. **The timekeeper must key on *media position*, never wall clock.**
- Late joiners — seek to current position on join.
- Host leaves — promote or end.

**Not blocking anything.** Ships after the player is solid.

---

## 18. Cast & AirPlay — RESOLVED

**Decision: no public domain is ever in scope. This settles both.**

- **Chromecast: permanently out.** Not deferred — out. See §18.1; it cannot work without a public domain.
- **AirPlay: deferred to the native clients** (§20.2), where it's nearly free. Not built into the web app. See §18.2 — it survives because it fails differently than Chromecast.

Retained requirement: **keep the device-profile abstraction (§11.1) general** so that a future `airplay` profile is just a profile with `subtitles: burn`. Free if we don't hardcode assumptions. Nothing else about casting influences any core decision.

The rest of this section is the reasoning, kept so nobody relitigates it.

### 18.1 Chromecast — why it's out, not deferred

Google's docs: Custom and Styled receivers **must be registered** to get an application ID; the Default Media Receiver needs no registration but **allows no styling** and supports limited formats. A Custom Web Receiver is an HTML5 app **you host yourself**, and **it must be served over HTTPS**.

That's the manageable part. This is the problem, from a well-known Jellyfin+Chromecast writeup:

> Chromecast requires HTTP traffic be encrypted into HTTPS with a valid certificate. Chromecast is **hard coded with google DNS servers (8.8.8.8, 8.8.4.4)**. Basically, Chromecast assumes that you are a 3rd party website hosted on the public internet somewhere like Youtube. Which you are not.

Its listed prerequisites include **a valid public domain name and access to its DNS records**, a publicly-valid certificate working on a local network, and **rerouting Google's hardcoded DNS to your own resolver**.

**Three conflicts:**

1. **vs. Tailscale-only (§16.4).** Chromecasts don't run Tailscale. The Chromecast fetches the stream itself, so it must reach your server — which means a public domain and public TLS. **Directly contradicts the deployment model.**
2. **vs. client-side ASS rendering (§13.1).** The Chromecast renders the stream itself. JASSUB isn't there. **Casting means burning in subtitles** — the most expensive transcode path, and the exact thing our subtitle architecture exists to avoid.
3. **vs. "no fiddly setup."** The above is a weekend for an expert.

Jellyfin ships this and *still* gets "I can't get Jellyfin to cast at all" next to "Emby has worked for 10 years."

### 18.2 AirPlay — much better, but not free

AirPlay from Safari/iOS is nearly free — the browser exposes it natively on `<video>` (`x-webkit-airplay`). No registration, no receiver app, no app ID.

Same two structural problems, weaker form:
- **Reachability:** the Apple TV fetches the HLS stream itself → must reach the server. LAN fine; Tailscale-only not.
- **Subtitles:** AirPlay bypasses our player → no JASSUB → burn-in, or HLS-native WebVTT (which loses all ASS styling).

### 18.3 ✅ DECIDED

**No public domain is ever in scope.** That settles both:

- **Chromecast: permanently out. Closed, not deferred.** It is hardcoded to Google's DNS and requires a publicly-resolvable, publicly-certificated host. Without a public domain there is no path. Don't build for it, don't design around it, don't leave hooks.
- **AirPlay: deferred to the native clients, not the web app.** Correct call — in a browser it's Safari-only, so the web client would ship a half-feature to a minority of users. Native iOS/macOS clients get proper `AVPlayer` route handling nearly free. Costs nothing to wait.
- **One nuance worth remembering:** **Apple TV can run Tailscale** (tvOS 17+). So AirPlay to an Apple TV *on the tailnet* is plausible later — the one place AirPlay beats Chromecast structurally rather than incrementally. Chromecasts cannot join a tailnet; Apple TVs can. Revisit when the native clients exist.
- **Keep the device-profile abstraction general anyway** (§11.1) — `airplay` as a profile with `subtitles: burn` costs nothing today and is the entire integration surface later.
- **Never let casting drive a core decision.** If it wants burned subs, it gets burned subs. We don't compromise §13 for it.

---

## 19. Build order

**Step 0 — license firewall.** `packages/metadata` = interfaces only, `packages-optional/` exists and is empty. Can't be retrofitted.

1. **Foundations.** Prisma schema (§7) + theme token contract (§15) + contract package + custom ffmpeg image + vendored font subsets + compose (bind mounts, §16.1) boots and migrates.
2. **Local-first pipeline, end to end.** scan → group (w/ runtime clustering) → NFO parse → embedded tags/art → generated art. **Ship a working, fully offline, zero-network media server.**
3. **Job infrastructure done right** (§9.6). Reconciler, idempotency, checkpointing, graceful shutdown, admin queue UI. *Do this early — retrofitting fault tolerance is a rewrite.*
4. **Parser registry + evidence engine + resolution + collections** (§7.3).
5. **Probe + fonts + subtitles + artwork store.** Eager font extraction, `.mks`, `fonts/`, `/config/fonts`, PGS flagging.
6. **Keyless network providers as enrichment.** TVmaze, AniList/Jikan, Wikidata bridge. Per-provider limiters, ETag/incremental, lifecycle TTL, self-healing.
7. **Playback decision engine + on-demand HLS + seek-restart.**
8. **Player.** Vidstack + JASSUB + fonts + track switching + COOP/COEP. *First moment it feels real.*
9. **Auth, profiles, watch state, continue-watching.** WS layer lands here.
10. **Theme system + switcher + reference themes.**
11. **Segments cascade + trickplay.**
12. **Watch parties** (§17) — rides the WS layer.
13. **Optional user-key tier** (shipped disabled, pending §8.6 decision).
14. **hwaccel overlay, wizard (+ `/config` fs probe), PUID/PGID, base path, docs.**
15. → Nix / Tailscale. → mobile/desktop clients + offline downloads, **AirPlay rides along** (§20.2). *Chromecast: never (§18.3).*

**Ordering principle:** build the thing that always works *first*, then layer the thing that needs the internet on top. The only order in which the no-key constraint becomes a feature instead of a wound.

---

## 20. Open decisions

### 20.1 Deferred by design
1. **License** (§8.5). Decide before v1.0. Determines whether AOD/Fribb/IMDb are in.
2. **Acquisition extensions** — build the interface, or leave the boundary theoretical?

### 20.2 Later, but constraints noted now
3. **Mobile + desktop clients with offline downloads.** The OpenAPI-generated client (§5) is the enabler — already planned, nothing to do now. **But one constraint must be preserved:** an offline download of an anime episode needs its **subtitles *and* fonts to travel with it.** An ASS track with external fonts does not work offline. Two options, decide later:
   - **(a)** Remux to MKV with sub tracks + font attachments embedded — preserves selectable subs. **Preferred.**
   - **(b)** Burn in — acceptable for a one-time offline encode since it isn't realtime.

   **The shared font store (§1.1/§13.2) already makes (a) possible. Don't break that.**
4. **AirPlay in native clients** (§18.3). Apple TV can run Tailscale, so this is live later.
5. **Search backend.** Postgres FTS assumed. Multi-title (romaji / english / native / synonyms) + fuzzy. Revisit only if actually slow.

### 20.3 Closed
- ~~Music~~ — never. Removed from schema, providers, parsers, UI.
- ~~Fonts~~ — font store is the primitive; four sources, one origin. §1.1.
- ~~Named volumes~~ — bind mounts only. §16.1.
- ~~Watch parties~~ — in scope. §17.
- ~~Movie artwork~~ — **option (b)**, settings-only toggle. §8.6.
- ~~Chromecast~~ — **permanently out.** No public domain, no path. §18.3.

---

## 21. Research appendix

Evidence behind the decisions. Verify anything load-bearing before building on it.

### Fonts
- **Zen Maru Gothic** — SIL OFL 1.1. Copyright 2021 The Zen Maru Gothic Authors, `github.com/googlefonts/zen-marugothic`. Designer Yoshimichi Ohira. OFL permits commercial use, modification, distribution. **Medium weight = 7,866 glyphs.** 5 weights (Light/Regular/Medium/Bold/Black). `@fontsource/zen-maru-gothic` on npm, split by weight. → `fonts.google.com/specimen/Zen+Maru+Gothic`, `online-fonts.com/fonts/zen-maru-gothic`

### Metadata providers
- **AniList** — free GraphQL, no key. 90/min + burst limiter; **currently degraded to 30/min**. 1-min timeout on breach. Explicitly does not guarantee availability; has disabled the API entirely during outages; may IP-block. Exposes relationships (prequels/sequels/side stories) → collection graph. Format enum `TV|MOVIE|OVA|ONA|SPECIAL`. → `docs.anilist.co/guide/rate-limiting`, `/guide/considerations`
- **TVmaze** — anonymous, free, CORS-enabled. CC BY-SA 4.0. ≥20 calls/10s per IP. Backend-limited but not edge-cache-limited. `?embed=` folds cast/episodes/seasons into one response. Incremental updates endpoint. Resolves by TVRage/TheTVDB/IMDb ID. Images `medium`/`original`, poster for shows/people, landscape for episodes; hotlinking permitted (we decline). → `tvmaze.com/api`, `apis.io/providers/tvmaze`
- **Jikan** — unofficial MAL API; scrapes MAL. No key. Self-hostable: `docker run jikanme/jikan-rest`. **ETag per request** → `If-None-Match` → 304. 24h cache. Can be limited by MAL upstream. Read-only. → `docs.api.jikan.moe`
- **TheTVDB** — v4 keys per-project; negotiated contract (generally requiring attribution) or user-supported requiring each end user to hold a **$12/yr subscription + PIN**. → **excluded.** `github.com/thetvdb/v4-api`
- **TMDB** — free key required. Jellyfin ships one project-wide key public in their repo; TMDB staff never clearly blessed it; Jellyfin maintainers noted the Trakt fix was revoking the project key. → **excluded from core; optional user-supplied only.** `github.com/jellyfin/jellyfin/pull/10737`
- **IMDb datasets** — `datasets.imdbws.com`, daily, TSV, no key. **Personal/non-commercial only.** No images. ~6.2M titles / 9.6M people. `isAdult` provided. → `developer.imdb.com/non-commercial-datasets`
- **Wikidata** — free SPARQL, no key. Returns IMDb/Trakt/TMDB/RT IDs + `part_of_series` / `follows` / `followed_by`. A Jellyfin dev was already building a Wikidata plugin. Poster coverage poor — Commons is free-content-only. → `wikidata.org/wiki/Wikidata:SPARQL_query_service`
- **Landscape** — "TVmaze is the only fully keyless option; TMDB and OMDb both require a free developer key." → `apideposu.com/en/blog/best-free-movie-tv-apis`

### ID mapping
- **manami-project/anime-offline-database** — cross-refs MAL/AniDB/Kitsu/AniList/anime-planet/anisearch/notify.moe/livechart. **AGPL-3.0.**
- **Fribb/anime-lists** — merges on AniDB ID; includes `episode_offset` and `season` per TVDB/TMDB. **The offset field is the whole ballgame.**
- **AnimeAPI (nattadasu)** — explicitly warns deriving from AOD forces AGPL; suggests a private instance for permissive projects. → *basis of the §8.5 firewall.*
- Mappings are **unidirectional**; A→B ≠ B→A.

### Parsing
- **Anitomy** — tokenizer, not regex, because regex provably can't: element order varies, technical info isn't reliably bracketed, brackets may be grouping or title, multiple delimiters coexist. Tens of thousands of filenames/sec.
- Author: works for movies/TV "to some extent, but the library is mostly optimized for anime."
- Unresolvable: `[Arigatou] Shuffle! - 08` (group vs title); `Spice and Wolf 2` (episode vs batch — "no way to know" without extension).
- **`anitomy` (yjl9903)** — TS port, zero deps, Node/Deno/Bun/browser. ← use this. **`anitomy-js`** — native node-gyp. ← avoid.

### Playback
- **Direct Play / Direct Stream / Transcode** — goal is Direct Play; Direct Stream when audio/container/subs unsupported; transcode when video codec unsupported. Subtitles cause either. Burn-in most intensive (two transcodes at once). → `jellyfin.org/docs/general/clients/codec-support`
- **StreamBuilder order** — force flags → direct play vs profile → transcoding profile.
- **MKV** — not streamable in Firefox, always remuxes.
- **On-demand HLS w/ seek** — full m3u8 immediately w/ static segment length; on seek into un-transcoded region, cancel ffmpeg and restart at that segment. → `github.com/advplyr/hls-media-server`
- Fixed keyframe interval required; variable segment duration destabilises players.

### HDR
- Naive conversion reads PQ Rec.2020 as SDR → washed out, crushed gamut, misread curve.
- CPU: `zscale=t=linear:npl=100, format=gbrpf32le, zscale=p=bt709, tonemap=hable:desat=0, zscale=t=bt709:m=bt709:r=tv, format=yuv420p`
- GPU: `libplacebo` — all three axes, one pass. `hable` + `desat=0` preserves shadow/highlight; `reinhard` if too dark.
- Dolby Vision: HDR10 base layer; enhancement layer ignored.

### Subtitles & fonts
- **JASSUB** — libass→WASM + WebGL. SharedArrayBuffer → COOP/COEP recommended; single-thread fallback; Firefox no threading. → `github.com/ThaUnknown/jassub`
- Crunchyroll uses SubtitlesOctopus (same lineage). Jellyfin maintains `@jellyfin/libass-wasm`.
- Extraction: `ffmpeg -dump_attachment:t "" -i file.mkv ...`
- Jellyfin font bugs (all from lazy extraction): Android extractor not running → silent fallback; failure on font filenames with spaces; workaround "play in browser first."
- **`.mks`** — external Matroska subtitle container with fonts; Jellyfin Web won't accept upload. **`fonts/` dir next to media** — seen "a bunch of times," unsupported. → `github.com/jellyfin/jellyfin/pull/7275`
- **PGS** — bitmap, forces burn-in, kills Direct Play.

### Segments
- **Chapters → segments** — open Jellyfin request: chapters exposed only as chapters; clients can only skip with explicit INTRO/OUTRO segments. → `github.com/jellyfin/jellyfin/issues/16663`
- **Chromaprint** — Shazam/AcoustID tech; repeated audio across a season; also credits. Requires ffmpeg `--enable-chromaprint`; Jellyfin bundles it (Linux/Windows, not macOS). Initial analysis very CPU-intensive, then incremental. Defaults: intro within first 25%/10min, 15s–2min; credits <4min.
- **Keyless community DBs** — IntroDB (anonymous API, crowd-verified, no signup); TheIntroDB (free API); aniskip (MAL ID → OP/ED). All proprietary.
- **EDL** — Jellyfin's EDL plugin writes segments for Kodi; **requires a writeable media library.**
- **Trickplay** — ~6MB per 90min at 320×180/10s; 1–4 min to generate. Upstreamed into Jellyfin 10.9.

### Standards
- **Kodi NFO** — always scanned first regardless of scraper settings. `<VideoFileName>.nfo` recommended; `movie.nfo` conditional on a folder setting. UTF-8 XML. `<uniqueid type="">`. → `kodi.wiki/view/NFO_files`
- **Plex NFO agent** — Kodi-spec compliant; local image assets always preferred over NFO URLs; Custom Metadata Agent chains NFO primary + online below. ← *the model we copy.*
- **Radarr** writes `poster.jpg`/`fanart.jpg`, **not** Kodi's `<movie_name>-<image_purpose>.jpg`. Support both; **this is the one that matters** (§8.6). → `github.com/Radarr/Radarr/issues/8399`
- **Embedded cover art** — `Stream #0:21: Video: mjpeg ... (attached pic), filename: cover.jpg`
- **Scene `.nfo`** = ASCII-art release notes, not Kodi NFO. Detect and ignore.

### Cast / AirPlay
- **Registration** — Styled Media Receiver and Custom Receiver **must be registered** for an app ID. Default Media Receiver requires no registration but allows **no styling**. Custom Web Receiver is self-hosted HTML5 and **must be served over HTTPS**. → `developers.google.com/cast/docs/registration`, `/cast/docs/caf_receiver`
- **The self-hosted reality** — "Chromecast requires HTTP traffic be encrypted into HTTPS with a valid certificate. Chromecast is hard coded with google DNS servers (8.8.8.8, 8.8.4.4). Basically, Chromecast assumes that you are a 3rd party website hosted on the public internet somewhere like Youtube. Which you are not." Prereqs listed: valid public domain + DNS access, publicly-valid cert working on LAN, rerouting Google DNS to an internal resolver, CSP for cross-origin cast scripts. → `gist.github.com/Vigrond/1de5fc5ff468a48f053fd455a69c8766`
- **Jellyfin** — open proposal to remove hard-coded receiver IDs and support self-hosted receivers. → `github.com/jellyfin/jellyfin-meta/issues/45`

### Architecture / deployment
- **Immich** — server + ML + Redis + Postgres; ioredis + BullMQ; jobs trigger jobs; all three clients use **OpenAPI-generated REST clients**; `ghcr.io/immich-app/postgres` ships extensions pre-installed; `hwaccel.transcoding.yml` with `extends:` and one of `nvenc|quicksync|rkmpp|vaapi|vaapi-wsl`. → `docs.immich.app/developer/architecture`
- **HW accel** — container can't see GPU unless explicitly mapped; differs per vendor; trips up experienced admins. Intel/AMD: `/dev/dri`, `group_add: video, render`, GID via `getent group render`. NVIDIA: Container Toolkit.
- **Seanime** — Go + React; "no mandatory folder structure and no naming conventions required"; extension architecture keeps core clean. → `github.com/5rahim/seanime`

---

*End of document.*
