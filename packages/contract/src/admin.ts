/** admin management system — queue ops (BullMQ) + library/account/settings mgmt (Postgres). */

import { z } from "zod";
import { ContentProfile, MediaKind } from "./browse.js";

export const QueueName = z.enum(["scan", "artwork", "trickplay", "metadata-tvmaze", "metadata-wikipedia", "metadata-anilist", "metadata-mal", "download", "anicli"]);
export const JobState = z.enum(["waiting", "active", "completed", "failed", "delayed"]);

export const ScanMode = z.enum(["WATCH_AND_PERIODIC", "PERIODIC_ONLY", "MANUAL"]);
export const ProviderName = z.enum(["LOCAL", "EMBEDDED", "GENERATED", "TVMAZE", "WIKIPEDIA", "ANILIST", "MAL", "WIKIDATA"]);

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

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard summary
// ─────────────────────────────────────────────────────────────────────────────

export const AdminSummary = z.object({
  libraries: z.number(),
  items: z.number(),
  itemKinds: z.record(z.string(), z.number()),
  mediaBytes: z.number(),
  mediaFiles: z.number(),
  artworkBytes: z.number(),
  artworkFiles: z.number(),
  fonts: z.number(),
  accounts: z.number(),
  profiles: z.number(),
  activeSessions: z.number(),
  runningTranscodes: z.number(),
  needsAttention: z.number(),
  lastScanAt: z.coerce.date().nullable(),
  queues: z.array(QueueSummary),
});
export type AdminSummary = z.infer<typeof AdminSummary>;

// ─────────────────────────────────────────────────────────────────────────────
// Libraries
// ─────────────────────────────────────────────────────────────────────────────

