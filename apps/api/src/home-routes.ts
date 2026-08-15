import { createHash } from "node:crypto";
import { PrismaClient } from "@hokago/db";
import { HomeQuery, HomeResponse, HomeRow, HomeSlide } from "@hokago/contract/home";
import type { MediaCard } from "@hokago/contract/browse";
import type { ContinueWatchingEntry } from "@hokago/contract/playback";
import type { ZodFastifyInstance } from "./fastify-zod.js";
import { loadContinueWatching } from "./continue-watching.js";
import { primaryArtworkUrl, type ArtworkRef } from "./artwork.js";

const db = new PrismaClient();

const ANILIST_URL = process.env.HOKAGO_ANILIST_BASE_URL ?? "https://graphql.anilist.co";

const cardSelect = {
  id: true,
  kind: true,
  title: true,
  sortTitle: true,
  year: true,
  genres: true,
  createdAt: true,
  artwork: { select: { id: true, kind: true, priority: true } },
  files: { select: { id: true }, take: 1 },
  _count: { select: { children: true } },
} as const;

function toCard<
  T extends {
    kind: string;
    title: string;
    artwork: ArtworkRef[];
    files: { id: string }[];
    _count: { children: number };
  },
>(
  item: T,
): Omit<T, "artwork" | "files" | "_count"> & {
  posterUrl: string | null;
  backdropUrl: string | null;
  mediaFileId: string | null;
  isDownloaded: boolean;
} {
  const { artwork, files, _count, ...rest } = item;
  return {
    ...rest,
    posterUrl: primaryArtworkUrl(artwork, "POSTER"),
    backdropUrl: primaryArtworkUrl(artwork, "BACKDROP"),
    mediaFileId: files[0]?.id ?? null,
    isDownloaded: item.kind === "SERIES" ? _count.children > 0 : files.length > 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// External artwork — provider bytes fetched server-side, served from OUR origin
// (the JASSUB/COOP-COEP invariant: nothing hotlinked, ever). The season/schedule
// fetches register the source URLs; /external-artwork/:hash lazily fetches +
// caches the bytes in memory and streams them back.
// ─────────────────────────────────────────────────────────────────────────────

const urlByHash = new Map<string, string>();
const artCache = new Map<string, { bytes: Buffer; type: string; at: number }>();
const MAX_ART_ENTRIES = 128;

function artHash(url: string): string {
  return createHash("sha1").update(url).digest("hex").slice(0, 24);
}

/** Register a provider artwork URL and return its our-origin path suffix. */
function registerExternalArt(url: string): string {
  const hash = artHash(url);
  if (!urlByHash.has(hash)) urlByHash.set(hash, url);
  return hash;
}

async function fetchExternalArt(hash: string): Promise<{ bytes: Buffer; type: string } | null> {
  const url = urlByHash.get(hash);
  if (!url) return null;
  const hit = artCache.get(hash);
  if (hit) return { bytes: hit.bytes, type: hit.type };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get("content-type") ?? "image/jpeg";
    if (artCache.size >= MAX_ART_ENTRIES) {
      const oldest = artCache.keys().next().value;
      if (oldest) artCache.delete(oldest);
    }
    artCache.set(hash, { bytes, type, at: Date.now() });
    return { bytes, type };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider discovery (keyless, TTL-cached, degrade-to-local)
// ─────────────────────────────────────────────────────────────────────────────

const ANIME_SEASON_QUERY = `
query ($season: MediaSeason, $seasonYear: Int) {
  Page(page: 1, perPage: 30) {
    media(season: $season, seasonYear: $seasonYear, type: ANIME, sort: POPULARITY_DESC) {
      id
      title { romaji english }
      startDate { year }
      bannerImage
      coverImage { extraLarge }
      genres
    }
  }
}`;

interface AnimeSeasonEntry {
  title: string;
  year: number | null;
  banner: string | null;
  cover: string | null;
  genres: string[];
}

/** Anime broadcast quarter. Jan–Mar = WINTER … Oct–Dec = FALL. */
function seasonQuarter(now: Date): { season: string; year: number } {
  const month = now.getMonth();
  const year = now.getFullYear();
  const season = month < 3 ? "WINTER" : month < 6 ? "SPRING" : month < 9 ? "SUMMER" : "FALL";
  return { season, year };
}

/**
 * This anime season's slate (Summer 2026 right now) — the "outside world"
 * hero content. One bulk GraphQL call, cached 6h — polite to AniList's
 * 30/min budget.
 */
async function fetchAnimeSeason(): Promise<AnimeSeasonEntry[] | null> {
  const { season, year } = seasonQuarter(new Date());
  const res = await fetch(ANILIST_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query: ANIME_SEASON_QUERY, variables: { season, seasonYear: year } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`AniList season failed: ${res.status} ${res.statusText}`);

  const body = (await res.json()) as {
    data?: {
      Page?: {
        media?: {
          title: { romaji: string | null; english: string | null } | null;
          startDate: { year: number | null } | null;
          bannerImage: string | null;
          coverImage: { extraLarge: string | null } | null;
          genres: string[] | null;
        }[];
      };
    };
  };
  return (body.data?.Page?.media ?? [])
    .map((m) => ({
      title: m.title?.romaji ?? m.title?.english ?? "",
      year: m.startDate?.year ?? null,
      banner: m.bannerImage ?? null,
      cover: m.coverImage?.extraLarge ?? null,
      genres: m.genres ?? [],
    }))
    .filter((e) => e.title.length > 0);
}

// In-memory TTL cache. Failures are negatively cached (~30 min) so a flaky
// upstream can't be hammered by every home load, and stale entries are served
// through a failure instead of dropping the whole surface to zero.
const providerCache = new Map<string, { value: unknown; at: number }>();
const FAILURE_TTL_MS = 30 * 60_000;

async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T | null>): Promise<T | null> {
  const hit = providerCache.get(key) as { value: T | null; at: number } | undefined;
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  try {
    const value = await fn();
    providerCache.set(key, { value, at: Date.now() });
    return value;
  } catch (err) {
    console.warn(`home discovery: ${key} unavailable, falling back to local content`, err);
    if (hit) {
      hit.at = Date.now() - (ttlMs - FAILURE_TTL_MS); // serve stale, retry in ~30 min
      return hit.value;
    }
    providerCache.set(key, { value: null, at: Date.now() - (ttlMs - FAILURE_TTL_MS) });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hero carousel assembly
// ─────────────────────────────────────────────────────────────────────────────

function kindSub(kind: string): string {
  return kind === "MOVIE" ? "Movie" : kind === "SEASON" ? "Season" : "Series";
}

/** Series title for a continuing EPISODE — the carousel shows the show name, not the episode name. */
async function seriesTitleFor(mediaItemId: string): Promise<string | null> {
  const item = await db.mediaItem.findUnique({
    where: { id: mediaItemId },
    select: { kind: true, parent: { select: { title: true, parent: { select: { title: true } } } } },
  });
  return item?.parent?.parent?.title ?? item?.parent?.title ?? null;
}

interface SlideSource {
  key: string;
  slide: HomeSlide;
}

async function buildSlides(args: {
  continueWatching: ContinueWatchingEntry[];
  season: AnimeSeasonEntry[];
  recentlyAdded: MediaCard[];
}): Promise<HomeSlide[]> {
  const { continueWatching, season, recentlyAdded } = args;
  const continueSources: SlideSource[] = [];
  const seen = new Set<string>();

  for (const entry of continueWatching.slice(0, 3)) {
    const item = entry.mediaItem;
    const showTitle = item.kind === "EPISODE" ? await seriesTitleFor(item.id) : null;
    const ep = item.kind === "EPISODE" && item.seasonNumber != null && item.episodeNumber != null;
    const progress = !entry.upNext && entry.durationMs != null && entry.durationMs > 0 ? entry.positionMs / entry.durationMs : null;
    const timeLeft =
      !entry.upNext && entry.durationMs != null && entry.durationMs > 0
        ? `${Math.max(1, Math.round((entry.durationMs - entry.positionMs) / 60_000))} min left`
        : null;
    continueSources.push({
      key: item.id,
      slide: {
        kind: "CONTINUE",
        label: entry.upNext ? "Up next" : "Continue watching",
        title: showTitle ?? item.title,
        sub: ep ? `S${item.seasonNumber} · E${item.episodeNumber} · ${item.title}` : kindSub(item.kind),
        year: item.year,
        posterUrl: item.posterUrl,
        backdropUrl: item.backdropUrl,
        progress,
        timeLeftLabel: timeLeft,
        detailId: entry.detailItemId,
        mediaItemId: item.id,
        mediaFileId: item.mediaFileId,
      },
    });
    seen.add(item.id);
  }

  const seasonSlides: SlideSource[] = season.slice(0, 6).map((s) => ({
    key: `ext:${s.title}`,
    slide: {
      kind: "THIS_SEASON",
      label: "This season",
      title: s.title,
      sub: s.genres.slice(0, 2).join(" · ") || null,
      year: s.year,
      posterUrl: s.cover ? `/external-artwork/${registerExternalArt(s.cover)}` : null,
      backdropUrl: s.banner ? `/external-artwork/${registerExternalArt(s.banner)}` : null,
      progress: null,
      timeLeftLabel: null,
      detailId: null,
      mediaItemId: null,
      mediaFileId: null,
    },
  }));

  const recentSlides: SlideSource[] = recentlyAdded.slice(0, 3).map((card) => ({
    key: card.id,
    slide: {
      kind: "RECENTLY_ADDED",
      label: "Recently added",
      title: card.title,
      sub: kindSub(card.kind),
      year: card.year,
      posterUrl: card.posterUrl,
      backdropUrl: card.backdropUrl,
      progress: null,
      timeLeftLabel: null,
      detailId: card.id,
      mediaItemId: card.id,
      mediaFileId: card.mediaFileId,
    },
  }));

  // Continue-watching first, then the outside-world + local pools interleaved
  // round-robin, deduped, capped at 8.
  const slides: HomeSlide[] = continueSources.map((s) => s.slide);
  const pools = [seasonSlides, recentSlides].filter((p) => p.length > 0);
  let i = 0;
  while (slides.length < 8) {
    let added = false;
    for (const pool of pools) {
      const source = pool[i];
      if (source && !seen.has(source.key)) {
        slides.push(source.slide);
        seen.add(source.key);
        added = true;
        if (slides.length >= 8) break;
      }
    }
    if (!added) break;
    i += 1;
  }
  return slides;
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembly
// ─────────────────────────────────────────────────────────────────────────────

async function buildHome(profileId: string | null): Promise<HomeResponse> {
  const libraries = await db.library.findMany({
    where: { enabled: true },
    select: { id: true, contentProfile: true },
  });
  const hasAnime = libraries.some((l) => l.contentProfile === "ANIME");

  const items = await db.mediaItem.findMany({
    where: { parentId: null, kind: { in: ["MOVIE", "SERIES"] }, library: { enabled: true, hiddenFromHome: false } },
    select: cardSelect,
  });
  const cards: MediaCard[] = items.map(toCard);
  const cardById = new Map(cards.map((c) => [c.id, c]));

  const continueWatching = profileId ? await loadContinueWatching(db, profileId) : [];

  // The outside world — only this anime season, and only when the instance
  // has an anime library. Regular TV is intentionally excluded (out of touch).
  const season = hasAnime ? (await cached("anime-season", 6 * 60 * 60 * 1000, fetchAnimeSeason)) ?? [] : [];

  const recentlyAdded = [...cards].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 18);
  const slides = await buildSlides({ continueWatching, season, recentlyAdded });

  const rows: HomeRow[] = [];
  if (recentlyAdded.length > 0) rows.push({ id: "recently-added", title: "Recently added", subtitle: null, items: recentlyAdded });

  // Genre rails from the whole catalog, ranked by how full they are.
  const byGenre = new Map<string, MediaCard[]>();
  for (const item of items) {
    const card = cardById.get(item.id);
    if (!card) continue;
    for (const g of item.genres) {
      const list = byGenre.get(g);
      if (list) list.push(card);
      else byGenre.set(g, [card]);
    }
  }
  for (const [genre, genreItems] of [...byGenre.entries()]
    .filter(([, list]) => list.length >= 3)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 6)) {
    rows.push({ id: `genre:${genre}`, title: genre, subtitle: null, items: genreItems });
  }

  return { continueWatching, slides, rows };
}

/** /home — the hero carousel (outside world + local) and rails, with local fallback. */
export async function registerHomeRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get(
    "/home",
    { preHandler: app.authenticate, schema: { querystring: HomeQuery, response: { 200: HomeResponse } } },
    async (req) => {
      // Continue-watching is per-profile — only honor a profile this account owns.
      let ownedId: string | null = null;
      if (req.query.profileId) {
        const owned = await db.profile.findFirst({
          where: { id: req.query.profileId, accountId: req.accountId },
          select: { id: true },
        });
        if (owned) ownedId = owned.id;
      }
      return buildHome(ownedId);
    },
  );

  // External hero artwork — bytes fetched server-side from the keyless
  // providers, cached in memory, served from our origin (never hotlinked).
  app.get<{ Params: { hash: string } }>("/external-artwork/:hash", async (req, reply) => {
    const art = await fetchExternalArt(req.params.hash);
    if (!art) return reply.code(404).send({ error: "artwork not found" });
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    reply.header("Cache-Control", "public, max-age=86400");
    reply.type(art.type);
    return reply.send(art.bytes);
  });
}
