import path from "node:path";
import { existsSync } from "node:fs";

import { Prisma, type PrismaClient, type LifecycleState, type TitleType } from "@hokago/db";
import type {
  EpisodeMetadata,
  MappingSource,
  MetadataArtworkCandidate,
  MetadataLifecycleState,
  MetadataMatch,
  MetadataProvider,
  MetadataQuery,
} from "@hokago/metadata";
import { findAcceptedMatch, normalizeTitle } from "@hokago/providers";

import {
  ARTWORK_SOURCE_PRIORITY,
  ANIME_MOVIE_CARVEOUT,
  DEFAULT_PROVIDER_ORDER,
  SELF_HEALING_CONFIDENCE_THRESHOLD,
  SELF_HEALING_RETRY_BACKOFF_MS,
} from "./constants.js";
import { storeBytes, upsertArtworkDescriptor } from "./artwork.js";
import { syncEvidenceAndConfidence, type EvidenceInput } from "./evidence.js";
import type { MetadataNeeded } from "./ingest.js";

/** Effective chain for this kind/profile: library override (or profile default), plus the always-tried anime carve-out for MOVIE (non-negotiable #15). */
export function buildProviderChain(
  kind: "MOVIE" | "SERIES",
  contentProfile: "GENERAL" | "ANIME",
  providerOrder: string[],
): string[] {
  const base = providerOrder.length > 0 ? providerOrder : DEFAULT_PROVIDER_ORDER[contentProfile]![kind];
  if (kind !== "MOVIE") return base;
  const extra = ANIME_MOVIE_CARVEOUT.filter((p) => !base.includes(p));
  return [...base, ...extra];
}

function ttlPolicyAndExpiry(lifecycleState: MetadataLifecycleState): { ttlPolicy: string; expiresAt: Date | null } {
  switch (lifecycleState) {
    case "ENDED":
      return { ttlPolicy: "infinite", expiresAt: null };
    case "ONGOING":
      return { ttlPolicy: "6h", expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000) };
    default: // UNKNOWN, UNRELEASED — retry-with-backoff surrogate
      return { ttlPolicy: "24h", expiresAt: new Date(Date.now() + SELF_HEALING_RETRY_BACKOFF_MS) };
  }
}

/**
 * Episode-title enrichments back off on a per-series stamp
 * (series.extra.titlesLastAttemptedAt), same cadence as the self-healing
 * sweeps. A failed episode fetch caches nothing, so without the stamp the
 * periodic metadata sweep would re-fetch the same dead source every pass
 * forever. TTL-expired cache rows are the designed refetch cadence and pass
 * through regardless — the stamp only gates rows that were never cached.
 */
async function titlesHealDue(db: PrismaClient, seriesId: string): Promise<boolean> {
  const series = await db.mediaItem.findUnique({ where: { id: seriesId }, select: { extra: true } });
  const stamp = (series?.extra as Record<string, unknown> | null)?.titlesLastAttemptedAt;
  const stampMs = typeof stamp === "string" ? Date.parse(stamp) : NaN;
  return Number.isNaN(stampMs) || Date.now() - stampMs >= SELF_HEALING_RETRY_BACKOFF_MS;
}

async function stampTitlesAttempt(db: PrismaClient, seriesId: string): Promise<void> {
  const series = await db.mediaItem.findUnique({ where: { id: seriesId }, select: { extra: true } });
  const extra = (series?.extra ?? {}) as Record<string, unknown>;
  await db.mediaItem.update({
    where: { id: seriesId },
    data: { extra: { ...extra, titlesLastAttemptedAt: new Date().toISOString() } as Prisma.InputJsonValue },
  });
}

/** Only ever declares the PROVIDER_MATCH domain, so this never prunes a local signal ingest.ts wrote (see ownedTypes doc on syncEvidenceAndConfidence). */
async function addProviderMatchEvidence(
  db: PrismaClient,
  mediaItemId: string,
  providerName: string,
  match: MetadataMatch,
): Promise<void> {
  const evidence: EvidenceInput[] = [
    {
      signalType: "PROVIDER_MATCH",
      source: providerName,
      value: { providerId: match.providerId, title: match.title, year: match.year ?? null },
    },
  ];
  await syncEvidenceAndConfidence(db, mediaItemId, evidence, ["PROVIDER_MATCH"]);
}

/** Title sync : each metadata run replaces all titles of a type it just fetched, per (mediaItemId, type). */
async function syncProviderTitles(db: PrismaClient, mediaItemId: string, match: MetadataMatch): Promise<void> {
  const titles = [{ type: "PRIMARY" as const, value: match.title }, ...(match.titles ?? [])];
  const byType = new Map<string, string[]>();
  for (const t of titles) {
    if (!byType.has(t.type)) byType.set(t.type, []);
    byType.get(t.type)!.push(t.value);
  }
  for (const [type, values] of byType) {
    await db.title.deleteMany({ where: { mediaItemId, type: type as TitleType } });
    await db.title.createMany({ data: values.map((value) => ({ mediaItemId, type: type as TitleType, value })) });
  }
}