export const AdminLibrary = z.object({
  id: z.string(),
  name: z.string(),
  rootPath: z.string(),
  contentProfile: ContentProfile,
  mediaKinds: z.array(MediaKind),
  providerOrder: z.array(ProviderName),
  scanMode: ScanMode,
  writable: z.boolean(),
  composeAllPosters: z.boolean(),
  enabled: z.boolean(),
  hiddenFromHome: z.boolean(),
  lastScanAt: z.coerce.date().nullable(),
  itemCount: z.number(),
  storageBytes: z.number(),
  /** Live scan progress from the BullMQ job — null when no scan is running. */
  scanProgress: z.object({ doneDirs: z.number(), totalDirs: z.number() }).nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type AdminLibrary = z.infer<typeof AdminLibrary>;

export const AdminLibraryParams = z.object({ id: z.string() });

export const AdminLibraryCreateBody = z.object({
  name: z.string(),
  rootPath: z.string(),
  contentProfile: ContentProfile.optional(),
  mediaKinds: z.array(MediaKind).optional(),
  providerOrder: z.array(ProviderName).optional(),
  scanMode: ScanMode.optional(),
  writable: z.boolean().optional(),
  composeAllPosters: z.boolean().optional(),
  enabled: z.boolean().optional(),
  hiddenFromHome: z.boolean().optional(),
});
export type AdminLibraryCreateBody = z.infer<typeof AdminLibraryCreateBody>;

export const AdminLibraryUpdateBody = z.object({
  name: z.string().optional(),
  rootPath: z.string().optional(),
  contentProfile: ContentProfile.optional(),
  mediaKinds: z.array(MediaKind).optional(),
  providerOrder: z.array(ProviderName).optional(),
  scanMode: ScanMode.optional(),
  writable: z.boolean().optional(),
  composeAllPosters: z.boolean().optional(),
  enabled: z.boolean().optional(),
  hiddenFromHome: z.boolean().optional(),
});
export type AdminLibraryUpdateBody = z.infer<typeof AdminLibraryUpdateBody>;

export const AdminScanResponse = z.object({ enqueued: z.boolean() });

// ─────────────────────────────────────────────────────────────────────────────
// Accounts / sessions / invites
// ─────────────────────────────────────────────────────────────────────────────

export const AdminAccount = z.object({
  id: z.string(),
  username: z.string(),
  isAdmin: z.boolean(),
  disabled: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  lastLoginAt: z.coerce.date().nullable(),
  profileCount: z.number(),
  sessionCount: z.number(),
});
export type AdminAccount = z.infer<typeof AdminAccount>;

export const AdminAccountParams = z.object({ id: z.string() });

export const AdminAccountCreateBody = z.object({
  username: z.string(),
  password: z.string(),
  isAdmin: z.boolean().optional(),
});
export type AdminAccountCreateBody = z.infer<typeof AdminAccountCreateBody>;

export const AdminAccountUpdateBody = z.object({
  isAdmin: z.boolean().optional(),
  disabled: z.boolean().optional(),
  password: z.string().optional(),
});
export type AdminAccountUpdateBody = z.infer<typeof AdminAccountUpdateBody>;

export const AdminAccountResponse = z.object({ id: z.string() });
export const AdminDeletedResponse = z.object({ deleted: z.boolean() });

export const AdminInvite = z.object({
  id: z.string(),
  code: z.string(),
  createdBy: z.string(),
  createdAt: z.coerce.date(),
  expiresAt: z.coerce.date().nullable(),
  usedAt: z.coerce.date().nullable(),
});
export type AdminInvite = z.infer<typeof AdminInvite>;

export const AdminInviteParams = z.object({ id: z.string() });

export const AdminSession = z.object({
  id: z.string(),
  username: z.string(),
  device: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.coerce.date(),
  expiresAt: z.coerce.date(),
  revokedAt: z.coerce.date().nullable(),
});
export type AdminSession = z.infer<typeof AdminSession>;

// ─────────────────────────────────────────────────────────────────────────────
// Server settings & providers
// ─────────────────────────────────────────────────────────────────────────────

export const ServerSettings = z.object({
  basePath: z.string(),
  maxConcurrentTranscodes: z.number(),
  maxTranscodesPerUser: z.number(),
  fingerprintEnabled: z.boolean(),
  fingerprintThreads: z.number(),
  fingerprintWindow: z.string().nullable(),
  setupCompletedAt: z.coerce.date().nullable(),
});
export type ServerSettings = z.infer<typeof ServerSettings>;

export const ServerSettingsUpdateBody = z.object({
  basePath: z.string().optional(),
  maxConcurrentTranscodes: z.number().optional(),
  maxTranscodesPerUser: z.number().optional(),
  fingerprintEnabled: z.boolean().optional(),
  fingerprintThreads: z.number().optional(),
  fingerprintWindow: z.string().nullable().optional(),
});
export type ServerSettingsUpdateBody = z.infer<typeof ServerSettingsUpdateBody>;

// ─────────────────────────────────────────────────────────────────────────────
// Attention / trouble
// ─────────────────────────────────────────────────────────────────────────────

export const AttentionFailure = z.object({
  jobType: z.string(),
  attempts: z.number(),
  lastError: z.string().nullable(),
  lastFailedAt: z.coerce.date(),
});

export const AttentionItem = z.object({
  id: z.string(),
  title: z.string(),
  kind: MediaKind,
  libraryName: z.string(),
  state: z.enum(["OK", "NEEDS_ATTENTION"]),
  confidence: z.number(),
  failures: z.array(AttentionFailure),
});
export type AttentionItem = z.infer<typeof AttentionItem>;

// ─────────────────────────────────────────────────────────────────────────────
// Hardware acceleration status (read-only — config is env/compose, Immich-style)
// ─────────────────────────────────────────────────────────────────────────────

export const HwaccelMethod = z.enum(["none", "vaapi", "qsv", "nvenc"]);
export const HwaccelRequest = z.enum(["auto", "none", "vaapi", "qsv", "nvenc"]);

export const AdminHwaccelStatus = z.object({
  /** what HOKAGO_HWACCEL asked for ("auto" = detect at boot) */
  requested: HwaccelRequest,
  /** what is actually active — "none" = CPU (no device, disabled, or explicit) */
  method: HwaccelMethod,
  /** device path in use (renderD* node or CUDA index; null when CPU) */
  device: z.string().nullable(),
  /** everything detection found usable on this host */
  available: z.array(
    z.object({
      method: z.enum(["vaapi", "qsv", "nvenc"]),
      device: z.string().nullable(),
    }),
  ),
  /** true when a runtime failure flipped this process to CPU */
  disabledAfterFailure: z.boolean(),
  /** why the resolved method was chosen */
  note: z.string().nullable(),
});
export type AdminHwaccelStatus = z.infer<typeof AdminHwaccelStatus>;
