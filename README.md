<br/>

<p align="center">
  <img src="apps/web/src/assets/logo.svg" width="180" alt="hokago — cat ears logo">
</p>

<h1 align="center">hokago</h1>

<p align="center">
  <b>放課後</b> — <i>noun.</i> japanese for "after school".<br/>
  that time of day when the bell rings, the shoes come off,<br/>
  and the only plan left is to watch something good.
</p>

<p align="center">
  <a href="https://github.com/rishabhroyy/hokago/pkgs/container/hokago"><img src="https://img.shields.io/badge/image-ghcr.io%2Frishabhroyy%2Fhokago-E8664F?style=for-the-badge&logo=docker&logoColor=white&labelColor=EFE7D8" alt="docker image"></a>
  <a href="https://github.com/rishabhroyy/hokago/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/rishabhroyy/hokago/release.yml?style=for-the-badge&label=release&labelColor=EFE7D8&color=4FB8E0" alt="release"></a>
  <img src="https://img.shields.io/badge/moe-100%25-E3A34C?style=for-the-badge&labelColor=EFE7D8" alt="certified moe">
</p>

<br/>

<p align="center">
  a cozy, self-hosted home for your <b>movies</b>, <b>shows</b>, and <b>anime</b>.<br/>
  point it at your folders, and it does the rest — posters, subtitles, transcodes,<br/>
  the works — wrapped in the cutest little wii-channel you ever did see.
</p>

<!-- screenshots go here! capture: home screen, detail page, player with subs, dark mode -->

<br/>

## why hokago?

- **anime is a first-class citizen, not an afterthought.** real episode parsing (yes, even `Show.Name.S02E03.1080p.BluRay.FLAC2.0.x264-Group.mkv`), matching against AniList, Jikan, MAL and TVmaze — and it knows that "Frieren" is the same show as "Frieren: Beyond Journey's End".
- **no api keys. ever.** nothing to sign up for, nothing to paste into a settings page, nothing that breaks when a free tier dies. keyless providers and your local files only.
- **works with the internet off.** metadata is enrichment, not a dependency. every provider on earth going down is a non-event — your library still scans, imports, and plays.
- **fansub-grade subtitles.** ASS/SSA rendered properly with JASSUB, with the actual fonts extracted from your files and served alongside. your typesetting and karaoke effects survive.
- **plays everything, the cheap way first.** direct play when possible, a fast copy-remux for HEVC-in-MKV, and full HLS transcoding only when it has to — with VAAPI, QSV, and NVENC hardware acceleration.
- **scrub previews** — hover the seek bar and see where you're going, like a dvd chapter menu but cuter.
- **watch parties.** one code, friends pile in, everyone plays and pauses together.
- **continue watching, everywhere.** pick up on the tv exactly where you left off in bed. pair a tv with a 6-digit code — no typing passwords with a remote.
- **your server, your rules.** invite-code accounts, no email, no telemetry, no cloud. everything is served from your own origin — even the fonts.

## get it running

it's one compose file — the image is pre-built and published, so there's nothing to compile. three little steps:

**1. grab the compose file**

```sh
mkdir hokago && cd hokago
curl -O https://raw.githubusercontent.com/rishabhroyy/hokago/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/rishabhroyy/hokago/main/example.env
```

**2. tell it where your shows live**

the compose file reads everything from `.env`, so copy the example into place — plain `KEY=value` lines with comments, no yaml in sight. (this step is required — `docker compose up` refuses to start without the file):

```sh
cp example.env .env
```

find the three `MEDIA_*` lines and point them at your real folders:

```env
MEDIA_MOVIES_PATH=/mnt/storage/movies
MEDIA_TV_PATH=/mnt/storage/tv
MEDIA_ANIME_PATH=/mnt/storage/anime
```

every other line can stay as-is — port, config dir, gpu and proxy knobs are all in there with short explanations. (skip the edits entirely and it runs on `./data/media/*` next to the compose file — fine for a test drive.) want more than three libraries, or know your way around compose? you can also edit `docker-compose.yml` itself — the yaml just turns the `.env` lines into real mounts and settings.

**3. wake it up**

```sh
docker compose up -d
```

then open **http://localhost:3000** — the setup wizard walks you through your admin account and libraries (pick the `/media/...` paths from step 2). about two minutes, start to finish.

got a gpu? **intel/amd: nothing to do** — the containers already get `/dev/dri` and auto-detect it at boot. nvidia: install `nvidia-container-toolkit` on the host, then uncomment the `gpus: all` line in both services of the compose file. no extra files, no rebuild, and a missing or grumpy gpu quietly falls back to cpu.

behind nginx, caddy, or another reverse proxy? add `HOKAGO_TRUST_PROXY=true` to your `.env` (it's in `example.env`, commented out) so login rate-limiting sees real client IPs instead of your proxy's. proxies must forward websocket `Upgrade` headers for watch parties and keep `Range` + `COOP`/`COEP` headers for streaming — caddy does both by default, nginx needs a couple of `proxy_set_header` lines (see [`AGENTS.md`](AGENTS.md)).

updates are `docker compose pull && docker compose up -d`. hokago snapshots your database before every migration, so an update is never a one-way door.

## the little things

- **dark mode** — warm espresso, not cold blue. one toggle, remembered forever.
- **profiles with avatars** for everyone in the house.
- **backups in one command** — database plus every poster and font, into one folder.
- **an admin console** that shows you exactly what the worker bees are doing, queue by queue.
- **lowercase everything**, as is tradition.

## a little disclosure

built with a lot of AI pair-programming — every line still read, tested, and shipped by a human. ♡

## contributing

pull requests welcome. a few house rules live in [`AGENTS.md`](AGENTS.md) — the short version: small commits, lowercase hokago, and no, it will never do music.

<br/>

<p align="center">
  <sub>made with love, for the 3pm-to-3am crowd ♡</sub><br/>
  <sub>nyaa~</sub>
</p>
