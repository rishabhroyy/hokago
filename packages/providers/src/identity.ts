import { AniListProvider } from "./anilist.js";
import { findAcceptedMatch } from "./match.js";
import type { MetadataMatch, MetadataQuery } from "@hokago/metadata";

export interface ExternalIdRef {
  provider: string;
  providerId: string;
}

type IdentitySearchFn = (
  query: MetadataQuery,
  opts?: { signal?: AbortSignal },
) => Promise<{ matches: MetadataMatch[] }>;

// Process-local budget shared by every resolveQueryExternalIds caller in
// this process (API preview/dedup, worker imports): AniList is ~90/min
// nominal and the metadata queue already budgets 45/min, but these are
// direct fetches outside that limiter. Exhaustion degrades to string
// matching (the pre-existing behavior), never an error — worst case on an
// empty-library typing burst is a few unmatched previews, not 429s.
const IDENTITY_BUDGET_MAX = 20;
const IDENTITY_BUDGET_WINDOW_MS = 10_000;
let identityBudgetTokens = IDENTITY_BUDGET_MAX;
let identityBudgetWindowStart = 0;

function takeIdentityBudget(now: number = Date.now()): boolean {
  if (now - identityBudgetWindowStart >= IDENTITY_BUDGET_WINDOW_MS) {
    identityBudgetWindowStart = now;
    identityBudgetTokens = IDENTITY_BUDGET_MAX;
  }
  if (identityBudgetTokens <= 0) return false;
  identityBudgetTokens -= 1;
  return true;
}

/** Test-only reset for the process-local budget above. */
export function __resetIdentityBudgetForTests(): void {
  identityBudgetTokens = IDENTITY_BUDGET_MAX;
  identityBudgetWindowStart = 0;
}

/**
 * Best-effort query → provider-identity resolution over the same AniList +
 * acceptMatch machinery scanner resolution trusts — the alias graph
 * (romaji/english/native) that local title strings alone can never carry.
 * "Sousou no Frieren" resolves to the same ANILIST/MAL ids as
 * "Frieren: Beyond Journey's End" here, while string matching needs a
 * stored AKA to bridge them.
 *
 * Never throws and never blocks callers: network/timeout/empty all yield
 * undefined so every site falls back to local string matching. Local-first
 * ordering lives in the callers — this runs only after string matching
 * misses, so the healthy/offline path costs zero extra requests.
 */
export async function resolveQueryExternalIds(
  title: string,
  year: number | null,
  opts?: { timeoutMs?: number; search?: IdentitySearchFn },
): Promise<ExternalIdRef[] | undefined> {
  try {
    const q = title.trim();
    if (!q) return undefined;
    if (!takeIdentityBudget()) return undefined;
    const search: IdentitySearchFn =
      opts?.search ?? ((query, o) => new AniListProvider().search(query, o));
    const { matches } = await search(
      { title: q, year: year ?? undefined, kind: "SERIES" },
      { signal: AbortSignal.timeout(opts?.timeoutMs ?? 2500) },
    );
    const accepted = findAcceptedMatch(
      { title: q, year: year ?? undefined, kind: "SERIES" },
      matches,
    );
    if (!accepted) return undefined;
    return [
      { provider: "ANILIST", providerId: accepted.providerId },
      ...(accepted.alternateIds ?? []).map((a) => ({
        provider: a.provider,
        providerId: a.id,
      })),
    ];
  } catch {
    return undefined;
  }
}

export interface SeriesIdentityDeps {
  db: {
    externalId: {
      findMany(args: {
        where: { OR: { provider: string; providerId: string }[] };
      }): Promise<{ mediaItemId: string | null }[]>;
    };
    mediaItem: {
      findMany(args: {
        where: { id: { in: string[] }; libraryId: string; kind: "SERIES" };
      }): Promise<{ id: string; title: string; year: number | null }[]>;
    };
  };
}

/**
 * Library SERIES row sharing any of the given provider identities.
 * DB errors propagate (callers keep their gate fail-closed); empty ids
 * short-circuit without touching the database.
 */
export async function findSeriesByExternalIds(
  deps: SeriesIdentityDeps,
  libraryId: string,
  ids: ExternalIdRef[],
): Promise<{ id: string; title: string; year: number | null } | undefined> {
  if (ids.length === 0) return undefined;
  const rows = await deps.db.externalId.findMany({
    where: { OR: ids.map((a) => ({ provider: a.provider, providerId: a.providerId })) },
  });
  const itemIds = [...new Set(rows.map((r) => r.mediaItemId).filter((v): v is string => v !== null))];
  if (itemIds.length === 0) return undefined;
  const series = await deps.db.mediaItem.findMany({
    where: { id: { in: itemIds }, libraryId, kind: "SERIES" },
  });
  const first = series[0];
  return first ? { id: first.id, title: first.title, year: first.year } : undefined;
}