/** Local data always outranks network providers — only fill descriptive fields still at their unset default. */
async function fillDescriptiveFields(db: PrismaClient, mediaItemId: string, match: MetadataMatch): Promise<void> {
  if (match.overview) {
    await db.mediaItem.updateMany({ where: { id: mediaItemId, overview: null }, data: { overview: match.overview } });
  }
  if (match.premieredAt) {
    await db.mediaItem.updateMany({
      where: { id: mediaItemId, premieredAt: null },
      data: { premieredAt: new Date(match.premieredAt) },
    });
  }
  if (match.originalTitle) {
    await db.mediaItem.updateMany({
      where: { id: mediaItemId, originalTitle: null },
      data: { originalTitle: match.originalTitle },
    });
  }
  if (match.genres && match.genres.length > 0) {
    await db.mediaItem.updateMany({
      where: { id: mediaItemId, genres: { isEmpty: true } },
      data: { genres: match.genres },
    });
  }
  if (match.rating != null) {
    await db.mediaItem.updateMany({ where: { id: mediaItemId, rating: null }, data: { rating: match.rating } });
  }
  if (match.studio) {
    await db.mediaItem.updateMany({ where: { id: mediaItemId, studio: null }, data: { studio: match.studio } });
  }
  if (match.lifecycleState) {
    await db.mediaItem.updateMany({
      where: { id: mediaItemId, lifecycleState: "UNKNOWN" },
      data: { lifecycleState: match.lifecycleState },
    });
  }
}

/** Fetched once, stored as bytes (non-negotiable #4), merged into the existing self-healing artwork slot . */
async function fetchAndStoreProviderArtwork(
  db: PrismaClient,
  mediaItemId: string,
  candidates: MetadataArtworkCandidate[] | undefined,
): Promise<void> {
  for (const candidate of candidates ?? []) {
    try {
      const res = await fetch(candidate.url);
      if (!res.ok) continue;
      const bytes = Buffer.from(await res.arrayBuffer());
      const ext = path.extname(new URL(candidate.url).pathname) || ".jpg";
      const { bytesPath, hash } = await storeBytes(bytes, ext);
      await upsertArtworkDescriptor(db, mediaItemId, {
        kind: candidate.kind,
        source: "PROVIDER",
        priority: ARTWORK_SOURCE_PRIORITY.PROVIDER!,
        bytesPath,
        hash,
        sizeBytes: bytes.length,
        meta: null,
      });
    } catch {
      // degrade, never error — one bad artwork URL must not fail the whole match
    }
  }
}

async function upsertMetadataCache(
  db: PrismaClient,
  providerName: string,
  match: MetadataMatch,
  lastModified: string | undefined,
): Promise<void> {
  const lifecycleState = match.lifecycleState ?? "UNKNOWN";
  const { ttlPolicy, expiresAt } = ttlPolicyAndExpiry(lifecycleState);
  await db.metadataCache.upsert({
    where: { provider_externalId: { provider: providerName, externalId: match.providerId } },
    create: {
      provider: providerName,
      externalId: match.providerId,
      payload: match as unknown as Prisma.InputJsonValue,
      lastModified: lastModified ?? null,
      ttlPolicy,
      lifecycleState,
      expiresAt,
    },
    update: {
      payload: match as unknown as Prisma.InputJsonValue,
      lastModified: lastModified ?? null,
      fetchedAt: new Date(),
      ttlPolicy,
      lifecycleState,
      expiresAt,
    },
  });
}

/**
 * self-healing for the "matched but low-confidence" case (the "never
 * matched at all" case already retries every scan via the `!existing` branch
 * below `resolveMetadataStep` — this closes the other half). Bypassing the
 * cache-freshness shortcut is only worth it when something suggests the match
 * could improve, never unconditionally on every scan (that would reintroduce
 * the unbounded-burst problem Step 3's backpressure work solved):
 *
 * - New local Evidence recorded since we last actually checked this provider
 *   → always worth a look (the "NFO appears, file renamed" case named in
 *) — this only fires when something on disk genuinely changed, not on
 *   every routine scan.
 * - Confidence still below SELF_HEALING_CONFIDENCE_THRESHOLD with no new
 *   evidence → still worth a periodic look (the provider's own data could
 *   have changed), but throttled to the same 24h retry-with-backoff cadence
 *   already used for UNKNOWN/UNRELEASED lifecycle TTLs, not every scan.
 */
