/**
 * hokago — throwaway health-check contract (§19 Step 1).
 * Proves the Zod → OpenAPI → generated TS client pipeline end to end (§5).
 * Real route contracts land per-subsystem as those steps come up.
 */

import { z } from "zod";

export const HealthResponse = z.object({
  status: z.literal("ok"),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
