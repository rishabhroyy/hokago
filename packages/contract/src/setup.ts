/** First-run setup wizard: the fresh-install bootstrap that creates the first admin account. */

import { z } from "zod";
export { ErrorResponse } from "./auth.js";

/**
 * Public setup state — the web app checks this before the login gate to
 * branch to the wizard on a fresh install. `setupRequired` is true while no
 * account exists at all (NOT the `ServerSetting.setupCompletedAt` stamp — a
 * CLI-bootstrapped server has accounts but no stamp, and must never be forced
 * through the wizard).
 */
export const SetupState = z.object({
  setupRequired: z.boolean(),
});
export type SetupState = z.infer<typeof SetupState>;

export const SetupCompleteBody = z.object({
  username: z.string().min(1).max(64),
  /** The first (admin) account deserves a real password policy even though the rest of the app stays lax. */
  password: z.string().min(8).max(256),
});
export type SetupCompleteBody = z.infer<typeof SetupCompleteBody>;

export const SetupCompleteResponse = z.object({
  ok: z.boolean(),
  /**
   * Session tokens minted for the new admin account — the wizard continues
   * authenticated into the library steps (and the app after it finishes)
   * instead of bouncing to a fresh login.
   */
  accessToken: z.string(),
  refreshToken: z.string(),
  sessionId: z.string(),
});