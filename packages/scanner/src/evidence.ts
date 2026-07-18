import { Prisma, type PrismaClient, type SignalType } from "@hokago/db";

import { SIGNAL_WEIGHT } from "./constants.js";

export interface EvidenceInput {
  signalType: SignalType;
  source: string;
  value: Record<string, unknown>;
}

// jsonb round-trips through Postgres don't preserve JS object key insertion
// order, so a plain JSON.stringify comparison against a freshly-fetched row
// spuriously reports "changed" on every scan. Sort keys recursively so the
// comparison is order-independent.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Confidence is derived from Evidence, never authored (§7.5, non-negotiable #8).
 * Noisy-OR combination: 1 - Π(1 - weight_i). A single strong signal (e.g.
 * NFO_UNIQUEID at 0.99) alone yields ~that weight instead of being diluted by
 * an averaging denominator; corroborating signals nudge it up instead of
 * getting double-counted away.
 */
// ponytail: contradiction is handled as a flat penalty multiplier, not a
// graduated one (e.g. weighing how far the runtime is from a typical episode
// length). Noisy-OR has no notion of signals disagreeing — it only combines
// how sure independent signals make us of *something* — so a filename that
// unambiguously parses as an episode (SxxEyy) on an item resolved as a MOVIE
// by runtime clustering would otherwise get full episode+movie-signal
// confidence with nothing reflecting that the signals fought. Upgrade to a
// graduated penalty if a flat 0.5 proves too coarse in practice.
const CONTRADICTION_PENALTY = 0.5;

export function computeConfidence(rows: { weight: number }[], contradicted = false): number {
  if (rows.length === 0) return 0;
  const product = rows.reduce((acc, r) => acc * (1 - r.weight), 1);
  const confidence = 1 - product;
  return contradicted ? confidence * CONTRADICTION_PENALTY : confidence;
}

/**
 * Sync rather than blind delete+recreate (§9.6.1 idempotency, §9.6.2
 * self-healing, crash-only): unchanged signals keep their original
 * observedAt instead of resetting on every rescan, changed/new signals get a
 * fresh one, and vanished sources are removed. All in one transaction so a
 * crash mid-sync can never leave a MediaItem with zero evidence rows.
 *
 * Shared by leaf items (MOVIE/EPISODE) and containers (SERIES/SEASON) —
 * container-level confidence was the Step 2 gap this closes (§19 Step 4).
 */
export async function syncEvidenceAndConfidence(
  db: PrismaClient,
  mediaItemId: string,
  evidence: EvidenceInput[],
  contradicted = false,
): Promise<number> {
  const finalRows = await db.$transaction(async (tx) => {
    const existing = await tx.evidence.findMany({ where: { mediaItemId } });
    const existingByKey = new Map(existing.map((row) => [`${row.signalType}::${row.source}`, row]));
    const seenIds = new Set<string>();

    for (const e of evidence) {
      const key = `${e.signalType}::${e.source}`;
      const weight = SIGNAL_WEIGHT[e.signalType] ?? 0.5;
      const prior = existingByKey.get(key);

      if (prior) {
        seenIds.add(prior.id);
        const unchanged = stableStringify(prior.value) === stableStringify(e.value) && prior.weight === weight;
        if (unchanged) continue;
        await tx.evidence.update({
          where: { id: prior.id },
          data: { value: e.value as Prisma.InputJsonValue, weight, observedAt: new Date() },
        });
        continue;
      }

      const created = await tx.evidence.create({
        data: {
          mediaItemId,
          signalType: e.signalType,
          source: e.source,
          value: e.value as Prisma.InputJsonValue,
          weight,
        },
      });
      seenIds.add(created.id);
    }

    // PROVIDER_MATCH rows belong to a separate subsystem (the metadata
    // pipeline) from whichever caller is syncing here (e.g. a local rescan) —
    // never delete one just because this caller's snapshot doesn't mention
    // it. A provider entry is only ever replaced by passing the same
    // signalType+source key back in, which goes through the update path above.
    const stale = existing.filter((row) => !seenIds.has(row.id) && row.signalType !== "PROVIDER_MATCH");
    if (stale.length > 0) {
      await tx.evidence.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
    }

    return tx.evidence.findMany({ where: { mediaItemId } });
  });

  // Confidence is derived from the full post-sync Evidence snapshot, not the
  // caller's partial view — otherwise a caller passing only its own subset
  // (e.g. local scan evidence) would silently drop preserved PROVIDER_MATCH
  // weight from the computed confidence (§7.5, non-negotiable #8).
  const confidence = computeConfidence(
    finalRows.map((r) => ({ weight: r.weight })),
    contradicted,
  );
  await db.mediaItem.update({ where: { id: mediaItemId }, data: { confidence } });
  return confidence;
}