async function dueForSelfHealing(db: PrismaClient, mediaItemId: string, lastResolvedAt: Date): Promise<boolean> {
  const [item, latestEvidence] = await Promise.all([
    db.mediaItem.findUnique({ where: { id: mediaItemId }, select: { confidence: true } }),
    db.evidence.findFirst({ where: { mediaItemId }, orderBy: { observedAt: "desc" }, select: { observedAt: true } }),
  ]);
  if (!item) return false;

  if (latestEvidence && latestEvidence.observedAt > lastResolvedAt) return true;

  const dueForBackoffRetry = Date.now() - lastResolvedAt.getTime() > SELF_HEALING_RETRY_BACKOFF_MS;
  // <= is deliberate: a bare PROVIDER_MATCH with zero local corroboration
  // computes to exactly the threshold, and that is precisely the case the
  // periodic re-check exists for (see the threshold's comment in constants).
  return item.confidence <= SELF_HEALING_CONFIDENCE_THRESHOLD && dueForBackoffRetry;
}

async function touchLastResolvedAt(db: PrismaClient, mediaItemId: string, providerName: string): Promise<void> {
  await db.externalId
    .update({
      where: { mediaItemId_provider: { mediaItemId, provider: providerName } },
      data: { lastResolvedAt: new Date() },
    })
    .catch(() => {});
}

/**
 * Re-runs episode-title enrichment for a single series with whatever
 * episode-capable external id it already has (the merged-source pass covers
 * every provider's list internally). Used by the refresh script; the normal
 * job path calls the private enrichEpisodeTitles directly.
 */
export async function enrichSeriesEpisodeTitles(
  db: PrismaClient,
  seriesId: string,
  providers: Record<string, MetadataProvider> = {},
): Promise<void> {
  const rows = await db.externalId.findMany({ where: { mediaItemId: seriesId } });
  const row = rows.find((r) => providers[r.provider]?.episodes) ?? rows[0];
  if (!row) return;
  const provider = providers[row.provider];
  if (!provider) return;
  await enrichEpisodeTitles(db, seriesId, row.provider, provider, row.providerId, providers);
}

async function refreshMetadataCacheExpiry(
  db: PrismaClient,
  providerName: string,
  externalId: string,
  lifecycleState: LifecycleState,
): Promise<void> {
  const { expiresAt } = ttlPolicyAndExpiry(lifecycleState);
  await db.metadataCache.update({
    where: { provider_externalId: { provider: providerName, externalId } },
    data: { fetchedAt: new Date(), expiresAt },
  });
}

/**
 * Episode-title enrichment, keyed by (seasonNumber, episodeNumber).
 *
 * The episode list rides inside the provider's own MetadataCache payload, so
 * it inherits the match's freshness/TTL policy — an ENDED series fetches its
 * episode list once, an ONGOING one re-fetches on the same cadence as its
 * show metadata. Local EPISODE items keep their filename-derived `title` as
 * the identity; the provider title lands in `extra.episodeTitle`, which the
 * browse API prefers for display. Degrade, never error: a provider episode
 * fetch failing must not fail the match that already succeeded.
 *
 * Source selection: the matched provider when it exposes `episodes`, else the
 * first OTHER provider this series has an ExternalId for AND that implements
 * `episodes` — an AniList-matched anime pulls its titles from MAL this way.
 * For matches made before `alternateIds` existed, ask the matched provider
 * for the alternate ids directly and persist them first.
 */
