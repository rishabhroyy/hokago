import path from "node:path";

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
import { findAcceptedMatch } from "@hokago/providers";

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
  return item.confidence < SELF_HEALING_CONFIDENCE_THRESHOLD && dueForBackoffRetry;
}

async function touchLastResolvedAt(db: PrismaClient, mediaItemId: string, providerName: string): Promise<void> {
  await db.externalId
    .update({
      where: { mediaItemId_provider: { mediaItemId, provider: providerName } },
      data: { lastResolvedAt: new Date() },
    })
    .catch(() => {});
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
    let source: { provider: MetadataProvider; providerName: string; providerId: string } | undefined =
      provider.episodes ? { provider, providerName, providerId } : undefined;
    if (!source) {
      const alternates = provider.alternateIds ? await provider.alternateIds(providerId) : [];
      for (const alt of alternates) {
        await db.externalId
          .upsert({
            where: { mediaItemId_provider: { mediaItemId: seriesId, provider: alt.provider } },
            create: { mediaItemId: seriesId, provider: alt.provider, providerId: alt.id, confidence: 1 },
            update: { providerId: alt.id },
          })
          .catch(() => {});
      }
      const rows = await db.externalId.findMany({ where: { mediaItemId: seriesId } });
      for (const row of rows) {
        const candidate = providers[row.provider];
        if (candidate?.episodes) {
          source = { provider: candidate, providerName: row.provider, providerId: row.providerId };
          break;
        }
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
      await db.metadataCache.upsert({
        where: { provider_externalId: { provider: source.providerName, externalId: source.providerId } },
        create: { provider: source.providerName, externalId: source.providerId, payload, ttlPolicy, expiresAt },
        update: { payload, ttlPolicy, expiresAt },
      });
    }
    if (episodes.length === 0) return;

    const byKey = new Map(episodes.map((ep) => [`${ep.seasonNumber}:${ep.episodeNumber}`, ep.title]));
    const locals = await db.mediaItem.findMany({
      where: {
        kind: "EPISODE",
        OR: [{ parentId: seriesId }, { parent: { parentId: seriesId } }],
      },
      select: { id: true, seasonNumber: true, episodeNumber: true, extra: true },
    });
    for (const ep of locals) {
      if (ep.seasonNumber == null || ep.episodeNumber == null) continue;
      const title = byKey.get(`${ep.seasonNumber}:${ep.episodeNumber}`);
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
        return true; // cache hit, zero network
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
      if (revalidated) {
        await applyMatch(db, target, providerName, revalidated, result.lastModified, wikidataBridge);
        await enrichEpisodeTitles(db, target.mediaItemId, providerName, provider, revalidated.providerId, providers);
        return true;
      }
      await touchLastResolvedAt(db, target.mediaItemId, providerName);
      return false; // no longer confirmed — caller tries the next provider
    }
  }

  const result = await provider.search(query);
  const match = findAcceptedMatch(query, result.matches);
  if (!match) return false;
  await applyMatch(db, target, providerName, match, result.lastModified, wikidataBridge);
  await enrichEpisodeTitles(db, target.mediaItemId, providerName, provider, match.providerId, providers);
  return true;
}
