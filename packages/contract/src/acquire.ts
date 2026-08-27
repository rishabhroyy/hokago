import { z } from "zod";
export const AcquireSearchQuery = z.object({ q: z.string().min(1).max(200), limit: z.coerce.number().int().min(1).max(20).optional() });
export const AcquireSearchResult = z.object({ id: z.string(), title: z.string(), provider: z.string() });
export const AcquireSearchResponse = z.array(AcquireSearchResult);
export const AcquireCreateBody = z.object({
  libraryId: z.string(),
  providerId: z.string(),
  title: z.string().min(1).max(300),
  episodes: z.array(z.number().int().positive()).optional(),
  quality: z.enum(["360","480","720","1080"]).optional(),
});
export const AcquireInfo = z.object({
  id: z.string(), libraryId: z.string(), providerId: z.string(), title: z.string(),
  status: z.enum(["QUEUED","PROCESSING","READY","FAILED","CANCELLED"]),
  progress: z.number().min(0).max(100).nullable(),
  error: z.string().nullable(), createdAt: z.coerce.date(), updatedAt: z.coerce.date(),
});
export const AcquireParams = z.object({ id: z.string() });
export const ErrorResponse = z.object({ error: z.string() });
