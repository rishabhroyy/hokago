/** Anime acquisition: search titles + enqueue downloads into an ANIME library, from the built-in ani-cli source or any external provider registered at runtime. Admin-only. */

import { z } from "zod";

export const AcquireSearchQuery = z.object({
  query: z.string().min(1).max(200),
});
export type AcquireSearchQuery = z.infer<typeof AcquireSearchQuery>;

export const AcquireSearchCandidate = z.object({
  title: z.string(),
  year: z.number().int().nullable(),
  posterUrl: z.string().nullable(),
  // Only ever populated by non-built-in providers (ani-cli has no notion of
  // it) — optional so the built-in source's responses need no change.
  size: z.string().nullable().optional(),
});
export type AcquireSearchCandidate = z.infer<typeof AcquireSearchCandidate>;

export const AcquireSearchResponse = z.object({
  candidates: z.array(AcquireSearchCandidate),
});
export type AcquireSearchResponse = z.infer<typeof AcquireSearchResponse>;

export const AcquireDownloadBody = z.object({
  libraryId: z.string().uuid(),
  /** Title the source will resolve + download (e.g. "Frieren S2" for a new season). */
  query: z.string().min(1).max(200),
  /** Display title from the search step (informational, optional). */
  title: z.string().max(200).optional(),
  /** "1-12" | "5" | undefined = all episodes. Validated server-side. */
  episodeRange: z.string().max(20).optional(),
  dub: z.boolean().optional(),
});
export type AcquireDownloadBody = z.infer<typeof AcquireDownloadBody>;

export const AcquireProgress = z.object({
  bytes: z.number(),
  files: z.number(),
  percent: z.number().nullable(),
  // Only ever populated by a provider whose own backend reports a live
  // transfer rate — ani-cli has no such notion and omits it, same as
  // size on AcquireSearchCandidate above.
  bytesPerSecond: z.number().nullable().optional(),
});
export type AcquireProgress = z.infer<typeof AcquireProgress>;

const AcquireDownloadInfoBase = z.object({
  id: z.string(),
  libraryId: z.string(),
  query: z.string(),
  title: z.string().nullable(),
  episodeRange: z.string().nullable(),
  dub: z.boolean(),
  status: z.enum(["QUEUED", "SEARCHING", "DOWNLOADING", "IMPORTING", "DONE", "FAILED", "CANCELLED"]),
  progress: AcquireProgress.nullable(),
  bytesWritten: z.number(),
  error: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const AcquireDownloadInfo = AcquireDownloadInfoBase.extend({
  // A provider whose one request resolves more than one importable item
  // can list the rest here — each one gets imported exactly like the
  // primary object above. Most providers return exactly one item and
  // omit this entirely. Capped at the same ceiling as the built-in
  // route's own episodeRange (see MAX_EPISODES) rather than trusting a
  // provider's response size unconditionally.
  also: z.array(AcquireDownloadInfoBase).max(100).optional(),
});
export type AcquireDownloadInfo = z.infer<typeof AcquireDownloadInfo>;

export const AcquireDownloadParams = z.object({ id: z.string() });

// ── Pluggable providers ────────────────────────────────────────────────────
// A provider is any external service that implements /health, /search and
// /downloads itself (same shapes as above) and registers its own baseUrl at
// runtime. hokago holds the registration in memory only — nothing about a
// registered provider is ever persisted to disk or checked into this repo.

export const AcquireProviderId = z.object({ providerId: z.string().min(1).max(60) });
export const AcquireProviderDownloadParams = z.object({ providerId: z.string().min(1).max(60), id: z.string() });

export const AcquireProviderRegisterBody = z.object({
  label: z.string().min(1).max(60),
  baseUrl: z.string().url(),
  // Sent back as `Authorization: Bearer <token>` on every call hokago makes
  // to this provider (health checks included). Write-only — never returned
  // by GET /acquire/providers.
  token: z.string().min(1).max(200).optional(),
});
export type AcquireProviderRegisterBody = z.infer<typeof AcquireProviderRegisterBody>;

export const AcquireProviderInfo = z.object({
  id: z.string(),
  label: z.string(),
});
export type AcquireProviderInfo = z.infer<typeof AcquireProviderInfo>;

export const AcquireOkResponse = z.object({ ok: z.boolean() });

// ── What the library already has ────────────────────────────────────────
// Surfaces the same show-matching + real SEASON/EPISODE hierarchy the dedup
// gate on /acquire/anicli/downloads and /acquire/:providerId/downloads
// already checks against, so a client can show "already have..." before the
// user picks what to grab instead of it only ever being enforced silently
// at submit time.

export const AcquireExistingQuery = z.object({ libraryId: z.string().uuid(), query: z.string().min(1).max(200) });
export type AcquireExistingQuery = z.infer<typeof AcquireExistingQuery>;

export const AcquireExistingSeason = z.object({
  /** 0 = specials. */
  season: z.number().int(),
  episodeCount: z.number().int(),
  episodeNumbers: z.array(z.number().int()),
});

export const AcquireExistingResponse = z.object({
  matched: z.object({ id: z.string(), title: z.string(), year: z.number().int().nullable() }).nullable(),
  seasons: z.array(AcquireExistingSeason),
});
export type AcquireExistingResponse = z.infer<typeof AcquireExistingResponse>;

export const ErrorResponse = z.object({ error: z.string() });
