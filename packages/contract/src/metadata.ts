/** /metadata — manual "fix match": provider search + pinning an identity. */

import { z } from "zod";

/** The keyless providers a manual match can pin against. */
export const MetadataMatchProvider = z.enum(["TVMAZE", "WIKIPEDIA", "ANILIST", "MAL"]);
export type MetadataMatchProvider = z.infer<typeof MetadataMatchProvider>;

export const MetadataSearchQuery = z.object({
  title: z.string().min(1).max(200),
  year: z.coerce.number().int().positive().optional(),
  kind: z.enum(["MOVIE", "SERIES"]),
});
export type MetadataSearchQuery = z.infer<typeof MetadataSearchQuery>;

/** One search hit, flattened from a provider's MetadataMatch for the picker. */
export const MetadataSearchCandidate = z.object({
  provider: MetadataMatchProvider,
  providerId: z.string(),
  title: z.string(),
  year: z.number().int().nullable(),
  overview: z.string().nullable().optional(),
  artworkUrl: z.string().url().nullable().optional(),
});
export type MetadataSearchCandidate = z.infer<typeof MetadataSearchCandidate>;

export const MetadataSearchResponse = z.object({ candidates: z.array(MetadataSearchCandidate) });
export type MetadataSearchResponse = z.infer<typeof MetadataSearchResponse>;

export const MetadataMatchPinParams = z.object({ id: z.string() });

/** The provider's canonical title/year for the pinned entry — stored in evidence so later auto-heal passes can re-confirm it. */
export const MetadataMatchPinBody = z.object({
  provider: MetadataMatchProvider,
  providerId: z.string().min(1),
  title: z.string().min(1),
  year: z.number().int().nullable().optional(),
});
export type MetadataMatchPinBody = z.infer<typeof MetadataMatchPinBody>;

export const MetadataMatchPinResponse = z.object({ pinned: z.boolean() });

export const MetadataMatchDeleteParams = z.object({ id: z.string() });
export const MetadataMatchDeleteBody = z.object({ provider: MetadataMatchProvider });
export const MetadataMatchDeleteResponse = z.object({ unpinned: z.boolean() });

export const ErrorResponse = z.object({ error: z.string() });
