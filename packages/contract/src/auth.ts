/** username/password auth, JWT access + opaque refresh token. */

import { z } from "zod";

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
  device: z.string().optional(),
});
export type LoginBody = z.infer<typeof LoginBody>;

export const LoginResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  sessionId: z.string(),
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
  userAgent: z.string().nullable(),
  createdAt: z.coerce.date(),
  expiresAt: z.coerce.date(),
  revokedAt: z.coerce.date().nullable(),
});

export const SessionParams = z.object({ id: z.string() });

export const CreateInviteBody = z.object({ expiresInDays: z.number().optional() });
export type CreateInviteBody = z.infer<typeof CreateInviteBody>;

export const InviteResponse = z.object({
  code: z.string(),
  expiresAt: z.coerce.date().nullable(),
});

export const ErrorResponse = z.object({ error: z.string() });