async function enrichEpisodeTitles(
  db: PrismaClient,
  seriesId: string,
  providerName: string,
  provider: MetadataProvider,
  providerId: string,
  providers: Record<string, MetadataProvider> = {},
): Promise<void> {
  try {
    // The per-series network backoff (see titlesHealDue) — read once, gates
    // every network fetch below: the primary episode list, the multi-cour
    // walk, and the TVMaze backfill.
    const retryDue = await titlesHealDue(db, seriesId);

    let source: { provider: MetadataProvider; providerName: string; providerId: string } | undefined =
      provider.episodes ? { provider, providerName, providerId } : undefined;
    if (!source) {
      // Prefer an episode-capable ExternalId this series already holds (an
      // AniList match persists its MAL alternate at match time) — zero
      // network. The alternateIds hop only fires for matches made before
      // `alternateIds` existed, i.e. when no MAL row exists yet; without
      // that skip it would re-question the AniList API on every sweep.
      let rows = await db.externalId.findMany({ where: { mediaItemId: seriesId } });
      let episodeCapable = rows.find((r) => providers[r.provider]?.episodes);
      if (!episodeCapable && provider.alternateIds) {
        const alternates = await provider.alternateIds(providerId);
        for (const alt of alternates) {
          await db.externalId
            .upsert({
              where: { mediaItemId_provider: { mediaItemId: seriesId, provider: alt.provider } },
              create: { mediaItemId: seriesId, provider: alt.provider, providerId: alt.id, confidence: 1 },
              update: { providerId: alt.id },
            })
            .catch(() => {});
        }
        rows = await db.externalId.findMany({ where: { mediaItemId: seriesId } });
        episodeCapable = rows.find((r) => providers[r.provider]?.episodes);
      }
      if (episodeCapable) {
        source = {
          provider: providers[episodeCapable.provider]!,
          providerName: episodeCapable.provider,
          providerId: episodeCapable.providerId,
        };
      }
    }
    if (!source) return;

    const cached = await db.metadataCache.findUnique({
      where: { provider_externalId: { provider: source.providerName, externalId: source.providerId } },
    });
    const fresh = cached !== null && (cached.expiresAt === null || cached.expiresAt > new Date());
    const cachedPayload = (cached?.payload ?? {}) as Record<string, unknown>;
    const cachedEpisodes = fresh ? cachedPayload.episodes : undefined;

    let episodes: EpisodeMetadata[] | undefined = Array.isArray(cachedEpisodes)
      ? (cachedEpisodes as EpisodeMetadata[])
      : undefined;
    if (!episodes) {
      const fetchEpisodes = source.provider.episodes;
      if (!fetchEpisodes) return;
      // Empty episode lists are never cached, and the source's own match row
      // rides in the same cache without an episode list — so a row lacking
      // one (or no row at all) is a never-succeeded fetch, and without the
      // stamp every metadata sweep would re-fetch the same dead source
      // forever. A brand-new series (no stamp) fetches immediately;
      // afterwards the stamp backs it off to the self-healing cadence. A
      // row THAT HAS a list but is TTL-expired is the designed refetch
      // cadence (ONGOING 6h) and passes through regardless.
      const rowHasList = Array.isArray((cached?.payload as Record<string, unknown> | null)?.episodes);
      if (!rowHasList) {
        if (!retryDue) return;
        await stampTitlesAttempt(db, seriesId);
      }
      episodes = await fetchEpisodes(source.providerId);
      // The enrichment row's TTL follows the series' own lifecycle, not the
      // matched provider's cache — an ONGOING anime keeps re-fetching its
      // episode list even though the match row is ANILIST's.
      const series = await db.mediaItem.findUnique({
        where: { id: seriesId },
        select: { lifecycleState: true },
      });
      const { ttlPolicy, expiresAt } = ttlPolicyAndExpiry(series?.lifecycleState ?? "UNKNOWN");
      const payload = { ...cachedPayload, episodes } as unknown as Prisma.InputJsonValue;
      if (episodes.length > 0) {
        await db.metadataCache.upsert({
          where: { provider_externalId: { provider: source.providerName, externalId: source.providerId } },
          create: { provider: source.providerName, externalId: source.providerId, payload, ttlPolicy, expiresAt },
          update: { payload, ttlPolicy, expiresAt },
        });
      }
    }

    // Split-season providers (MAL/Jikan expose one record per season) only
    // cover part of a multi-cour series — merge every episode-capable source
    // this series already has, and let the list with the broadest season
    // coverage win conflicts (e.g. TVMaze S1-S2 over MAL S1).
    const lists = [{ episodes, maxSeason: Math.max(0, ...episodes.map((e) => e.seasonNumber ?? 0)) }];
    const allRows = await db.externalId.findMany({ where: { mediaItemId: seriesId } });
    for (const row of allRows) {
      if (row.provider === source.providerName) continue;
      const candidate = providers[row.provider];
      if (!candidate?.episodes) continue;
      const cached = await db.metadataCache.findUnique({
        where: { provider_externalId: { provider: row.provider, externalId: row.providerId } },
      });
      if (!cached) continue;
      // Stale is fine for title enrichment — the cache TTL governs re-fetch
      // freshness of the *primary* source; supplementary lists only fill gaps.
      const payload = (cached.payload ?? {}) as Record<string, unknown>;
      const eps = payload.episodes;
      if (!Array.isArray(eps) || eps.length === 0) continue;
      lists.push({ episodes: eps as EpisodeMetadata[], maxSeason: Math.max(0, ...(eps as EpisodeMetadata[]).map((e) => e.seasonNumber ?? 0)) });
    }
    lists.sort((a, b) => b.maxSeason - a.maxSeason);
    const byKey = new Map<string, string>();
    for (const list of lists) {
      for (const ep of list.episodes) {
        if (ep.seasonNumber == null || ep.episodeNumber == null) continue;
        // Lists are sorted broadest-coverage first; first-write-wins so the
        // narrowest list (e.g. MAL's single-cour S1) can't clobber the
        // broadest (TVmaze S1-S2) on conflicts.
        const key = `${ep.seasonNumber}:${ep.episodeNumber}`;
        if (!byKey.has(key)) byKey.set(key, ep.title);
      }
    }
    // Rank-based index: provider and local numbering can disagree (absolute
    // vs season-relative), so keep per-season ordered title lists too — the
    // nth local episode maps to the nth provider episode. One list per
    // season (broadest first): concatenating every list's titles would read
    // into the *next* list's ep-1 title once a season outgrows the first
    // list's length — silently shifted titles.
    const titlesBySeason = new Map<number, string[]>();
    for (const list of lists) {
      const bySeasonPairs = new Map<number, { n: number; title: string }[]>();
      for (const ep of list.episodes) {
        if (ep.seasonNumber == null || ep.episodeNumber == null) continue;
        const arr = bySeasonPairs.get(ep.seasonNumber) ?? [];
        arr.push({ n: ep.episodeNumber, title: ep.title });
        bySeasonPairs.set(ep.seasonNumber, arr);
      }
      for (const [season, pairs] of bySeasonPairs) {
        if (titlesBySeason.has(season)) continue;
        titlesBySeason.set(season, pairs.sort((a, b) => a.n - b.n).map((p) => p.title));
      }
    }
    const locals = await db.mediaItem.findMany({
      where: {
        kind: "EPISODE",
        OR: [{ parentId: seriesId }, { parent: { parentId: seriesId } }],
      },
      select: { id: true, seasonNumber: true, episodeNumber: true, extra: true },
    });
    // Deterministic order — rank-based matching would silently shift titles if
    // the heap order of the rows above was ever anything but ascending.
    const sortedLocals = locals.sort(
      (a, b) => (a.seasonNumber ?? 0) - (b.seasonNumber ?? 0) || (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0),
    );
    const localsBySeason = new Map<number, number[]>();
    for (const ep of sortedLocals) {
      if (ep.seasonNumber == null || ep.episodeNumber == null) continue;
      const arr = localsBySeason.get(ep.seasonNumber) ?? [];
      arr.push(ep.episodeNumber);
      localsBySeason.set(ep.seasonNumber, arr);
    }

    // Season-gap backfill: split-season providers only cover the cour they
    // matched, so later seasons of a multi-cour anime stay title-less. TVMaze
    // keeps the whole show under one record — title-search it when a local
    // season has no titles, then merge (and cache) what it returns.
    const covered = new Set([...byKey.keys()].map((k) => Number(k.split(":")[0])));
    const localSeasons = new Set(locals.map((l) => l.seasonNumber).filter((s): s is number => s != null));
    const gapSeasons = [...localSeasons].filter((s) => !covered.has(s));

    // Multi-cour walk (split-record catalogs): MAL/Jikan keep one record per
    // cour, so the primary list only ever covers the cour the match landed
    // on (cour 1 — local season 1). The matched provider's SEQUEL chain
    // orders the remaining cours; each cour's episode list is pulled under
    // its own MAL id — cache-backed, network-gated by the same 24h attempt
    // stamp — and remapped to its cour's season number.
    const thatAnilist = providers["ANILIST"] as MetadataProvider | undefined;
    if (gapSeasons.length > 0 && thatAnilist?.sequels) {
      const anilistRow = await db.externalId.findUnique({
        where: { mediaItemId_provider: { mediaItemId: seriesId, provider: "ANILIST" } },
        select: { providerId: true },
      });
      if (anilistRow) {
        // The chain query itself is network — gated by the stamp so a
        // never-resolvable gap (extra seasons that don't exist) can't churn
        // AniList every sweep. Stamped up front: a failed walk backs off
        // like any other failed fetch.
        let chain: Array<{ provider: string; providerId: string }> = [];
        if (retryDue) {
          await stampTitlesAttempt(db, seriesId);
          chain = await thatAnilist.sequels(anilistRow.providerId);
        }
        const jikanEpisodes = providers["MAL"]?.episodes;
        if (chain.length > 0 && jikanEpisodes) {
          for (let i = 0; i < chain.length; i++) {
            const courSeason = i + 2; // chain[0] = cour 2 = local season 2
            if (!gapSeasons.includes(courSeason)) continue;
            const node = chain[i]!;
            if (node.provider !== "MAL") continue;
            const nodeCached = await db.metadataCache.findUnique({
              where: { provider_externalId: { provider: "MAL", externalId: node.providerId } },
            });
            const nodeFresh =
              nodeCached !== null && (nodeCached.expiresAt === null || nodeCached.expiresAt > new Date());
            let courList: EpisodeMetadata[] | undefined = nodeFresh
              ? ((nodeCached?.payload as Record<string, unknown> | null)?.episodes as EpisodeMetadata[] | undefined)
              : undefined;
            if (!courList) {
              // A TTL-expired row is a designed refetch cadence (ONGOING);
              // a missing row is a never-attempted cour — stamp-gated so a
              // dead source can't churn Jikan every sweep.
              if (!nodeFresh && nodeCached !== null) continue;
              if (!retryDue) continue;
              courList = await jikanEpisodes(node.providerId);
              if (courList.length === 0) continue; // never cache empty lists
              const { ttlPolicy, expiresAt } = ttlPolicyAndExpiry(
                (
                  await db.mediaItem.findUnique({
                    where: { id: seriesId },
                    select: { lifecycleState: true },
                  })
                )?.lifecycleState ?? "UNKNOWN",
              );
              await db.metadataCache.upsert({
                where: { provider_externalId: { provider: "MAL", externalId: node.providerId } },
                create: {
                  provider: "MAL",
                  externalId: node.providerId,
                  payload: { episodes: courList } as unknown as Prisma.InputJsonValue,
                  ttlPolicy,
                  expiresAt,
                },
                update: {
                  payload: { episodes: courList } as unknown as Prisma.InputJsonValue,
                  ttlPolicy,
                  expiresAt,
                },
              });
            }
            for (const ep of courList) {
              if (ep.episodeNumber == null) continue;
              // Gap-fill only — never overwrite a title the primary/
              // broader-coverage sources already supplied.
              const key = `${courSeason}:${ep.episodeNumber}`;
              if (!byKey.has(key)) byKey.set(key, ep.title);
            }
            const pairs: { n: number; title: string }[] = courList
              .filter((ep): ep is EpisodeMetadata & { episodeNumber: number } => ep.episodeNumber != null)
              .map((ep) => ({ n: ep.episodeNumber, title: ep.title }));
            if (!titlesBySeason.has(courSeason)) {
              titlesBySeason.set(courSeason, pairs.sort((a, b) => a.n - b.n).map((p) => p.title));
            }
          }
        }
      }
    }

    // Recompute the gaps after the walk — a filled cour shouldn't waste a
    // TVMaze search.
    const coveredAfter = new Set([...byKey.keys()].map((k) => Number(k.split(":")[0])));
    const gapSeasonsAfter = [...localSeasons].filter((s) => !coveredAfter.has(s));
    const tvMaze = providers["TVMAZE"] as MetadataProvider | undefined;
    if (gapSeasonsAfter.length > 0 && retryDue && tvMaze?.search && tvMaze.episodes) {
      const series = await db.mediaItem.findUnique({ where: { id: seriesId }, select: { title: true } });
      // Exact-normalized equality, or containment in the provider title
      // (short local name vs fuller provider title). Never fall back to a
      // blind first hit — a *wrong* show's episode list is worse than no
      // titles at all, and it would poison every episode's display. An
      // empty-normalized local title (all-CJK folder name) would make
      // `.includes("")` vacuously true — same blind hit, so skip instead.
      const seriesNorm = series?.title ? normalizeTitle(series.title) : "";
      const hit =
        seriesNorm.length > 0
          ? (await tvMaze.search({ title: series!.title, kind: "SERIES" })).matches.find((r) => {
              const candidateNorm = normalizeTitle(r.title);
              return candidateNorm === seriesNorm || candidateNorm.includes(seriesNorm);
            })
          : undefined;
      // A backfill miss must only skip the backfill — the primary source's
      // titles (already fetched above) still apply below.
      if (hit) {
        const backfill = await tvMaze.episodes(hit.providerId);
        if (backfill.length > 0) {
          const { ttlPolicy, expiresAt } = ttlPolicyAndExpiry(
            (await db.mediaItem.findUnique({ where: { id: seriesId }, select: { lifecycleState: true } }))?.lifecycleState ?? "UNKNOWN",
          );
          await db.metadataCache.upsert({
            where: { provider_externalId: { provider: "TVMAZE", externalId: hit.providerId } },
            create: {
              provider: "TVMAZE",
              externalId: hit.providerId,
              payload: { episodes: backfill } as unknown as Prisma.InputJsonValue,
              ttlPolicy,
              expiresAt,
            },
            update: {
              payload: { episodes: backfill } as unknown as Prisma.InputJsonValue,
              ttlPolicy,
              expiresAt,
            },
          });
          const backfillBySeason = new Map<number, { n: number; title: string }[]>();
          for (const ep of backfill) {
            if (ep.seasonNumber == null || ep.episodeNumber == null) continue;
            // Gap-fill only — never overwrite a title the primary/
            // broader-coverage sources already supplied.
            const key = `${ep.seasonNumber}:${ep.episodeNumber}`;
            if (!byKey.has(key)) byKey.set(key, ep.title);
            const arr = backfillBySeason.get(ep.seasonNumber) ?? [];
            arr.push({ n: ep.episodeNumber, title: ep.title });
            backfillBySeason.set(ep.seasonNumber, arr);
          }
          for (const [season, pairs] of backfillBySeason) {
            if (titlesBySeason.has(season)) continue;
            titlesBySeason.set(season, pairs.sort((a, b) => a.n - b.n).map((p) => p.title));
          }
        }
      }
    }

    for (const ep of locals) {
      if (ep.seasonNumber == null || ep.episodeNumber == null) continue;
      const exact = byKey.get(`${ep.seasonNumber}:${ep.episodeNumber}`);
      const seasonTitles = titlesBySeason.get(ep.seasonNumber);
      const seasonNumbers = localsBySeason.get(ep.seasonNumber);
      const rank = seasonNumbers?.indexOf(ep.episodeNumber) ?? -1;
      const title = exact ?? (rank >= 0 && seasonTitles ? seasonTitles[rank] : undefined);
      if (!title) continue;
      const extra = (ep.extra ?? {}) as Record<string, unknown>;
      if (extra.episodeTitle === title) continue;
      await db.mediaItem.update({
        where: { id: ep.id },
        data: { extra: { ...extra, episodeTitle: title } as Prisma.InputJsonValue },
      });
    }
  } catch {
    // degrade, never error — enrichment is polish, not a dependency
  }
}

