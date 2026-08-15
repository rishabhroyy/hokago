/** username/password auth, JWT access + opaque refresh token, device registration + TV pairing. */

import { z } from "zod";

export const DevicePlatform = z.enum([
  "WEB",
  "IOS",
  "IPADOS",
  "ANDROID",
  "MACOS",
  "WINDOWS",
  "LINUX",
  "TVOS",
  "ANDROIDTV",
  "GOOGLETV",
]);
export type DevicePlatform = z.infer<typeof DevicePlatform>;

export const RegisterBody = z.object({
  inviteCode: z.string(),
  username: z.string(),
  password: z.string(),
});
export type RegisterBody = z.infer<typeof RegisterBody>;

export const RegisterResponse = z.object({ accountId: z.string() });

export const LoginBody = z.object({
  username: z.string(),
  password: z.string(),
  /** Legacy free-text display label ("web"). Web clients still send this. */
  device: z.string().optional(),
  /**
   * Native-client stable per-install identity (UUID the app generates once and
   * keeps in its secure store). When present the server upserts a Device row
   * for this account and binds the new session to it, so the session shows up
   * under a real device and "revoke device" revokes everything it had.
   */
  clientKey: z.string().optional(),
  deviceName: z.string().optional(),
  platform: DevicePlatform.optional(),
});
export type LoginBody = z.infer<typeof LoginBody>;

export const LoginResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  sessionId: z.string(),
  /** Device row bound to this session — set when clientKey was sent. */
  deviceId: z.string().nullable().default(null),
});

export const RefreshBody = z.object({ refreshToken: z.string() });
export type RefreshBody = z.infer<typeof RefreshBody>;

export const RefreshResponse = z.object({ accessToken: z.string() });

export const RevokedResponse = z.object({ revoked: z.boolean() });

export const ChangePasswordBody = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(1),
});
export type ChangePasswordBody = z.infer<typeof ChangePasswordBody>;

export const ChangePasswordResponse = z.object({ changed: z.boolean() });

export const SessionSummary = z.object({
  id: z.string(),
  device: z.string().nullable(),
  deviceId: z.string().nullable(),
  platform: DevicePlatform.nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.coerce.date(),
  expiresAt: z.coerce.date(),
  revokedAt: z.coerce.date().nullable(),
});

export const SessionParams = z.object({ id: z.string() });

/** A registered native client (see Device model). */
export const DeviceSummary = z.object({
  id: z.string(),
  name: z.string(),
  platform: DevicePlatform,
  createdAt: z.coerce.date(),
  lastSeenAt: z.coerce.date().nullable(),
});
export type DeviceSummary = z.infer<typeof DeviceSummary>;

export const DeviceParams = z.object({ id: z.string() });

// ── TV-style pairing ─────────────────────────────────────────────────────────

/** Unauthenticated TV: request a code to display. */
export const PairingRequestBody = z.object({
  name: z.string().min(1).max(80),
  platform: DevicePlatform,
  /** The TV's stable per-install identity — becomes its Device on approval. */
  clientKey: z.string().optional(),
});
export type PairingRequestBody = z.infer<typeof PairingRequestBody>;

export const PairingRequestResponse = z.object({
  pairingId: z.string(),
  /** 6-digit code shown on screen. */
  code: z.string(),
  expiresAt: z.coerce.date(),
});

/** Authenticated phone/PC: approve a code someone's TV is showing. */
export const PairingVerifyBody = z.object({ code: z.string().min(4).max(8) });
export type PairingVerifyBody = z.infer<typeof PairingVerifyBody>;

export const PairingVerifyResponse = z.object({
  ok: z.boolean(),
  /** The approved TV's Device id — the TV gets this from /status. */
  deviceId: z.string().nullable(),
});

/** Unauthenticated TV: poll until the code is approved, then get a session. */
export const PairingStatusBody = z.object({ pairingId: z.string() });
export type PairingStatusBody = z.infer<typeof PairingStatusBody>;

export const PairingStatusResponse = z.object({
  status: z.enum(["PENDING", "APPROVED", "COMPLETE", "EXPIRED"]),
  /** Minted once, on the first poll after APPROVED — the TV's session tokens. */
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  sessionId: z.string().optional(),
  deviceId: z.string().optional(),
  /**
   * The approving account's username — lets the TV label the new profile in
   * its account switcher before any authenticated call is made.
   */
  username: z.string().optional(),
});

export const CreateInviteBody = z.object({ expiresInDays: z.number().optional() });
export type CreateInviteBody = z.infer<typeof CreateInviteBody>;

export const InviteResponse = z.object({
  code: z.string(),
  expiresAt: z.coerce.date().nullable(),
});

export const ErrorResponse = z.object({ error: z.string() });
