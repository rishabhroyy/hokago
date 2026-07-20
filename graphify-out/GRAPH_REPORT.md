# Graph Report - /Users/rishabh/Documents/GitHub/hokago  (2026-07-19)

## Corpus Check
- 100 files · ~46,902 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 853 nodes · 1079 edges · 80 communities (50 shown, 30 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 10 edges (avg confidence: 0.69)
- Token cost: 99,142 input · 0 output

## Community Hubs (Navigation)
- Scanner Ingest & Metadata Pipeline
- Artwork & Media Probe
- Metadata Provider Clients
- API Package Manifest
- Theme Token System
- Web Package Manifest
- Web Theme Runtime & Player UI
- Design Doc Core Concepts
- Scanner Package Manifest
- Contract Package Manifest
- Worker Package Manifest
- API Auth
- Worker Job Orchestration
- Root Package Manifest
- Web TSConfig
- Metadata Interface Types
- Fonts Package (Vendored)
- API Core Routes
- DB Package (Prisma)
- FFmpeg Package Manifest
- Presence & Watch State
- Queue Package Manifest
- Playback Decision Engine
- Theme Package Manifest
- API Playback Routes
- Providers Package Manifest
- Queue Definitions
- Base TSConfig
- API Static/Asset Routes
- FFmpeg Process Spawning
- Metadata Package Manifest
- Filename Parsers
- API Admin Routes
- API TSConfig
- Worker TSConfig
- Evidence & Anime Profile Concepts
- Contract TSConfig
- FFmpeg TSConfig
- Font Build Script
- Metadata TSConfig
- Providers TSConfig
- Queue TSConfig
- Scanner TSConfig
- Theme TSConfig
- License Firewall Boundary
- OpenAPI Generation
- HLS Segment Building
- Admin Queue UI
- Vendored Font Seeding
- Docker Compose Bind Mounts
- Contract Client & Smoke Test
- Web Vite Config
- Build Order Reference
- hokago Project Identity
- Bind Mounts Rule
- Anime ContentProfile Rule
- ContentProfile Default Rule
- Crash-Only Principle
- Degrade Never Error Principle
- CLAUDE.md Root Doc
- Explicit Over Magic Principle
- Honest Limits Principle
- Local-First Principle
- Lowercase Naming Rule
- No-Music / Video-Only Rule
- Never Block, Stay Fixable
- No API Key Rule
- No Email Rule
- PlaybackSession Rule
- Rejected Stack Choices
- schema.prisma Reference
- Stack Decision
- Theme Tokens Rule
- tokens.ts Reference
- Working Agreement
- Anitomy Parser
- Jikan Provider
- No Email (Design Doc)
- No Music (Design Doc)
- README

## God Nodes (most connected - your core abstractions)
1. `ingestLibrary()` - 15 edges
2. `compilerOptions` - 11 edges
3. `FastifyInstance` - 10 edges
4. `ingestLeafItem()` - 10 edges
5. `Stack choice for LLM-buildability` - 10 edges
6. `syncEvidenceAndConfidence()` - 9 edges
7. `probeFile()` - 9 edges
8. `registerAuthRoutes()` - 8 edges
9. `compilerOptions` - 8 edges
10. `storeBytes()` - 8 edges

## Surprising Connections (you probably didn't know these)
- `Web app HTML entry point` --semantically_similar_to--> `Stack choice for LLM-buildability`  [INFERRED] [semantically similar]
  apps/web/index.html → docs/design.md
- `pnpm workspace config` --semantically_similar_to--> `Stack choice for LLM-buildability`  [INFERRED] [semantically similar]
  pnpm-workspace.yaml → docs/design.md
- `hokago cat-ears logo (SVG)` --references--> `hokago (project identity)`  [EXTRACTED]
  packages/theme/assets/logo.svg → docs/design.md
- `Browser loads fonts/artwork only from our own origin` --references--> `Font store primitive`  [EXTRACTED]
  CLAUDE.md → docs/design.md
- `packages/metadata contains interfaces only (license firewall)` --references--> `License firewall`  [EXTRACTED]
  CLAUDE.md → docs/design.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Prior art systems referenced in design rationale** — docs_design_jellyfin, docs_design_immich, docs_design_plex, docs_design_kodi, docs_design_seanime [INFERRED 0.85]
- **Keyless metadata provider chain** — docs_design_anilist, docs_design_tvmaze, docs_design_jikan, docs_design_wikidata [EXTRACTED 1.00]
- **Core stack technologies chosen for LLM-buildability** — docs_design_fastify, docs_design_bullmq, docs_design_valkey, docs_design_postgres, docs_design_prisma, docs_design_vidstack [EXTRACTED 1.00]

## Communities (80 total, 30 thin omitted)

### Community 0 - "Scanner Ingest & Metadata Pipeline"
Cohesion: 0.05
Nodes (61): main(), resolveArtwork(), upsertArtworkDescriptor(), clusterByRuntime(), median(), RuntimeClusterInput, RuntimeClusterResult, ANIME_MOVIE_CARVEOUT (+53 more)

### Community 1 - "Artwork & Media Probe"
Cohesion: 0.07
Nodes (47): ArtworkDescriptor, ArtworkKind, ArtworkSource, artworkStoreDir(), configDir(), extractEmbeddedArt(), findSidecarArt(), generateArt() (+39 more)

### Community 2 - "Metadata Provider Clients"
Cohesion: 0.09
Nodes (24): PROVIDERS, AniListMedia, AniListProvider, AniListResponse, AniListTitle, lifecycleFromStatus(), primaryTitle(), titleVariants() (+16 more)

### Community 3 - "API Package Manifest"
Cohesion: 0.06
Nodes (35): dependencies, fastify, @fastify/jwt, fastify-type-provider-zod, @fastify/websocket, hash-wasm, @hokago/contract, @hokago/db (+27 more)

### Community 4 - "Theme Token System"
Cohesion: 0.07
Nodes (30): result, BehaviorTokens, BorderWidthTokens, Color, ColorTokens, crunchyrollTheme, cssVarBlock(), defaultTheme (+22 more)

### Community 5 - "Web Package Manifest"
Cohesion: 0.06
Nodes (30): dependencies, hls.js, @hokago/theme, react, react-dom, vidstack, @vidstack/react, devDependencies (+22 more)

### Community 6 - "Web Theme Runtime & Player UI"
Cohesion: 0.10
Nodes (25): jassub, BROWSER_DEVICE_PROFILE, BrowserDeviceProfile, fontStyle, mediaFileId, params, profileId, varStyle (+17 more)

### Community 7 - "Design Doc Core Concepts"
Cohesion: 0.08
Nodes (29): Web app HTML entry point, Chromecast is permanently out, Every job is idempotent, keyed on content hash, Browser loads fonts/artwork only from our own origin, Valkey is a cache, not a source of truth, BullMQ (queue), Chromecast permanently out, Fastify (API framework) (+21 more)

### Community 8 - "Scanner Package Manifest"
Cohesion: 0.08
Nodes (24): anitomy, fast-xml-parser, dependencies, anitomy, fast-xml-parser, @hokago/db, @hokago/metadata, @hokago/providers (+16 more)

### Community 9 - "Contract Package Manifest"
Cohesion: 0.08
Nodes (24): @asteasolutions/zod-to-openapi, openapi3-ts, openapi-fetch, openapi-typescript, dependencies, @asteasolutions/zod-to-openapi, openapi-fetch, zod (+16 more)

### Community 10 - "Worker Package Manifest"
Cohesion: 0.10
Nodes (20): dependencies, @hokago/db, @hokago/metadata, @hokago/providers, @hokago/queue, @hokago/scanner, @hokago/db, @hokago/metadata (+12 more)

### Community 11 - "API Auth"
Cohesion: 0.17
Nodes (16): db, main(), AccessTokenPayload, fastify, @fastify/jwt, FastifyJWT, FastifyRequest, generateOpaqueToken() (+8 more)

### Community 12 - "Worker Job Orchestration"
Cohesion: 0.14
Nodes (17): artworkQueue, artworkWorker, connection, db, enqueueArtwork(), enqueueMetadata(), enqueueScan(), makeProcessMetadata() (+9 more)

### Community 13 - "Root Package Manifest"
Cohesion: 0.11
Nodes (17): devDependencies, tsx, @types/node, typescript, engines, node, name, packageManager (+9 more)

### Community 14 - "Web TSConfig"
Cohesion: 0.12
Nodes (16): compilerOptions, isolatedModules, jsx, lib, module, moduleResolution, noEmit, types (+8 more)

### Community 15 - "Metadata Interface Types"
Cohesion: 0.12
Nodes (14): IdMapping, MappingSource, MetadataArtworkCandidate, MetadataLifecycleState, MetadataMatch, MetadataProvider, MetadataQuery, MetadataSearchOptions (+6 more)

### Community 16 - "Fonts Package (Vendored)"
Cohesion: 0.12
Nodes (15): @fontsource/inter, @fontsource/jetbrains-mono, @fontsource/zen-maru-gothic, dependencies, @fontsource/inter, @fontsource/jetbrains-mono, @fontsource/zen-maru-gothic, subset-font (+7 more)

### Community 17 - "API Core Routes"
Cohesion: 0.17
Nodes (11): FastifyInstance, registerAuth(), app, db, port, CreateProfileBody, db, registerProfileRoutes() (+3 more)

### Community 18 - "DB Package (Prisma)"
Cohesion: 0.13
Nodes (14): devDependencies, prisma, main, name, private, scripts, generate, migrate:deploy (+6 more)

### Community 19 - "FFmpeg Package Manifest"
Cohesion: 0.13
Nodes (14): dependencies, exports, ./child-registry, ./decision, ./device-profile, ./hls, ./spawn, name (+6 more)

### Community 20 - "Presence & Watch State"
Cohesion: 0.19
Nodes (12): broadcastPresence(), db, registerPresence(), sockets, db, findNextEpisode(), HeartbeatBody, registerWatchStateRoutes() (+4 more)

### Community 21 - "Queue Package Manifest"
Cohesion: 0.14
Nodes (13): bullmq, ioredis, dependencies, bullmq, ioredis, exports, name, private (+5 more)

### Community 22 - "Playback Decision Engine"
Cohesion: 0.19
Nodes (9): decidePlaybackMethod(), PlaybackDecision, PlaybackMethod, AUDIO_ENCODERS, CONTAINER_ALIASES, DeviceProfile, needsToneMap(), PlaybackCandidateInput (+1 more)

### Community 23 - "Theme Package Manifest"
Cohesion: 0.14
Nodes (13): dependencies, zod, zod, main, name, private, scripts, build (+5 more)

### Community 24 - "API Playback Routes"
Cohesion: 0.23
Nodes (11): audioOutDir(), BITMAP_SUBTITLE_FORMATS, buildCandidateInput(), configDir(), db, LiveSession, liveSessions, registerPlaybackRoutes() (+3 more)

### Community 25 - "Providers Package Manifest"
Cohesion: 0.15
Nodes (12): dependencies, @hokago/metadata, exports, @hokago/metadata, name, private, scripts, build (+4 more)

### Community 26 - "Queue Definitions"
Cohesion: 0.30
Nodes (9): getConnection(), ArtworkJobData, artworkJobId(), MetadataJobData, metadataJobId(), QUEUE_NAMES, QueueName, ScanJobData (+1 more)

### Community 27 - "Base TSConfig"
Cohesion: 0.17
Nodes (11): compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, module, moduleResolution, resolveJsonModule (+3 more)

### Community 28 - "API Static/Asset Routes"
Cohesion: 0.25
Nodes (8): ARTWORK_MIME, CONTAINER_MIME, db, FONT_MIME, registerStaticRoutes(), SUBTITLE_MIME, SUBTITLE_MUX, subtitleRelativeIndex()

### Community 29 - "FFmpeg Process Spawning"
Cohesion: 0.33
Nodes (5): tracked, trackPid(), untrackPid(), RunningTranscode, spawnFfmpeg()

### Community 30 - "Metadata Package Manifest"
Cohesion: 0.22
Nodes (8): exports, name, private, scripts, build, typecheck, type, version

### Community 31 - "Filename Parsers"
Cohesion: 0.47
Nodes (5): parseAnime(), cleanTitle(), parseScene(), yearOf(), ParsedFilename

### Community 32 - "API Admin Routes"
Cohesion: 0.32
Nodes (7): connection, __dirname, JOB_STATES, JobState, queueOrNotFound(), queues, registerAdminRoutes()

### Community 33 - "API TSConfig"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, extends, include, src, ../../tsconfig.base.json

### Community 34 - "Worker TSConfig"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, extends, include, src, ../../tsconfig.base.json

### Community 35 - "Evidence & Anime Profile Concepts"
Cohesion: 0.29
Nodes (8): Confidence is derived from Evidence, never authored, AniList (metadata provider), Anime as ContentProfile, not MediaKind, Collections — movies inside series, Evidence — the confidence engine, Kodi (prior art / NFO standard), Seanime (prior art), Wikidata (ID bridge)

### Community 36 - "Contract TSConfig"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, extends, include, src, ../../tsconfig.base.json

### Community 37 - "FFmpeg TSConfig"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, extends, include, src, ../../tsconfig.base.json

### Community 38 - "Font Build Script"
Cohesion: 0.32
Nodes (7): buildWordmark(), copyFontsourceFiles(), main(), root, SUBSETS, vendorDir, WEIGHTS

### Community 39 - "Metadata TSConfig"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, extends, include, src, ../../tsconfig.base.json

### Community 40 - "Providers TSConfig"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, extends, include, src, ../../tsconfig.base.json

### Community 41 - "Queue TSConfig"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, extends, include, src, ../../tsconfig.base.json

### Community 42 - "Scanner TSConfig"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, extends, include, src, ../../tsconfig.base.json

### Community 43 - "Theme TSConfig"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, extends, include, src, ../../tsconfig.base.json

### Community 44 - "License Firewall Boundary"
Cohesion: 0.48
Nodes (7): packages/metadata contains interfaces only (license firewall), anime-offline-database (AGPL dataset), Fribb/anime-lists (episode_offset dataset), IMDb datasets, License firewall, TVmaze (metadata provider), packages-optional runtime-fetched adapter boundary

### Community 45 - "OpenAPI Generation"
Cohesion: 0.53
Nodes (3): doc, HealthResponse, buildOpenApiDocument()

### Community 46 - "HLS Segment Building"
Cohesion: 0.40
Nodes (4): buildFfmpegArgs(), escapeFilterPath(), SegmentJobInput, TONE_MAP_FILTERS

### Community 47 - "Admin Queue UI"
Cohesion: 0.50
Nodes (5): api() — admin fetch wrapper, render() — admin queue page renderer, Admin queue UI, hwaccel.transcoding.yml overlay, Immich (prior art)

### Community 48 - "Vendored Font Seeding"
Cohesion: 0.67
Nodes (3): fontStoreDir(), seedVendoredFonts(), VENDORED_FONTS

### Community 49 - "Docker Compose Bind Mounts"
Cohesion: 0.83
Nodes (4): Bind mounts only, no named volumes, docker-compose: hokago (API) service, docker-compose: postgres service, docker-compose: valkey service

## Knowledge Gaps
- **402 isolated node(s):** `CLAUDE.md — hokago project constitution`, `packages/db/prisma/schema.prisma — the data model`, `packages/theme/src/tokens.ts — the token contract`, `hokago (README title)`, `name` (+397 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **30 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `@prisma/client` connect `Presence & Watch State` to `Scanner Ingest & Metadata Pipeline`, `API Auth`?**
  _High betweenness centrality (0.058) - this node is a cross-community bridge._
- **Why does `syncEvidenceAndConfidence()` connect `Scanner Ingest & Metadata Pipeline` to `Presence & Watch State`?**
  _High betweenness centrality (0.047) - this node is a cross-community bridge._
- **Why does `registerAuthRoutes()` connect `API Auth` to `API Core Routes`, `Presence & Watch State`?**
  _High betweenness centrality (0.022) - this node is a cross-community bridge._
- **What connects `CLAUDE.md — hokago project constitution`, `packages/db/prisma/schema.prisma — the data model`, `packages/theme/src/tokens.ts — the token contract` to the rest of the system?**
  _402 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Scanner Ingest & Metadata Pipeline` be split into smaller, more focused modules?**
  _Cohesion score 0.05289193302891933 - nodes in this community are weakly interconnected._
- **Should `Artwork & Media Probe` be split into smaller, more focused modules?**
  _Cohesion score 0.07003367003367003 - nodes in this community are weakly interconnected._
- **Should `Metadata Provider Clients` be split into smaller, more focused modules?**
  _Cohesion score 0.08677098150782361 - nodes in this community are weakly interconnected._