/** §9.6.8 — admin queue UI, backed directly by BullMQ. */

import { z } from "zod";

export const QueueName = z.enum(["scan", "artwork", "metadata-tvmaze", "metadata-anilist", "metadata-mal"]);
export const JobState = z.enum(["waiting", "active", "completed", "failed", "delayed"]);

export const QueueSummary = z.object({
  name: z.string(),
  paused: z.boolean(),
  counts: z.record(z.string(), z.number()),
});
export const QueueListResponse = z.array(QueueSummary);

export const QueueParams = z.object({ name: z.string() });
export const QueueJobsQuery = z.object({ state: JobState.optional() });
export type QueueJobsQuery = z.infer<typeof QueueJobsQuery>;

export const QueueJob = z.object({
  id: z.string().optional(),
  data: z.unknown(),
  attemptsMade: z.number(),
  failedReason: z.string().optional(),
  timestamp: z.number(),
});
export const QueueJobsResponse = z.array(QueueJob);

export const QueuePausedResponse = z.object({ paused: z.boolean() });
export const QueueRetriedResponse = z.object({ retried: z.number() });
export const QueueCleanBody = z.object({ state: JobState.optional() });
export type QueueCleanBody = z.infer<typeof QueueCleanBody>;
export const QueueCleanResponse = z.object({ removed: z.number() });

export const ErrorResponse = z.object({ error: z.string() });
