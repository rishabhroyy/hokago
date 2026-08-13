/** offline downloads: server-produced artifact (original or transcoded) + packaged subtitles/fonts, served for offline playback on native clients. */

import { z } from "zod";

/** original = the raw file; transcode = ffmpeg to a self-contained MP4 at optional caps (clamped server-side like playback). */
export const DownloadVariant = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("original") }),
  z.object({
    kind: z.literal("transcode"),
    maxHeight: z.number().int().positive().optional(),
    maxBitrateKbps: z.number().int().positive().optional(),
  }),
]);
export type DownloadVariant = z.infer<typeof DownloadVariant>;

export const DownloadCreateBody = z.object({
  mediaItemId: z.string(),
  mediaFileId: z.string(),
  /** The device that owns this download — must belong to the account. */
  deviceId: z.string(),
  variant: DownloadVariant,
  /**
   * Subtitle tracks to package alongside the media. Text formats (SRT/VTT/ASS)
   * are packaged as sidecars for either variant; a bitmap track is only
   * possible on a TRANSCODE variant, where it is burned into the encode.
   */
  subtitleTrackIds: z.array(z.string()).optional(),
});
export type DownloadCreateBody = z.infer<typeof DownloadCreateBody>;

export const DownloadInfo = z.object({
  id: z.string(),
  mediaItemId: z.string(),
  mediaFileId: z.string(),
  deviceId: z.string(),
  variant: z.enum(["original", "transcode"]),
  targetHeight: z.number().int().nullable(),
  targetBitrateKbps: z.number().int().nullable(),
  subtitleTrackIds: z.array(z.string()),
  status: z.enum(["QUEUED", "PROCESSING", "READY", "FAILED"]),
  sizeBytes: z.number().nullable(),
  error: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type DownloadInfo = z.infer<typeof DownloadInfo>;

export const DownloadListQuery = z.object({ deviceId: z.string().optional() });

export const DownloadParams = z.object({ id: z.string() });

export const DownloadSubtitleParams = z.object({ id: z.string(), trackId: z.string() });

export const DownloadFontParams = z.object({ id: z.string(), hash: z.string() });

/** The packaged artifact: the media file plus sidecar subtitles + fonts. URLs are relative — resolve against the client's configured base URL. */
export const DownloadArtifactManifest = z.object({
  media: z
    .object({ filename: z.string(), url: z.string(), sizeBytes: z.number().nullable() })
    .nullable(),
  subtitles: z.array(
    z.object({
      trackId: z.string(),
      filename: z.string(),
      format: z.string(),
      lang: z.string().nullable(),
    }),
  ),
  fonts: z.array(z.object({ hash: z.string(), filename: z.string(), url: z.string() })),
});
export type DownloadArtifactManifest = z.infer<typeof DownloadArtifactManifest>;

export const ErrorResponse = z.object({ error: z.string() });