/**
 * Wikidata is an ID bridge only ("✅ (ID bridge)", not descriptive/artwork)
 * — it turns this provider's own item ID into an IMDb ID. `IdMapping` is the
 * dataset-level cache (reusable across any item sharing this provider+ID, so a
 * second item never re-queries Wikidata for the same show); `ExternalId` is
 * what the rest of the pipeline actually reads. Best-effort: Wikidata being
 * unreachable must never fail the real match that already succeeded above.
 */
async function bridgeToWikidata(
  db: PrismaClient,
  mediaItemId: string,
  providerName: string,
  providerId: string,
  bridge: MappingSource | undefined,
): Promise<void> {
  if (!bridge) return;
  try {
    const existing = await db.idMapping.findFirst({
      where: { sourceProvider: providerName, sourceId: providerId, targetProvider: "IMDB" },
    });
    const mapping = existing ?? (await bridge.mappingsFor(providerName, providerId))[0];
    if (!mapping) return;
    if (!existing) {
      await db.idMapping.create({ data: { ...mapping, datasetSource: bridge.datasetSource } }).catch(() => {});
    }
    await db.externalId
      .upsert({
        where: { mediaItemId_provider: { mediaItemId, provider: "IMDB" } },
        create: { mediaItemId, provider: "IMDB", providerId: mapping.targetId, confidence: 0.9 },
        update: { providerId: mapping.targetId },
      })
      .catch(() => {});
  } catch {
    // degrade, never error — Wikidata is enrichment, never a dependency
  }
}

