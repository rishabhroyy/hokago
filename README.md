# hokago

Self-hosted media server for movies, TV and anime — keyless metadata (TVmaze, AniList, Jikan),
hardware-accelerated transcoding, watch parties, downloads. One container serves the API and
the built web app; a second container owns all ffmpeg work. No API key, no email, no cloud —
just your files and a Docker daemon.

## Quick start

Requirements: Docker Engine 24+ (with compose v2), a `v*` release published to GHCR.
`glibc`-based Linux or Docker Desktop (macOS/Windows). The image ships for amd64 and arm64.

```sh
mkdir hokago && cd hokago
curl -o docker-compose.yml https://raw.githubusercontent.com/rishabhroyy/hokago/main/docker-compose.yml
# copy the env template only if you want to customize paths/port (optional):
curl -o .env https://raw.githubusercontent.com/rishabhroyy/hokago/main/.env.example
docker compose up -d
```

Open `http://localhost:3000` and run the setup wizard (first admin + libraries).
Library roots are the fixed container paths `/media/movies`, `/media/tv`, `/media/anime` —
whatever host folders `MEDIA_*_PATH` point at are mounted there read-only. More libraries?
Add a mount line like the ones in `docker-compose.yml` and enter its target path in the wizard.

Upgrades: `docker compose pull && docker compose up -d`. Pin `HOKAGO_VERSION=v0.1.0` in `.env`
to stay on a specific release; omitting it follows `latest`. Defaults:

| Service | Image |
| --- | --- |
| `hokago` / `hokago-worker` | `ghcr.io/rishabhroyy/hokago:${HOKAGO_VERSION:-latest}` |
| `postgres` | `postgres:17-bookworm` |
| `valkey` | `valkey/valkey:8-bookworm` |

No `.env` is required to boot — every value has a compose default (config lands in
`./data/config` next to the compose file, media in `./data/media/*`). The signing
secret is auto-generated on first boot and persisted, so a fresh install never
runs a known default and never asks you to generate one (set `HOKAGO_JWT_SECRET`
only to pin your own).

## Hardware acceleration

One extra `-f` overlay, no rebuild (the image carries the userspace drivers):

```sh
# Intel/AMD (VAAPI/QSV) — mounts /dev/dri
docker compose -f docker-compose.yml -f infra/hwaccel.transcoding.yml up -d
# NVIDIA (NVENC) — needs nvidia-container-toolkit on the host
docker compose -f docker-compose.yml -f infra/hwaccel.nvenc.yml up -d
```

`HOKAGO_HWACCEL=auto` (default in the overlays) picks qsv/vaapi/nvenc from what it finds.
A missing/broken device falls back to CPU automatically — playback always works.

## Versioning & clients

`/health` (unauthenticated) reports the exact tag running:

```sh
curl http://localhost:3000/health
# {"status":"ok","version":"v0.1.0"}
```

Native clients probe it before talking to the typed API, the way immich clients check
`/api/server/version` — see `docs/native-clients.md`. The admin dashboard sidebar shows the
same version.

## Data & backup

Everything lives under `HOKAGO_CONFIG_DIR` (default `./data/config`): postgres data, artwork,
fonts, cache. Backups (postgres dump + whole config dir) via `scripts/backup.sh`; the API also snapshots
the DB before every migration. The media mounts are read-only — your library files are never
touched.

## Development

See `AGENTS.md`. Short version: pnpm workspace, API/worker run in containers (`pnpm docker:dev`,
web on the host via `pnpm dev:web`), the base compose being image-pure means local builds go
through the `compose.build.yml` overlay.