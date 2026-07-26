/** §7.1 — multiple profiles per account. */

import { z } from "zod";

export const Profile = z.object({
  id: z.string(),
  accountId: z.string(),
  name: z.string(),
  avatarPath: z.string().nullable(),
  maturityRating: z.string().nullable(),
  prefs: z.unknown(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Profile = z.infer<typeof Profile>;

export const ProfileParams = z.object({ id: z.string() });

export const CreateProfileBody = z.object({
  name: z.string(),
  avatarPath: z.string().optional(),
  maturityRating: z.string().optional(),
});
export type CreateProfileBody = z.infer<typeof CreateProfileBody>;

export const UpdateProfileBody = z.object({
  name: z.string().optional(),
  avatarPath: z.string().nullable().optional(),
  maturityRating: z.string().nullable().optional(),
});
export type UpdateProfileBody = z.infer<typeof UpdateProfileBody>;

export const NotFoundError = z.object({ error: z.string() });