async function applyMatch(
  db: PrismaClient,
  target: MetadataNeeded,
  providerName: string,
  match: MetadataMatch,
  lastModified: string | undefined,
  wikidataBridge: MappingSource | undefined,
): Promise<void> {
  await db.externalId
    .upsert({
      where: { mediaItemId_provider: { mediaItemId: target.mediaItemId, provider: providerName } },
      create: {
        mediaItemId: target.mediaItemId,
        provider: providerName,
        providerId: match.providerId,
        confidence: 1,
        lastResolvedAt: new Date(),
      },
      update: { providerId: match.providerId, lastResolvedAt: new Date() },
    })
    .catch(() => {});
  // Alternate ids ride along with the match (e.g. AniList's idMal) so later
  // enrichment passes can pull episodes from a provider the matcher skipped.
  for (const alt of match.alternateIds ?? []) {
    await db.externalId
      .upsert({
        where: { mediaItemId_provider: { mediaItemId: target.mediaItemId, provider: alt.provider } },
        create: { mediaItemId: target.mediaItemId, provider: alt.provider, providerId: alt.id, confidence: 1 },
        update: { providerId: alt.id },
      })
      .catch(() => {});
  }
  await addProviderMatchEvidence(db, target.mediaItemId, providerName, match);
  await syncProviderTitles(db, target.mediaItemId, match);
  await fillDescriptiveFields(db, target.mediaItemId, match);
  await fetchAndStoreProviderArtwork(db, target.mediaItemId, match.artwork);
  await upsertMetadataCache(db, providerName, match, lastModified);
  await bridgeToWikidata(db, target.mediaItemId, providerName, match.providerId, wikidataBridge);
}

