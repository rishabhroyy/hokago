# Graph Report - .  (2026-07-17)

## Corpus Check
- Corpus is ~13,433 words - fits in a single context window. You may not need a graph.

## Summary
- 163 nodes · 203 edges · 18 communities (10 shown, 8 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 4 edges (avg confidence: 0.85)
- Token cost: 125,325 input · 0 output

## Community Hubs (Navigation)
- Theme Token Contract (tokens.ts)
- Core Invariants & Subsystem Entrypoints
- Job Robustness & Playback Pipeline
- Project Identity & Constitution
- Data Model & Identity Resolution
- Stack Choices & Segments
- Metadata & Artwork Resolution Chain
- Theming Token Surface
- Metadata Providers & Collections
- Deployment & Storage
- Crash-Only Design
- Degrade, Never Error
- Never Block, Stay Fixable
- Explicit Over Magic
- Honest Limits (~95%)
- Lowercase Naming Rule
- Fetch Once Principle
- LLM-Buildable Principle

## God Nodes (most connected - your core abstractions)
1. `§5 Stack, chosen for LLM-buildability` - 13 edges
2. `§7 Data model` - 9 edges
3. `§21 Research appendix` - 9 edges
4. `hokago Design Document v0.3` - 8 edges
5. `Font store — the primitive (four sources, one origin)` - 7 edges
6. `Collections — movies inside series (§7.3)` - 7 edges
7. `§19 Build order (steps 0-15)` - 7 edges
8. `Immich — prior art` - 6 edges
9. `Jellyfin — prior art and pitfalls` - 6 edges
10. `Provider capability matrix` - 6 edges

## Surprising Connections (you probably didn't know these)
- `hokago (README title)` --semantically_similar_to--> `hokago identity: name, logo, wordmark, tone`  [INFERRED] [semantically similar]
  README.md → docs/design.md
- `CLAUDE.md — hokago project constitution` --references--> `hokago Design Document v0.3`  [EXTRACTED]
  CLAUDE.md → docs/design.md
- `Browser loads fonts/artwork only from our own origin` --references--> `Font store — the primitive (four sources, one origin)`  [EXTRACTED]
  CLAUDE.md → docs/design.md
- `packages/metadata contains interfaces only (license firewall)` --references--> `License firewall — no AGPL/non-commercial code in core repo`  [EXTRACTED]
  CLAUDE.md → docs/design.md
- `Every component consumes theme tokens only` --references--> `Theme token contract mechanism`  [EXTRACTED]
  CLAUDE.md → docs/design.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Fonts-as-artwork architecture: font store, roles, eager extraction, COOP/COEP** — docs_design_font_store, docs_design_zen_maru_gothic, docs_design_eager_font_extraction, docs_design_coop_coep_trap, docs_design_font_roles [INFERRED 0.85]
- **Generated artwork pipeline (§8.7): frame selection, poster composition, provisional replacement, anime cross-library carve-out** — docs_design_generated_artwork_pipeline, docs_design_frame_selection, docs_design_poster_composition, docs_design_generated_art_provisional, docs_design_anime_movies_cross_library [EXTRACTED 1.00]
- **Crash-only job system: idempotency, Valkey-as-cache, boot reconciler, BullMQ** — docs_design_job_robustness, docs_design_bullmq_valkey, claude_valkey_cache_rule, claude_idempotent_job_rule, docs_design_ingest_job_graph [INFERRED 0.85]

## Communities (18 total, 8 thin omitted)

### Community 0 - "Theme Token Contract (tokens.ts)"
Cohesion: 0.09
Nodes (24): BehaviorTokens, BorderWidthTokens, Color, ColorTokens, cssVarBlock(), defaultTheme, Duration, FontSizeTokens (+16 more)

### Community 1 - "Core Invariants & Subsystem Entrypoints"
Cohesion: 0.12
Nodes (22): Chromecast is permanently out, packages/metadata contains interfaces only (license firewall), Browser loads fonts/artwork only from our own origin, AirPlay deferred to native clients, §18 Cast & AirPlay, Chromecast permanently out — no public domain, Client-side libass/WASM rendering, not server burn-in, COOP/COEP trap — cross-origin images break under require-corp (+14 more)

### Community 2 - "Job Robustness & Playback Pipeline"
Cohesion: 0.13
Nodes (18): Work the build order in docs/design.md §19, Every job is idempotent, keyed on content hash, Every playback start creates a PlaybackSession, Valkey is a cache, not a source of truth, anitomy (yjl9903 TS port) tokenizer, §19 Build order (steps 0-15), BullMQ + Valkey queue, Evidence accumulation: group first, match second (+10 more)

### Community 3 - "Project Identity & Constitution"
Cohesion: 0.12
Nodes (18): CLAUDE.md — hokago project constitution, Local-first principle, No music — MediaKind is video-only, Working agreement: small commits, ask when ambiguous, update doc explicitly, Containers: hokago, hokago-worker, postgres, valkey, Zod → OpenAPI → generated TS client, hokago Design Document v0.3, Extension boundary for acquisition plugins (+10 more)

### Community 4 - "Data Model & Identity Resolution"
Cohesion: 0.12
Nodes (17): Anime is ContentProfile.ANIME, not a MediaKind, contentProfile is a default, not a hard wall, for MediaKind.MOVIE, Confidence is derived from Evidence, never authored, No email anywhere — username+password auth, admin/CLI reset, packages/db/prisma/schema.prisma — the data model, accounts/profiles/sessions/invites — username+password auth, contentProfile as default not hard wall for anime movies (§8.7.6), artwork.bytes_path — stored locally, never a remote URL (+9 more)

### Community 5 - "Stack Choices & Segments"
Cohesion: 0.14
Nodes (14): Rejected: Go backend, NestJS, s6-overlay, Postgres-as-queue, anitomy-js, Decided stack: TS/Node22, Fastify, Prisma, BullMQ+Valkey, React, Vidstack, JASSUB, custom ffmpeg, Chromaprint audio fingerprinting, Custom ffmpeg build with --enable-chromaprint, Fastify API framework, PostgreSQL database, Prisma ORM, React + Vite + TS frontend (+6 more)

### Community 6 - "Metadata & Artwork Resolution Chain"
Cohesion: 0.18
Nodes (13): No API key is ever required, Will it look beautiful with no keys? — settings-only optional key toggle, Deterministic frame selection algorithm, Generated art is always provisional, silently replaced, §8.7 Generated artwork pipeline — guarantee every item has artwork, Kodi — prior art, Kodi NFO sidecar standard, §8 Metadata subsystem (+5 more)

### Community 7 - "Theming Token Surface"
Cohesion: 0.22
Nodes (9): Every component consumes theme tokens only, packages/theme/src/tokens.ts — the token contract, Font roles: display/body/ui/mono/wordmark, each a stack, 2:3 poster problem — composition not cropping, Reference themes: hokago, crunchyroll-ish, netflix-ish, light, oled, Tailwind + shadcn/ui (in-repo, editable), Theme token contract mechanism, §15 Theming (+1 more)

### Community 8 - "Metadata Providers & Collections"
Cohesion: 0.36
Nodes (9): AniList provider, collection_entries: relation_type, release_order, story_order, anchor, Collections — movies inside series (§7.3), IMDb datasets (non-commercial only), Jikan (MAL) provider, Provider capability matrix, §21 Research appendix, TVmaze provider (+1 more)

### Community 9 - "Deployment & Storage"
Cohesion: 0.38
Nodes (7): Bind mounts only; no named docker volumes (except Postgres UID), Backup story: pg_dump, rebuildable cache/artwork, Bind mounts only — no named docker volumes, §16 Deployment & storage, /config/db owned by Postgres's own internal UID — deliberate exception, PUID/PGID, TZ, base path, first-run wizard, Optional NFO/EDL write-back

## Knowledge Gaps
- **39 isolated node(s):** `Color`, `Length`, `Duration`, `FontStack`, `ColorTokens` (+34 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **8 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Immich — prior art` connect `Project Identity & Constitution` to `Deployment & Storage`, `Job Robustness & Playback Pipeline`?**
  _High betweenness centrality (0.142) - this node is a cross-community bridge._
- **Why does `hokago Design Document v0.3` connect `Project Identity & Constitution` to `Core Invariants & Subsystem Entrypoints`, `Metadata & Artwork Resolution Chain`?**
  _High betweenness centrality (0.142) - this node is a cross-community bridge._
- **Why does `§19 Build order (steps 0-15)` connect `Job Robustness & Playback Pipeline` to `Data Model & Identity Resolution`, `Theming Token Surface`?**
  _High betweenness centrality (0.138) - this node is a cross-community bridge._
- **What connects `Color`, `Length`, `Duration` to the rest of the system?**
  _39 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Theme Token Contract (tokens.ts)` be split into smaller, more focused modules?**
  _Cohesion score 0.08666666666666667 - nodes in this community are weakly interconnected._
- **Should `Core Invariants & Subsystem Entrypoints` be split into smaller, more focused modules?**
  _Cohesion score 0.12121212121212122 - nodes in this community are weakly interconnected._
- **Should `Job Robustness & Playback Pipeline` be split into smaller, more focused modules?**
  _Cohesion score 0.13071895424836602 - nodes in this community are weakly interconnected._