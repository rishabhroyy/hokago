/** ani-cli internet acquisition: search titles + enqueue downloads into an ANIME library. Admin-only. */

import { z } from "zod";

export const AnicliSearchQuery = z.object({
  query: z.string().min(1).max(200),
});
export type AnicliSearchQuery = z.infer<typeof AnicliSearchQuery>;

export const AnicliSearchCandidate = z.object({
  title: z.string(),
  year: z.number().int().nullable(),
  posterUrl: z.string().nullable(),
});
export type AnicliSearchCandidate = z.infer<typeof AnicliSearchCandidate>;

export const AnicliSearchResponse = z.object({
  candidates: z.array(AnicliSearchCandidate),
});
export type AnicliSearchResponse = z.infer<typeof AnicliSearchResponse>;

export const AnicliDownloadBody = z.object({
  libraryId: z.string().uuid(),
  /** Title ani-cli will resolve + download (e.g. "Frieren S2" for a new season). */
  query: z.string().min(1).max(200),
  /** Display title from the search step (informational, optional). */
  title: z.string().max(200).optional(),
  /** "1-12" | "5" | undefined = all episodes. Validated server-side. */
  episodeRange: z.string().max(20).optional(),
  dub: z.boolean().optional(),
});
export type AnicliDownloadBody = z.infer<typeof AnicliDownloadBody>;

export const AnicliProgress = z.object({
  bytes: z.number(),
  files: z.number(),
  percent: z.number().nullable(),
});
export type AnicliProgress = z.infer<typeof AnicliProgress>;

export const AnicliDownloadInfo = z.object({
  id: z.string(),
  libraryId: z.string(),
  query: z.string(),
  title: z.string().nullable(),
  episodeRange: z.string().nullable(),
  dub: z.boolean(),
  status: z.enum(["QUEUED", "SEARCHING", "DOWNLOADING", "IMPORTING", "DONE", "FAILED", "CANCELLED"]),
  progress: AnicliProgress.nullable(),
  bytesWritten: z.number(),
  error: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type AnicliDownloadInfo = z.infer<typeof AnicliDownloadInfo>;

export const AnicliParams = z.object({ id: z.string() });

export const ErrorResponse = z.object({ error: z.string() });
