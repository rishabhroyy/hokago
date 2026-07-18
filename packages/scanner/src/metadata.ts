import path from "node:path";

import { Prisma, type PrismaClient, type LifecycleState, type TitleType } from "@hokago/db";
import type {
  MappingSource,
  MetadataArtworkCandidate,
  MetadataLifecycleState,
  MetadataMatch,
  MetadataProvider,
  MetadataQuery,
} from "@hokago/metadata";
import { findAcceptedMatch } from "@hokago/providers";

import { ARTWORK_SOURCE_PRIORITY, ANIME_MOVIE_CARVEOUT, DEFAULT_PROVIDER_ORDER } from "./constants.js";
import { storeBytes, upsertArtworkDescriptor } from "./artwork.js";
import { syncEvidenceAndConfidence, type EvidenceInput } from "./evidence.js";
import type { MetadataNeeded } from "./ingest.js";

/** Effective chain for this kind/profile: library override (or profile default), plus the always-tried anime carve-out for MOVIE (§8.7.6, non-negotiable #15). */
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
    default: // UNKNOWN, UNRELEASED — retry-with-backoff surrogate (§8.3)
      return { ttlPolicy: "24h", expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) };
  }
}

/**
 * Reconstructs the full evidence snapshot before adding/replacing this
 * provider's PROVIDER_MATCH row — syncEvidenceAndConfidence replaces *all*
 * evidence for a mediaItem in one call, so passing only the new signal would
 * silently wipe every local signal ingest.ts already wrote (§7.5).
 */
/** syncEvidenceAndConfidence never deletes a PROVIDER_MATCH row it isn't explicitly given, so this only needs its own entry. */
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
  await syncEvidenceAndConfidence(db, mediaItemId, evidence);
}

/** Title sync (§20.2): each metadata run replaces all titles of a type it just fetched, per (mediaItemId, type). */
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

/** Local data always outranks network providers (§8.3) — only fill descriptive fields still at their unset default. */
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
  if (match.lifecycleState) {
    await db.mediaItem.updateMany({
      where: { id: mediaItemId, lifecycleState: "UNKNOWN" },
      data: { lifecycleState: match.lifecycleState },
    });
  }
}

/** Fetched once, stored as bytes (non-negotiable #4), merged into the existing self-healing artwork slot (§8.7.4). */
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
 * Wikidata is an ID bridge only (§8.2: "✅ (ID bridge)", not descriptive/artwork)
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
      create: { mediaItemId: target.mediaItemId, provider: providerName, providerId: match.providerId, confidence: 1 },
      update: { providerId: match.providerId },
    })
    .catch(() => {});
  await addProviderMatchEvidence(db, target.mediaItemId, providerName, match);
  await syncProviderTitles(db, target.mediaItemId, match);
  await fillDescriptiveFields(db, target.mediaItemId, match);
  await fetchAndStoreProviderArtwork(db, target.mediaItemId, match.artwork);
  await upsertMetadataCache(db, providerName, match, lastModified);
  await bridgeToWikidata(db, target.mediaItemId, providerName, match.providerId, wikidataBridge);
}

/**
 * One provider's turn in the chain (§8.2) — not the whole chain. Each
 * provider gets its own BullMQ queue with its own `limiter` (own rate
 * budget), so a job here only ever calls this one provider's API; the
 * caller (apps/worker) decides whether to enqueue the next provider in the
 * chain when this returns `false`. A media item with a fresh (unexpired)
 * MetadataCache entry costs zero network calls either way — the "fetch
 * once" promise (§8.3).
 *
 * Returns true once a match is accepted and fully written (or the existing
 * cache is still fresh) — the chain stops there. Returns false when this
 * provider found nothing acceptable and the caller should try the next one.
 */
export async function resolveMetadataStep(
  db: PrismaClient,
  target: MetadataNeeded,
  providerName: string,
  provider: MetadataProvider,
  wikidataBridge?: MappingSource,
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
      if (isFresh) return true; // cache hit, zero network (§8.3)

      const result = await provider.search(query, {
        existingProviderId: existing.providerId,
        lastModified: cached.lastModified ?? undefined,
      });
      if (result.notModified) {
        await refreshMetadataCacheExpiry(db, providerName, existing.providerId, cached.lifecycleState);
        return true;
      }
      const revalidated = findAcceptedMatch(query, result.matches);
      if (revalidated) {
        await applyMatch(db, target, providerName, revalidated, result.lastModified, wikidataBridge);
        return true;
      }
      return false; // no longer confirmed — caller tries the next provider
    }
  }

  const result = await provider.search(query);
  const match = findAcceptedMatch(query, result.matches);
  if (!match) return false;
  await applyMatch(db, target, providerName, match, result.lastModified, wikidataBridge);
  return true;
}
