/**
 * hokago — throwaway health-check contract (Step 1).
 * Proves the Zod → OpenAPI → generated TS client pipeline end to end .
 * Real route contracts land per-subsystem as those steps come up.
 */

import { z } from "zod";

export const HealthResponse = z.object({
  status: z.literal("ok"),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
