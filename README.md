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

it's one compose file. the image is pre-built and published, so there's nothing to compile:

```sh
curl -O https://raw.githubusercontent.com/rishabhroyy/hokago/main/docker-compose.yml
docker compose up -d
```

then open **http://localhost:3000** and the setup wizard will walk you through making your admin account and pointing at your media folders. the whole thing takes about two minutes.

edit the compose file to tell it where your stuff lives:

```yaml
# one read-only mount per library — the wizard remembers these container paths
- /mnt/storage/movies:/media/movies:ro
- /mnt/storage/tv:/media/tv:ro
- /mnt/storage/anime:/media/anime:ro
```

got a gpu? hardware transcoding is one extra flag, no rebuild:

```sh
# intel / amd
docker compose -f docker-compose.yml -f infra/hwaccel.transcoding.yml up -d
# nvidia
docker compose -f docker-compose.yml -f infra/hwaccel.nvenc.yml up -d
```

updates are `docker compose pull && docker compose up -d`. hokago snapshots your database before every migration, so an update is never a one-way door.

## the little things

- **dark mode** — warm espresso, not cold blue. one toggle, remembered forever.
- **profiles with avatars** for everyone in the house.
- **backups in one command** — database plus every poster and font, into one folder.
- **an admin console** that shows you exactly what the worker bees are doing, queue by queue.
- **lowercase everything**, as is tradition.

## what's next

intro/outro skip, native phone and tv apps (the server side is already waiting for them), and more. hokago grows slowly and carefully — nothing ships until it's cute *and* correct.

## contributing

pull requests welcome. a few house rules live in [`AGENTS.md`](AGENTS.md) — the short version: small commits, lowercase hokago, and no, it will never do music.

<br/>

<p align="center">
  <sub>made with love, for the 3pm-to-3am crowd ♡</sub><br/>
  <sub>nyaa~</sub>
</p>
