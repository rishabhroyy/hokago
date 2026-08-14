<p align="center">
  <a href="https://github.com/rishabhroyy/hokago"><img src="https://img.shields.io/github/stars/rishabhroyy/hokago?style=for-the-badge&label=Stars&color=2E9BC4&labelColor=ececec" alt="GitHub stars"></a>
  <a href="https://github.com/rishabhroyy/hokago/releases"><img src="https://img.shields.io/github/v/release/rishabhroyy/hokago?style=for-the-badge&label=Release&color=2E9BC4&labelColor=ececec" alt="Latest release"></a>
  <a href="https://github.com/rishabhroyy/hokago/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/rishabhroyy/hokago/ci.yml?style=for-the-badge&label=CI&color=2E9BC4&labelColor=ececec" alt="CI status"></a>
</p>

<p align="center">
  <img src="apps/web/src/assets/logo.svg" width="140" alt="hokago logo — a cat-eared bust with red bows" />
</p>

<h3 align="center">self-hosted media server with a heart for anime</h3>
<p align="center">movies, TV and anime — streamed, scrubbed and shared from your own hardware. no API key, no email, no cloud.</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#features">Features</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#hardware-acceleration">Hardware acceleration</a> ·
  <a href="#data--backup">Data & backup</a> ·
  <a href="#contributors">Contributors</a>
</p>

> [!NOTE]
> hokago is pre-1.0 — it works today, but treat it as a living project. `latest` tracks the newest release; pin `HOKAGO_VERSION` if you want to stay put.

## Requirements

- Docker Engine 24+ with compose v2 (or Docker Desktop on macOS / Windows)
- 2 GB RAM, and a few CPU cores for transcoding
- A local POSIX filesystem for the config dir — not NFS/SMB/exFAT
- amd64 (hardware acceleration enabled) or arm64 (CPU-only)

## Quick Start

No env file required — everything lives in the compose template itself, with a visible default on every value:

```bash
wget -O docker-compose.yml https://raw.githubusercontent.com/rishabhroyy/hokago/main/docker-compose.yml
docker compose up -d
```

Open `http://localhost:3000` and run the one-minute setup wizard: admin account, then point hokago at your media. Want different paths or a port? Edit them right in `docker-compose.yml` — each value reads `<NAME>: ${VAR:-default}`, so the defaults are right there in the file.

> [!TIP]
> Library roots are the fixed container paths `/media/movies`, `/media/tv`, `/media/anime` — the wizard records those, whatever host folders the `MEDIA_*_PATH` envs bind there. More than three libraries? Add a mount line like the ones in the template and enter its target path in the wizard.

### Upgrading

```bash
docker compose pull && docker compose up -d
```

The API snapshots the database before every migration, so any upgrade is reversible in place. Still on the image you first installed? `docker compose ps` shows the tag.

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
| Offline downloads — API + worker live; UI lands with the mobile/desktop/TV apps | — | — | coming |

## Configuration

Every value is an inline `${VAR:-default}` in `docker-compose.yml` — edit the file directly. The keys at a glance:

| Variable | Purpose | Default |
| :---------------------- | :------------------------------------------------ | :---------------------- |
| `HOKAGO_CONFIG_DIR` | host dir for all persistent state (db, artwork, fonts, downloads) | `./data/config` |
| `MEDIA_MOVIES_PATH` | host folder → `/media/movies` | `./data/media/movies` |
| `MEDIA_TV_PATH` | host folder → `/media/tv` | `./data/media/tv` |
| `MEDIA_ANIME_PATH` | host folder → `/media/anime` | `./data/media/anime` |
| `HOKAGO_PORT` | web port | `3000` |
| `HOKAGO_VERSION` | image tag to run | `latest` |
| `POSTGRES_PASSWORD` | change it on anything reachable | `hokago` |
| `TZ` | timezone | `UTC` |

`HOKAGO_JWT_SECRET` never needs setting: the first boot generates a random signing key and stores it in the database. Set it only to pin your own (required for multiple API replicas).

The template also publishes `5432` (postgres) and `6379` (valkey) for host-side admin tooling — safe to remove from `docker-compose.yml` on a locked-down deploy, nothing internal needs them.

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

The admin dashboard sidebar shows the same version, and the upcoming native apps probe it before talking to the typed API — the same compatibility dance immich clients do with `/api/server/version`. The shell architecture is sketched in [`docs/native-clients.md`](docs/native-clients.md).

## Data & backup

Everything persistent lives in the config dir — **bind mounts only, zero docker volumes**: postgres data, valkey cache, artwork, fonts, downloads. Media folders are mounted read-only and never touched. All of it in `./data/config` by default, all of it survives `docker compose down`.

```bash
./scripts/backup.sh        # postgres dump + whole config dir
```

Done with it? `docker compose down` stops everything; delete the config dir and it's a clean slate — your media is untouched either way.

## Star history

<a href="https://star-history.com/#rishabhroyy/hokago&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=rishabhroyy/hokago&type=Date&theme=dark" />
    <img alt="Star history chart" src="https://api.star-history.com/svg?repos=rishabhroyy/hokago&type=Date" />
  </picture>
</a>

## Contributors

<a href="https://github.com/rishabhroyy/hokago/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=rishabhroyy/hokago" width="480" alt="hokago contributors" />
</a>