/**
 * The item's poster slot is considered intact only when at least one row
 * exists AND its bytes are still on disk. A missing row or a dangling path
 * (moved store, failed write, deleted config) makes the cache-hit path fall
 * through to revalidation, which re-fetches artwork — "Scan" in the admin
 * console repairs lost posters instead of just re-confirming the cache.
 */
async function posterIntact(db: PrismaClient, mediaItemId: string): Promise<boolean> {
  const rows = await db.artwork.findMany({ where: { mediaItemId, kind: "POSTER" }, select: { bytesPath: true } });
  if (rows.length === 0) return false;
  return rows.every((a) => existsSync(a.bytesPath));
}

/**
 * One provider's turn in the chain — not the whole chain. Each
 * provider gets its own BullMQ queue with its own `limiter` (own rate
 * budget), so a job here only ever calls this one provider's API; the
 * caller (apps/worker) decides whether to enqueue the next provider in the
 * chain when this returns `false`. A media item with a fresh (unexpired)
 * MetadataCache entry costs zero network calls either way — the "fetch
 * once" promise .
 *
 * Returns true once a match is accepted and fully written (or the existing
 * cache is still fresh and not due for self-healing) — the chain stops
 * there. Returns false when this provider found nothing acceptable and the
 * caller should try the next one.
 */
