/** multiple profiles per account. */

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
  maturityRating: z.string().nullable().optional(),
});
export type UpdateProfileBody = z.infer<typeof UpdateProfileBody>;

// avatarPath is not patchable directly — the upload endpoint owns it (it must
// point at a file we stored, never an arbitrary client-supplied path).
export const AvatarUploadResponse = z.object({ avatarPath: z.string() });

export const NotFoundError = z.object({ error: z.string() });
