<p align="center">
  <a href="https://github.com/rishabhroyy/hokago"><img src="https://img.shields.io/github/stars/rishabhroyy/hokago?style=for-the-badge&label=Stars&color=2E9BC4&labelColor=ececec" alt="GitHub stars"></a>
  <a href="https://github.com/rishabhroyy/hokago/releases"><img src="https://img.shields.io/github/v/release/rishabhroyy/hokago?style=for-the-badge&label=Release&color=2E9BC4&labelColor=ececec" alt="Latest release"></a>
  <a href="https://github.com/rishabhroyy/hokago/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/rishabhroyy/hokago/ci.yml?style=for-the-badge&label=CI&color=2E9BC4&labelColor=ececec" alt="CI status"></a>
</p>

<p align="center">
  <img src="apps/web/src/assets/logo.svg" width="150" alt="hokago logo — a cat-eared bust with red bows" />
</p>

<h3 align="center">self-hosted media server with a heart for anime</h3>
<p align="center">movies, TV and anime — streamed, scrubbed and shared from your own hardware. no API key, no email, no cloud.</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#features">Features</a> ·
  <a href="#hardware-acceleration">hwaccel</a> ·
  <a href="#versioning--clients">Versioning & clients</a> ·
  <a href="#data--backup">Backup</a> ·
  <a href="#development">Development</a>
</p>

> [!NOTE]
> hokago is still pre-1.0 — everything below works today, and the release pipeline is live. Pin a release tag once you like a version; `latest` always tracks the newest.

## Quick Start

Three commands, no env file required — the compose template pulls a published multi-arch image (amd64 with hardware acceleration, arm64 CPU) and every configurable value has a default:

```bash
# get the drop-in template
wget -O docker-compose.yml https://raw.githubusercontent.com/rishabhroyy/hokago/main/docker-compose.yml

# optional: customize media paths, port, timezone — not required to boot
wget -O .env https://raw.githubusercontent.com/rishabhroyy/hokago/main/.env.example

docker compose up -d
```

Open `http://localhost:3000` and run the one-minute setup wizard: admin account, then point hokago at your media.

> [!TIP]
> Library roots are the fixed container paths `/media/movies`, `/media/tv`, `/media/anime` — the wizard records those, whatever host folders the `MEDIA_*_PATH` envs bind there. More than three libraries? Add a mount line like the ones in the template and enter its target path in the wizard.

## Features

| Feature | Movies | TV | Anime |
| :------------------------------------------ | ------ | -- | ----- |
| Three-tier playback — direct, remux, transcode | ✓ | ✓ | ✓ |
| Hardware-accelerated encoding (VAAPI / QSV / NVENC), CPU fallback | ✓ | ✓ | ✓ |
| Keyless metadata — TVmaze · AniList · Jikan, nothing to configure | ✓ | ✓ | ✓ |
| Episode-accurate parsing (anitomy) with season → absolute mapping | — | ✓ | ✓ |
| AniList → MAL resolution chain | — | — | ✓ 🌸 |
| ASS / SRT / VTT subtitles with packaged fonts | ✓ | ✓ | ✓ |
| Trickplay scrubber (sprite-sheet previews) | ✓ | ✓ | ✓ |
| Watch parties over WebSocket | ✓ | ✓ | ✓ |
| Continue-watching, profiles, multiuser | ✓ | ✓ | ✓ |
| Collections, editable matches, admin console | ✓ | ✓ | ✓ |
| Offline downloads — API + worker live; UI lands with the shells | — | — | coming |

Movies can still lean on the anime chain (a movie in a general library doesn't lose AniList) — the profile just decides the default order.

## Hardware acceleration

The image carries the userspace drivers; acceleration is one extra `-f` overlay, no rebuild:

```bash
# Intel/AMD — VAAPI/QSV, mounts /dev/dri
docker compose -f docker-compose.yml -f infra/hwaccel.transcoding.yml up -d

# NVIDIA — NVENC, needs nvidia-container-toolkit on the host
docker compose -f docker-compose.yml -f infra/hwaccel.nvenc.yml up -d
```

`HOKAGO_HWACCEL=auto` picks qsv / vaapi / nvenc from what it finds; a missing or broken device falls back to CPU automatically — playback always works.

## Versioning & clients

`/health` is unauthenticated on purpose and reports the exact image tag:

```sh
curl http://localhost:3000/health   # {"status":"ok","version":"v0.1.0"}
```

Native clients probe it before talking to the typed API — the same compatibility dance immich clients do with `/api/server/version`. The admin dashboard sidebar shows the same version. Architecture for the shells (webview + bridges, one UI source) lives in [`docs/native-clients.md`](docs/native-clients.md).

## Data & backup

Everything persistent lives in the config dir (default `./data/config` beside the compose file) — **bind mounts only, zero docker volumes**: postgres data, valkey cache, artwork, fonts, downloads. Media folders are mounted read-only and never touched. The signing secret self-generates on first boot and persists in the DB — no setup step, no published default.

```bash
./scripts/backup.sh        # postgres dump + whole config dir
```

The API also snapshots the DB before every migration, so upgrades stay reversible in place.

## Development

pnpm workspace; API + worker run in containers with hot reload, the web app on the host with Vite HMR. The base compose is image-only for drop-ins — local builds go through the `compose.build.yml` overlay.

```bash
pnpm install && pnpm docker:dev   # containers: postgres, valkey, api :3000, worker
pnpm dev:web                      # host Vite server, proxies to the container API
```

Everything the contributors need to know (commands, invariants, build order) is [`AGENTS.md`](AGENTS.md).

## Star history

<a href="https://star-history.com/#rishabhroyy/hokago&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=rishabhroyy/hokago&type=date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=rishabhroyy/hokago&type=date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=rishabhroyy/hokago&type=date" width="100%" />
 </picture>
</a>

## Contributors

<a href="https://github.com/rishabhroyy/hokago/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=rishabhroyy/hokago" width="100%" />
</a>