export async function resolveMetadataStep(
  db: PrismaClient,
  target: MetadataNeeded,
  providerName: string,
  provider: MetadataProvider,
  wikidataBridge?: MappingSource,
  providers: Record<string, MetadataProvider> = {},
): Promise<boolean> {
  const query: MetadataQuery = { title: target.title, year: target.year ?? undefined, kind: target.kind };

  const existing = await db.externalId.findUnique({
    where: { mediaItemId_provider: { mediaItemId: target.mediaItemId, provider: providerName } },
  });

  if (existing) {
    const cached = await db.metadataCache.findUnique({
      where: { provider_externalId: { provider: providerName, externalId: existing.providerId } },
    });
    if (cached) {
      const isFresh = cached.expiresAt === null || cached.expiresAt > new Date();
      if (isFresh && !(await dueForSelfHealing(db, target.mediaItemId, existing.lastResolvedAt))) {
        await enrichEpisodeTitles(db, target.mediaItemId, providerName, provider, existing.providerId, providers);
        // zero-network fast path only when the poster is actually servable —
        // a broken/missing poster falls through to revalidation and re-fetch.
        if (await posterIntact(db, target.mediaItemId)) return true;
      }

      const result = await provider.search(query, {
        existingProviderId: existing.providerId,
        lastModified: cached.lastModified ?? undefined,
      });
      if (result.notModified) {
        await refreshMetadataCacheExpiry(db, providerName, existing.providerId, cached.lifecycleState);
        await touchLastResolvedAt(db, target.mediaItemId, providerName);
        await enrichEpisodeTitles(db, target.mediaItemId, providerName, provider, existing.providerId, providers);
        return true;
      }
      const revalidated = findAcceptedMatch(query, result.matches);
      // A pinned/prior identity is never re-contested on title alone: when
      // the provider returned exactly the entry for the id we already hold
      // (manual "fix match" pins, or the provider itself renamed the entry),
      // accept it even though the folder-derived title no longer clears the
      // gate — the gate protects against accepting a *new wrong* id, not
      // against re-confirming the id we already resolved to.
      const confirmed =
        revalidated ?? result.matches.find((m) => m.providerId === existing.providerId);
      if (confirmed) {
        await applyMatch(db, target, providerName, confirmed, result.lastModified, wikidataBridge);
        await enrichEpisodeTitles(db, target.mediaItemId, providerName, provider, confirmed.providerId, providers);
        return true;
      }
      await touchLastResolvedAt(db, target.mediaItemId, providerName);
      return false; // no longer confirmed — caller tries the next provider
    }

    // A held id with no cache row — the manual "fix match" pin writes only
    // the ExternalId, so it lands here. Revalidate the held id exactly (same
    // as the cached path): a bare fuzzy title search would re-reject the very
    // title mismatch the pin exists to override, and the pin would stay inert
    // — no artwork, no descriptive fields, no episode titles, forever.
    const result = await provider.search(query, { existingProviderId: existing.providerId });
    const confirmed =
      findAcceptedMatch(query, result.matches) ?? result.matches.find((m) => m.providerId === existing.providerId);
    if (confirmed) {
      await applyMatch(db, target, providerName, confirmed, result.lastModified, wikidataBridge);
      await enrichEpisodeTitles(db, target.mediaItemId, providerName, provider, confirmed.providerId, providers);
      return true;
    }
    await touchLastResolvedAt(db, target.mediaItemId, providerName);
    return false;
  }

  const result = await provider.search(query);
  const match = findAcceptedMatch(query, result.matches);
  if (!match) return false;
  await applyMatch(db, target, providerName, match, result.lastModified, wikidataBridge);
  await enrichEpisodeTitles(db, target.mediaItemId, providerName, provider, match.providerId, providers);
  return true;
}
